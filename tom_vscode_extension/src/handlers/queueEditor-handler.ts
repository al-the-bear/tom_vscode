/**
 * Prompt Queue Editor (§3.2)
 *
 * A command-opened webview panel that shows the ordered queue of
 * prompts destined for Copilot Chat.  Each item is editable with
 * status, expanded preview, reordering, and per-item reminder config.
 *
 * Opened via `tomAi.editor.promptQueue` command.
 */

import * as vscode from 'vscode';
import { PromptQueueManager, QueuedPrompt, applyTemplateWrapping } from '../managers/promptQueueManager';
import { ReminderSystem, REMINDER_PLACEHOLDER_HELP } from '../managers/reminderSystem';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig } from './handler_shared';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';
import { renderTransportPicker } from '../utils/transportPicker';
import { loadWebviewHtml } from '../utils/webviewLoader';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _queueListener: vscode.Disposable | undefined;
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

    // Listen for queue changes
    try {
        const qm = PromptQueueManager.instance;
        _queueListener = qm.onDidChange(() => sendState());
    } catch (e) {
        console.error('[QueueEditor] Failed to bind onDidChange:', e);
    }

    _panel.onDidDispose(() => {
        _panel = undefined;
        _queueListener?.dispose();
        _queueListener = undefined;
    });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    // Handle non-queue messages first
    switch (msg.type) {
        case 'getState':
            sendState();
            return;
        case 'openContextSettings':
            await vscode.commands.executeCommand('tomAi.editor.contextSettings');
            return;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('tomAi.editor.chatVariables');
            return;
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
          PromptQueueManager.instance.setDefaultTransport(transport, pid);
          PromptQueueManager.instance.setDefaultMessageTemplate(tplId);
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
        case 'sendNow':
            await qm.sendNow(msg.id);
            break;
        case 'continueSending':
          await qm.continueSending(msg.id);
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
        case 'toggleReminder':
            qm.updateItemReminder(msg.id, { reminderEnabled: msg.enabled });
            break;
        case 'setItemStatus':
          if (msg.status === 'staged' || msg.status === 'pending') {
            qm.setStatus(msg.id, msg.status);
          }
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
        case 'clearSent':
            qm.clearByStatus('sent');
            break;
        case 'clearErrors':
            qm.clearByStatus('error');
            break;
        case 'clearAll':
            qm.clearAll();
            break;
        case 'sendAllStaged':
            qm.sendAllStaged();
            break;
        case 'retryAllErrors':
            try {
                const summary = await qm.retryAllErrors();
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
        case 'toggleAutoSend':
            qm.autoSendEnabled = !qm.autoSendEnabled;
            sendState();        // explicit update in case onDidChange listener isn't wired
            break;
        case 'toggleAutoContinue':
            qm.autoContinueEnabled = !qm.autoContinueEnabled;
            sendState();
            break;
        case 'toggleAutoStart':
            qm.autoStartEnabled = !qm.autoStartEnabled;
            sendState();
            break;
        case 'toggleAutoPause':
            qm.autoPauseEnabled = !qm.autoPauseEnabled;
            sendState();
            break;
        case 'restartQueue':
            qm.restartQueue();
            sendState();
            break;
        case 'stopActiveItem': {
            const stopped = qm.stopActiveItem();
            if (!stopped) {
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
          qm.responseFileTimeoutMinutes = Math.max(5, parseInt(String(msg.minutes || '60'), 10) || 60);
          sendState();
          break;
        case 'setDefaultReminderTemplate':
          qm.defaultReminderTemplateId = msg.templateId || undefined;
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
                    repeatCount: (typeof msg.repeatCount === 'string' && !/^[0-9]+$/.test(msg.repeatCount)) ? msg.repeatCount : (typeof msg.repeatCount === 'number' || typeof msg.repeatCount === 'string' ? Math.max(0, Math.round(Number(msg.repeatCount) || 0)) : 0),
                    repeatPrefix: typeof msg.repeatPrefix === 'string' ? msg.repeatPrefix : undefined,
                    repeatSuffix: typeof msg.repeatSuffix === 'string' ? msg.repeatSuffix : undefined,
                    deferSend: true,
                    // Multi-transport fields (spec §4.10).
                    transport: addTransport,
                    anthropicProfileId: typeof msg.anthropicProfileId === 'string' && msg.anthropicProfileId ? msg.anthropicProfileId : undefined,
                    anthropicConfigId: typeof msg.anthropicConfigId === 'string' && msg.anthropicConfigId ? msg.anthropicConfigId : undefined,
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

const REMINDER_TEMPLATE_HELP = REMINDER_PLACEHOLDER_HELP;

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
  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'copilot' });
  }
}

