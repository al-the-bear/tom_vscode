/**
 * Prompt Queue Editor (§3.2)
 *
 * A command-opened webview panel that shows the ordered queue of
 * prompts destined for Copilot Chat.  Each item is editable with
 * status, expanded preview, reordering, and per-item reminder config.
 *
 * Opened via `dartscript.openQueueEditor` command.
 */

import * as vscode from 'vscode';
import { PromptQueueManager, QueuedPrompt, applyTemplateWrapping } from '../managers/promptQueueManager';
import { ReminderSystem } from '../managers/reminderSystem';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig, PLACEHOLDER_HELP } from './handler_shared';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _queueListener: vscode.Disposable | undefined;
let _ctx: vscode.ExtensionContext | undefined;
const QUEUE_COLLAPSED_STATE_KEY = 'dartscript.queueEditor.collapsedItemIds';
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
        vscode.commands.registerCommand('dartscript.openQueueEditor', () => openQueueEditor(ctx))
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
        'dartscript.queueEditor',
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
        .replace(/</g, '\\u003c');
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
            const { openPanelFile } = await import('../utils/panelYamlStore.js');
            await openPanelFile('queue');
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
            const { showPreviewPanel, expandPlaceholders } = await import('./handler_shared.js');
            let previewContent = msg.text || '';
            const template = msg.template || '';
            const answerWrapper = msg.answerWrapper || false;
            previewContent = await expandPlaceholders(previewContent);
            previewContent = await applyTemplateWrapping(previewContent, template, answerWrapper);
            await showPreviewPanel('Queue Item Preview', previewContent);
            return;
        }
        case 'previewFollowUp': {
          const { showPreviewPanel, expandPlaceholders } = await import('./handler_shared.js');
          let previewContent = msg.text || '';
          const template = msg.template || '';
          previewContent = await expandPlaceholders(previewContent);
          previewContent = await applyTemplateWrapping(previewContent, template, true);
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
        case 'sendNow':
            await qm.sendNow(msg.id);
            break;
        case 'setItemStatus':
          if (msg.status === 'staged' || msg.status === 'pending') {
            qm.setStatus(msg.id, msg.status);
          }
          break;
        case 'updateText':
            await qm.updateText(msg.id, msg.text);
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
        case 'clearAll':
            qm.clearAll();
            break;
        case 'toggleAutoSend':
            qm.autoSendEnabled = !qm.autoSendEnabled;
            sendState();        // explicit update in case onDidChange listener isn't wired
            break;
        case 'setResponseTimeout':
          qm.responseFileTimeoutMinutes = Math.max(5, parseInt(String(msg.minutes || '60'), 10) || 60);
          sendState();
          break;
        case 'addPrompt':
            try {
                console.log('[QueueEditor] addPrompt received, text length:', msg.text?.length);
                await qm.enqueue({
                    originalText: msg.text || '',
                    template: msg.template,
                    answerWrapper: msg.answerWrapper || false,
                    reminderTemplateId: msg.reminderTemplateId,
                    reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
              reminderRepeat: !!msg.reminderRepeat,
              reminderEnabled: !!msg.reminderEnabled,
              deferSend: true,
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
    }
}

const REMINDER_TEMPLATE_HELP =
  `${PLACEHOLDER_HELP}<br><br><strong>Reminder-only placeholders:</strong><br>` +
  `<code>\${timeoutMinutes}</code> – timeout for this reminder in minutes<br>` +
  `<code>\${waitingMinutes}</code> – elapsed wait time since prompt/follow-up was sent<br>` +
  `<code>\${originalPrompt}</code> – original prompt text (or active follow-up text)<br>` +
  `<code>\${followUpIndex}</code> – 1-based current follow-up index (0 before first follow-up)<br>` +
  `<code>\${followUpTotal}</code> – total configured follow-up prompts<br>` +
  `<code>\${sentAt}</code> – sent timestamp in ISO format<br>` +
  `<code>\${followUpText}</code> – active follow-up text<br>` +
  `<code>\${promptId}</code> – queue item ID<br>` +
  `<code>\${promptType}</code> – queue item type<br>` +
  `<code>\${status}</code> – queue item status<br>` +
  `<code>\${template}</code> – active template label<br>` +
  `<code>\${requestId}</code> – extracted request ID<br>` +
  `<code>\${expectedRequestId}</code> – currently expected request ID<br>` +
  `<code>\${createdAt}</code> – queue item creation timestamp<br>` +
  `<code>\${reminderSentCount}</code> – number of reminders already sent<br>` +
  `<code>\${queueLength}</code> – total queue length`;

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
  const templateNames = Object.keys(config.templates || {});
  if (templateNames.length === 0) {
    vscode.window.showWarningMessage('No prompt templates available.');
    return;
  }

  let name = currentName;
  if (!name || !config.templates?.[name]) {
    const picked = await vscode.window.showQuickPick(templateNames, { placeHolder: 'Select template to edit' });
    if (!picked) {
      return;
    }
    name = picked;
  }

  const existing = config.templates?.[name];
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
  const templateNames = Object.keys(config.templates || {});
  if (templateNames.length === 0) {
    vscode.window.showWarningMessage('No prompt templates available.');
    return;
  }

  let name = currentName;
  if (!name || !config.templates?.[name]) {
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

  delete config.templates?.[name];
  saveSendToChatConfig(config);
}

// ============================================================================
// State builder & push
// ============================================================================

function buildState(): Record<string, unknown> {
    let items: readonly QueuedPrompt[] = [];
    let autoSend = true;
  let responseTimeoutMinutes = 60;
    let templates: { id: string; name: string }[] = [];

    try {
        const qm = PromptQueueManager.instance;
        items = qm.items;
        autoSend = qm.autoSendEnabled;
        responseTimeoutMinutes = qm.responseFileTimeoutMinutes;
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
    try {
        const config = loadSendToChatConfig();
        if (config?.templates) {
            promptTemplates = Object.keys(config.templates).filter(k => config.templates[k].showInMenu !== false);
        }
    } catch { /* */ }

    return {
        type: 'state',
        items: [...items],  // spread to plain array for serialisation
        autoSend,
        responseTimeoutMinutes,
        reminderTemplates: templates,
        promptTemplates,
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
  :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border); --btnBg: var(--vscode-button-background); --btnFg: var(--vscode-button-foreground); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--fg); background: var(--bg); margin: 0; padding: 8px; }
  h2 { margin: 0 0 8px; font-size: 1.1em; }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar button:not(.ctx-btn-icon) { padding: 4px 10px; border: 1px solid var(--border); background: var(--btnBg); color: var(--btnFg); cursor: pointer; border-radius: 3px; font-size: 0.85em; }
  .toolbar .toggle.active { background: var(--vscode-inputValidation-infoBorder, #007acc); }
  .queue-list { display: flex; flex-direction: column; gap: 8px; }
  .queue-item { border: 1px solid var(--border); border-radius: 4px; padding: 8px; position: relative; }
  .queue-item.sending { border-left: 3px solid var(--vscode-inputValidation-infoBorder, #007acc); }
  .queue-item.sent { opacity: 0.55; }
  .queue-item.error { border-left: 3px solid var(--vscode-inputValidation-errorBorder, #f44); }
  .queue-item.reminder { border-left: 3px solid orange; }
  .item-header { display: flex; align-items: center; margin-bottom: 4px; }
  .item-meta { font-size: 0.8em; opacity: 0.7; }
  .status-bar { flex: 1; padding: 3px 10px; border-radius: 3px; font-size: 0.8em; font-weight: bold; text-transform: uppercase; color: #000; display: flex; justify-content: space-between; align-items: center; }
  .status-bar.staged { background: #ef9a9a; }
  .status-bar.pending { background: #4caf50; }
  .status-bar.sending { background: #4caf50; }
  .status-bar.sent { background: #bdbdbd; }
  .status-bar.error { background: #e57373; }
  .status-bar.reminder { background: #ff9800; }
  textarea { width: 100%; min-height: 50px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); padding: 4px; box-sizing: border-box; }
  .empty { text-align: center; opacity: 0.5; padding: 20px; }
  .context-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px 8px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; font-size: 0.85em; }
  .context-summary { flex: 1; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-btn { padding: 3px 10px; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border-radius: 3px; font-size: 0.8em; white-space: nowrap; }
  .ctx-btn-icon { padding: 2px 4px; border: none; background: transparent; color: var(--fg); cursor: pointer; border-radius: 3px; font-size: 0.85em; opacity: 0.7; }
  .ctx-btn-icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .add-form { border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin-bottom: 10px; display: none; }
  .add-form.visible { display: block; }
  .add-form label { font-size: 0.85em; font-weight: 600; display: block; margin: 6px 0 2px; }
  .add-form textarea { width: 100%; min-height: 50px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); padding: 4px; box-sizing: border-box; }
  .add-options { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-top: 6px; font-size: 0.85em; }
  .add-options label { font-weight: 600; }
  .add-options select, .add-options input[type="number"] { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--border); padding: 2px 6px; font-size: 0.9em; border-radius: 3px; }
  .add-form-actions { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  .add-form-actions button { padding: 4px 14px; border: 1px solid var(--border); cursor: pointer; border-radius: 3px; font-size: 0.85em; }
  .add-feedback { font-size: 0.8em; margin-left: 8px; transition: opacity 0.3s; }
  .add-feedback.success { color: var(--vscode-charts-green, #388a34); }
  .add-feedback.error { color: var(--vscode-charts-red, #f44); }
  .followup-block { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .followup-block.indented { margin-left: 16px; }
  .followup-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; margin-top: 4px; }
  .followup-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .followup-actions .followup-row { margin-top: 0; flex-wrap: wrap; }
  .followup-row textarea { min-height: 44px; }
  .followup-list { display: flex; flex-direction: column; gap: 6px; }
  .followup-item { border: 1px solid var(--border); border-radius: 3px; padding: 6px; }
  .followup-item-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.8em; opacity: 0.8; margin-bottom: 4px; }
  .followup-tools { display: flex; gap: 3px; align-items: center; }
  .status-left { display:flex; align-items:center; gap:6px; }
  .status-icons { display:flex; align-items:center; gap:3px; }
  .details-hidden { display:none; }
</style>
</head>
<body>
<h2>Prompt Queue</h2>
<div class="context-bar">
  <span id="contextSummary" class="context-summary"></span>
  <button class="ctx-btn-icon" onclick="openChatVariables()" title="Chat Variables"><span class="codicon codicon-symbol-key"></span></button>
  <button class="ctx-btn-icon" onclick="openContextSettings()" title="Context &amp; Settings"><span class="codicon codicon-tools"></span></button>
  <button class="ctx-btn-icon" onclick="showFile()" title="Show YAML file"><span class="codicon codicon-go-to-file"></span></button>
</div>
<div class="toolbar">
  <button class="ctx-btn-icon" onclick="toggleAddForm()" title="Add to Queue"><span class="codicon codicon-add"></span></button>
  <button class="ctx-btn-icon" id="autoSendBtn" onclick="toggleAutoSend()" title="Auto-Send"><span class="codicon codicon-play"></span></button>
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
  <select id="toolbarReminderTemplate"></select>
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
    <label style="margin-left:12px;"><input type="checkbox" id="addAnswerWrapper"> Answer Wrapper</label>
  </div>
  <div class="add-options">
    <label style="margin-right:6px;"><input type="checkbox" id="addReminderEnabled"> Reminder</label>
    <select id="addReminderTemplate"><option value="">Global Default</option></select>
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
    <label style="margin-left:8px;"><input type="checkbox" id="addReminderRepeat"> Repeat</label>
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
let responseTimeoutMinutes = __INITIAL__.responseTimeoutMinutes !== undefined ? __INITIAL__.responseTimeoutMinutes : 60;
let reminderTemplates = __INITIAL__.reminderTemplates || [];
let promptTemplates = __INITIAL__.promptTemplates || [];
let currentContext = __INITIAL__.context || { quest: '', role: '', activeProjects: [] };
let detailsExpanded = {};
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

function showFatalError(context, err) {
  const list = document.getElementById('queueList');
  if (!list) return;
  const message = (err && err.message) ? err.message : String(err || 'unknown error');
  list.innerHTML = '<div class="empty" style="color:var(--vscode-errorForeground,#f85149);">Queue render error (' + escapeHtml(context) + '): ' + escapeHtml(message) + '</div>';
}

function statusSortRank(status) {
  if (status === 'sending') return 0;
  if (status === 'pending') return 1;
  if (status === 'staged') return 2;
  if (status === 'sent') return 3;
  return 4;
}

function formatPromptTemplateName(name) {
  if (!name || name === '(None)') return '(None)';
  if (name === '__answer_file__') return 'Answer Wrapper';
  return name;
}

function reminderTimeoutOptions(selectedMinutes) {
  const options = [5, 10, 15, 30, 60, 120, 240, 480];
  const selected = Math.max(1, parseInt(String(selectedMinutes || 0), 10) || 0);
  const rendered = options.map(function(m) {
    return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + ' min</option>';
  }).join('');
  return rendered || '<option value="60">60 min</option>';
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
      responseTimeoutMinutes = msg.responseTimeoutMinutes || 60;
      reminderTemplates = msg.reminderTemplates || [];
      promptTemplates = msg.promptTemplates || [];
      currentContext = msg.context || { quest: '', role: '', activeProjects: [] };
      normalizeState();
      render();
      populateAddForm();
      updateContextSummary();
    } else if (msg.type === 'addSuccess') {
      showAddFeedback('Added to queue ✓', 'success');
      document.getElementById('addForm').classList.remove('visible');
      document.getElementById('addText').value = '';
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

function showFile() {
  vscode.postMessage({ type: 'showFile' });
}

function render() {
  const btn = document.getElementById('autoSendBtn');
  btn.innerHTML = autoSend ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>';
  btn.title = autoSend ? 'Auto-Send ON (click to pause)' : 'Auto-Send OFF (click to resume)';
  btn.style.opacity = autoSend ? '1' : '0.5';

  const timeoutSel = document.getElementById('responseTimeout');
  if (timeoutSel) timeoutSel.value = String(responseTimeoutMinutes || 60);

  const staged = currentItems.filter(i => i.status === 'staged').length;
  const pending = currentItems.filter(i => i.status === 'pending').length;
  const sending = currentItems.filter(i => i.status === 'sending').length;
  const sent = currentItems.filter(i => i.status === 'sent').length;
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
      const statusA = (a.item.status === 'staged' || a.item.status === 'pending' || a.item.status === 'sending' || a.item.status === 'sent' || a.item.status === 'error')
        ? a.item.status
        : 'staged';
      const statusB = (b.item.status === 'staged' || b.item.status === 'pending' || b.item.status === 'sending' || b.item.status === 'sent' || b.item.status === 'error')
        ? b.item.status
        : 'staged';
      const rankDiff = statusSortRank(statusA) - statusSortRank(statusB);
      if (rankDiff !== 0) { return rankDiff; }
      if (statusA === 'sent') {
        return (new Date(b.item.createdAt || 0).getTime()) - (new Date(a.item.createdAt || 0).getTime());
      }
      return a.idx - b.idx;
    })
    .map(function(x) { return x.item; });

  list.innerHTML = displayItems.map((item, idx) => {
    const safeStatus = (item.status === 'staged' || item.status === 'pending' || item.status === 'sending' || item.status === 'sent' || item.status === 'error')
      ? item.status
      : 'staged';
    const queuePos = idx + 1;
    const typeIconClass = item.type === 'timed' ? 'codicon-watch' : item.type === 'reminder' ? 'codicon-bell' : 'codicon-comment';
    const cls = [safeStatus];
    if (item.type === 'reminder') cls.push('reminder');
    const time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : '';
    const sentTime = item.sentAt ? new Date(item.sentAt).toLocaleTimeString() : '';
    const isPending = safeStatus === 'pending';
    const isStaged = safeStatus === 'staged';
    const isEditable = isStaged;
    const statusBarCls = item.type === 'reminder' ? 'reminder' : safeStatus;
    const statusLabel = safeStatus.toUpperCase();

    const followUps = Array.isArray(item.followUps) ? item.followUps : [];
    const sentFollowUps = item.followUpIndex || 0;
    const followUpProgress = followUps.length > 0 ? ('  [FU ' + Math.min(sentFollowUps, followUps.length) + '/' + followUps.length + ']') : '';

    const expanded = detailsExpanded[item.id] !== false;

    return '<div class="queue-item ' + cls.join(' ') + '">' +
      '<div class="item-header">' +
        '<div class="status-bar ' + statusBarCls + '">' +
          '<span class="status-left">' +
            '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\\'' + item.id + '\\')" title="Toggle details"></span>' +
            statusLabel +
            followUpProgress +
            (item.template && item.template !== '(None)' && item.template !== '__answer_file__' ? '  [' + escapeHtml(item.template) + ']' : '') +
            (item.answerWrapper || item.template === '__answer_file__' ? '  [AW]' : '') +
            '<span class="status-icons">' +
            '<span class="codicon codicon-eye" style="cursor:pointer;color:#000;" onclick="previewItem(\\'' + item.id + '\\')" title="Preview"></span>' +
            (isStaged ? '<span class="codicon codicon-arrow-right" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + item.id + '\\', \\'pending\\')" title="Set to Pending"></span>' : '') +
            (isPending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + item.id + '\\', \\'staged\\')" title="Move back to Staged"></span>' : '') +
            ((isPending || isStaged) ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="sendNow(\\'' + item.id + '\\')" title="Send Now"></span>' : '') +
            (isPending ? '<span class="codicon codicon-arrow-up" style="cursor:pointer;color:#000;" onclick="moveDown(\\'' + item.id + '\\')" title="Move up (away from send)"></span>' : '') +
            (isPending ? '<span class="codicon codicon-arrow-down" style="cursor:pointer;color:#000;" onclick="moveUp(\\'' + item.id + '\\')" title="Move down (closer to send)"></span>' : '') +
            '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="remove(\\'' + item.id + '\\')" title="Delete"></span>' +
            '</span>' +
          '</span>' +
          '<span style="display:flex;align-items:center;gap:6px;">' +
            '#' + queuePos + '  ' + time + (sentTime ? ' \\u2192 ' + sentTime : '') +
            ' <span class="codicon ' + typeIconClass + '" style="color:#000;"></span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="' + (expanded ? '' : 'details-hidden') + '">' +
      (isEditable
        ? '<textarea onchange="updateText(\\'' + item.id + '\\', this.value)">' + escapeHtml(item.originalText) + '</textarea>'
        : '<div style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(item.originalText) + '</div>') +
      (isEditable
        ? '<div class="followup-row" style="margin-top:6px;">' +
            '<label style="font-size:0.8em;"><input type="checkbox" ' + (item.reminderEnabled ? 'checked' : '') + ' onchange="updateItemReminder(\\'' + item.id + '\\', \"enabled\", this.checked)"> Reminder</label>' +
            '<select onchange="updateItemReminder(\\'' + item.id + '\\', \"template\", this.value)">' +
              '<option value="">Global Default</option>' +
              reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (item.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
            '</select>' +
            '<button class="ctx-btn-icon" onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>' +
            '<button class="ctx-btn-icon" onclick="editReminderTemplateById(\\'' + (item.reminderTemplateId || '') + '\\')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>' +
            '<button class="ctx-btn-icon" onclick="deleteReminderTemplateById(\\'' + (item.reminderTemplateId || '') + '\\')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>' +
            '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
            '<select onchange="updateItemReminder(\\'' + item.id + '\\', \"timeout\", this.value)">' + reminderTimeoutOptions(item.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
            '<label style="font-size:0.8em;"><input type="checkbox" ' + (item.reminderRepeat ? 'checked' : '') + ' onchange="updateItemReminder(\\'' + item.id + '\\', \"repeat\", this.checked)"> Repeat</label>' +
          '</div>'
        : '') +
      renderFollowUps(item, safeStatus) +
      (item.error ? '<div style="color:var(--vscode-charts-red);font-size:0.8em;margin-top:4px;">Error: ' + escapeHtml(item.error) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderFollowUps(item, status) {
  const followUps = Array.isArray(item.followUps) ? item.followUps : [];
  const isEditable = status === 'staged';
  if (followUps.length === 0 && !isEditable) {
    return '';
  }
  const sentFollowUps = item.followUpIndex || 0;
  const rows = followUps.map((f, idx) => {
    const safeItemId = escapeJsSingleQuoted(item.id);
    const safeFollowUpId = escapeJsSingleQuoted(f.id || '');
    const safeTemplate = escapeJsSingleQuoted(f.template || '');
    const safeReminderTemplateId = escapeJsSingleQuoted(f.reminderTemplateId || '');
    const doneMark = idx < sentFollowUps ? '✓ ' : '';
    const templateLabel = formatPromptTemplateName(f.template || '(None)');
    return '<div class="followup-item">' +
      '<div class="followup-item-head">' +
        '<span>' + doneMark + 'Follow-up #' + (idx + 1) + (f.template ? (' [' + escapeHtml(templateLabel) + ']') : '') + ' [AW]</span>' +
        '<span class="followup-tools">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;" onclick="previewFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\')" title="Preview follow-up"></span>' +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removeFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\')" title="Delete follow-up"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? '<textarea onchange="updateFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', this.value)">' + escapeHtml(f.originalText || '') + '</textarea>' +
          '<div class="followup-actions">' +
            '<div class="followup-row">' +
              '<span style="font-size:0.8em;opacity:0.85;">Template:</span>' +
              '<select onchange="updateFollowUpTemplate(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', this.value)">' +
                '<option value="">(None)</option>' +
                promptTemplates.map(function(name){ return '<option value="' + escapeHtml(name) + '"' + ((f.template || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>'; }).join('') +
              '</select>' +
              '<button class="ctx-btn-icon" onclick="addPromptTemplate()" title="Add Prompt Template"><span class="codicon codicon-add"></span></button>' +
              '<button class="ctx-btn-icon" onclick="editPromptTemplateByName(\\\'' + safeTemplate + '\\\')" title="Edit Prompt Template"><span class="codicon codicon-edit"></span></button>' +
              '<button class="ctx-btn-icon" onclick="deletePromptTemplateByName(\\\'' + safeTemplate + '\\\')" title="Delete Prompt Template"><span class="codicon codicon-trash"></span></button>' +
            '</div>' +
            '<div class="followup-row">' +
              '<label style="font-size:0.8em;"><input type="checkbox" ' + (f.reminderEnabled ? 'checked' : '') + ' onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \"enabled\", this.checked)"> Reminder</label>' +
              '<select onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \"template\", this.value)">' +
                '<option value="">Global Default</option>' +
                reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (f.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
              '</select>' +
              '<button class="ctx-btn-icon" onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>' +
              '<button class="ctx-btn-icon" onclick="editReminderTemplateById(\\'' + safeReminderTemplateId + '\\')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>' +
              '<button class="ctx-btn-icon" onclick="deleteReminderTemplateById(\\'' + safeReminderTemplateId + '\\')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>' +
              '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
              '<select onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \"timeout\", this.value)">' + reminderTimeoutOptions(f.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
              '<label style="font-size:0.8em;"><input type="checkbox" ' + (f.reminderRepeat ? 'checked' : '') + ' onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \"repeat\", this.checked)"> Repeat</label>' +
            '</div>' +
          '</div>'
        : '<div style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(f.originalText || '') + '</div>') +
    '</div>';
  }).join('');

  return '<div class="followup-block indented">' +
    '<div style="font-size:0.85em;opacity:0.85;display:flex;align-items:center;gap:6px;">' +
      'Follow-up Prompts (all wrapped with Answer Wrapper)' +
      (isEditable ? '<button class="ctx-btn-icon" onclick="addEmptyFollowUp(\\'' + item.id + '\\')" title="Add Follow-up"><span class="codicon codicon-add"></span></button>' : '') +
    '</div>' +
    '<div class="followup-list">' + rows + (followUps.length === 0 ? '<div style="opacity:0.75;font-size:0.8em;">No follow-up prompts yet.</div>' : '') + '</div>' +
    '' +
  '</div>';
}

function escapeHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeJsSingleQuoted(s) {
  const value = String(s || '');
  const backslash = String.fromCharCode(92);
  const singleQuote = String.fromCharCode(39);
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === backslash) {
      out += backslash + backslash;
    } else if (ch === singleQuote) {
      out += backslash + singleQuote;
    } else {
      out += ch;
    }
  }
  return out;
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
function setResponseTimeout(minutes) { vscode.postMessage({ type: 'setResponseTimeout', minutes: parseInt(minutes || '60', 10) || 60 }); }
function setItemStatus(id, status) { vscode.postMessage({ type: 'setItemStatus', id, status }); }
function clearSent() { vscode.postMessage({ type: 'clearSent' }); }
function clearAll() { vscode.postMessage({ type: 'clearAll' }); }
function remove(id) { vscode.postMessage({ type: 'remove', id }); }
function moveUp(id) { vscode.postMessage({ type: 'moveUp', id }); }
function moveDown(id) { vscode.postMessage({ type: 'moveDown', id }); }
function sendNow(id) { vscode.postMessage({ type: 'sendNow', id }); }
function updateText(id, text) { vscode.postMessage({ type: 'updateText', id, text }); }
function previewItem(id) {
  const item = currentItems.find(i => i.id === id);
  if (!item) return;
  vscode.postMessage({ type: 'previewItem', id, text: item.originalText, template: item.template || '', answerWrapper: item.answerWrapper || false });
}
function previewFollowUp(id, followUpId) {
  const item = currentItems.find(i => i.id === id);
  if (!item || !Array.isArray(item.followUps)) return;
  const follow = item.followUps.find(f => f.id === followUpId);
  if (!follow) return;
  vscode.postMessage({ type: 'previewFollowUp', id, followUpId, text: follow.originalText || '', template: follow.template || '' });
}
function addPrompt() {
  const ta = document.getElementById('addText');
  const text = ta.value.trim();
  if (!text) { showAddFeedback('Please enter prompt text', 'error'); return; }
  const selTpl = document.getElementById('addReminderTemplate');
  const selTimeout = document.getElementById('addReminderTimeout');
  const chkRemEnabled = document.getElementById('addReminderEnabled');
  const chkRemRepeat = document.getElementById('addReminderRepeat');
  const selTemplate = document.getElementById('addTemplate');
  const chkAw = document.getElementById('addAnswerWrapper');
  const msg = { type: 'addPrompt', text };
  if (selTemplate && selTemplate.value) { msg.template = selTemplate.value; }
  if (chkAw && chkAw.checked) { msg.answerWrapper = true; }
  if (selTpl && selTpl.value) { msg.reminderTemplateId = selTpl.value; }
  if (selTimeout && selTimeout.value) { msg.reminderTimeoutMinutes = parseInt(String(selTimeout.value || '0'), 10) || undefined; }
  if (chkRemEnabled && chkRemEnabled.checked) { msg.reminderEnabled = true; }
  if (chkRemRepeat && chkRemRepeat.checked) { msg.reminderRepeat = true; }
  vscode.postMessage(msg);
  ta.value = '';
}

function updateItemReminder(id, field, value) {
  const msg = { type: 'updateItemReminder', id };
  if (field === 'enabled') msg.reminderEnabled = !!value;
  if (field === 'template') msg.reminderTemplateId = value || '';
  if (field === 'timeout') msg.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
  if (field === 'repeat') msg.reminderRepeat = !!value;
  vscode.postMessage(msg);
}

function addEmptyFollowUp(id) {
  vscode.postMessage({
    type: 'addEmptyFollowUp',
    id,
  });
}

function updateFollowUp(id, followUpId, text) {
  vscode.postMessage({ type: 'updateFollowUp', id, followUpId, text });
}

function updateFollowUpTemplate(id, followUpId, template) {
  vscode.postMessage({ type: 'updateFollowUp', id, followUpId, template: template || '' });
}

function updateFollowUpReminder(id, followUpId, field, value) {
  const msg = { type: 'updateFollowUp', id, followUpId };
  if (field === 'enabled') msg.reminderEnabled = !!value;
  if (field === 'template') msg.reminderTemplateId = value || '';
  if (field === 'timeout') msg.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
  if (field === 'repeat') msg.reminderRepeat = !!value;
  vscode.postMessage(msg);
}

function addReminderTemplate() {
  vscode.postMessage({ type: 'addReminderTemplate' });
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

function removeFollowUp(id, followUpId) {
  vscode.postMessage({ type: 'removeFollowUp', id, followUpId });
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
  // Populate prompt template dropdown
  const tplSel = document.getElementById('addTemplate');
  if (tplSel) {
    const prevTpl = tplSel.value;
    tplSel.innerHTML = '<option value="">(None)</option>';
    promptTemplates.forEach(function(name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = formatPromptTemplateName(name);
      tplSel.appendChild(opt);
    });
    if (prevTpl) { tplSel.value = prevTpl; }
  }
  const toolbarSel = document.getElementById('toolbarReminderTemplate');
  if (toolbarSel) {
    const prevToolbar = toolbarSel.value;
    toolbarSel.innerHTML = '<option value="">Global Default</option>';
    reminderTemplates.forEach(function(t) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      toolbarSel.appendChild(opt);
    });
    if (prevToolbar) { toolbarSel.value = prevToolbar; }
  }
  // Populate reminder template dropdown
  const sel = document.getElementById('addReminderTemplate');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Global Default</option>';
  reminderTemplates.forEach(function(t) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (prev) { sel.value = prev; }
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
