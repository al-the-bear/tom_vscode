/**
 * Prompt Queue Editor (§3.2)
 *
 * A command-opened webview panel that shows the ordered queue of
 * prompts destined for Copilot Chat.  Each item is editable with
 * status, expanded preview, reordering, and per-item reminder config.
 *
 * Opened via `tomAi.editor.promptQueue` command.
 */

import { todoIdPatternOf } from '../utils/todoQueueMarks';
import { pickAgentSdkSession, sessionsFolder } from './sessionPicker';
import { listSessions } from '../services/agentSdkSessionStore';
import { sessionInfoOf } from '../utils/sessionSpecs';
import * as fs from 'fs';
import { WsPaths } from '../utils/workspacePaths';
import { listRoleNames } from '../utils/roleNames';
import * as vscode from 'vscode';
import { PromptQueueManager, QueuedPrompt, applyTemplateWrapping } from '../managers/promptQueueManager';
import type { LaneSummary } from '../utils/queueLanes';
import { ReminderSystem } from '../managers/reminderSystem';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig } from './handler_shared';
import { compactionPickerState, setCompactionModel, type CompactionPickerConfig } from '../utils/compactionTarget';
import { missingDirectApiKey, profileKeyStates } from '../utils/anthropicApiKeyCheck';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';
import { addUserMessageTemplate, deleteUserMessageTemplate, editUserMessageTemplate } from './userMessageTemplateActions';
import { userMessageTemplateOptions } from '../utils/copilotTemplates';
import { renderTransportPicker } from '../utils/transportPicker';
import { normalizeRepeatCountInput } from '../utils/queueStep3Utils';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { QuestRefreshService } from '../services/quest-refresh-service';
import { ProcessStateStore } from '../managers/processStateStore';
import { positionText } from '../utils/processActionPrompt';
import { runningLoopAbove } from '../utils/queueSendBetween';
import { itemUsageSummaryLine } from '../utils/usageCost';
import { repetitionAnswersFromTrail, walkPrefixOf } from '../utils/repetitionAnswers';
import { continueOptions, continuePrompt, waitingSinceLabel, type ContinueAction } from '../utils/pendingQuestion';
import { backgroundWaitLine, formatLimit, listBackgroundWork } from '../utils/backgroundWait';
import { extractTodoRefsFromVariables, parseTodoRef } from '../utils/todoLogRefs';
import { questTrailFolder } from '../utils/questPaths';
import { todoLogTrailSets } from '../utils/todoLogTrailSets';
import { discoverTrailSets, loadTrailSet } from './trailEditor-handler';

/** The process position a queue item belongs to, as text (`quest: Phase #n › Step #n`); undefined when none. */
function processPositionOf(item: QueuedPrompt): string | undefined {
    const run = item.processRun;
    if (!run) { return undefined; }
    const def = ProcessStateStore.instance?.entry(run.state.process)?.definition;
    const where = def ? positionText(def, run.state) : `${run.state.process} › ${run.state.phase} › ${run.state.step}`;
    return `${run.quest}: ${where}`;
}

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _queueListener: vscode.Disposable | undefined;
let _questRefreshListener: vscode.Disposable | undefined;
/** The process store's changes: the state is sent again when the runs or the window's run changed. */
let _runsListener: vscode.Disposable | undefined;
let _ctx: vscode.ExtensionContext | undefined;
const QUEUE_COLLAPSED_STATE_KEY = 'tomAi.queueEditor.collapsedItemIds';
let _collapsedItemIds = new Set<string>();

function loadCollapsedQueueState(ctx: vscode.ExtensionContext): void {
  const stored = ctx.workspaceState.get<string[]>(QUEUE_COLLAPSED_STATE_KEY, []);
  _collapsedItemIds = new Set((stored || []).filter(id => typeof id === 'string' && id));
}

async function persistCollapsedQueueState(): Promise<void> {
  if (!_ctx) { return; }
  await _ctx.workspaceState.update(QUEUE_COLLAPSED_STATE_KEY, Array.from(_collapsedItemIds));
}

// ============================================================================
// Registration
// ============================================================================

export function registerQueueEditorCommand(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.promptQueue', () => openQueueEditor(ctx))
    );
    // Restore the panel after a window reload. The queue editor is a singleton
    // that rebuilds its entire view from PromptQueueManager on open, so no
    // per-panel state needs persisting — we just re-bind the panel VS Code
    // hands back. Without this serializer the tab silently vanishes on reload.
    ctx.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('tomAi.queueEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                panel.webview.options = getQueueEditorWebviewOptions(ctx);
                bindQueueEditorPanel(ctx, panel);
            },
        })
    );
}

// ============================================================================
// Open / Reveal
// ============================================================================

/** Webview options shared by the fresh-open and reload-restore paths. */
function getQueueEditorWebviewOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(ctx.extensionUri, 'media'),
            vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

function openQueueEditor(ctx: vscode.ExtensionContext): void {
    if (_panel) { _panel.reveal(); return; }

    const panel = vscode.window.createWebviewPanel(
        'tomAi.queueEditor',
        'Prompt Queue',
        vscode.ViewColumn.One,
        {
            ...getQueueEditorWebviewOptions(ctx),
            retainContextWhenHidden: true,
        },
    );
    bindQueueEditorPanel(ctx, panel);
}

/**
 * Wire a (freshly-created or reload-restored) Prompt Queue panel: install the
 * message handler, paint the initial HTML, push state, and subscribe to queue
 * changes. Both `openQueueEditor` and the reload serializer call this so the
 * wiring lives in exactly one place.
 */
function bindQueueEditorPanel(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    _panel = panel;
    _ctx = ctx;
    loadCollapsedQueueState(ctx);

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    // Register message handler BEFORE setting html so no messages are lost
    _panel.webview.onDidReceiveMessage(handleMessage);
    // The add form's `/command`, `/skill` and `@file` completion (Ctrl+Shift+Space).
    wireCompletionMessages(_panel.webview);

    // Build initial state — handed to the webview as first-paint data via the
    // loader's window.__INIT__ (the loader handles </script> escaping). The
    // codicons stylesheet URI and the two host-rendered transport-picker
    // fragments (queue-default + add-form) travel the same way; main.js injects
    // them into the DOM. See media/queueEditor/index.html for the panel's
    // hand-written 'unsafe-inline' CSP (it keeps inline on*= handlers).
    const initialState = buildState();
    _panel.webview.html = loadWebviewHtml(_panel.webview, 'queueEditor', {
        init: {
            state: initialState,
            codiconsUri: webviewCodiconsUri.toString(),
            queueDefaultPickerHtml: renderTransportPicker({
                idPrefix: 'queueDefault',
                context: 'queue-default',
                value: { transport: 'copilot' },
                showTargets: true,
                onChangeEvent: 'setQueueDefaultTransport',
                inline: true,
            }),
            addFormPickerHtml: renderTransportPicker({
                idPrefix: 'addForm',
                context: 'queue-default',
                value: { transport: 'copilot' },
                showTargets: true,
                onChangeEvent: 'addFormTransportChanged',
            }),
        },
    });

    // Also push state via message (belt & suspenders)
    sendState();
    setTimeout(() => sendState(), 500);

    // Listen for queue changes — through whenReady: a tab VS Code restores
    // after a reload is bound while the extension activates, before the queue
    // manager starts, and binding to `instance` then subscribed to nothing.
    void PromptQueueManager.whenReady().then((qm) => {
        if (_panel !== panel || _queueListener) { return; }
        _queueListener = qm.onDidChange(() => sendState());
        sendState();
    });

    // Re-push state when a Quest Refresh starts/ends so the webview can show
    // (or hide) its orange "refresh running" banner. The refresh fires outside
    // the queue's own change events, so it needs a separate subscription.
    try {
        _questRefreshListener = QuestRefreshService.instance.onDidChangeRefreshing(() => sendState());
    } catch (e) {
        console.error('[QueueEditor] Failed to bind onDidChangeRefreshing:', e);
    }

    // The run filter and the add form's run follow the quest's runs and the window's run.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const processes = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore;
        void processes.ready.then((store) => {
            if (_panel !== panel || _runsListener) { return; }
            let last = JSON.stringify(queueRunState());
            _runsListener = store.onDidChange(() => {
                const now = JSON.stringify(queueRunState());
                if (now !== last) { last = now; sendState(); }
            });
        });
    } catch { /* no process store */ }

    _panel.onDidDispose(() => {
        _panel = undefined;
        // An edit left open in the closed editor would hold the queue for good.
        try { void PromptQueueManager.instance.endTextEdit(undefined); } catch { /* no queue */ }
        _runsListener?.dispose();
        _runsListener = undefined;
        _queueListener?.dispose();
        _queueListener = undefined;
        _questRefreshListener?.dispose();
        _questRefreshListener = undefined;
    });
}

