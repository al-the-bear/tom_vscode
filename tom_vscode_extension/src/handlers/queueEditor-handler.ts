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
import { queueEntryStyles, queueEntryUtils, queueEntryRenderFunctions, queueEntryMessageHandlers } from './queueEntryComponent';
import { renderTransportPicker, transportPickerScript } from '../utils/transportPicker';

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
}

// ============================================================================
// Open / Reveal
// ============================================================================

function openQueueEditor(ctx: vscode.ExtensionContext): void {
    if (_panel) { _panel.reveal(); return; }
  _ctx = ctx;
  loadCollapsedQueueState(ctx);

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    _panel = vscode.window.createWebviewPanel(
        'tomAi.queueEditor',
        'Prompt Queue',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        },
    );

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    // Register message handler BEFORE setting html so no messages are lost
    _panel.webview.onDidReceiveMessage(handleMessage);

    // Build initial state and embed it directly in the HTML
    const initialState = buildState();
    // Escape only < to prevent </script> closing the JSON data block
    const safeJson = JSON.stringify(initialState)
        .replace(/</g, '\\u003c')
        .replace(/`/g, '\\u0060')
        .replace(/\$/g, '\\u0024');
    _panel.webview.html = getHtml(webviewCodiconsUri.toString(), safeJson);

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

// ============================================================================
// HTML
// ============================================================================

function getHtml(codiconsUri: string, safeStateJson: string): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="stylesheet" href="${codiconsUri}">
<style>
${queueEntryStyles()}
</style>
</head>
<body>
<h2>Prompt Queue</h2>
<div class="context-bar">
  <span id="contextSummary" class="context-summary"></span>
  <button class="ctx-btn-icon" onclick="openChatVariables()" title="Chat Variables"><span class="codicon codicon-symbol-key"></span></button>
  <button class="ctx-btn-icon" onclick="openContextSettings()" title="Context &amp; Settings"><span class="codicon codicon-tools"></span></button>
  <button class="ctx-btn-icon" onclick="openTemplateEditor()" title="Prompt Templates"><span class="codicon codicon-file-code"></span></button>
  <button class="ctx-btn-icon" onclick="openQueueTemplates()" title="Queue Templates"><span class="codicon codicon-symbol-file"></span></button>
</div>
<!-- Queue-level default transport (spec §4.10 header row). Persists
     in the queue-settings YAML; new items without an explicit transport
     inherit this at dispatch. Per-item / per-stage overrides still win.
     Initial value is a neutral 'copilot' — populateAddForm syncs it
     to the real queueDefaultTransport once the state payload arrives. -->
<div class="context-bar" style="border-top:1px solid var(--vscode-panel-border);padding-top:6px;">
  ${renderTransportPicker({
    idPrefix: 'queueDefault',
    context: 'queue-default',
    value: { transport: 'copilot' },
    showTargets: true,
    onChangeEvent: 'setQueueDefaultTransport',
    inline: true,
  })}
</div>
<div class="toolbar">
  <button class="ctx-btn-icon" onclick="toggleAddForm()" title="Add to Queue"><span class="codicon codicon-add"></span></button>
  <button class="ctx-btn-icon" id="autoSendBtn" onclick="toggleAutoSend()" title="Auto-Send"><span class="codicon codicon-play"></span></button>
  <button class="ctx-btn-icon" id="autoStartBtn" onclick="toggleAutoStart()" title="Auto-Start (enable auto-send on extension load)"><span class="codicon codicon-rocket"></span></button>
  <button class="ctx-btn-icon" id="autoPauseBtn" onclick="toggleAutoPause()" title="Auto-Pause (pause when queue empties)"><span class="codicon codicon-debug-pause"></span></button>
  <button class="ctx-btn-icon" id="autoContinueBtn" onclick="toggleAutoContinue()" title="Auto-Continue (resume repetitions after reload)"><span class="codicon codicon-sync"></span></button>
  <button class="ctx-btn-icon" onclick="restartQueue()" title="Restart Queue (reset stuck items)"><span class="codicon codicon-debug-restart"></span></button>
  <button class="ctx-btn-icon" id="stopActiveBtn" onclick="stopActiveItem()" title="Stop currently running prompt (revert to staged)"><span class="codicon codicon-debug-stop"></span></button>
  <button onclick="sendAllStaged()">Send All Staged</button>
  <button onclick="retryAllErrors()" title="Resend every item currently in error state — the first errored item takes the sending slot, the rest are requeued in place">Retry All Errors</button>
  <button onclick="clearErrors()" title="Remove every item currently in error state">Delete Errors</button>
  <button onclick="clearSent()">Clear Sent</button>
  <button onclick="clearAll()">Clear All</button>
  <label style="font-size:0.85em;opacity:0.85;">Answer Timeout:</label>
  <select id="responseTimeout" onchange="setResponseTimeout(this.value)">
    <option value="5">5 Minutes</option>
    <option value="10">10 Minutes</option>
    <option value="15">15 Minutes</option>
    <option value="30">30 Minutes</option>
    <option value="60">60 Minutes</option>
    <option value="120">120 Minutes</option>
    <option value="240">240 Minutes</option>
    <option value="480">480 Minutes</option>
  </select>
  <label style="font-size:0.85em;opacity:0.85;">Reminder Template:</label>
  <select id="toolbarReminderTemplate" onchange="setDefaultReminderTemplate(this.value)"></select>
  <button class="ctx-btn-icon" onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>
  <button class="ctx-btn-icon" onclick="editReminderTemplate()" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>
  <button class="ctx-btn-icon" onclick="deleteReminderTemplate()" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>
  <button onclick="collapseAll()">Collapse All</button>
  <button onclick="expandAll()">Expand All</button>
  <span id="countLabel" style="margin-left:auto; font-size:0.85em; opacity:0.7;"></span>
</div>

<div class="add-form" id="addForm">
  <label>Prompt</label>
  <textarea id="addText" placeholder="Type a prompt to add to the queue..." rows="3"></textarea>
  <div class="add-options">
    <label>Template:</label>
    <select id="addTemplate"><option value="">(None)</option></select>
    <button class="ctx-btn-icon" onclick="addPromptTemplate()" title="Add Template"><span class="codicon codicon-add"></span></button>
    <button class="ctx-btn-icon" onclick="editPromptTemplate()" title="Edit Template"><span class="codicon codicon-edit"></span></button>
    <button class="ctx-btn-icon" onclick="deletePromptTemplate()" title="Delete Template"><span class="codicon codicon-trash"></span></button>
  </div>
  <div class="add-options">
    <label style="margin-right:6px;">Reminder:</label>
    <select id="addReminderTemplate"><option value="">Global Default</option><option value="__none__">No reminder</option></select>
    <button class="ctx-btn-icon" onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>
    <button class="ctx-btn-icon" onclick="editReminderTemplate('addReminderTemplate')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>
    <button class="ctx-btn-icon" onclick="deleteReminderTemplate('addReminderTemplate')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>
    <span style="font-size:0.8em;opacity:0.85;">Wait:</span>
    <select id="addReminderTimeout">
      <option value="5">5 min</option>
      <option value="10">10 min</option>
      <option value="15">15 min</option>
      <option value="30">30 min</option>
      <option value="60" selected>60 min</option>
      <option value="120">120 min</option>
      <option value="240">240 min</option>
      <option value="480">480 min</option>
    </select>
  </div>
  <div class="add-options">
    <label style="margin-right:6px;">Queue Repeats:</label>
    <input id="addRepeatCount" type="text" value="1" style="width:80px" title="Total number of times to send this prompt (number or variable name)"/>
  </div>
  <!-- Multi-transport picker (spec §4.10 / §4.15). Pins the staged
       item to either Copilot (answer-file polling) or Anthropic
       (direct AnthropicHandler.sendMessage dispatch). Profile id is
       optional when Anthropic is selected — blank falls back to the
       default profile. Uses the shared renderTransportPicker helper
       so the queue editor's Add form and any other consumer produce
       identical markup + webview wiring. -->
  <div class="add-options" id="addTransportRow">
    ${renderTransportPicker({
      idPrefix: 'addForm',
      context: 'queue-default',
      value: { transport: 'copilot' },
      showTargets: true,
      onChangeEvent: 'addFormTransportChanged',
    })}
  </div>
  <div class="add-options" style="display:block;">
    <label style="display:block;margin-bottom:4px;">Repeat Prefix (supports \${repeatNumber}, \${repeatIndex}, \${repeatCount})</label>
    <textarea id="addRepeatPrefix" rows="2" placeholder="Optional text added before repeated prompt body"></textarea>
    <label style="display:block;margin:6px 0 4px;">Repeat Suffix (supports \${repeatNumber}, \${repeatIndex}, \${repeatCount})</label>
    <textarea id="addRepeatSuffix" rows="2" placeholder="Optional text added after repeated prompt body"></textarea>
  </div>
  <div class="add-form-actions">
    <button onclick="addPrompt()" style="background:var(--btnBg);color:var(--btnFg);">✅ Add</button>
    <button onclick="cancelAdd()">Cancel</button>
    <span id="addFeedback" class="add-feedback"></span>
  </div>
</div>

<div class="queue-list" id="queueList"><div class="empty">Loading…</div></div>
<noscript><div class="empty" style="color:var(--vscode-errorForeground,#f85149);">JavaScript is disabled in this webview.</div></noscript>
<script>
(function() {
  window.__queueEditorBooted = false;
  var lastBootstrapError = '';
  function showBootstrapFailure(message) {
    var list = document.getElementById('queueList');
    if (!list) { return; }
    var currentText = String(list.textContent || '');
    if (currentText.indexOf('Loading') === -1) { return; }
    var detail = lastBootstrapError ? ('<div class="empty" style="opacity:0.9;">' + lastBootstrapError + '</div>') : '';
    list.innerHTML =
      '<div class="empty" style="color:var(--vscode-errorForeground,#f85149);">' +
      message +
      '</div>' +
      '<div class="empty" style="opacity:0.85;">Bootstrap watchdog triggered before UI initialization.</div>' +
      detail;
  }
  window.__queueWatchdogFail = showBootstrapFailure;
  window.addEventListener('error', function(event) {
    var msg = String(event && event.message ? event.message : 'unknown error');
    var file = String(event && event.filename ? event.filename : 'unknown file');
    var line = String(event && event.lineno ? event.lineno : 0);
    var col = String(event && event.colno ? event.colno : 0);
    lastBootstrapError = 'window.error: ' + msg + ' @ ' + file + ':' + line + ':' + col;
  });
  window.addEventListener('unhandledrejection', function(event) {
    var reason = event && event.reason;
    if (typeof reason === 'string') {
      lastBootstrapError = 'unhandledrejection: ' + reason;
    } else {
      try {
        lastBootstrapError = 'unhandledrejection: ' + JSON.stringify(reason);
      } catch (_) {
        lastBootstrapError = 'unhandledrejection: [non-serializable]';
      }
    }
  });
  setTimeout(function() {
    if (window.__queueEditorBooted !== true) {
      showBootstrapFailure('Queue webview script initialization failed.');
    }
  }, 1500);
})();
</script>

<!-- JSON data block: never executed as JS, parsed via JSON.parse -->
<script type="application/json" id="__initial_state__">${safeStateJson}</script>

<script>
/* Error catcher — logs to console only */
window.onerror = function(msg, url, line, col, err) {
  console.error('[QueueEditor] JS ERROR:', msg, 'line', line, 'col', col);
  return false;
};
</script>
<script>
const vscode = (() => {
  try {
    if (typeof acquireVsCodeApi === 'function') {
      return acquireVsCodeApi();
    }
  } catch (err) {
    console.error('[QueueEditor] acquireVsCodeApi failed:', err);
  }
  return {
    postMessage: function() { return false; },
    setState: function() { /* noop */ },
    getState: function() { return undefined; },
  };
})();
window.__queueEditorBooted = false;

/* ---- Parse initial state from JSON data block ---- */
var __INITIAL__ = {};
try {
  var __rawJson = document.getElementById('__initial_state__');
  if (__rawJson) {
    __INITIAL__ = JSON.parse(__rawJson.textContent);
  }
} catch (parseErr) {
  console.error('[QueueEditor] JSON parse error:', parseErr);
}

let currentItems = __INITIAL__.items || [];
let autoSend = __INITIAL__.autoSend !== undefined ? __INITIAL__.autoSend : true;
let autoStart = __INITIAL__.autoStart !== undefined ? __INITIAL__.autoStart : false;
let autoPause = __INITIAL__.autoPause !== undefined ? __INITIAL__.autoPause : true;
let autoContinue = __INITIAL__.autoContinue !== undefined ? __INITIAL__.autoContinue : false;
let responseTimeoutMinutes = __INITIAL__.responseTimeoutMinutes !== undefined ? __INITIAL__.responseTimeoutMinutes : 60;
let defaultReminderTemplateId = __INITIAL__.defaultReminderTemplateId || '';
let reminderTemplates = __INITIAL__.reminderTemplates || [];
let promptTemplates = __INITIAL__.promptTemplates || [];
// Multi-transport UI state (spec §4.10). Populated from the state
// payload so the queue editor's Add form can show a profile +
// config picker when Anthropic transport is selected.
let anthropicProfiles = __INITIAL__.anthropicProfiles || [];
let anthropicConfigs = __INITIAL__.anthropicConfigs || [];
let anthropicUserMessageTemplates = __INITIAL__.anthropicUserMessageTemplates || [];
let queueDefaultTransport = __INITIAL__.queueDefaultTransport || 'copilot';
let queueDefaultAnthropicProfileId = __INITIAL__.queueDefaultAnthropicProfileId || '';
let queueDefaultMessageTemplateId = __INITIAL__.queueDefaultMessageTemplateId || '';
let currentContext = __INITIAL__.context || { quest: '', role: '', activeProjects: [] };
let detailsExpanded = {};
var editorMode = 'queue';
if (Array.isArray(__INITIAL__.collapsedIds)) {
  __INITIAL__.collapsedIds
    .filter(function(id) { return typeof id === 'string' && !!id; })
    .forEach(function(id) { detailsExpanded[id] = false; });
}

function normalizeState() {
  if (!Array.isArray(currentItems)) { currentItems = []; }
  currentItems = currentItems
    .filter(function(item) { return !!item && typeof item === 'object'; })
    .map(function(item, index) {
      const safeId = (typeof item.id === 'string' && item.id) ? item.id : ('queue-item-' + index);
      const safeStatus = (item.status === 'staged' || item.status === 'pending' || item.status === 'sending' || item.status === 'sent' || item.status === 'error')
        ? item.status
        : 'staged';
      return {
        ...item,
        id: safeId,
        status: safeStatus,
        template: typeof item.template === 'string' ? item.template : '(None)',
        originalText: typeof item.originalText === 'string' ? item.originalText : '',
        followUps: Array.isArray(item.followUps) ? item.followUps : [],
        followUpIndex: typeof item.followUpIndex === 'number' ? item.followUpIndex : 0,
      };
    });

  if (!Array.isArray(reminderTemplates)) { reminderTemplates = []; }
  reminderTemplates = reminderTemplates.filter(function(t) { return t && typeof t.id === 'string' && typeof t.name === 'string'; });

  if (!Array.isArray(promptTemplates)) { promptTemplates = []; }
  promptTemplates = promptTemplates.filter(function(name) { return typeof name === 'string'; });

  if (!currentContext || typeof currentContext !== 'object') {
    currentContext = { quest: '', role: '', activeProjects: [] };
  }
  if (!Array.isArray(currentContext.activeProjects)) {
    currentContext.activeProjects = [];
  }
}

/* ---- Shared component: utilities, rendering, message handlers ---- */
/* ---- Shared component: utilities, rendering, message handlers ---- */
${queueEntryUtils()}
${queueEntryRenderFunctions()}
${queueEntryMessageHandlers()}
/* ---- Shared: TransportPicker script (spec §4.15) ---- */
${transportPickerScript()}

function showFatalError(context, err) {
  const list = document.getElementById('queueList');
  if (!list) return;
  const message = (err && err.message) ? err.message : String(err || 'unknown error');
  list.innerHTML = '<div class="empty" style="color:var(--vscode-errorForeground,#f85149);">Queue render error (' + escapeHtml(context) + '): ' + escapeHtml(message) + '</div>';
}

/* Render immediately from embedded state */
try {
  normalizeState();
  render();
  populateAddForm();
  updateContextSummary();
  window.__queueEditorBooted = true;
} catch (err) {
  console.error('[QueueEditor] Initial render error:', err);
  showFatalError('initial', err);
  window.__queueEditorBooted = false;
}

window.addEventListener('message', e => {
  const msg = e.data;
  try {
    if (msg.type === 'state') {
      currentItems = msg.items || [];
      autoSend = msg.autoSend;
      autoStart = msg.autoStart !== undefined ? msg.autoStart : false;
      autoPause = msg.autoPause !== undefined ? msg.autoPause : true;
      autoContinue = msg.autoContinue !== undefined ? msg.autoContinue : false;
      responseTimeoutMinutes = msg.responseTimeoutMinutes || 60;
      defaultReminderTemplateId = msg.defaultReminderTemplateId || '';
      reminderTemplates = msg.reminderTemplates || [];
      promptTemplates = msg.promptTemplates || [];
      anthropicProfiles = msg.anthropicProfiles || [];
      anthropicConfigs = msg.anthropicConfigs || [];
      anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
      queueDefaultTransport = msg.queueDefaultTransport || 'copilot';
      queueDefaultAnthropicProfileId = msg.queueDefaultAnthropicProfileId || '';
      queueDefaultMessageTemplateId = msg.queueDefaultMessageTemplateId || '';
      currentContext = msg.context || { quest: '', role: '', activeProjects: [] };
      normalizeState();
      render();
      populateAddForm();
      updateContextSummary();
    } else if (msg.type === 'addSuccess') {
      showAddFeedback('Added to queue ✓', 'success');
      document.getElementById('addForm').classList.remove('visible');
      document.getElementById('addText').value = '';
      const repeatInput = document.getElementById('addRepeatCount');
      if (repeatInput) { repeatInput.value = '0'; }
      const repeatPrefix = document.getElementById('addRepeatPrefix');
      if (repeatPrefix) { repeatPrefix.value = ''; }
      const repeatSuffix = document.getElementById('addRepeatSuffix');
      if (repeatSuffix) { repeatSuffix.value = ''; }
    } else if (msg.type === 'addError') {
      showAddFeedback('Error: ' + (msg.error || 'Failed'), 'error');
    }
  } catch (err) {
    console.error('[QueueEditor Webview] Error in message handler:', err);
    showFatalError('message', err);
  }
});

function showAddFeedback(text, cls) {
  const el = document.getElementById('addFeedback');
  if (!el) return;
  el.textContent = text;
  el.className = 'add-feedback ' + cls;
  setTimeout(() => { el.textContent = ''; el.className = 'add-feedback'; }, 3000);
}

function updateContextSummary() {
  const el = document.getElementById('contextSummary');
  if (!el) return;
  const parts = [];
  if (currentContext.quest) parts.push('Quest: ' + currentContext.quest);
  if (currentContext.role) parts.push('Role: ' + currentContext.role);
  if (currentContext.activeProjects && currentContext.activeProjects.length) parts.push('Projects: ' + currentContext.activeProjects.join(', '));
  el.textContent = parts.length > 0 ? parts.join('  |  ') : 'No context set';
}

function openContextSettings() {
  vscode.postMessage({ type: 'openContextSettings' });
}

function openChatVariables() {
  vscode.postMessage({ type: 'openChatVariablesEditor' });
}

function render() {
  const btn = document.getElementById('autoSendBtn');
  btn.innerHTML = autoSend ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>';
  btn.title = autoSend ? 'Auto-Send ON (click to pause)' : 'Auto-Send OFF (click to resume)';
  btn.style.opacity = autoSend ? '1' : '0.5';

  const acBtn = document.getElementById('autoContinueBtn');
  if (acBtn) {
    acBtn.title = autoContinue ? 'Auto-Continue ON (resumes repetitions after reload)' : 'Auto-Continue OFF (click to enable)';
    acBtn.style.opacity = autoContinue ? '1' : '0.5';
  }

  const asBtn = document.getElementById('autoStartBtn');
  if (asBtn) {
    asBtn.title = autoStart ? 'Auto-Start ON (auto-send enabled on extension load)' : 'Auto-Start OFF (click to enable)';
    asBtn.style.opacity = autoStart ? '1' : '0.5';
  }

  const apBtn = document.getElementById('autoPauseBtn');
  if (apBtn) {
    apBtn.title = autoPause ? 'Auto-Pause ON (pauses when queue empties)' : 'Auto-Pause OFF (keeps running when empty)';
    apBtn.style.opacity = autoPause ? '1' : '0.5';
  }

  const timeoutSel = document.getElementById('responseTimeout');
  if (timeoutSel) timeoutSel.value = String(responseTimeoutMinutes || 60);

  const staged = currentItems.filter(i => i.status === 'staged').length;
  const pending = currentItems.filter(i => i.status === 'pending').length;
  const sending = currentItems.filter(i => i.status === 'sending').length;
  const sent = currentItems.filter(i => i.status === 'sent').length;

  const stopBtn = document.getElementById('stopActiveBtn');
  if (stopBtn) {
    const hasSending = sending > 0;
    stopBtn.disabled = !hasSending;
    stopBtn.style.opacity = hasSending ? '1' : '0.4';
    stopBtn.style.cursor = hasSending ? 'pointer' : 'not-allowed';
    stopBtn.title = hasSending
      ? 'Stop currently running prompt (revert to staged)'
      : 'Stop — no prompt is currently running';
  }
  document.getElementById('countLabel').textContent =
    'Sending: ' + sending + '  |  Pending: ' + pending + '  |  Staged: ' + staged + '  |  Sent: ' + sent + '  |  Timeout: ' + (responseTimeoutMinutes || 60) + 'm';

  const list = document.getElementById('queueList');
  if (currentItems.length === 0) {
    list.innerHTML = '<div class="empty">Queue is empty</div>';
    return;
  }

  const displayItems = [...currentItems]
    .map(function(item, idx) { return { item: item, idx: idx }; })
    .sort(function(a, b) {
      var statusA = a.item.status || 'staged';
      var statusB = b.item.status || 'staged';
      var rankDiff = statusSortRank(statusA) - statusSortRank(statusB);
      if (rankDiff !== 0) return rankDiff;
      if (statusA === 'sent') return (new Date(b.item.createdAt || 0).getTime()) - (new Date(a.item.createdAt || 0).getTime());
      return a.idx - b.idx;
    })
    .map(function(x) { return x.item; });

  list.innerHTML = displayItems.map(function(item, idx) {
    return renderEntry(item, idx);
  }).join('');
}

function toggleDetails(id) {
  detailsExpanded[id] = !(detailsExpanded[id] !== false);
  vscode.postMessage({ type: 'setDetailsExpanded', id: id, expanded: detailsExpanded[id] !== false });
  render();
}

function collapseAll() {
  currentItems.forEach(function(item) { detailsExpanded[item.id] = false; });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: currentItems.map(function(item) { return item.id; }), expanded: false });
  render();
}

function expandAll() {
  currentItems.forEach(function(item) { detailsExpanded[item.id] = true; });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: currentItems.map(function(item) { return item.id; }), expanded: true });
  render();
}

function toggleAutoSend() { vscode.postMessage({ type: 'toggleAutoSend' }); }
function toggleAutoStart() { vscode.postMessage({ type: 'toggleAutoStart' }); }
function toggleAutoPause() { vscode.postMessage({ type: 'toggleAutoPause' }); }
function toggleAutoContinue() { vscode.postMessage({ type: 'toggleAutoContinue' }); }
function restartQueue() { vscode.postMessage({ type: 'restartQueue' }); }
function stopActiveItem() { vscode.postMessage({ type: 'stopActiveItem' }); }
function sendAllStaged() { vscode.postMessage({ type: 'sendAllStaged' }); }
function setResponseTimeout(minutes) { vscode.postMessage({ type: 'setResponseTimeout', minutes: parseInt(minutes || '60', 10) || 60 }); }
function setDefaultReminderTemplate(templateId) {
  const normalizedTemplateId = templateId || '';
  defaultReminderTemplateId = normalizedTemplateId;
  const addSel = document.getElementById('addReminderTemplate');
  if (addSel) {
    addSel.value = normalizedTemplateId;
  }
  vscode.postMessage({ type: 'setDefaultReminderTemplate', templateId: normalizedTemplateId });
}
function setItemStatus(id, status) { vscode.postMessage({ type: 'setItemStatus', id, status }); }
function clearSent() { vscode.postMessage({ type: 'clearSent' }); }
function clearAll() { vscode.postMessage({ type: 'clearAll' }); }
function retryAllErrors() { vscode.postMessage({ type: 'retryAllErrors' }); }
function clearErrors() { vscode.postMessage({ type: 'clearErrors' }); }
function remove(id) { vscode.postMessage({ type: 'remove', id }); }
function moveUp(id) { vscode.postMessage({ type: 'moveUp', id }); }
function moveDown(id) { vscode.postMessage({ type: 'moveDown', id }); }
function moveToFront(id) { vscode.postMessage({ type: 'moveToFront', id }); }
function sendNow(id) { vscode.postMessage({ type: 'sendNow', id }); }
function continueSending(id) { vscode.postMessage({ type: 'continueSending', id }); }
function resendLastPrompt(id) { vscode.postMessage({ type: 'resendLastPrompt', id }); }
function resetToPending(id) { vscode.postMessage({ type: 'resetToPending', id }); }
function toggleReminder(id, enabled) { vscode.postMessage({ type: 'toggleReminder', id, enabled }); }
function openTemplateEditor() { vscode.postMessage({ type: 'openTemplateEditor' }); }
function openQueueTemplates() { vscode.postMessage({ type: 'openQueueTemplates' }); }
function addPrompt() {
  const ta = document.getElementById('addText');
  const text = ta.value.trim();
  if (!text) { showAddFeedback('Please enter prompt text', 'error'); return; }
  const selTpl = document.getElementById('addReminderTemplate');
  const selTimeout = document.getElementById('addReminderTimeout');
  const inputRepeatCount = document.getElementById('addRepeatCount');
  const inputRepeatPrefix = document.getElementById('addRepeatPrefix');
  const inputRepeatSuffix = document.getElementById('addRepeatSuffix');
  const selTemplate = document.getElementById('addTemplate');
  const msg = { type: 'addPrompt', text };
  if (selTemplate && selTemplate.value) {
    msg.template = selTemplate.value;
    msg.answerWrapper = true; // All templates get Answer Wrapper applied
  }
  // Handle 'No reminder' option
  if (selTpl && selTpl.value === '__none__') {
    msg.reminderEnabled = false;
  } else if (selTpl && selTpl.value) {
    msg.reminderTemplateId = selTpl.value;
    msg.reminderEnabled = true;
  } else {
    // Global default selected: honor toolbar default, including "No reminder"
    msg.reminderEnabled = defaultReminderTemplateId === '__none__' ? false : true;
  }
  if (selTimeout && selTimeout.value) { msg.reminderTimeoutMinutes = parseInt(String(selTimeout.value || '0'), 10) || undefined; }
  if (inputRepeatCount) {
    var rcVal = String(inputRepeatCount.value || '1').trim();
    msg.repeatCount = /^[0-9]+$/.test(rcVal) ? Math.max(1, parseInt(rcVal, 10)) : rcVal;
  }
  if (inputRepeatPrefix && inputRepeatPrefix.value) {
    msg.repeatPrefix = inputRepeatPrefix.value;
  }
  if (inputRepeatSuffix && inputRepeatSuffix.value) {
    msg.repeatSuffix = inputRepeatSuffix.value;
  }
  // Transport picker (spec §4.10 / §4.15). Read from the shared helper's
  // generated selects. The Config dropdown was replaced by a per-
  // transport Template dropdown (anthropic user-msg OR copilot msg).
  var tSel = document.getElementById('addForm-transport-t');
  if (tSel && tSel.value === 'anthropic') {
    msg.transport = 'anthropic';
    var pSel = document.getElementById('addForm-transport-profile');
    var tplA = document.getElementById('addForm-transport-tpl-anthropic');
    if (pSel && pSel.value) { msg.anthropicProfileId = pSel.value; }
    if (tplA && tplA.value) { msg.messageTemplateId = tplA.value; }
  } else if (tSel && tSel.value === 'copilot') {
    msg.transport = 'copilot';
    var tplC = document.getElementById('addForm-transport-tpl-copilot');
    if (tplC && tplC.value) { msg.messageTemplateId = tplC.value; }
  }
  vscode.postMessage(msg);
  ta.value = '';
}

function addReminderTemplate() {
  vscode.postMessage({ type: 'addReminderTemplate' });
  if (inputRepeatCount) {
    var rcVal2 = String(inputRepeatCount.value || '0').trim();
    msg.repeatCount = /^[0-9]+$/.test(rcVal2) ? Math.max(0, parseInt(rcVal2, 10)) : rcVal2;
  } else {
    msg.repeatCount = 0;
  }
}

function addPromptTemplate() {
  vscode.postMessage({ type: 'addPromptTemplate' });
}

function editPromptTemplate(selectId) {
  const sel = document.getElementById(selectId || 'addTemplate');
  vscode.postMessage({ type: 'editPromptTemplate', name: sel && sel.value ? sel.value : undefined });
}

function deletePromptTemplate(selectId) {
  const sel = document.getElementById(selectId || 'addTemplate');
  vscode.postMessage({ type: 'deletePromptTemplate', name: sel && sel.value ? sel.value : undefined });
}

function editPromptTemplateByName(name) {
  vscode.postMessage({ type: 'editPromptTemplate', name: name || undefined });
}

function deletePromptTemplateByName(name) {
  vscode.postMessage({ type: 'deletePromptTemplate', name: name || undefined });
}

function editReminderTemplate(selectId) {
  const sel = document.getElementById(selectId || 'toolbarReminderTemplate');
  vscode.postMessage({ type: 'editReminderTemplate', id: sel && sel.value ? sel.value : undefined });
}

function deleteReminderTemplate(selectId) {
  const sel = document.getElementById(selectId || 'toolbarReminderTemplate');
  vscode.postMessage({ type: 'deleteReminderTemplate', id: sel && sel.value ? sel.value : undefined });
}

function editReminderTemplateById(id) {
  vscode.postMessage({ type: 'editReminderTemplate', id: id || undefined });
}

function deleteReminderTemplateById(id) {
  vscode.postMessage({ type: 'deleteReminderTemplate', id: id || undefined });
}

function toggleAddForm() {
  const form = document.getElementById('addForm');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('addText').focus();
  }
}

function cancelAdd() {
  document.getElementById('addForm').classList.remove('visible');
}

function populateAddForm() {
  // Populate prompt template dropdown. Spec §4.16: when the effective
  // transport for this new item is Anthropic, filter the list to the
  // Anthropic user-message templates store; otherwise show the
  // Copilot templates. Changing the transport in the add form clears
  // the selection (see wireAddFormTemplateFilter below).
  const tplSel = document.getElementById('addTemplate');
  if (tplSel) {
    populateAddFormTemplateList();
  }
  const toolbarSel = document.getElementById('toolbarReminderTemplate');
  if (toolbarSel) {
    toolbarSel.innerHTML = '<option value="">Global Default</option><option value="__none__">No reminder</option>';
    reminderTemplates.forEach(function(t) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      toolbarSel.appendChild(opt);
    });
    // Restore persisted default reminder template
    toolbarSel.value = defaultReminderTemplateId || '';
  }
  // Populate reminder template dropdown
  const sel = document.getElementById('addReminderTemplate');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Global Default</option><option value="__none__">No reminder</option>';
  reminderTemplates.forEach(function(t) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (prev) {
    sel.value = prev;
  } else {
    sel.value = defaultReminderTemplateId || '';
  }

  // Populate the Anthropic profile + config dropdowns inside every
  // renderTransportPicker instance on the page (spec §4.10 queue-level
  // default + add-form override). Helpers emit selects with IDs of
  // the form {prefix}-transport-profile and {prefix}-transport-config.
  var PICKER_PREFIXES = ['queueDefault', 'addForm'];
  PICKER_PREFIXES.forEach(function(prefix) {
    var pSel = document.getElementById(prefix + '-transport-profile');
    if (pSel) {
      var prev = pSel.value;
      pSel.innerHTML = '<option value="">(default profile)</option>';
      (anthropicProfiles || []).forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name ? (p.name + ' (' + p.id + ')') : p.id;
        pSel.appendChild(opt);
      });
      if (prefix === 'queueDefault' && queueDefaultAnthropicProfileId) {
        pSel.value = queueDefaultAnthropicProfileId;
      } else if (prev) {
        pSel.value = prev;
      }
    }
    // Per-transport template dropdowns: the picker renders two
    // selects (anthropic user-message and copilot) and shows the one
    // matching the current transport. Repopulate both here from the
    // live config payload so switching transport finds a fresh list.
    var tplAnth = document.getElementById(prefix + '-transport-tpl-anthropic');
    if (tplAnth) {
      var prevTplA = tplAnth.value;
      tplAnth.innerHTML = '<option value="">(none)</option>';
      (anthropicUserMessageTemplates || []).forEach(function(t) {
        if (!t || !t.id) { return; }
        var opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name ? (t.name + ' (' + t.id + ')') : t.id;
        tplAnth.appendChild(opt);
      });
      if (prefix === 'queueDefault' && queueDefaultTransport === 'anthropic' && queueDefaultMessageTemplateId) {
        tplAnth.value = queueDefaultMessageTemplateId;
      } else if (prevTplA) {
        tplAnth.value = prevTplA;
      }
    }
    var tplCop = document.getElementById(prefix + '-transport-tpl-copilot');
    if (tplCop) {
      var prevTplC = tplCop.value;
      tplCop.innerHTML = '<option value="">(none)</option>';
      (promptTemplates || []).forEach(function(name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        tplCop.appendChild(opt);
      });
      if (prefix === 'queueDefault' && queueDefaultTransport === 'copilot' && queueDefaultMessageTemplateId) {
        tplCop.value = queueDefaultMessageTemplateId;
      } else if (prevTplC) {
        tplCop.value = prevTplC;
      }
    }
    var tSelX = document.getElementById(prefix + '-transport-t');
    var targetsX = document.getElementById(prefix + '-transport-targets');
    var pWrapX = document.getElementById(prefix + '-transport-profile-wrap');
    if (tSelX) {
      if (prefix === 'queueDefault') {
        tSelX.value = queueDefaultTransport;
      }
      var isA = tSelX.value === 'anthropic';
      var isC = tSelX.value === 'copilot';
      if (targetsX) { targetsX.style.display = (isA || isC) ? '' : 'none'; }
      if (pWrapX) { pWrapX.style.display = isA ? '' : 'none'; }
      if (tplAnth) { tplAnth.style.display = isA ? '' : 'none'; }
      if (tplCop) { tplCop.style.display = isC ? '' : 'none'; }
    }
  });
  // Remove the old single-prefix population below — still kept as a
  // fallback when the loop above didn't find the element (shouldn't
  // happen, but harmless).
  var profSel = document.getElementById('addForm-transport-profile');
  if (profSel) {
    var prevProf = profSel.value;
    profSel.innerHTML = '<option value="">(default profile)</option>';
    (anthropicProfiles || []).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name ? (p.name + ' (' + p.id + ')') : p.id;
      profSel.appendChild(opt);
    });
    if (prevProf) { profSel.value = prevProf; }
  }
  var cfgSel = document.getElementById('addForm-transport-config');
  if (cfgSel) {
    var prevCfg = cfgSel.value;
    cfgSel.innerHTML = '<option value="">(profile default)</option>';
    (anthropicConfigs || []).forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      var prefix = '[direct]';
      if (c.transport === 'agentSdk') { prefix = '[agentSdk]'; }
      else if (c.transport === 'vscodeLm') { prefix = '[vscodeLm]'; }
      else if (c.transport === 'localLlm') { prefix = '[localLlm]'; }
      opt.textContent = prefix + ' ' + (c.name ? (c.name + ' (' + c.id + ')') : c.id);
      cfgSel.appendChild(opt);
    });
    if (prevCfg) { cfgSel.value = prevCfg; }
  }
  // Spec §4.7 + §4.16 — when the add-form's transport flips to
  // Anthropic, (a) disable reminder / answerWait (Copilot-only
  // constructs) and (b) repopulate the template dropdown from the
  // Anthropic user-message templates store, blanking the current
  // selection (spec §5 edge case).
  var tSel = document.getElementById('addForm-transport-t');
  if (tSel) {
    var apply = function() {
      var isAnthropic = tSel.value === 'anthropic';
      var remTpl = document.getElementById('addReminderTemplate');
      var remTimeout = document.getElementById('addReminderTimeout');
      if (remTpl) {
        remTpl.disabled = isAnthropic;
        remTpl.title = isAnthropic ? 'Disabled — reminders apply only to Copilot queue items.' : '';
      }
      if (remTimeout) {
        remTimeout.disabled = isAnthropic;
        remTimeout.title = isAnthropic ? 'Disabled — anthropic items advance synchronously.' : '';
      }
      populateAddFormTemplateList();
    };
    tSel.addEventListener('change', apply);
    apply();
  }
}

function populateAddFormTemplateList() {
  // Spec §4.16: queue-editor add-form template dropdown filters by
  // the effective transport. Copilot → config.copilot.templates
  // (via promptTemplates state), Anthropic →
  // config.anthropic.userMessageTemplates. Selection is blanked on
  // every repopulate so the user sees a clean picker matching the
  // transport they just picked (spec §5 edge case).
  var tplSel = document.getElementById('addTemplate');
  if (!tplSel) { return; }
  var tSel = document.getElementById('addForm-transport-t');
  var transport = tSel ? tSel.value : 'copilot';
  var isAnthropic = transport === 'anthropic';
  tplSel.innerHTML = '<option value="">(None)</option>';
  if (isAnthropic) {
    (anthropicUserMessageTemplates || []).forEach(function(t) {
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name || t.id;
      tplSel.appendChild(opt);
    });
  } else {
    (promptTemplates || []).forEach(function(name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = formatPromptTemplateName(name);
      tplSel.appendChild(opt);
    });
  }
  // Blank the selection (spec §5) so users can't accidentally
  // submit with a template name that lives in a different store.
}

// Fallback: also request state via message in case embedded state was stale
vscode.postMessage({ type: 'getState' });
</script>
<script>
(function() {
  if (window.__queueEditorBooted === true) {
    return;
  }

  const vscode = (() => {
    try {
      if (typeof acquireVsCodeApi === 'function') {
        return acquireVsCodeApi();
      }
    } catch (err) {
      addEvent('acquireVsCodeApi.error', String(err && err.message ? err.message : err));
    }
    return {
      postMessage: function() { return false; },
      setState: function() { /* noop */ },
      getState: function() { return undefined; },
    };
  })();
  const list = document.getElementById('queueList');
  const count = document.getElementById('countLabel');
  const diagnostics = {
    activatedAt: new Date().toISOString(),
    events: [],
    lastStateSummary: '',
    lastStateRaw: '',
  };
  let debugPanel;
  let debugPre;

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setText(text) {
    if (!list) {
      return;
    }
    list.innerHTML = '<div class="empty">' + esc(text) + '</div>';
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return '[stringify failed] ' + String(err && err.message ? err.message : err);
    }
  }

  function addEvent(kind, detail) {
    const line = '[' + new Date().toISOString() + '] ' + kind + ': ' + detail;
    diagnostics.events.push(line);
    if (diagnostics.events.length > 250) {
      diagnostics.events.shift();
    }
    renderDebug();
  }

  function ensureDebugPanel() {
    if (debugPanel) {
      return;
    }
    debugPanel = document.createElement('div');
    debugPanel.style.marginTop = '12px';
    debugPanel.style.borderTop = '1px solid var(--vscode-panel-border)';
    debugPanel.style.paddingTop = '10px';

    const title = document.createElement('div');
    title.textContent = 'Fallback Diagnostics';
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    debugPanel.appendChild(title);

    debugPre = document.createElement('pre');
    debugPre.style.whiteSpace = 'pre-wrap';
    debugPre.style.wordBreak = 'break-word';
    debugPre.style.maxHeight = '260px';
    debugPre.style.overflow = 'auto';
    debugPre.style.padding = '8px';
    debugPre.style.margin = '0';
    debugPre.style.border = '1px solid var(--vscode-panel-border)';
    debugPre.style.background = 'var(--vscode-editor-background)';
    debugPanel.appendChild(debugPre);

    document.body.appendChild(debugPanel);
  }

  function renderDebug() {
    ensureDebugPanel();
    if (!debugPre) {
      return;
    }
    const info = [
      'panel=queue',
      'fallbackActive=true',
      'mainBootFlag=' + String(!!window.__queueEditorBooted),
      'activatedAt=' + diagnostics.activatedAt,
      'url=' + String(location && location.href ? location.href : ''),
      diagnostics.lastStateSummary ? ('lastState=' + diagnostics.lastStateSummary) : 'lastState=(none)',
      '',
      '--- recent events ---',
    ];
    const events = diagnostics.events.slice(-80);
    const payload = diagnostics.lastStateRaw
      ? ('\n--- last state payload ---\n' + diagnostics.lastStateRaw)
      : '\n--- last state payload ---\n(none)';
    debugPre.textContent = info.concat(events).join('\n') + payload;
  }

  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = function() {
    try { addEvent('console.error', Array.prototype.slice.call(arguments).map(String).join(' | ')); } catch (_) { /* noop */ }
    return originalConsoleError.apply(console, arguments);
  };
  console.warn = function() {
    try { addEvent('console.warn', Array.prototype.slice.call(arguments).map(String).join(' | ')); } catch (_) { /* noop */ }
    return originalConsoleWarn.apply(console, arguments);
  };

  window.addEventListener('error', function(event) {
    const detail = String(event && event.message ? event.message : 'unknown') +
      ' @ ' + String(event && event.filename ? event.filename : 'unknown') +
      ':' + String(event && event.lineno ? event.lineno : 0) +
      ':' + String(event && event.colno ? event.colno : 0);
    addEvent('window.error', detail);
  });

  window.addEventListener('unhandledrejection', function(event) {
    const reason = event && event.reason ? event.reason : 'unknown';
    addEvent('unhandledrejection', typeof reason === 'string' ? reason : safeStringify(reason));
  });

  function renderState(state) {
    const items = Array.isArray(state && state.items) ? state.items : [];
    diagnostics.lastStateSummary = 'items=' + items.length + ', keys=' + Object.keys(state || {}).join(',');
    diagnostics.lastStateRaw = safeStringify(state);
    addEvent('state.received', diagnostics.lastStateSummary);
    if (count) {
      count.textContent = 'Fallback mode (diagnostics)';
    }
    if (!list) {
      return;
    }
    if (items.length === 0) {
      setText('Queue is empty (fallback mode)');
      return;
    }
    list.innerHTML = items.map(function(item, idx) {
      const status = (item && typeof item.status === 'string') ? item.status.toUpperCase() : 'STAGED';
      const text = (item && typeof item.originalText === 'string') ? item.originalText : '';
      return '<div class="queue-item" style="border-left:3px solid var(--vscode-inputValidation-warningBorder,#d7ba7d);">' +
        '<div class="item-meta">#' + (idx + 1) + ' · ' + esc(status) + '</div>' +
        '<div style="white-space:pre-wrap;">' + esc(text) + '</div>' +
      '</div>';
    }).join('');
  }

  window.addEventListener('message', function(e) {
    const msg = e.data;
    const msgType = msg && msg.type ? String(msg.type) : '(unknown)';
    addEvent('message', 'type=' + msgType);
    if (msg && msg.type === 'state') {
      renderState(msg);
    }
  });

  addEvent('fallback.activated', 'Queue editor fallback booted because main script flag was missing');
  renderDebug();
  setText('Fallback mode active. Loading state…');
  addEvent('postMessage', 'requesting state');
  vscode.postMessage({ type: 'getState' });
})();
</script>
</body>
</html>`;
}
