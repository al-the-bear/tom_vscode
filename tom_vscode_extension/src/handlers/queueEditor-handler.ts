/**
 * Prompt Queue Editor (§3.2)
 *
 * A command-opened webview panel that shows the ordered queue of
 * prompts.  Each item is editable with
 * status, expanded preview and reordering.
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
import { questShortDescription, windowWorkspaceQuests } from '../services/aiWorkspaceLive';
import { PromptQueueManager, QueuedPrompt, applyTemplateWrapping } from '../managers/promptQueueManager';
import * as questTodo from '../managers/questTodoManager';
import { SOFT_INTERRUPT_TIMEOUT_MS, type SoftInterruptState } from '../services/softInterrupt';
import type { LaneSummary } from '../utils/queueLanes';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig } from './handler_shared';
import { compactionPickItems, compactionPickerState, setCompactionModel, type CompactionPickerConfig } from '../utils/compactionTarget';
import { missingDirectApiKey, profileKeyStates } from '../utils/anthropicApiKeyCheck';
import { addUserMessageTemplate, deleteUserMessageTemplate, editUserMessageTemplate } from './userMessageTemplateActions';
import { userMessageTemplateOptions } from '../utils/userMessageTemplateLookup';
import { trackChatSend } from './chatQueueTracking';
import { itemProfileView, profilePickEntries, QUEUE_DEFAULT_PICK, type ConfigurationLike, type ItemProfileView, type ProfileLike } from '../utils/queueItemProfile';
import { normalizeRepeatCountInput } from '../utils/queueStep3Utils';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { QuestRefreshService } from '../services/quest-refresh-service';
import { ProcessStateStore } from '../managers/processStateStore';
import { positionText } from '../utils/processActionPrompt';
import { isLoopItem, runningLoopAbove } from '../utils/queueSendBetween';
import { itemUsageSummaryLine } from '../utils/usageCost';
import { repetitionAnswersFromTrail, walkPrefixOf } from '../utils/repetitionAnswers';
import { questPicks, runPicks, ALL_QUESTS_PICK } from '../utils/doneNotificationTargets';
import { ProcessRepository } from '../utils/processRepository';
import { continueOptions, continuePrompt, waitingSinceLabel, type ContinueAction } from '../utils/pendingQuestion';
import { backgroundWaitLine, formatLimit, listBackgroundWork } from '../utils/backgroundWait';
import type { UserWaitKind } from '../services/userWaits';
import { clockLabel, waitForLine, waitForUntilLabel } from '../utils/waitFor';
import { extractTodoRefsFromVariables, parseTodoRef } from '../utils/todoLogRefs';
import { questTrailFolder } from '../utils/questPaths';
import { hostTrailAnswerEntries, todoLogTrailSets } from '../utils/todoLogTrailSets';
import { readHostTrail } from '../services/hostTrail';
import * as path from 'path';
import { hostSlugOf } from '../utils/hostSlug';
import { discoverTrailSets, loadTrailSet } from './trailEditor-handler';
import { runQueueRemovalDialog, runQueueRemovalPlan, runQueueRemovalRefused } from '../utils/runQueueRemoval';
import { runChatSessionAction } from './chatPanel-handler';
import { isNightMode, onNightModeChange, setNightMode } from '../services/nightMode';
import { otherOpenWindows } from './aspectChoiceCommands';
import { sendWindowRequest, windowRequestsOwnWindow } from '../services/windowRequests';
import { DEFAULT_RUN_SESSION, runQueueSession, runSessionName, sessionBaseName } from '../utils/runSessions';
import { canRelocateQueueItem, iteratingSendingItem, queueStatusChoices, type LanePlace } from '../utils/queueStatusChange';
import { runDefaultFieldsOf, runDefaultPickerEntries, runDefaultsApplySummary, type RunDefaultField, type RunDefaultsMode } from '../utils/queueRunDefaultsApply';
import { waitMessageViews } from '../utils/itemWaitMessages';
import { answerItemAsk, itemAskViews } from '../services/queueItemAsks';
import { aspectPickerState } from '../services/aspectPickerState';
import { handleAspectPickerMessage } from './aspectPickerMessages';
import { openRecentPromptsPanel } from './recentPromptsPanel-handler';

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

/** The column the Prompt Queue editor is open in, when it is (the reload overlay opens over it, vscimpb142b). */
export function queueEditorViewColumn(): vscode.ViewColumn | undefined {
    return _panel?.viewColumn;
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
    // codicons stylesheet URI and the host-rendered add-form transport
    // picker travel the same way; main.js injects
    // them into the DOM. See media/queueEditor/index.html for the panel's
    // hand-written 'unsafe-inline' CSP (it keeps inline on*= handlers).
    const initialState = buildState();
    _panel.webview.html = loadWebviewHtml(_panel.webview, 'queueEditor', {
        init: {
            state: initialState,
            codiconsUri: webviewCodiconsUri.toString(),
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

    // Night mode (services/nightMode.ts): the headline button follows it, also when another window switched it.
    _nightModeListener?.dispose();
    _nightModeListener = onNightModeChange(() => sendState());

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

    // The todo lists of the walks (a GROUP item's members, a `<prefix>*` walk's todos) are read from the todo files:
    // when one changes — a todo finished, added, renumbered, cancelled or archived, in any window — draw them again.
    _todoFilesListener?.dispose();
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const todoPanel = require('./questTodoPanel-handler.js') as typeof import('./questTodoPanel-handler');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watcher = todoPanel.setupQuestTodoWatcher(() => {
            if (!hasWalkList()) { return; }
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(() => { timer = undefined; if (_panel === panel) { sendState(); } }, 800);
        });
        _todoFilesListener = watcher ? { dispose: () => { if (timer) { clearTimeout(timer); } watcher.dispose(); } } : undefined;
    } catch { /* no todo watcher: the lists follow the queue's own changes */ }

    _panel.onDidDispose(() => {
        _panel = undefined;
        // An edit left open in the closed editor would hold the queue for good.
        try { void PromptQueueManager.instance.endTextEdit(undefined); } catch { /* no queue */ }
        _todoFilesListener?.dispose();
        _todoFilesListener = undefined;
        _runsListener?.dispose();
        _runsListener = undefined;
        _queueListener?.dispose();
        _queueListener = undefined;
        _questRefreshListener?.dispose();
        _questRefreshListener = undefined;
        _nightModeListener?.dispose();
        _nightModeListener = undefined;
    });
}

let _nightModeListener: vscode.Disposable | undefined;
let _todoFilesListener: vscode.Disposable | undefined;

/** Whether an item of the queue lists the todos of its walk (a GROUP item, a `<prefix>*` walk) that is not done yet. */
function hasWalkList(): boolean {
    try {
        return PromptQueueManager.instance.items.some((i) => i.status !== 'sent' && i.status !== 'chat-sent' && typeof i.repeatCount === 'string'
            && (/\*\s*$/.test(i.repeatCount) || i.repeatCount.startsWith('group:')));
    } catch { return false; }
}

/**
 * The headline's night-mode button: on or off in this window, or in every open window of this machine (the
 * window request `setNightMode`). Night mode is the window-wide chat variable `night-mode`; the aspect
 * `night_mode` (Interaction level) sends its text while it is on.
 */
async function toggleNightModeFlow(): Promise<void> {
    const next = !isNightMode();
    const word = next ? 'on' : 'off';
    const picked = await vscode.window.showQuickPick([
        { label: `$(window) Night mode ${word} in this window`, all: false },
        { label: `$(multiple-windows) Night mode ${word} in every open window`, description: 'the other windows of this machine too', all: true },
    ], {
        title: next ? 'Night mode: work on without asking, record the decisions for the morning' : 'Night mode off: ask again when a decision is needed',
        placeHolder: 'Where',
    });
    if (!picked) { return; }
    await setNightMode(next);
    let others = 0;
    if (picked.all) {
        for (const windowId of otherOpenWindows(windowRequestsOwnWindow())) {
            if (sendWindowRequest(windowId, { type: 'setNightMode', on: next })) { others++; }
        }
    }
    vscode.window.setStatusBarMessage(`$(${next ? 'moon' : 'sun'}) Night mode ${word}${picked.all ? ` here and in ${others} other window${others === 1 ? '' : 's'}` : ' in this window'}`, 5000);
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
    // The guideline picker (gsel5): the window, all windows, a run, an item; the quest default.
    // A change redraws this editor and the todo views itself (aspectViewsRefresh.ts).
    const aspect = await handleAspectPickerMessage(msg);
    if (aspect.handled) { return; }
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
        case 'toggleNightMode':
            await toggleNightModeFlow();
            sendState();
            break;
        case 'pickCompactionModel': {
          // The label-less model buttons above the queue (gsel22): VS Code's picker, then the same write as setCompactionModel.
          const purpose = msg.purpose === 'memory' ? 'memory' : 'compaction';
          const config = loadSendToChatConfig();
          if (!config) { return; }
          const items = compactionPickItems(compactionPickerState(config as unknown as CompactionPickerConfig), purpose);
          const picked = await vscode.window.showQuickPick(items, {
            title: purpose === 'compaction' ? 'Compaction model' : 'Memory extraction model',
            placeHolder: purpose === 'compaction' ? 'The model that compacts the history (also on the Status Page, History Compaction)' : 'The model that extracts memory (also on the Status Page, History Compaction)',
          });
          if (picked && setCompactionModel(config as unknown as CompactionPickerConfig, purpose, picked.value)) {
            saveSendToChatConfig(config);
            const { refreshStatusPage } = await import('./statusPage-handler.js');
            await refreshStatusPage();
          }
          sendState();
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
        case 'pickQueueDefaultProfile':
        case 'pickQueueDefaultTemplate': {
          // The context bar's Profile and Template: a VS Code picker each, for the tab's run.
          const pqm = PromptQueueManager.instance;
          const run = settingsRunOf(msg);
          const s = pqm.runQueueSettings(run);
          const config = loadSendToChatConfig();
          const mark = (on: boolean) => (on ? '$(check) ' : '');
          if (msg.type === 'pickQueueDefaultProfile') {
            const keyless = new Map(profileKeyStates(config?.anthropic, process.env).map((k) => [k.id, k.noApiKey]));
            const current = s.defaultAnthropicProfileId ?? '';
            const picked = await vscode.window.showQuickPick([
              { label: `${mark(!current)}(default profile)`, value: '', description: 'the profile marked as default' },
              ...(config?.anthropic?.profiles ?? []).filter((p) => !!p && typeof p.id === 'string').map((p) => ({
                label: `${mark(p.id === current)}${p.name || p.id}`, value: p.id,
                description: [p.name && p.name !== p.id ? p.id : '', keyless.get(p.id) ? 'no API key in this window' : ''].filter(Boolean).join(' · '),
              })),
            ], { title: `Default profile of run ${run ?? 'default'}`, placeHolder: `Current: ${current || '(default profile)'}` });
            // A picked profile derives its configuration (none kept from the old one).
            if (picked && picked.value !== current) { pqm.setDefaultTransport('anthropic', picked.value, undefined, run); }
          } else {
            const current = s.defaultMessageTemplateId ?? '';
            const picked = await vscode.window.showQuickPick([
              { label: `${mark(!current)}(none)`, value: '', description: 'no template' },
              ...userMessageTemplateOptions(config).map((t) => ({ label: `${mark(t.id === current)}${t.label}`, value: t.id, description: t.label !== t.id ? t.id : '' })),
            ], { title: `Default template of run ${run ?? 'default'}`, placeHolder: `Current: ${current || '(none)'}` });
            if (picked && picked.value !== current) { pqm.setDefaultMessageTemplate(picked.value, run); }
          }
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

        case 'pickQueueDefaultRole':
        case 'editItemRole': {
          // The role of one item (its chip), or the run's default role (the context bar), gsel3.
          const pqm = PromptQueueManager.instance;
          const roles = listRoleNames(WsPaths.ai('roles'));
          const isDefault = msg.type === 'pickQueueDefaultRole';
          const run = isDefault ? settingsRunOf(msg) : undefined;
          const id = !isDefault && typeof msg.id === 'string' ? msg.id : '';
          const item = id ? pqm.getById(id) : undefined;
          if (!isDefault && !item) { return; }
          const current = isDefault ? (pqm.runQueueSettings(run).defaultRole ?? '') : (item?.role ?? '');
          const picked = await vscode.window.showQuickPick(
            [
              ...(isDefault ? [] : [{ label: '$(circle-slash) Default role', role: '',
                description: 'the todo\'s, the step\'s or the run\'s default role' }]),
              ...roles.map((r) => ({ label: r, role: r, description: r === current ? '(current)' : '' })),
            ],
            { title: isDefault ? `Default role of run ${run ?? 'default'} in the prompt queue` : 'Role of this queue item', placeHolder: `Current: ${current || '(none)'}` },
          );
          if (!picked) { return; }
          if (isDefault) {
            pqm.setDefaultRole(picked.role, run);
          } else if (!pqm.updateItemRole(id, picked.role)) {
            void vscode.window.showWarningMessage('Only a staged or pending item can change its role.');
          }
          sendState();
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
              defaultLabel: `The queue default (${pqm.defaultAgentSdkSession || DEFAULT_RUN_SESSION})`,
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
        case 'pickItemProfile': {
          // The click on an item header's profile: any profile, whatever its transport.
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (id) { await pickItemProfile(id); sendState(); }
          return;
        }
        case 'editItemTransport':
        case 'editPrePromptTransport':
        case 'editFollowUpTransport': {
          // The per-item + per-stage profile override: the same QuickPick
          // flow (profile → configuration) whatever the scope; only the
          // manager method that commits the result differs.
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const pqm = PromptQueueManager.instance;
          const item = pqm.getById(id);
          if (!item) { return; }

          // The current stage's ids for "(current)" / "(default)" labelling.
          let currentProfile = item.anthropicProfileId;
          let currentConfig = item.anthropicConfigId;
          let scopeLabel = 'queue item';
          if (msg.type === 'editPrePromptTransport') {
            const ppIndex = typeof msg.index === 'number' ? msg.index : -1;
            const pp = item.prePrompts?.[ppIndex];
            if (!pp) { return; }
            currentProfile = pp.anthropicProfileId || currentProfile;
            currentConfig = pp.anthropicConfigId || currentConfig;
            scopeLabel = `pre-prompt #${ppIndex + 1}`;
          } else if (msg.type === 'editFollowUpTransport') {
            const followUpId = typeof msg.followUpId === 'string' ? msg.followUpId : '';
            const fu = item.followUps?.find((f) => f.id === followUpId);
            if (!fu) { return; }
            currentProfile = fu.anthropicProfileId || currentProfile;
            currentConfig = fu.anthropicConfigId || currentConfig;
            scopeLabel = `follow-up ${followUpId.slice(0, 8)}`;
          }

          const applyUpdate = (transport: 'anthropic' | undefined, profileId: string, configId: string): void => {
            if (msg.type === 'editItemTransport') {
              pqm.updateItemTransport(id, { transport, anthropicProfileId: profileId, anthropicConfigId: configId });
            } else if (msg.type === 'editPrePromptTransport') {
              const ppIndex = typeof msg.index === 'number' ? msg.index : -1;
              pqm.updatePrePrompt(id, ppIndex, { transport, anthropicProfileId: profileId, anthropicConfigId: configId });
            } else {
              const followUpId = typeof msg.followUpId === 'string' ? msg.followUpId : '';
              pqm.updateFollowUpPrompt(id, followUpId, { transport, anthropicProfileId: profileId, anthropicConfigId: configId });
            }
            sendState();
          };

          const cfg = loadSendToChatConfig();
          const profiles = (cfg?.anthropic?.profiles ?? []).filter((p) => !!p && typeof p.id === 'string');
          if (profiles.length === 0) {
            vscode.window.showWarningMessage('No Anthropic profiles defined. Create one in the Extension State Page first.');
            return;
          }
          const INHERIT = '\u0000inherit';
          const profilePickItems = [
            msg.type === 'editItemTransport'
              ? { label: 'Inherit (queue default)', value: INHERIT, description: 'No profile of its own: the run\'s default profile.' }
              : { label: 'Inherit from item', value: INHERIT, description: 'No profile of its own: the item\'s profile.' },
            ...profiles.map((p) => ({
              label: p.name || p.id,
              description: p.id === currentProfile ? '(current)' : p.isDefault ? '(default)' : '',
              value: p.id,
            })),
          ];
          const profilePick = await vscode.window.showQuickPick(profilePickItems, {
            placeHolder: `Profile for ${scopeLabel}`,
            ignoreFocusOut: true,
          });
          if (!profilePick) { return; }
          if (profilePick.value === INHERIT) {
            applyUpdate(undefined, '', '');
            return;
          }
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
              defaultLabel: `The queue default (${pqm.defaultAgentSdkSession || DEFAULT_RUN_SESSION})`,
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
            previewContent = await expandTemplate(previewContent);
            previewContent = await applyTemplateWrapping(previewContent, template);
            await showPreviewPanel('Queue Item Preview', previewContent);
            return;
        }
        case 'previewFollowUp': {
          const { showPreviewPanel } = await import('./handler_shared.js');
          const { expandTemplate } = await import('./promptTemplate.js');
          let previewContent = msg.text || '';
          const template = msg.template || '';
          previewContent = await expandTemplate(previewContent);
          previewContent = await applyTemplateWrapping(previewContent, template);
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
        case 'moveItemsToRun': {
            // The Move items overlay: the picked items into another run's queue, their own settings removed.
            const ids = Array.isArray(msg.ids) ? (msg.ids as unknown[]).map(String) : [];
            if (!ids.length || typeof msg.run !== 'string') { break; }
            const r = await qm.moveItemsToRun(ids, msg.run);
            const refused = r.refused.length ? `; not moved: ${r.refused.length} (${[...new Set(r.refused.map((x) => x.reason))].join('; ')})` : '';
            void vscode.window.showInformationMessage(`Moved ${r.moved.length} item${r.moved.length === 1 ? '' : 's'} to run ${r.run}: they follow its defaults (profile, session, role, template)${refused}.`);
            sendState();
            break;
        }
        case 'moveItemToRun': {
            // The run tag of a staged or pending item: pick another run of the quest, the item goes into its queue.
            const id = String(msg.id ?? '');
            const item = qm.getById(id);
            if (!item) { break; }
            const current = item.run ?? 'default';
            const { processRuns, currentRun } = queueRunState();
            const picks = processRuns.filter((r) => r !== current).map((r) => ({
                label: r,
                description: [r === currentRun ? 'this window\'s run' : '', r === 'default' ? 'the quest\'s own position' : ''].filter(Boolean).join(', ') || undefined,
            }));
            if (!picks.length) {
                vscode.window.showInformationMessage('The quest has no other run to move the item to (create one in the PROCESS view).');
                break;
            }
            const picked = await vscode.window.showQuickPick(picks, { title: `Move the item from run ${current} to`, placeHolder: 'The item goes to the end of that run\'s queue' });
            if (!picked) { break; }
            const r = qm.moveItemToRun(id, picked.label);
            if (!r.ok) { vscode.window.showInformationMessage(`Move to another run: ${r.reason}.`); }
            sendState();
            break;
        }
        case 'removeRunQueue': {
            // The remove button of a deleted run's tab (vscimpb86): confirmed here, removed by the manager.
            const run = String(msg.run ?? '');
            const refused = runQueueRemovalRefused(run, queueRunState().processRuns);
            if (refused) { vscode.window.showInformationMessage(`Remove the run's queue: ${refused}.`); sendState(); break; }
            const plan = runQueueRemovalPlan(qm.items, run);
            if (plan.total === 0) { sendState(); break; }
            const dialog = runQueueRemovalDialog(plan);
            const picked = await vscode.window.showWarningMessage(dialog.message, { modal: true, detail: dialog.detail }, ...dialog.choices.map((c) => c.label));
            const choice = dialog.choices.find((c) => c.label === picked);
            if (!choice) { break; }
            // The run may have been created again while the dialog was open: then it keeps its queue.
            const late = runQueueRemovalRefused(run, queueRunState().processRuns);
            if (late) { vscode.window.showInformationMessage(`Remove the run's queue: ${late}.`); sendState(); break; }
            const r = qm.removeRunQueue(run, choice.mode);
            vscode.window.setStatusBarMessage(`$(trash) Run ${run}: ${r.removed} item${r.removed === 1 ? '' : 's'} deleted${r.kept ? `, ${r.kept} kept` : ''}`, 4000);
            sendState();
            break;
        }
        case 'letNextGoFirst': {
            const r = qm.letNextGoFirst(String(msg.id ?? ''));
            if (!r.ok) {
                vscode.window.showInformationMessage(`Let the next item go first: ${r.reason}.`);
            } else if (r.mode === 'armed') {
                vscode.window.setStatusBarMessage('$(debug-step-over) The item lets the next one go first after its running iteration', 4000);
            }
            sendState();
            break;
        }
        case 'sendNow':
            await qm.sendNow(msg.id);
            break;
        case 'interruptWaitFor':
          // The waiting line's button: interrupt the turn's wait and move on (vscimpb82).
          if (!qm.interruptWaitFor(String(msg.id ?? ''))) { vscode.window.showInformationMessage('The item no longer waits.'); }
          break;
        case 'continueSending':
          // Continue asks first: Answer now / Resend this stage / Skip (vscimpb55).
          await continueWithChoice(qm, msg.id);
          break;
        case 'resendSendingStage':
          await resendRunningStage(qm, msg.id);
          break;
        case 'messageRunningItem': {
          // The speech bubble's message box: into the item's running Agent SDK prompt (a waiting turn takes it as the
          // wait panel's Message does). Shown as a chat send of source `update` that ends with its answer.
          const id = String(msg.id ?? '');
          const text = String(msg.text ?? '');
          if (qm.canMessageWaitingItem(id)) {
              const w = qm.messageWaitingItem(id, text);
              if (!w.ok) { vscode.window.showInformationMessage(`The message was not sent: ${w.reason}`); }
          } else {
              const r = qm.messageRunningItem(id, text);
              if (!r.ok) {
                  vscode.window.showInformationMessage(`The message was not sent: ${r.reason}`);
              } else {
                  void trackChatSend({ text: text.trim(), session: r.session, source: 'update' }, () => r.answer.then((answer) => ({ text: answer }))).catch(() => undefined);
              }
          }
          sendState();
          break;
        }
        case 'messageWaitingItem': {
          // A wait panel's message box (vscimpb173): straight to the item's own waiting turn.
          const r = qm.messageWaitingItem(String(msg.id ?? ''), String(msg.text ?? ''));
          if (!r.ok) { vscode.window.showInformationMessage(`The message was not sent: ${r.reason}`); }
          sendState();
          break;
        }
        case 'answerItemAsk': {
          // The item's ask panel (vscimpb173): answered as the user-input panel / picker / MD Browser answers it.
          const r = answerItemAsk(String(msg.id ?? ''), String(msg.askId ?? ''), (msg.response && typeof msg.response === 'object' ? msg.response : {}) as Record<string, unknown>);
          if (!r.ok) { vscode.window.showInformationMessage(r.reason); }
          sendState();
          break;
        }
        case 'openPendingQuestion':
          // What the item waits for (vscimpb81): the user-input panel on its run's tab, or its MD Browser.
          await vscode.commands.executeCommand('tomAi.showUserInteraction', { itemId: String(msg.id ?? '') });
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
        case 'openItemLiveTrail': {
          // The item headline's icon: the live trail of the session the item runs in (live MD Browser).
          const session = typeof msg.id === 'string' ? PromptQueueManager.instance.stageSessionOf(msg.id) : undefined;
          if (!session) { return; }
          await runChatSessionAction('liveTrail', session);
          return;
        }

        case 'setPauseAfter':
            qm.setPauseAfter(msg.id, !!msg.pauseAfter);
            break;
        case 'updateDoneNotification':
            qm.updateItemDoneNotification(String(msg.id), { prompt: String(msg.prompt ?? '') });
            break;
        case 'setDoneNotificationDisabled':
            qm.updateItemDoneNotification(String(msg.id), { disabled: !!msg.disabled });
            break;
        case 'pickDoneNotificationTarget': {
            // Where the done notification goes (vscimpb71): a quest, then one of its runs.
            const id = String(msg.id ?? '');
            const item = qm.getById(id);
            if (!item || item.status === 'sent') { break; }
            const ownQuest = WsPaths.getWorkspaceQuestId() || 'default';
            const questsDir = WsPaths.ai('quests');
            const allQuests = questsDir && fs.existsSync(questsDir)
                ? fs.readdirSync(questsDir).filter((q) => !q.startsWith('.') && fs.statSync(`${questsDir}/${q}`).isDirectory())
                : [];
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { liveQuestSendAccess } = require('../tools/chat-enhancement-tools') as typeof import('../tools/chat-enhancement-tools');
            const live = new Set(allQuests.filter((q) => q !== ownQuest && liveQuestSendAccess.liveWindows(q).length > 0));
            // The workspace's quests first (vscimpb144), All quests… for every quest.
            const ws = windowWorkspaceQuests();
            const pickOptions = { title: 'Post the done notification to the quest', placeHolder: `Now: ${item.doneNotificationQuest ?? ownQuest}` };
            // Each with its short description (vscimpb145).
            const describe = (q: string): string | undefined => questShortDescription(q)?.split('\n')[0];
            let quest = await vscode.window.showQuickPick(questPicks(ownQuest, allQuests, live, ws && ws.source !== 'all' ? ws.quests : undefined, describe), pickOptions);
            if (quest?.value === ALL_QUESTS_PICK) { quest = await vscode.window.showQuickPick(questPicks(ownQuest, allQuests, live, undefined, describe), pickOptions); }
            if (!quest) { break; }
            const targetQuest = quest.value || ownQuest;
            const processes = WsPaths.ai('processes');
            const runs = processes && questsDir
                ? new ProcessRepository(processes, questsDir).listRuns(targetQuest).map((r) => r.run)
                : ['default'];
            const run = await vscode.window.showQuickPick(runPicks(runs, targetQuest === ownQuest, item.run ?? 'default'), {
                title: `The run of ${targetQuest} it is queued in`, placeHolder: 'Its lane and its sessions (<session>@<run>)',
            });
            if (!run) { break; }
            qm.updateItemDoneNotification(id, { quest: quest.value, run: run.value });
            sendState();
            break;
        }
        case 'setItemStatus':
          if (msg.status === 'staged' || msg.status === 'pending') {
            qm.setStatus(msg.id, msg.status);
          }
          break;
        case 'pickItemStatus': {
            // The status label of an item: pending, staged or sent, as its state allows (utils/queueStatusChange.ts).
            const id = String(msg.id ?? '');
            const item = qm.getById(id);
            if (!item) { break; }
            const choices = queueStatusChoices(item.status);
            if (!choices.length) { break; }
            const running = ['sending', 'interrupted', 'todo-blocked', 'decision-needed'].includes(item.status);
            const picked = await vscode.window.showQuickPick(choices.map((c) => ({ label: c.label, description: c.detail, status: c.status })), {
                title: `The status of this item (now ${item.status})`,
                placeHolder: running ? 'Its running or held turn is stopped first' : 'Pick the status it takes',
            });
            if (!picked) { break; }
            const r = qm.changeItemStatus(id, picked.status);
            if (!r.ok) { void vscode.window.showInformationMessage(`Set the status: ${r.reason}.`); }
            sendState();
            break;
        }
        case 'relocateItem': {
            // The run or session chip of an item that is not sent: run, then session (or a new one), then the place.
            await relocateItemFlow(String(msg.id ?? ''));
            sendState();
            break;
        }
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
        case 'setGroupSelection': {
            // A GROUP item's member list (vscimpb129): one member's box, Select all, Reset to rules.
            const change = msg.all ? { all: true as const } : msg.rules ? { rules: true as const } : { member: String(msg.member), checked: msg.checked === true };
            qm.setGroupSelection(String(msg.id), change);
            break;
        }
        case 'updateItemTemplate':
            await qm.updateItemTemplate(msg.id, { template: msg.template });
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
        // Make default (vscimpb60g): the tab's shown settings become the top-level keys (the start values of new runs).
        case 'makeRunSettingsDefault': {
            const run = settingsRunOf(msg) ?? qm.windowRun;
            const changed = qm.setDefaultQueueSettings(run);
            vscode.window.setStatusBarMessage(changed.length
                ? `Prompt Queue: run ${run}'s settings are the default for new runs now (${changed.length} changed: ${changed.join(', ')})`
                : `Prompt Queue: run ${run}'s settings already are the default for new runs`, 8000);
            sendState();
            break;
        }
        // Apply run defaults to all items: the user picks which of profile, template, session and role, and
        // whether to set the run's default on every item or remove the items' own settings (utils/queueRunDefaultsApply.ts).
        case 'applyRunDefaultsToItems': {
            const run = settingsRunOf(msg) ?? qm.windowRun;
            const removeEntry = {
                label: '$(clear-all) Remove per-item settings',
                description: 'instead of setting the defaults: the items follow the run\'s defaults, now and when they change',
                remove: true as const,
            };
            const entries = runDefaultPickerEntries(qm.runQueueSettings(run), run).map((e) => ({ ...e, picked: true }));
            const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { field?: RunDefaultField; remove?: true }>(
                [...entries, { label: '', kind: vscode.QuickPickItemKind.Separator }, removeEntry],
                {
                    canPickMany: true,
                    title: `Apply run ${run}'s defaults to all items of its queue`,
                    placeHolder: 'Which settings? Staged and pending items change; items that already started stay as they are.',
                },
            );
            if (!picked) { return; }
            const fields = runDefaultFieldsOf(picked.map((p) => p.field));
            if (!fields.length) {
                void vscode.window.showInformationMessage('Nothing applied: no setting was picked (profile, template, session or role).');
                return;
            }
            const mode: RunDefaultsMode = picked.some((p) => p.remove) ? 'clear' : 'set';
            const result = await qm.applyRunDefaultsToItems(run, fields, mode);
            void vscode.window.showInformationMessage(runDefaultsApplySummary(result));
            sendState();
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
        case 'skipBlockedTodo': {
            // A held walk or GROUP item's Continue: the todo it waits at is skipped, the walk goes on.
            if (!qm.skipBlockedTodo(String(msg.id ?? ''))) { vscode.window.showInformationMessage('Nothing to continue: the item is no longer held at a blocked todo, or it runs a single todo.'); }
            sendState();
            break;
        }
        case 'runBlockedTodoAnyway': {
            // A held item's Run anyway: the todo it waits at runs without waiting for its blockers.
            if (!qm.runBlockedTodoAnyway(String(msg.id ?? ''))) { vscode.window.showInformationMessage('Nothing to run: the item is no longer held at a blocked todo.'); }
            sendState();
            break;
        }
        case 'cancelSoftInterrupt': {
            // The interruption panel's Cancel interruption: the turn goes on, as before the press.
            if (!qm.cancelSoftInterrupt(String(msg.id ?? ''))) { vscode.window.showInformationMessage('No interruption to cancel.'); }
            sendState();
            break;
        }
        case 'hardInterruptNow': {
            // The interruption panel's Hard interrupt now.
            if (!qm.interruptActiveItemForContinuation(String(msg.id ?? ''), undefined, { hard: true })) { vscode.window.showInformationMessage('No prompt is currently running.'); }
            sendState();
            break;
        }
        case 'updateItemRepeat':
          qm.updateRepeat(msg.id, {
            repeatCount: msg.repeatCount,
            repeatIndex: msg.repeatIndex,
            repeatPrefix: msg.repeatPrefix,
            repeatSuffix: msg.repeatSuffix,
            templateRepeatCount: msg.templateRepeatCount,
            templateRepeatIndex: msg.templateRepeatIndex,
          });
          break;
        case 'addPrompt':
            try {
                console.log('[QueueEditor] addPrompt received, text length:', msg.text?.length);
                await qm.enqueue({
                    originalText: msg.text || '',
                    template: msg.template,
                    repeatCount: normalizeRepeatCountInput(msg.repeatCount),
                    repeatPrefix: typeof msg.repeatPrefix === 'string' ? msg.repeatPrefix : undefined,
                    repeatSuffix: typeof msg.repeatSuffix === 'string' ? msg.repeatSuffix : undefined,
                    deferSend: true,
                    // The profile picked in the add form (none: the run's default).
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
          case 'openRecentPrompts': {
            // The Recent Prompts panel (recentPromptsPanel-handler): the last prompts this queue sent.
            if (_ctx) { openRecentPromptsPanel(_ctx); }
            return;
          }
    }
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
function waitingForUserOf(item: QueuedPrompt): UserWaitKind[] | undefined {
    // A running chat send waits like a queue item (vscimpb81): it shows the same indicator.
    if (item.status !== 'sending' && item.status !== 'chat') { return undefined; }
    try {
        const kinds = PromptQueueManager.instance.waitingForUserOf(item.id);
        return kinds.length ? kinds : undefined;
    } catch { return undefined; }
}

/** What the editor shows of a sending item's soft interrupt (vscimpb112): requested (with its timeout) or held. */
export function softInterruptViewOf(item: QueuedPrompt): { phase: 'requested' | 'held'; requestedAt: number; timeoutMs: number; heldAt?: number; kind?: string; tool?: string; unlimited?: true } | undefined {
    if (item.status !== 'sending') { return undefined; }
    let state: SoftInterruptState | undefined;
    try { state = PromptQueueManager.instance.softInterruptOf(item.id); } catch { state = undefined; }
    state ??= item.softInterrupt;
    if (!state) { return undefined; }
    return {
        phase: state.heldAt !== undefined ? 'held' : 'requested',
        requestedAt: state.requestedAt,
        timeoutMs: SOFT_INTERRUPT_TIMEOUT_MS,
        ...(state.heldAt !== undefined ? { heldAt: state.heldAt } : {}),
        ...(state.kind ? { kind: state.kind } : {}),
        ...(state.tool ? { tool: state.tool } : {}),
        ...(state.unlimited ? { unlimited: true as const } : {}),
    };
}

/** The question a sending item's turn waits in: its first line and since when (the ❓ tooltip, vscimpb112). */
function questionViewOf(item: QueuedPrompt): { firstLine: string; since: string } | undefined {
    if (item.status !== 'sending') { return undefined; }
    try {
        const q = PromptQueueManager.instance.pendingQuestionOf(item.id);
        return q ? { firstLine: q.firstLine || '(a question)', since: new Date(q.askedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } : undefined;
    } catch { return undefined; }
}

/** The profiles and configurations the item headers and the profile picker name. */
function profileCatalogue(): { profiles: ProfileLike[]; configurations: ConfigurationLike[] } {
    try {
        const config = loadSendToChatConfig();
        const profiles = (config?.anthropic?.profiles ?? []).filter((p) => !!p && typeof p.id === 'string') as ProfileLike[];
        const configurations: ConfigurationLike[] = [
            ...((config?.anthropic?.configurations ?? []).filter((c) => !!c && typeof c.id === 'string')
                .map((c) => ({ id: c.id, name: c.name, model: c.model, transport: c.transport || 'direct' }))),
            ...(((config as { localLlm?: { configurations?: Array<{ id?: string; name?: string; model?: string }> } } | null)?.localLlm?.configurations ?? [])
                .filter((c) => !!c && typeof c.id === 'string').map((c) => ({ id: c.id as string, name: c.name, model: c.model, transport: 'localLlm' }))),
        ];
        return { profiles, configurations };
    } catch { return { profiles: [], configurations: [] }; }
}

/** What an item's header shows for its profile (src/utils/queueItemProfile.ts); undefined for a marker. A chat send names the profile it was sent with, without a click. */
function profileViewOf(item: QueuedPrompt, catalogue: { profiles: ProfileLike[]; configurations: ConfigurationLike[] }): ItemProfileView | undefined {
    if (item.processMove) { return undefined; }
    let resolved: { transport: string; anthropicProfileId?: string } | undefined;
    try { resolved = PromptQueueManager.instance.resolvedProfileOf(item.id); } catch { /* not ready */ }
    return itemProfileView({
        status: item.status, ownTransport: item.transport, ownProfileId: item.anthropicProfileId,
        resolved: resolved ?? { transport: 'anthropic', anthropicProfileId: item.anthropicProfileId },
        ...catalogue,
    });
}

/**
 * The profile picker of an item's header: every profile, whatever its
 * transport. A profile that cannot continue the conversation of the item's
 * session is offered with the queue's default session instead (asked first).
 */
export async function pickItemProfile(id: string): Promise<void> {
    const pqm = PromptQueueManager.instance;
    const item = pqm.getById(id);
    if (!item) { return; }
    const catalogue = profileCatalogue();
    const view = profileViewOf(item, catalogue);
    if (!view?.canPick) { return; }
    if (catalogue.profiles.length === 0) {
        void vscode.window.showWarningMessage('No profiles are defined. Create one in the template editor (Anthropic profiles) first.');
        return;
    }
    const picked = await vscode.window.showQuickPick(profilePickEntries(catalogue.profiles, catalogue.configurations, view), {
        title: 'Profile of this queue item',
        placeHolder: view.own ? `Its profile: ${view.name}` : `No profile of its own — it runs with ${view.name}`,
        matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true,
    });
    if (!picked) { return; }
    const profileId = picked.value === QUEUE_DEFAULT_PICK ? undefined : picked.value;
    let result = pqm.setItemProfile(id, profileId);
    if (!result.ok && result.sessionMismatch) {
        const useDefault = 'Use the default session';
        const answer = await vscode.window.showWarningMessage(
            `Profile "${picked.label}" cannot continue session "${result.sessionMismatch}".`,
            { modal: true, detail: `${result.reason}\n\nThe item can run with this profile in the queue's default session instead.` },
            useDefault,
        );
        if (answer !== useDefault) { return; }
        result = pqm.setItemProfile(id, profileId, { defaultSession: true });
    }
    if (!result.ok) { void vscode.window.showWarningMessage(`The profile was not changed: ${result.reason}.`); }
}

/** The transport of a sending item's stage. */
/**
 * The speech bubble of a sending item: whether a message can go into its running prompt (an Agent SDK query
 * runs in its session, or its turn waits and takes one), else why not (the bubble's tooltip).
 */
function runningMessageOf(item: QueuedPrompt): { canMessageRunning: true } | { runningMessageUnavailable: string } | Record<string, never> {
    if (item.status !== 'sending') { return {}; }
    try {
        const qm = PromptQueueManager.instance;
        if (qm.canMessageRunningItem(item.id) || qm.canMessageWaitingItem(item.id)) { return { canMessageRunning: true }; }
        return {
            runningMessageUnavailable: 'only an Agent SDK prompt takes a message while it runs, and none runs in its session now (another transport, or between two stages)',
        };
    } catch { return {}; }
}

/** The question a sending item's turn waits in: when it was asked, as a label. */
/** Whether a message can be written to the item's waiting turn now (vscimpb173). */
function canMessageWaitOf(item: QueuedPrompt): boolean {
    if (item.status !== 'sending') { return false; }
    try { return PromptQueueManager.instance.canMessageWaitingItem(item.id); } catch { return false; }
}

function pendingQuestionLabelOf(item: QueuedPrompt): string | undefined {
    if (item.status !== 'sending') { return undefined; }
    try {
        const q = PromptQueueManager.instance.pendingQuestionOf(item.id);
        return q ? waitingSinceLabel(q.askedAt, Date.now()) : undefined;
    } catch { return undefined; }
}

/** The button's state on `item` (vscimpb60e): shown on pending / sending iteration items, with why it is disabled. */
function letNextGoFirstStateOf(item: QueuedPrompt): { canLetNextGoFirst?: boolean; letNextGoFirstUnavailable?: string } {
    if (item.status !== 'pending' && item.status !== 'sending') { return {}; }
    if (!isLoopItem(item)) { return {}; }
    try {
        const why = PromptQueueManager.instance.letNextGoFirstUnavailable(item.id);
        return why ? { canLetNextGoFirst: false, letNextGoFirstUnavailable: why } : { canLetNextGoFirst: true };
    } catch {
        return {};
    }
}

/**
 * Continue on a sending item: never blindly. The user picks Answer now (only
 * while its turn waits for an answer), Resend this stage or Skip; dismissing
 * the dialog does nothing.
 */
export async function continueWithChoice(qm: PromptQueueManager, id: string): Promise<void> {
    const item = qm.getById(id);
    if (!item || item.status !== 'sending') { return; }
    // A held item (vscimpb112): Resume or Hard interrupt, nothing else.
    const soft = qm.softInterruptOf(id) ?? item.softInterrupt;
    if (soft) {
        const choice = await vscode.window.showWarningMessage(
            soft.heldAt !== undefined ? 'The prompt is held for continuation.' : 'A soft interrupt is requested for this prompt.',
            { modal: true, detail: 'Resume: the held result goes back to the turn and it goes on where it stopped (auto-send of its run comes back on). Hard interrupt: the turn ends now; the prompt is resent, with a note, when auto-send is re-enabled.' },
            'Resume', 'Hard interrupt',
        );
        if (choice === 'Resume') { qm.resumeHeldItem(id); }
        if (choice === 'Hard interrupt') { qm.interruptActiveItemForContinuation(id, undefined, { hard: true }); }
        return;
    }
    const question = qm.pendingQuestionOf(id);
    const walk = walkPrefixOf(item) !== undefined;
    const background = qm.backgroundWaitOf(id);
    const waitFor = qm.waitForOf(id);
    const options = continueOptions({
        waitingForAnswer: question !== undefined,
        canResend: item.lastDispatched !== undefined,
        walk,
        // "Let the next item go first" (vscimpb60e): an iteration item with a following item in its lane.
        canLetNextGoFirst: isLoopItem(item) && !qm.letNextGoFirstUnavailable(id),
        yieldArmed: item.yieldAfterIteration === true,
        ...(background ? { backgroundLimit: formatLimit(background.limitMinutes) } : {}),
        waitingFor: waitFor !== undefined,
        canMessage: qm.canMessageWaitingItem(id),
        canAnswerHere: question !== undefined,
    });
    const text = continuePrompt({
        waitingSince: question ? waitingSinceLabel(question.askedAt, Date.now()) : undefined,
        walk,
        ...(background ? { backgroundWait: backgroundWaitLine(background, Date.now()) } : {}),
        ...(waitFor ? { waitingFor: waitForLine(waitFor, Date.now()) } : {}),
    });
    const picked = await vscode.window.showWarningMessage(text.message, { modal: true, detail: text.detail }, ...options.map((o) => o.label));
    const action: ContinueAction | undefined = options.find((o) => o.label === picked)?.action;
    if (!action) { return; }
    if (action === 'answer') {
        await vscode.commands.executeCommand('tomAi.showUserInteraction', { itemId: id });
        return;
    }
    if (action === 'answerHere' && question) {
        // The same answer the user-input panel's Submit sends, typed here (vscimpb173).
        const text = await vscode.window.showInputBox({ title: question.title ?? 'Answer the question', prompt: question.firstLine, ignoreFocusOut: true });
        if (text === undefined) { return; }
        const r = answerItemAsk(id, question.requestId, { type: 'submit', requestId: question.requestId, text });
        if (!r.ok) { vscode.window.showInformationMessage(r.reason); }
        return;
    }
    if (action === 'message') {
        const text = await vscode.window.showInputBox({ title: 'Message to the waiting turn', prompt: 'The agent gets it at once, answers, and goes on waiting.', ignoreFocusOut: true });
        if (text === undefined || text.trim() === '') { return; }
        const r = qm.messageWaitingItem(id, text);
        if (!r.ok) { vscode.window.showInformationMessage(`The message was not sent: ${r.reason}`); }
        return;
    }
    if (action === 'waitWithoutLimit') { qm.waitWithoutLimit(id); return; }
    if (action === 'keepWaiting') { qm.keepWaitingForBackground(id); return; }
    if (action === 'stopWaiting') { qm.stopBackgroundWait(id); return; }
    if (action === 'keepWaitingFor') { return; }
    if (action === 'interruptWaitFor') {
        if (!qm.interruptWaitFor(id)) { vscode.window.showInformationMessage('The item no longer waits.'); }
        return;
    }
    if (action === 'letNextGoFirst') {
        const r = qm.letNextGoFirst(id);
        if (!r.ok) { vscode.window.showInformationMessage(`Let the next item go first: ${r.reason}.`); }
        return;
    }
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

/**
 * A todo's `role` by quest and id, each quest's todos read once (gsel11: the
 * role chips of one state). Archived and deleted todos are read too, as the
 * queue reads them when it sends.
 */
export function cachedTodoRoles(): (quest: string, id: string) => string | undefined {
    const byQuest = new Map<string, Map<string, string>>();
    return (quest, id) => {
        let roles = byQuest.get(quest);
        if (!roles) {
            roles = new Map();
            try {
                for (const t of questTodo.readAllTodos(quest, questTodo.ALL_TODO_FILES)) { if (t.role) { roles.set(t.id, t.role); } }
            } catch { /* no todos */ }
            byQuest.set(quest, roles);
        }
        return roles.get(id);
    };
}

/** What the editor shows of a sending item's wait in tomAi_waitFor (vscimpb82), or undefined when it does not wait. */
export function waitForViewOf(item: QueuedPrompt, now = Date.now()): { reason: string; details?: string; until: string; untilLabel: string; left: string; since: string } | undefined {
    if (item.status !== 'sending' || !item.waitingFor) { return undefined; }
    const w = item.waitingFor;
    const until = Date.parse(w.until);
    return {
        reason: w.reason,
        ...(w.details ? { details: w.details } : {}),
        until: w.until,
        untilLabel: Number.isFinite(until) ? clockLabel(until, now) : w.until,
        left: waitForUntilLabel(w, now),
        since: w.since,
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
/** A GROUP item's members as the item's member list shows them (utils/groupItemSelection.ts); undefined otherwise. */
function groupMembersOf(item: { id: string }): unknown[] | undefined {
    try { return PromptQueueManager.instance.groupMembers(item.id); } catch { return undefined; }
}

function backfillSentWalkAnswers(qm: PromptQueueManager): void {
    const due = qm.items.filter((i) => i.status === 'sent' && !i.repetitionAnswers?.length && walkPrefixOf(i) && !repetitionBackfillTried.has(i.id));
    if (due.length === 0) { return; }
    for (const i of due) { repetitionBackfillTried.add(i.id); }
    const quest = WsPaths.getWorkspaceQuestId();
    const folder = quest ? questTrailFolder(WsPaths.ai('quests', quest) || '') : '';
    if (!folder || !fs.existsSync(folder)) { return; }
    let entries: Array<{ type: string; timestamp: string; content: string; variables?: string }> = [];
    try {
        // This host's trail, and the summary pairs of the other subsystems.
        const sets = todoLogTrailSets(folder, discoverTrailSets);
        entries = [...hostTrailAnswerEntries(readHostTrail(path.dirname(folder), hostSlugOf())), ...[...sets.keys()].flatMap((name) => loadTrailSet(name, sets))];
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
        queueDefaultAnthropicProfileId = qm.defaultAnthropicProfileId || '';
        queueDefaultMessageTemplateId = qm.defaultMessageTemplateId || '';
        queueDefaultSession = qm.defaultAgentSdkSession || '';
        sessionInfo = sessionInfoOf(listSessions(sessionsFolder(WsPaths.getWorkspaceQuestId())));
        console.log('[QueueEditor] buildState: items count =', items.length);
    } catch (e) {
        console.error('[QueueEditor] buildState: PromptQueueManager not ready:', e);
    }

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
        // The template dropdowns: the one template store, by id.
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

    const catalogue = profileCatalogue();
    // The role chip (gsel11): each quest's todos read once for this state.
    const todoRoleOf = cachedTodoRoles();
    return {
        type: 'state',
        // A plain array for serialisation; an item a missing API key would make fail carries the reason.
        // The process position an item belongs to is shown on it, as text.
        items: items.map((item) => {
            const processPosition = processPositionOf(item);
            const profileView = profileViewOf(item, catalogue);
            const extra = {
                // The profile it runs with: its own (a clickable name) or the default's (an icon button).
                ...(profileView ? { profileView } : {}),
                ...(apiKeyWarnings.has(item.id) ? { apiKeyWarnings: apiKeyWarnings.get(item.id) } : {}),
                ...(processPosition ? { processPosition } : {}),
                // The tokens the item's stages used in this run, summed (input / output / cache read / cache write).
                ...(item.sendUsage ? { sendUsageLine: itemUsageSummaryLine(item.sendUsage) } : {}),
                // Directly under a running loop: Send next means "send between iterations".
                ...(runningLoopAbove(items, item.id) ? { canSendBetween: true } : {}),
                // "Let the next item go first" (vscimpb60e): offered on a pending / sending iteration item;
                // why not, when it cannot (no following item in its lane), for the disabled button's tooltip.
                ...(letNextGoFirstStateOf(item)),
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
                // Its turn waits in tomAi_waitFor: the reason, until when, how long is left (vscimpb82).
                ...(waitForViewOf(item) ? { waitForView: waitForViewOf(item) } : {}),
                // What the user wrote to its waiting turn from the item, and whether a message can be written now (vscimpb173).
                // Kept after the item ended too: the messages written into its running prompt stay listed with their answers.
                ...(item.waitMessages?.length ? { waitMessagesView: waitMessageViews(item.waitMessages) } : {}),
                // The speech bubble writes into its running prompt, or says why it cannot.
                ...runningMessageOf(item),
                ...(canMessageWaitOf(item) ? { canMessageWait: true } : {}),
                // What its turn asks (questions, pickers, MD Browser asks): answered in the item's ask panel (vscimpb173).
                ...(item.status === 'sending' && itemAskViews(item.id).length ? { askViews: itemAskViews(item.id) } : {}),
                // Interrupt for continuation (vscimpb112): the soft interrupt's request or hold, the question its
                // turn waits in (the ❓ tooltip).
                ...(softInterruptViewOf(item) ? { softInterruptView: softInterruptViewOf(item) } : {}),
                // A held item (todo-blocked): Continue (a walk or GROUP item) and Run anyway.
                ...(item.status === 'todo-blocked' ? { blockedActions: PromptQueueManager.instance.blockedItemActions(item.id) } : {}),
                ...(questionViewOf(item) ? { questionView: questionViewOf(item) } : {}),
                // The todos it runs: a walk queued before items carried the field shows it too.
                ...(!item.todoIdPattern && todoIdPatternOf(item) ? { todoIdPattern: todoIdPatternOf(item) } : {}),
                // A GROUP item's members with → / ✓ / checkbox (vscimpb129).
                ...(groupMembersOf(item) ? { groupMembers: groupMembersOf(item) } : {}),
                // The role it runs as and where it comes from: its todo's, its own, its step's, its run's default (gsel11).
                ...(item.processMove ? {} : { roleView: PromptQueueManager.instance.roleViewOf(item, todoRoleOf) }),
            };
            return Object.keys(extra).length ? { ...item, ...extra } : item;
        }),
        autoSend,
        autoStart,
        autoPause,
        autoContinue,
        promptTemplates,
        // The compaction / memory-extraction model pickers above the queue,
        // the same state as the Status Page's History Compaction dropdowns.
        // Night mode (services/nightMode.ts): the headline button's state.
        nightMode: isNightMode(),
        compactionPickers: (() => {
            try { return compactionPickerState(loadSendToChatConfig() as unknown as CompactionPickerConfig); } catch { return undefined; }
        })(),
        // The guideline picker's sections and shared levels (gsel5): the window's
        // buttons, the run's info line and each item's button resolve over them.
        aspects: (() => {
            try { return aspectPickerState(); } catch { return undefined; }
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

/**
 * Move an item to another run and session, and decide where it goes (the queue editor's run and session chips):
 * the run (the current one marked), then — on Anthropic — the session in that run (an existing one, the run's
 * queue default, or a new one created there), then the place in the run's lane: at the end, at the top, or next
 * (between the iterations of the run's iterating sending item, offered only while there is one). A changed
 * session is then offered to the run's other items not sent yet. A running or held item is stopped and goes on
 * as pending (PromptQueueManager.relocateItem).
 */
async function relocateItemFlow(id: string): Promise<void> {
    const qm = PromptQueueManager.instance;
    const item = qm.getById(id);
    if (!item) { return; }
    if (!canRelocateQueueItem(item.status)) { void vscode.window.showInformationMessage(`An item that is ${item.status} stays where it is.`); return; }
    if (item.processMove) { void vscode.window.showInformationMessage('A process-move marker stays with its Proceed run.'); return; }
    const current = item.run || item.processRun?.run || 'default';
    const { processRuns, currentRun } = queueRunState();
    let run = current;
    if (item.processRun) {
        void vscode.window.showInformationMessage(`The item belongs to the Proceed run ${current}: only its session and place can change.`);
    } else {
        const runPick = await vscode.window.showQuickPick(
            (processRuns.includes(current) ? processRuns : [current, ...processRuns]).map((r) => ({
                label: `${r === current ? '$(check) ' : ''}${r}`,
                description: [r === current ? 'its run now' : '', r === currentRun ? 'this window\'s run' : '', r === 'default' ? 'the quest\'s own position' : ''].filter(Boolean).join(', ') || undefined,
                run: r,
            })),
            { title: 'Move the item — 1. the run', placeHolder: `Now in run ${current}` },
        );
        if (!runPick) { return; }
        run = runPick.run;
    }
    const settings = qm.runQueueSettings(run);
    const transport = item.transport ?? settings.defaultTransport;
    const before = item.session;
    let session: string | undefined;
    if (transport === 'anthropic') {
        const queueDefault = runQueueSession(settings.defaultAgentSdkSession, run);
        const picked = await pickAgentSdkSession({
            questId: WsPaths.getWorkspaceQuestId(),
            current: item.session ? runSessionName(sessionBaseName(item.session), run) : undefined,
            run,
            title: `Move the item — 2. the session in run ${run}`,
            defaultLabel: `The run's queue default (${queueDefault})`,
        });
        if (picked === undefined) { return; }
        session = picked;
    }
    const lane = qm.items.filter((i) => i.id !== id).map((i) => ({ id: i.id, status: i.status, run: i.run || i.processRun?.run || 'default', iterates: isLoopItem(i) }));
    const loop = iteratingSendingItem(lane, run);
    const places: Array<vscode.QuickPickItem & { place: LanePlace }> = [
        { label: '$(list-ordered) At the end', description: `behind every item of run ${run}`, place: 'end' },
        { label: '$(arrow-up) At the top', description: `before the first item of run ${run} not being sent`, place: 'top' },
        ...(loop ? [{ label: '$(debug-step-over) Next, between iterations', description: `right after the running item ${loop.id}, before its next iteration`, place: 'next' as const }] : []),
    ];
    const placePick = await vscode.window.showQuickPick(places, { title: `Move the item — 3. its place in run ${run}`, placeHolder: 'Where it goes in the run\'s queue' });
    if (!placePick) { return; }
    const r = qm.relocateItem(id, { run, session, place: placePick.place });
    if (!r.ok) { void vscode.window.showInformationMessage(`Move the item: ${r.reason}.`); return; }
    // A changed session: the run's other items not sent yet too?
    if (session !== undefined && (session || undefined) !== before) {
        const others = qm.items.filter((i) => i.id !== id && (i.run || i.processRun?.run || 'default') === run && (i.status === 'staged' || i.status === 'pending'));
        if (others.length) {
            const label = session || `the run's queue default`;
            const all = await vscode.window.showQuickPick([
                { label: 'Only this item', all: false },
                { label: `Every item of run ${run} not sent yet (${others.length})`, description: 'the staged and pending ones', all: true },
            ], { title: `Session ${label}: also for the run's other items?`, placeHolder: 'The items being sent or held keep theirs' });
            if (all?.all) {
                const res = qm.setSessionOfRunItems(run, session, id);
                vscode.window.setStatusBarMessage(`$(check) Session ${label}: ${res.changed} more item${res.changed === 1 ? '' : 's'}${res.refused.length ? `, ${res.refused.length} kept theirs (their profile cannot continue it)` : ''}`, 5000);
            }
        }
    }
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
function queueLaneState(): { heldRuns: string[]; lanes: LaneSummary[]; runQueueSettings: Record<string, unknown>; startQueueSettings?: Record<string, unknown> } {
    try {
        const qm = PromptQueueManager.instance;
        const { processRuns } = queueRunState();
        const runQueueSettings: Record<string, unknown> = {};
        for (const run of new Set(['default', ...processRuns, ...qm.allRunQueueSettings().map((r) => r.run)])) {
            runQueueSettings[run] = qm.runQueueSettings(run);
        }
        // The start values (the file's top-level keys): Make default is disabled while a tab's settings equal them.
        return { heldRuns: [...qm.heldRuns], lanes: qm.laneSummaries(processRuns), runQueueSettings, startQueueSettings: { ...qm.startQueueSettings() } };
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