// ============================================================================
// Message handling
// ============================================================================

/**
 * Every message, with a refusal shown to the user: the queue manager throws
 * when a value cannot be queued (a todo prefix ending in a digit), and a
 * webview message has nobody else to tell.
 */
async function handleMessage(msg: any): Promise<void> {
    try {
        await handleMessageUnsafe(msg);
    } catch (e) {
        void vscode.window.showErrorMessage(`Prompt Queue: ${(e as Error).message}`);
    }
}

async function handleMessageUnsafe(msg: any): Promise<void> {
    // Handle non-queue messages first
    switch (msg.type) {
        case 'getState':
            sendState();
            return;
        case 'renderMarkdown':
            // An item's answer as safe HTML for the editor's markdown overlay.
            _panel?.webview.postMessage({ type: 'markdownHtml', title: String(msg.title || ''), html: renderQuestLogMarkdown(String(msg.markdown || '')) });
            return;
        case 'openMarkdownPreview':
            // The same answer in the markdown preview editor.
            if (_ctx) {
                await showMarkdownHtmlPreview(_ctx, { title: String(msg.title || 'Answer'), markdown: String(msg.markdown || '') });
            }
            return;
        // The context links of a run's tab open that run's data, and the editors say which run (vscimpb60c).
        case 'openContextSettings':
            await vscode.commands.executeCommand('tomAi.editor.contextSettings', tabRunOf(msg));
            return;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('tomAi.editor.chatVariables', tabRunOf(msg));
            return;
        case 'openRunStateFile': {
            // The tab's run's process position: its state file (`process-state.<quest>[.<run>].yaml`).
            const file = runContextOf(tabRunOf(msg) ?? 'default').stateFile;
            if (file && fs.existsSync(file)) {
                await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
            } else {
                vscode.window.showInformationMessage(`Run ${tabRunOf(msg) ?? 'default'} has no process position yet.`);
            }
            return;
        }
        case 'showFile': {
          const { getQueueFolder, readAllEntries } = await import('../storage/queueFileStorage.js');
          const fs = await import('fs');
          const path = await import('path');
            const folder = getQueueFolder();
          if (!folder) {
            vscode.window.showWarningMessage('Queue folder is not configured for this workspace.');
            return;
          }

          const entries = readAllEntries();
          if (entries.length > 0) {
            const prioritized =
              entries.find(e => e.doc.meta.status === 'sending')
              || entries.find(e => e.doc.meta.status === 'pending')
              || entries.find(e => e.doc.meta.status === 'staged')
              || entries[entries.length - 1];
            const uri = vscode.Uri.file(prioritized.filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            await vscode.commands.executeCommand('revealInExplorer', uri);
            return;
            }

          const settingsPath = path.join(folder, 'queue-settings.yaml');
          if (fs.existsSync(settingsPath)) {
            const uri = vscode.Uri.file(settingsPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            await vscode.commands.executeCommand('revealInExplorer', uri);
            return;
          }

          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
            return;
        }
        case 'showEntryFile': {
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const { findEntryById } = await import('../storage/queueFileStorage.js');
          const entry = findEntryById(id);
          if (!entry) {
            vscode.window.showWarningMessage(`Queue entry file not found for id: ${id}`);
            return;
          }
          const uri = vscode.Uri.file(entry.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
          await vscode.commands.executeCommand('revealInExplorer', uri);
          return;
        }
        case 'setCompactionModel': {
          // The compaction / memory-extraction model pickers above the queue:
          // the same keys the Status Page's History Compaction dropdowns write.
          const purpose = msg.purpose === 'memory' ? 'memory' : 'compaction';
          const config = loadSendToChatConfig();
          if (!config) { return; }
          if (setCompactionModel(config as unknown as CompactionPickerConfig, purpose, typeof msg.value === 'string' ? msg.value : '')) {
            saveSendToChatConfig(config);
            const { refreshStatusPage } = await import('./statusPage-handler.js');
            await refreshStatusPage();
          }
          sendState();
          return;
        }
        case 'setQueueDefaultTransport': {
          // Spec §4.10 header-row queue-level default. Persists to
          // queue-settings.yaml so the setting survives reloads; new
          // items without an explicit transport inherit it at
          // dispatch time. The template here is transport-scoped
          // (anthropic user-message template id or copilot template
          // name) and gets stamped onto items when a queue template
          // is dispatched into the queue.
          const transport = (msg.transport === 'anthropic' ? 'anthropic' : 'copilot') as 'copilot' | 'anthropic';
          const pid = typeof msg.anthropicProfileId === 'string' ? msg.anthropicProfileId : '';
          const tplId = typeof msg.messageTemplateId === 'string' ? msg.messageTemplateId : '';
          // The defaults of the run the editor's settings are for (settings per run).
          const run = settingsRunOf(msg);
          PromptQueueManager.instance.setDefaultTransport(transport, pid, undefined, run);
          PromptQueueManager.instance.setDefaultMessageTemplate(tplId, run);
          sendState();
          return;
        }
        case 'applyQueueDefaultTransport': {
          // Header-bar "adopt queue settings" button. Copies the queue-level
          // default transport + Anthropic profile (the dropdowns above the
          // queue) onto this item. Allowed in any status — for a currently
          // repeating item the next repetition picks up the new values.
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          PromptQueueManager.instance.applyQueueDefaultsToItem(id);
          sendState();
          return;
        }
        case 'pickRole': {
          // The role chat variable, from the roles under _ai/roles (the context bar's Role link).
          const chat = ChatVariablesStore.instance;
          const roles = listRoleNames(WsPaths.ai('roles'));
          const picked = await vscode.window.showQuickPick(
            [{ label: '$(circle-slash) No role', role: '' }, ...roles.map((r) => ({ label: r, role: r, description: r === chat.role ? '(current)' : '' }))],
            { title: 'Role of the prompts', placeHolder: `Current role: ${chat.role || '(none)'}` },
          );
          if (picked) {
            chat.role = picked.role;
            sendState();
          }
          return;
        }

        case 'pickQueueDefaultSession':
        case 'editItemSession': {
          // The session of one item (its chip), or the queue's default (the context bar).
          const pqm = PromptQueueManager.instance;
          const quest = WsPaths.getWorkspaceQuestId();
          if (msg.type === 'pickQueueDefaultSession') {
            const run = settingsRunOf(msg);
            const picked = await pickAgentSdkSession({
              questId: quest, current: pqm.runQueueSettings(run).defaultAgentSdkSession, title: `Default session of run ${run ?? 'default'} in the prompt queue`,
              defaultLabel: 'The run\'s own session (default)',
            });
            if (picked !== undefined) { pqm.setDefaultAgentSdkSession(picked, run); }
          } else {
            const id = typeof msg.id === 'string' ? msg.id : '';
            const item = id ? pqm.getById(id) : undefined;
            if (!item) { return; }
            const picked = await pickAgentSdkSession({
              questId: quest, current: item.session, title: 'Session of this queue item',
              defaultLabel: `The queue default (${pqm.defaultAgentSdkSession || 'default'})`,
            });
            if (picked !== undefined) {
              try {
                if (!pqm.updateItemSession(id, picked)) {
                  void vscode.window.showWarningMessage('Only a staged or pending item can change its session.');
                }
              } catch (e) {
                // A session the item's profile cannot continue (see sessionRefusal).
                void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
              }
            }
          }
          sendState();
          return;
        }
        case 'editItemTransport':
        case 'editPrePromptTransport':
        case 'editFollowUpTransport': {
          // Spec §4.10 per-item + per-stage Advanced override. Same
          // three-step QuickPick flow (transport → profile → config)
          // regardless of scope; differs only in which manager method
          // commits the result.
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const pqm = PromptQueueManager.instance;
          const item = pqm.getById(id);
          if (!item) { return; }

          // Resolve the current stage's transport + ids for "(current)"
          // / "(default)" labelling.
          let currentTransport: string = item.transport || 'copilot';
          let currentProfile = item.anthropicProfileId;
          let currentConfig = item.anthropicConfigId;
          let scopeLabel = 'queue item';
          if (msg.type === 'editPrePromptTransport') {
            const ppIndex = typeof msg.index === 'number' ? msg.index : -1;
            const pp = item.prePrompts?.[ppIndex];
            if (!pp) { return; }
            currentTransport = pp.transport || currentTransport;
            currentProfile = pp.anthropicProfileId || currentProfile;
            currentConfig = pp.anthropicConfigId || currentConfig;
            scopeLabel = `pre-prompt #${ppIndex + 1}`;
          } else if (msg.type === 'editFollowUpTransport') {
            const followUpId = typeof msg.followUpId === 'string' ? msg.followUpId : '';
            const fu = item.followUps?.find((f) => f.id === followUpId);
            if (!fu) { return; }
            currentTransport = fu.transport || currentTransport;
            currentProfile = fu.anthropicProfileId || currentProfile;
            currentConfig = fu.anthropicConfigId || currentConfig;
            scopeLabel = `follow-up ${followUpId.slice(0, 8)}`;
          }

          const transportPick = await vscode.window.showQuickPick(
            [
              { label: 'Copilot Chat', value: 'copilot' as const, description: 'Answer-file polling flow.' },
              { label: 'Anthropic', value: 'anthropic' as const, description: 'Routes through AnthropicHandler.sendMessage; auto-approves tool calls.' },
              // Spec §4.15 inherit semantics:
              //   queue-item context  → "Inherit (queue default)"
              //   queue-stage context → "Inherit (item)"
              ...(msg.type === 'editItemTransport'
                ? [{ label: 'Inherit (queue default)', value: 'inherit' as const, description: 'Use whatever the queue-level default transport is.' }]
                : [{ label: 'Inherit from item', value: 'inherit' as const, description: 'Use the parent item\'s transport.' }]),
            ],
            { placeHolder: `Transport for ${scopeLabel} (current: ${currentTransport})`, ignoreFocusOut: true },
          );
          if (!transportPick) { return; }

          const applyUpdate = (transport: 'copilot' | 'anthropic' | undefined, profileId: string, configId: string): void => {
            if (msg.type === 'editItemTransport') {
              // Spec §5 edge case — template names only resolve inside
              // one transport's store. Changing the item's transport
              // invalidates the cached template reference, so clear it
              // along with the transport so the user picks a new one
              // from the right store next time.
              pqm.updateItemTransport(id, { transport, anthropicProfileId: profileId, anthropicConfigId: configId });
              pqm.updateItemTemplateAndWrapper(id, { template: '' }).catch(() => { /* best-effort */ });
            } else if (msg.type === 'editPrePromptTransport') {
              const ppIndex = typeof msg.index === 'number' ? msg.index : -1;
              pqm.updatePrePrompt(id, ppIndex, { transport, anthropicProfileId: profileId, anthropicConfigId: configId, template: '' });
            } else {
              const followUpId = typeof msg.followUpId === 'string' ? msg.followUpId : '';
              pqm.updateFollowUpPrompt(id, followUpId, { transport, anthropicProfileId: profileId, anthropicConfigId: configId, template: '' });
            }
            sendState();
          };

          if (transportPick.value === 'inherit') {
            applyUpdate(undefined, '', '');
            return;
          }
          if (transportPick.value === 'copilot') {
            applyUpdate('copilot', '', '');
            return;
          }

          const cfg = loadSendToChatConfig();
          const profiles = (cfg?.anthropic?.profiles ?? []).filter((p) => !!p && typeof p.id === 'string');
          if (profiles.length === 0) {
            vscode.window.showWarningMessage('No Anthropic profiles defined. Create one in the Extension State Page first.');
            return;
          }
          const profilePickItems = profiles.map((p) => ({
            label: p.name || p.id,
            description: p.id === currentProfile ? '(current)' : p.isDefault ? '(default)' : '',
            value: p.id,
          }));
          const profilePick = await vscode.window.showQuickPick(profilePickItems, {
            placeHolder: 'Anthropic profile',
            ignoreFocusOut: true,
          });
          if (!profilePick) { return; }
          const anthropicConfigs = (cfg?.anthropic?.configurations ?? []).filter((c) => !!c && typeof c.id === 'string');
          const localLlmConfigs = ((cfg as { localLlm?: { configurations?: Array<{ id?: string; name?: string }> } })?.localLlm?.configurations ?? []).filter((c) => !!c && typeof c.id === 'string');
          const configPickItems = [
            { label: '(profile default)', value: '', description: currentConfig ? '' : '(current)' },
            ...anthropicConfigs.map((c) => {
              const t = c.transport;
              const prefix = t === 'agentSdk' ? '[agentSdk]' : t === 'vscodeLm' ? '[vscodeLm]' : '[direct]';
              return { label: `${prefix} ${c.name || c.id}`, value: c.id, description: c.id === currentConfig ? '(current)' : c.id };
            }),
            ...localLlmConfigs.map((c) => ({ label: `[localLlm] ${c.name || c.id}`, value: (c.id as string), description: c.id === currentConfig ? '(current)' : (c.id as string) })),
          ];
          const configPick = await vscode.window.showQuickPick(configPickItems, {
            placeHolder: 'Configuration',
            ignoreFocusOut: true,
          });
          if (!configPick) { return; }
          applyUpdate('anthropic', profilePick.value, configPick.value);
          if (msg.type === 'editItemTransport') {
            // Last step for an item: the Agent SDK session it runs in.
            const picked = await pickAgentSdkSession({
              questId: WsPaths.getWorkspaceQuestId(), current: item.session, title: 'Session of this queue item',
              defaultLabel: `The queue default (${pqm.defaultAgentSdkSession || 'default'})`,
            });
            if (picked !== undefined) { pqm.updateItemSession(id, picked); sendState(); }
          }
          return;
        }
        case 'setDetailsExpanded': {
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const expanded = msg.expanded !== false;
          if (expanded) {
            _collapsedItemIds.delete(id);
          } else {
            _collapsedItemIds.add(id);
          }
          await persistCollapsedQueueState();
          return;
        }
        case 'setAllDetailsExpanded': {
          const ids = Array.isArray(msg.ids) ? msg.ids.filter((id: unknown) => typeof id === 'string' && !!id) as string[] : [];
          const expanded = msg.expanded !== false;
          if (expanded) {
            ids.forEach(id => _collapsedItemIds.delete(id));
          } else {
            ids.forEach(id => _collapsedItemIds.add(id));
          }
          await persistCollapsedQueueState();
          return;
        }
        case 'addReminderTemplate':
          await addReminderTemplate();
          sendState();
          return;
        case 'editReminderTemplate':
          await editReminderTemplate(msg.id);
          sendState();
          return;
        case 'deleteReminderTemplate':
          await deleteReminderTemplate(msg.id);
          sendState();
          return;
        case 'addPromptTemplate':
          await addPromptTemplate();
          sendState();
          return;
        case 'editPromptTemplate':
          await editPromptTemplate(msg.name);
          sendState();
          return;
        case 'deletePromptTemplate':
          await deletePromptTemplate(msg.name);
          sendState();
          return;
        case 'previewItem': {
            const { showPreviewPanel } = await import('./handler_shared.js');
            const { expandTemplate } = await import('./promptTemplate.js');
            let previewContent = msg.text || '';
            const template = msg.template || '';
            const answerWrapper = msg.answerWrapper || false;
            // Spec §4.16 — preview applies the template from the same
            // store a live dispatch would hit (copilot vs anthropic).
            const transport: 'copilot' | 'anthropic' = msg.transport === 'anthropic' ? 'anthropic' : 'copilot';
            previewContent = await expandTemplate(previewContent);
            // Anthropic items never apply the Copilot answer-wrapper.
            const effectiveWrap = transport === 'copilot' ? answerWrapper : false;
            previewContent = await applyTemplateWrapping(previewContent, template, effectiveWrap, transport);
            await showPreviewPanel('Queue Item Preview', previewContent);
            return;
        }
        case 'previewFollowUp': {
          const { showPreviewPanel } = await import('./handler_shared.js');
          const { expandTemplate } = await import('./promptTemplate.js');
          let previewContent = msg.text || '';
          const template = msg.template || '';
          const transport: 'copilot' | 'anthropic' = msg.transport === 'anthropic' ? 'anthropic' : 'copilot';
          previewContent = await expandTemplate(previewContent);
          // Anthropic follow-ups skip the Copilot answer-wrapper.
          previewContent = await applyTemplateWrapping(previewContent, template, transport === 'copilot', transport);
          await showPreviewPanel('Follow-up Prompt Preview', previewContent);
          return;
        }
    }

    // Queue-dependent messages
    let qm: PromptQueueManager;
    try { qm = PromptQueueManager.instance; } catch {
        vscode.window.showWarningMessage('Prompt queue not available');
        return;
    }

    switch (msg.type) {
        case 'remove':
            qm.remove(msg.id);
            break;
        case 'moveUp':
            qm.move(msg.id, 'up');
            break;
        case 'moveDown':
            qm.move(msg.id, 'down');
            break;
        case 'moveToFront':
            qm.move(msg.id, 'front');
            break;
        case 'toggleSendBetween':
            qm.toggleSendBetween(msg.id);
            break;
        case 'sendNow':
            await qm.sendNow(msg.id);
            break;
        case 'continueSending':
          // Continue asks first: Answer now / Resend this stage / Skip (vscimpb55).
          await continueWithChoice(qm, msg.id);
          break;
        case 'resendSendingStage':
          await resendRunningStage(qm, msg.id);
          break;
        case 'openPendingQuestion':
          await vscode.commands.executeCommand('tomAi.showPendingQuestion');
          break;
        case 'backgroundWaitAction':
          // The waiting item's buttons: Wait without limit / Keep waiting / Stop waiting.
          applyBackgroundWaitAction(qm, msg.id, msg.action);
          break;
        case 'resendLastPrompt':
          try {
            await qm.resendLastPrompt(msg.id);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Resend failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'continueOnProfile':
          // Out of credit: send the stopped stage on another profile (src/utils/outOfBudget.ts).
          try {
            await qm.continueOnProfile(msg.id, msg.profileId);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Continue on profile failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'resetToPending':
          // Soft action on an error item: flip back to `pending`
          // without sending. Auto-send stays off (the error transition
          // already disabled it); the user re-enables it explicitly
          // when they're ready to drain the queue.
          try {
            qm.resetItemToPending(msg.id);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Reset to pending failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'retryWaitingNow':
          // Manual escape hatch on a rate-limit-parked item: cut the reset
          // countdown short, flip to `pending`, and send immediately.
          try {
            await qm.retryWaitingNow(msg.id);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Retry now failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'retryRetryingNow':
          // Manual escape hatch on a retry-parked item: cut the backoff
          // countdown short, flip to `pending`, and send immediately.
          try {
            await qm.retryRetryingNow(msg.id);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Retry now failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'stopRetrying':
          // Give up on a retry-parked item: promote it to `error` and pause
          // the queue (mirrors the exhausted-schedule path).
          try {
            qm.stopRetrying(msg.id);
          } catch (err) {
            vscode.window.showWarningMessage(
              `Stop retrying failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          break;
        case 'toggleReminder':
            qm.updateItemReminder(msg.id, { reminderEnabled: msg.enabled });
            break;
        case 'setPauseAfter':
            qm.setPauseAfter(msg.id, !!msg.pauseAfter);
            break;
        case 'updateDoneNotification':
            qm.updateItemDoneNotification(String(msg.id), { prompt: String(msg.prompt ?? '') });
            break;
        case 'setDoneNotificationDisabled':
            qm.updateItemDoneNotification(String(msg.id), { disabled: !!msg.disabled });
            break;
        case 'setItemStatus':
          if (msg.status === 'staged' || msg.status === 'pending') {
            qm.setStatus(msg.id, msg.status);
          }
          break;
        // Editing a pending (or staged) item's text: the queue waits for it while it is open.
        case 'beginTextEdit':
            if (!qm.beginTextEdit(String(msg.id))) {
                _panel?.webview.postMessage({ type: 'textEditRefused', id: msg.id });
            }
            break;
        case 'saveTextEdit':
            await qm.endTextEdit(String(msg.id), String(msg.text ?? ''));
            break;
        case 'cancelTextEdit':
            await qm.endTextEdit(String(msg.id));
            break;
        case 'updateText':
            await qm.updateText(msg.id, msg.text);
            break;
        case 'updateItemTemplate':
            // Auto-set answerWrapper based on template: true if any template selected, false if "(None)"
            await qm.updateItemTemplateAndWrapper(msg.id, { 
              template: msg.template,
              answerWrapper: !!(msg.template && msg.template !== '(None)')
            });
            break;
        case 'updateItemReminder':
          qm.updateItemReminder(msg.id, {
            reminderEnabled: msg.reminderEnabled,
            reminderTemplateId: msg.reminderTemplateId,
          reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
            reminderRepeat: msg.reminderRepeat,
          });
          break;
        // The toolbar of a run's tab: every action acts on that run's items (`run`; none: the whole queue).
        case 'clearSent':
            qm.clearByStatus('sent', tabRunOf(msg));
            break;
        case 'clearErrors':
            qm.clearByStatus('error', tabRunOf(msg));
            break;
        case 'clearAll':
            qm.clearAll(tabRunOf(msg));
            break;
        case 'sendAllStaged':
            qm.sendAllStaged(tabRunOf(msg));
            break;
        case 'retryAllErrors':
            try {
                const summary = await qm.retryAllErrors(tabRunOf(msg));
                if (summary.resent === 0 && summary.requeued === 0) {
                    vscode.window.showInformationMessage('No error-state items to retry.');
                } else {
                    vscode.window.showInformationMessage(
                        `Retrying ${summary.resent + summary.requeued} error item(s): ${summary.resent} resent, ${summary.requeued} requeued.`,
                    );
                }
            } catch (err) {
                vscode.window.showWarningMessage(
                    `Retry all failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
            break;
        case 'setSettingsRun':
            editorSettingsRun = typeof msg.run === 'string' && msg.run.trim() ? msg.run.trim() : undefined;
            break;
        // The toolbar's settings are those of one run (settings per run): the message names it.
        case 'toggleAutoSend':
        case 'toggleAutoContinue':
        case 'toggleAutoStart':
        case 'toggleAutoPause': {
            const run = settingsRunOf(msg);
            const key = ({ toggleAutoSend: 'autoSend', toggleAutoContinue: 'autoContinue', toggleAutoStart: 'autoStart', toggleAutoPause: 'autoPause' } as const)[msg.type as 'toggleAutoSend'];
            qm.setRunQueueSettings(run, { [key]: !qm.runQueueSettings(run)[key] });
            sendState();        // explicit update in case onDidChange listener isn't wired
            break;
        }
        case 'restartQueue':
            qm.restartQueue(tabRunOf(msg));
            sendState();
            break;
        case 'stopActiveItem': {
            const stopped = qm.stopActiveItem(typeof msg.id === 'string' && msg.id ? msg.id : undefined, tabRunOf(msg));
            if (!stopped) {
                vscode.window.showInformationMessage('No prompt is currently running.');
            }
            sendState();
            break;
        }
        // Toolbar (no id: the sending item) and per-row (id) variants of
        // interrupt-for-continuation share one manager entry point.
        case 'interruptActiveForContinuation':
        case 'interruptForContinuation': {
            const held = qm.interruptActiveItemForContinuation(msg.type === 'interruptForContinuation' ? msg.id : undefined, tabRunOf(msg));
            if (!held) {
                vscode.window.showInformationMessage('No prompt is currently running.');
            }
            sendState();
            break;
        }
        case 'updateItemRepeat':
          qm.updateRepeat(msg.id, {
            repeatCount: msg.repeatCount,
            repeatIndex: msg.repeatIndex,
            repeatPrefix: msg.repeatPrefix,
            repeatSuffix: msg.repeatSuffix,
            answerWaitMinutes: msg.answerWaitMinutes,
            templateRepeatCount: msg.templateRepeatCount,
            templateRepeatIndex: msg.templateRepeatIndex,
          });
          break;
        case 'setResponseTimeout':
          qm.setRunQueueSettings(settingsRunOf(msg), { responseTimeoutMinutes: Math.max(5, parseInt(String(msg.minutes || '60'), 10) || 60) });
          sendState();
          break;
        case 'setDefaultReminderTemplate':
          qm.setRunQueueSettings(settingsRunOf(msg), { defaultReminderTemplateId: msg.templateId || undefined });
          sendState();
          break;
        case 'addPrompt':
            try {
                console.log('[QueueEditor] addPrompt received, text length:', msg.text?.length);
                const addTransport = msg.transport === 'anthropic' ? 'anthropic' as const : undefined;
                // Add-to-Queue form now carries the message template
                // via `messageTemplateId` (from the transport picker).
                // Keep the legacy `template` field as a fallback in case
                // some caller still sends it.
                const addTemplate = (typeof msg.messageTemplateId === 'string' && msg.messageTemplateId)
                    ? msg.messageTemplateId
                    : msg.template;
                await qm.enqueue({
                    originalText: msg.text || '',
                    template: addTemplate,
                    // Copilot answer-wrapper is a Copilot-only construct
                    // (spec §4.7). Anthropic items skip it.
                    answerWrapper: addTransport === 'anthropic' ? false : (msg.answerWrapper || false),
                    reminderTemplateId: msg.reminderTemplateId,
                    reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
                    reminderRepeat: !!msg.reminderRepeat,
                    reminderEnabled: !!msg.reminderEnabled,
                    repeatCount: normalizeRepeatCountInput(msg.repeatCount),
                    repeatPrefix: typeof msg.repeatPrefix === 'string' ? msg.repeatPrefix : undefined,
                    repeatSuffix: typeof msg.repeatSuffix === 'string' ? msg.repeatSuffix : undefined,
                    deferSend: true,
                    // Multi-transport fields (spec §4.10).
                    transport: addTransport,
                    anthropicProfileId: typeof msg.anthropicProfileId === 'string' && msg.anthropicProfileId ? msg.anthropicProfileId : undefined,
                    anthropicConfigId: typeof msg.anthropicConfigId === 'string' && msg.anthropicConfigId ? msg.anthropicConfigId : undefined,
                    // The run picked in the add form (default the window's current run); an unknown one is refused.
                    ...(typeof msg.run === 'string' && msg.run ? { run: addFormRun(msg.run) } : {}),
                });
                console.log('[QueueEditor] addPrompt enqueued successfully');
                _panel?.webview.postMessage({ type: 'addSuccess' });
                sendState(); // Explicit state push after add
            } catch (e: any) {
                console.error('[QueueEditor] addPrompt error:', e);
                _panel?.webview.postMessage({ type: 'addError', error: e?.message || 'Failed to add to queue' });
            }
            break;
          case 'addFollowUp': {
            const follow = qm.addFollowUpPrompt(msg.id, {
              originalText: msg.text || '',
              template: msg.template || undefined,
              reminderTemplateId: msg.reminderTemplateId || undefined,
              reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
              reminderRepeat: !!msg.reminderRepeat,
              reminderEnabled: !!msg.reminderEnabled,
            });
            if (!follow) {
              _panel?.webview.postMessage({ type: 'addError', error: 'Failed to add follow-up prompt' });
            }
            break;
          }
          case 'addEmptyFollowUp': {
            const follow = qm.addEmptyFollowUpPrompt(msg.id);
            if (!follow) {
              _panel?.webview.postMessage({ type: 'addError', error: 'Failed to add follow-up prompt' });
            }
            break;
          }
          case 'updateFollowUp': {
            qm.updateFollowUpPrompt(msg.id, msg.followUpId, {
              originalText: msg.text,
              template: msg.template,
              repeatCount: msg.repeatCount,
              answerWaitMinutes: msg.answerWaitMinutes,
              reminderTemplateId: msg.reminderTemplateId,
              reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
              reminderRepeat: msg.reminderRepeat,
              reminderEnabled: msg.reminderEnabled,
            });
            break;
          }
          case 'removeFollowUp': {
            qm.removeFollowUpPrompt(msg.id, msg.followUpId);
            break;
          }
          case 'addPrePrompt': {
            qm.addPrePrompt(msg.id, msg.text || '', msg.template || undefined);
            break;
          }
          case 'updatePrePrompt': {
            qm.updatePrePrompt(msg.id, msg.index, {
              text: msg.text,
              template: msg.template,
              repeatCount: msg.repeatCount,
              answerWaitMinutes: msg.answerWaitMinutes,
              reminderTemplateId: msg.reminderTemplateId,
              reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
              reminderRepeat: msg.reminderRepeat,
              reminderEnabled: msg.reminderEnabled,
            });
            break;
          }
          case 'removePrePrompt': {
            qm.removePrePrompt(msg.id, msg.index);
            break;
          }
          case 'openTemplateEditor': {
            await vscode.commands.executeCommand('tomAi.editor.promptTemplates');
            return;
          }
          case 'openQueueTemplates': {
            await vscode.commands.executeCommand('tomAi.editor.queueTemplates');
            return;
          }
    }
}

async function addReminderTemplate(): Promise<void> {
  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'reminder' });
  }
}

async function editReminderTemplate(id?: string): Promise<void> {
  const templates = ReminderSystem.instance.templates;
  if (templates.length === 0) {
    vscode.window.showWarningMessage('No reminder templates available.');
    return;
  }

  let template = id ? templates.find(t => t.id === id) : undefined;
  if (!template) {
    const picked = await vscode.window.showQuickPick(
      templates.map(t => ({ label: t.name, description: t.id, id: t.id })),
      { placeHolder: 'Select reminder template to edit' },
    );
    if (!picked?.id) {
      return;
    }
    template = templates.find(t => t.id === picked.id);
  }
  if (!template) {
    return;
  }

  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'reminder', itemId: template.id });
  }
}

async function deleteReminderTemplate(id?: string): Promise<void> {
  const templates = ReminderSystem.instance.templates;
  if (templates.length === 0) {
    vscode.window.showWarningMessage('No reminder templates available.');
    return;
  }

  let template = id ? templates.find(t => t.id === id) : undefined;
  if (!template) {
    const picked = await vscode.window.showQuickPick(
      templates.map(t => ({ label: t.name, description: t.id, id: t.id })),
      { placeHolder: 'Select reminder template to delete' },
    );
    if (!picked?.id) {
      return;
    }
    template = templates.find(t => t.id === picked.id);
  }
  if (!template) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Delete reminder template "${template.name}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') {
    return;
  }
  ReminderSystem.instance.removeTemplate(template.id);
}

async function addPromptTemplate(): Promise<void> {
  addUserMessageTemplate(_ctx);
}

async function editPromptTemplate(currentName?: string): Promise<void> {
  await editUserMessageTemplate(_ctx, currentName);
}

async function deletePromptTemplate(currentName?: string): Promise<void> {
  await deleteUserMessageTemplate(currentName);
}

// ============================================================================
// State builder & push
// ============================================================================

/** The session a pending item waits for (a chat send runs in it), or undefined. */
function waitingForSessionOf(item: QueuedPrompt): string | undefined {
    if (item.status !== 'pending') { return undefined; }
    try { return PromptQueueManager.instance.chatHoldingSessionOf(item)?.session; } catch { return undefined; }
}

/** What a sending item's prompt waits for the user for, or undefined. */
function waitingForUserOf(item: QueuedPrompt): Array<'question' | 'approval'> | undefined {
    if (item.status !== 'sending') { return undefined; }
    try {
        const kinds = PromptQueueManager.instance.waitingForUserOf(item.id);
        return kinds.length ? kinds : undefined;
    } catch { return undefined; }
}

/** The question a sending item's turn waits in: when it was asked, as a label. */
function pendingQuestionLabelOf(item: QueuedPrompt): string | undefined {
    if (item.status !== 'sending') { return undefined; }
    try {
        const q = PromptQueueManager.instance.pendingQuestionOf(item.id);
        return q ? waitingSinceLabel(q.askedAt, Date.now()) : undefined;
    } catch { return undefined; }
}

/**
 * Continue on a sending item: never blindly. The user picks Answer now (only
 * while its turn waits for an answer), Resend this stage or Skip; dismissing
 * the dialog does nothing.
 */
export async function continueWithChoice(qm: PromptQueueManager, id: string): Promise<void> {
    const item = qm.getById(id);
    if (!item || item.status !== 'sending') { return; }
    const question = qm.pendingQuestionOf(id);
    const walk = walkPrefixOf(item) !== undefined;
    const background = qm.backgroundWaitOf(id);
    const options = continueOptions({
        waitingForAnswer: question !== undefined,
        canResend: item.lastDispatched !== undefined,
        walk,
        ...(background ? { backgroundLimit: formatLimit(background.limitMinutes) } : {}),
    });
    const text = continuePrompt({
        waitingSince: question ? waitingSinceLabel(question.askedAt, Date.now()) : undefined,
        walk,
        ...(background ? { backgroundWait: backgroundWaitLine(background, Date.now()) } : {}),
    });
    const picked = await vscode.window.showWarningMessage(text.message, { modal: true, detail: text.detail }, ...options.map((o) => o.label));
    const action: ContinueAction | undefined = options.find((o) => o.label === picked)?.action;
    if (!action) { return; }
    if (action === 'answer') {
        await vscode.commands.executeCommand('tomAi.showPendingQuestion');
        return;
    }
    if (action === 'waitWithoutLimit') { qm.waitWithoutLimit(id); return; }
    if (action === 'keepWaiting') { qm.keepWaitingForBackground(id); return; }
    if (action === 'stopWaiting') { qm.stopBackgroundWait(id); return; }
    if (action === 'resend') {
        await resendRunningStage(qm, id, true);
        return;
    }
    await qm.continueSending(id);
}

/** Resend the stage a sending item runs; a question its turn waits in is closed, so ask first then. */
async function resendRunningStage(qm: PromptQueueManager, id: string, confirmed = false): Promise<void> {
    if (!confirmed && qm.pendingQuestionOf(id)) {
        const ok = await vscode.window.showWarningMessage(
            'The turn is waiting for your answer. Resending closes the question unanswered and sends the same prompt again.',
            { modal: true },
            'Resend this stage',
        );
        if (ok !== 'Resend this stage') { return; }
    }
    try {
        await qm.resendSendingStage(id);
    } catch (err) {
        vscode.window.showWarningMessage(`Resend failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** What the editor shows of a sending item's background wait, or undefined when it does not wait. */
export function backgroundWaitViewOf(item: QueuedPrompt, now = Date.now()): { line: string; limit: string; unlimited: boolean; items: Array<{ id: string; description: string; command?: string; outputFile?: string; kind: string }> } | undefined {
    if (item.status !== 'sending' || !item.backgroundWait) { return undefined; }
    const state = item.backgroundWait;
    return {
        line: backgroundWaitLine(state, now),
        limit: formatLimit(state.limitMinutes),
        unlimited: state.unlimited === true,
        items: state.items.map((i) => ({ id: i.id, kind: i.kind, description: i.description, ...(i.command ? { command: i.command } : {}), ...(i.outputFile ? { outputFile: i.outputFile } : {}) })),
    };
}

/** A waiting item's button: the manager's action, answered with a note when the wait is already over. */
export function applyBackgroundWaitAction(qm: PromptQueueManager, id: string, action: unknown): boolean {
    const done = action === 'waitWithoutLimit' ? qm.waitWithoutLimit(id)
        : action === 'keepWaiting' ? qm.keepWaitingForBackground(id)
            : action === 'stopWaiting' ? qm.stopBackgroundWait(id)
                : false;
    if (!done) {
        const state = qm.backgroundWaitOf(id);
        void vscode.window.showInformationMessage(state
            ? `The item's wait cannot be changed now (${listBackgroundWork(state.items)}).`
            : 'The item no longer waits for background work.');
    }
    return done;
}

/** Whether a `chat` item's send still runs (it holds its session). */
function chatSendAlive(item: QueuedPrompt): boolean {
    try { return PromptQueueManager.instance.sessionHolder(item.session ?? 'chat')?.id === item.id; } catch { return false; }
}

/** Whether the queue holds `id`'s text open for editing (no queue: no). */
function isTextBeingEdited(id: string): boolean {
    try { return PromptQueueManager.instance.isTextBeingEdited(id); } catch { return false; }
}

/** Items whose repetition answers were looked up in the trail already (once per item and window). */
const repetitionBackfillTried = new Set<string>();

/**
 * A sent todo walk without its repetitions' answers (it ran before the queue
 * kept them): read them back from the quest's session trails once, so its
 * chips show every todo's answer (repetitionAnswersFromTrail).
 */
function backfillSentWalkAnswers(qm: PromptQueueManager): void {
    const due = qm.items.filter((i) => i.status === 'sent' && !i.repetitionAnswers?.length && walkPrefixOf(i) && !repetitionBackfillTried.has(i.id));
    if (due.length === 0) { return; }
    for (const i of due) { repetitionBackfillTried.add(i.id); }
    const quest = WsPaths.getWorkspaceQuestId();
    const folder = quest ? questTrailFolder(WsPaths.ai('quests', quest) || '') : '';
    if (!folder || !fs.existsSync(folder)) { return; }
    let entries: ReturnType<typeof loadTrailSet> = [];
    try {
        const sets = todoLogTrailSets(folder, discoverTrailSets);
        entries = [...sets.keys()].flatMap((name) => loadTrailSet(name, sets));
    } catch { return; }
    for (const item of due) {
        // No time bound: `sentAt` is the last repetition's dispatch, before its answer arrived.
        const answers = repetitionAnswersFromTrail(entries, quest, walkPrefixOf(item)!, extractTodoRefsFromVariables, parseTodoRef);
        qm.backfillRepetitionAnswers(item.id, answers);
    }
}

function buildState(): Record<string, unknown> {
    let items: readonly QueuedPrompt[] = [];
    let autoSend = true;
    let autoStart = false;
    let autoPause = true;
    let autoContinue = false;
  let responseTimeoutMinutes = 60;
  let defaultReminderTemplateId: string | undefined;
    let templates: { id: string; name: string }[] = [];
    let queueDefaultTransport: 'copilot' | 'anthropic' = 'copilot';
    let queueDefaultAnthropicProfileId = '';
    let queueDefaultMessageTemplateId = '';
    let queueDefaultSession = '';
    // Base and lifetime of every session of the quest, for the context bar and the item chips.
    let sessionInfo: Record<string, { basedOn?: string; mode: string }> = {};
    // Per item not yet sent: the stages a missing API key would make fail.
    const apiKeyWarnings = new Map<string, string[]>();

    try {
        const qm = PromptQueueManager.instance;
        backfillSentWalkAnswers(qm);
        items = qm.items;
        for (const item of items) {
            if (item.status === 'sent') { continue; }
            const lines = qm.missingApiKeyWarnings(item.id);
            if (lines.length > 0) { apiKeyWarnings.set(item.id, lines); }
        }
        autoSend = qm.autoSendEnabled;
        autoStart = qm.autoStartEnabled;
        autoPause = qm.autoPauseEnabled;
        autoContinue = qm.autoContinueEnabled;
        responseTimeoutMinutes = qm.responseFileTimeoutMinutes;
        defaultReminderTemplateId = qm.defaultReminderTemplateId;
        queueDefaultTransport = qm.defaultTransport;
        queueDefaultAnthropicProfileId = qm.defaultAnthropicProfileId || '';
        queueDefaultMessageTemplateId = qm.defaultMessageTemplateId || '';
        queueDefaultSession = qm.defaultAgentSdkSession || '';
        sessionInfo = sessionInfoOf(listSessions(sessionsFolder(WsPaths.getWorkspaceQuestId())));
        console.log('[QueueEditor] buildState: items count =', items.length);
    } catch (e) {
        console.error('[QueueEditor] buildState: PromptQueueManager not ready:', e);
    }

    try {
        const rs = ReminderSystem.instance;
        templates = rs.templates.map(t => ({ id: t.id, name: t.name }));
    } catch { /* not ready */ }

    let quest = '';
    let role = '';
    let activeProjects: string[] = [];
    try {
        const store = ChatVariablesStore.instance;
        quest = store.quest || '';
        role = store.role || '';
        activeProjects = store.activeProjects || [];
    } catch { /* */ }

    let questRefreshActive = false;
    try {
        questRefreshActive = QuestRefreshService.instance.isRefreshing;
    } catch { /* service not ready */ }

    let promptTemplates: string[] = [];
    // `noApiKey`: a direct-API profile whose key variable is not in this VS
    // Code's environment (the pickers mark it, as the host-rendered ones do).
    let anthropicProfiles: Array<{ id: string; name?: string; noApiKey?: boolean }> = [];
    let defaultProfileNoApiKey = false;
    let anthropicConfigs: Array<{ id: string; name?: string; transport?: string }> = [];
    try {
        const config = loadSendToChatConfig();
        // The Copilot template dropdowns: the one template store, by id.
        promptTemplates = userMessageTemplateOptions(config).map((t) => t.id);
        // Anthropic profiles + configurations (spec §4.10). Also
        // surface Local LLM configurations per §4.3 so the queue
        // editor's config dropdown shows every option a profile
        // could reference. Tagged by backing type so the rendered
        // label stays unambiguous.
        const keyless = new Map(profileKeyStates(config?.anthropic, process.env).map((k) => [k.id, k.noApiKey]));
        anthropicProfiles = (config?.anthropic?.profiles || [])
            .filter((p) => !!p && typeof p.id === 'string')
            .map((p) => ({ id: p.id, name: p.name, noApiKey: keyless.get(p.id) === true }));
        defaultProfileNoApiKey = !!missingDirectApiKey(config?.anthropic, {}, process.env);
        anthropicConfigs = [
            ...((config?.anthropic?.configurations || [])
                .filter((c) => !!c && typeof c.id === 'string')
                .map((c) => ({ id: c.id, name: c.name, transport: c.transport || 'direct' }))),
            ...(((config as { localLlm?: { configurations?: Array<{ id?: string; name?: string }> } }).localLlm?.configurations || [])
                .filter((c) => !!c && typeof c.id === 'string')
                .map((c) => ({ id: c.id as string, name: c.name, transport: 'localLlm' }))),
        ];
    } catch { /* */ }

    return {
        type: 'state',
        // A plain array for serialisation; an item a missing API key would make fail carries the reason.
        // The process position an item belongs to is shown on it, as text.
        items: items.map((item) => {
            const processPosition = processPositionOf(item);
            const extra = {
                ...(apiKeyWarnings.has(item.id) ? { apiKeyWarnings: apiKeyWarnings.get(item.id) } : {}),
                ...(processPosition ? { processPosition } : {}),
                // The tokens the item's stages used in this run, summed (input / output / cache read / cache write).
                ...(item.sendUsage ? { sendUsageLine: itemUsageSummaryLine(item.sendUsage) } : {}),
                // Directly under a running loop: Send next means "send between iterations".
                ...(runningLoopAbove(items, item.id) ? { canSendBetween: true } : {}),
                // Its text is open for editing: the queue waits for it.
                ...(isTextBeingEdited(item.id) ? { textEditing: true } : {}),
                // A chat send runs in its session: it waits for the session.
                ...(waitingForSessionOf(item) ? { waitingForSession: waitingForSessionOf(item) } : {}),
                // A chat send whose send still runs (Remove stops it).
                ...(item.status === 'chat' && chatSendAlive(item) ? { chatActive: true } : {}),
                // Its running prompt waits for the user: a question or an approval is open.
                ...(waitingForUserOf(item) ? { waitingForUser: waitingForUserOf(item) } : {}),
                // Its turn waits in a tomAi_askUser question: since when (and the Open question button).
                ...(pendingQuestionLabelOf(item) ? { pendingQuestionSince: pendingQuestionLabelOf(item) } : {}),
                // Its turn waits for its background work: the line, the limit and the running tasks (the ? list).
                ...(backgroundWaitViewOf(item) ? { backgroundWaitView: backgroundWaitViewOf(item) } : {}),
                // The todos it runs: a walk queued before items carried the field shows it too.
                ...(!item.todoIdPattern && todoIdPatternOf(item) ? { todoIdPattern: todoIdPatternOf(item) } : {}),
            };
            return Object.keys(extra).length ? { ...item, ...extra } : item;
        }),
        autoSend,
        autoStart,
        autoPause,
        autoContinue,
        responseTimeoutMinutes,
        defaultReminderTemplateId,
        reminderTemplates: templates,
        promptTemplates,
        // The compaction / memory-extraction model pickers above the queue,
        // the same state as the Status Page's History Compaction dropdowns.
        compactionPickers: (() => {
            try { return compactionPickerState(loadSendToChatConfig() as unknown as CompactionPickerConfig); } catch { return undefined; }
        })(),
        anthropicProfiles,
        defaultProfileNoApiKey,
        anthropicConfigs,
        // Anthropic user-message templates — surfaced so the queue
        // editor's add-form can offer them when the effective
        // transport is Anthropic (spec §4.16 template filter).
        anthropicUserMessageTemplates: (() => {
            try {
                const cfg = loadSendToChatConfig();
                const arr = (cfg?.anthropic?.userMessageTemplates || []).filter(
                    (t) => !!t && typeof t.id === 'string',
                );
                return arr.map((t) => ({ id: t.id, name: t.name || t.id }));
            } catch { return []; }
        })(),
        // Queue-level default transport (spec §4.10 header row).
        queueDefaultTransport,
        queueDefaultAnthropicProfileId,
        queueDefaultMessageTemplateId,
        queueDefaultSession,
        sessionInfo,
        collapsedIds: Array.from(_collapsedItemIds),
        context: { quest, role, activeProjects },
        // Each run's context for its tab's links: position, role, chat variables (vscimpb60c).
        runContexts: runContextsFor(items),
        // Drives the webview's orange "Quest refresh is running…" banner
        // between the queue header and the first item.
        questRefreshActive,
        // The quest's process runs (the run filter, Group by run, the add form's run) and the window's.
        ...queueRunState(),
        // Queue per run: the setting, the held runs and each lane (empty while it is off).
        ...queueLaneState(),
    };
}

/** The quest's process runs and the window's current run, for the run filter and the add form. */
/** A run's context as its tab's links show it: the process position, the role its step names, its chat variables. */
export interface QueueRunContext {
    run: string;
    process: string;
    position: string;
    role: string;
    /** Its custom chat variables (its run parameters). */
    variables: Record<string, string>;
    /** Its process state file, absolute; `''` without a quest. */
    stateFile: string;
}

/** The context of `run`, read without moving anything (ProcessStateStore.runOverview, ChatVariablesStore.withRun). */
export function runContextOf(run: string): QueueRunContext {
    const out: QueueRunContext = { run, process: '', position: '', role: '', variables: {}, stateFile: '' };
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        if (store) {
            const o = store.runOverview(run);
            Object.assign(out, { process: o.process, position: o.position, role: o.role, stateFile: o.stateFile });
        }
    } catch { /* the process store is not there */ }
    try {
        const chat = ChatVariablesStore.instance;
        out.variables = chat.withRun(run, () => ({ ...chat.custom }));
    } catch { /* the chat variables are not there */ }
    return out;
}

/** The context of every tab's run: the quest's runs and any an item belongs to. */
function runContextsFor(items: readonly QueuedPrompt[]): Record<string, QueueRunContext> {
    const runs = new Set<string>(['default', ...queueRunState().processRuns]);
    for (const i of items) { runs.add(i.processRun?.run ?? i.run ?? 'default'); }
    const out: Record<string, QueueRunContext> = {};
    for (const run of runs) { out[run] = runContextOf(run); }
    return out;
}

function queueRunState(): { processRuns: string[]; currentRun: string } {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        if (!store) { return { processRuns: ['default'], currentRun: 'default' }; }
        const runs = store.runs().map((r) => r.run);
        return { processRuns: runs.length ? runs : ['default'], currentRun: store.currentRun };
    } catch {
        return { processRuns: ['default'], currentRun: 'default' };
    }
}

/**
 * The lanes (one per run, always) with what each holds and whether its run is
 * paused, and the queue settings of each run (vscimpb60a): the editor shows
 * those of its settings run.
 */
function queueLaneState(): { heldRuns: string[]; lanes: LaneSummary[]; runQueueSettings: Record<string, unknown> } {
    try {
        const qm = PromptQueueManager.instance;
        const { processRuns } = queueRunState();
        const runQueueSettings: Record<string, unknown> = {};
        for (const run of new Set(['default', ...processRuns, ...qm.allRunQueueSettings().map((r) => r.run)])) {
            runQueueSettings[run] = qm.runQueueSettings(run);
        }
        return { heldRuns: [...qm.heldRuns], lanes: qm.laneSummaries(processRuns), runQueueSettings };
    } catch {
        return { heldRuns: [], lanes: [], runQueueSettings: {} };
    }
}

/** The run of the tab a toolbar action came from (`run`), undefined = the whole queue. */
function tabRunOf(msg: { run?: unknown }): string | undefined {
    return typeof msg.run === 'string' && msg.run.trim() ? msg.run.trim() : undefined;
}

/** The run the editor's toolbar settings are for (its Run filter, else the window's run), as the webview last said. */
let editorSettingsRun: string | undefined;

/** The run a settings message of the editor is for: its own `run`, else the editor's settings run; undefined = the window's run. */
function settingsRunOf(msg: { run?: unknown }): string | undefined {
    return typeof msg.run === 'string' && msg.run.trim() ? msg.run.trim() : editorSettingsRun;
}

/** Send the editor its state again (another view changed something it shows, e.g. the compaction models). */
export function refreshQueueEditorState(): void {
    sendState();
}

function sendState(): void {
    if (!_panel) { return; }
    const state = buildState();
    console.log('[QueueEditor] sendState posting to webview, items:', (state.items as unknown[]).length);
  _panel.webview.postMessage(state).then(
        ok => console.log('[QueueEditor] postMessage result:', ok),
        err => console.error('[QueueEditor] postMessage failed:', err),
    );
}


/** The add form's run: one of the quest's runs, else an error. */
function addFormRun(run: string): string {
    const { processRuns } = queueRunState();
    if (!processRuns.includes(run)) { throw new Error(`The quest has no run "${run}" (its runs: ${processRuns.join(', ')}).`); }
    return run;
}