async function editPromptTemplate(currentName?: string): Promise<void> {
  const config = loadSendToChatConfig();
  if (!config) {
    vscode.window.showWarningMessage('Send-to-chat config is not available.');
    return;
  }
  const templateNames = Object.keys(config.copilot?.templates || {});
  if (templateNames.length === 0) {
    vscode.window.showWarningMessage('No prompt templates available.');
    return;
  }

  const templates = config.copilot?.templates;
  let name = currentName;
  if (!name || !templates?.[name]) {
    const picked = await vscode.window.showQuickPick(templateNames, { placeHolder: 'Select template to edit' });
    if (!picked) {
      return;
    }
    name = picked;
  }

  const existing = templates?.[name];
  if (!existing) {
    return;
  }

  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'copilot', itemId: name });
  }
}

async function deletePromptTemplate(currentName?: string): Promise<void> {
  const config = loadSendToChatConfig();
  if (!config) {
    vscode.window.showWarningMessage('Send-to-chat config is not available.');
    return;
  }
  const templateNames = Object.keys(config.copilot?.templates || {});
  if (templateNames.length === 0) {
    vscode.window.showWarningMessage('No prompt templates available.');
    return;
  }

  const templates = config.copilot?.templates;
  let name = currentName;
  if (!name || !templates?.[name]) {
    const picked = await vscode.window.showQuickPick(templateNames, { placeHolder: 'Select template to delete' });
    if (!picked) {
      return;
    }
    name = picked;
  }

  if (!name) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Delete prompt template "${name}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') {
    return;
  }

  delete templates?.[name];
  saveSendToChatConfig(config);
}

// ============================================================================
// State builder & push
// ============================================================================

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

    try {
        const qm = PromptQueueManager.instance;
        items = qm.items;
        autoSend = qm.autoSendEnabled;
        autoStart = qm.autoStartEnabled;
        autoPause = qm.autoPauseEnabled;
        autoContinue = qm.autoContinueEnabled;
        responseTimeoutMinutes = qm.responseFileTimeoutMinutes;
        defaultReminderTemplateId = qm.defaultReminderTemplateId;
        queueDefaultTransport = qm.defaultTransport;
        queueDefaultAnthropicProfileId = qm.defaultAnthropicProfileId || '';
        queueDefaultMessageTemplateId = qm.defaultMessageTemplateId || '';
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

    let promptTemplates: string[] = [];
    let anthropicProfiles: Array<{ id: string; name?: string }> = [];
    let anthropicConfigs: Array<{ id: string; name?: string; transport?: string }> = [];
    try {
        const config = loadSendToChatConfig();
        const templates = config?.copilot?.templates;
        if (templates) {
            promptTemplates = Object.keys(templates).filter(k => templates[k].showInMenu !== false);
        }
        // Anthropic profiles + configurations (spec §4.10). Also
        // surface Local LLM configurations per §4.3 so the queue
        // editor's config dropdown shows every option a profile
        // could reference. Tagged by backing type so the rendered
        // label stays unambiguous.
        anthropicProfiles = (config?.anthropic?.profiles || [])
            .filter((p) => !!p && typeof p.id === 'string')
            .map((p) => ({ id: p.id, name: p.name }));
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
        items: [...items],  // spread to plain array for serialisation
        autoSend,
        autoStart,
        autoPause,
        autoContinue,
        responseTimeoutMinutes,
        defaultReminderTemplateId,
        reminderTemplates: templates,
        promptTemplates,
        anthropicProfiles,
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
        collapsedIds: Array.from(_collapsedItemIds),
        context: { quest, role, activeProjects },
    };
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

