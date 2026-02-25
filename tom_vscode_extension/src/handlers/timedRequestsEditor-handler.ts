/**
 * Timed Requests Editor (§3.3)
 *
 * A command-opened webview panel for managing scheduled/repeating
 * request entries.  Each entry has a prompt, schedule config
 * (interval or specific times), reminder overrides, and status.
 *
 * Opened via `dartscript.openTimedRequestsEditor` command.
 */

import * as vscode from 'vscode';
import { TimerEngine, TimedRequest, ScheduledTime } from '../managers/timerEngine';
import { applyTemplateWrapping } from '../managers/promptQueueManager';
import { ReminderSystem } from '../managers/reminderSystem';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig, PLACEHOLDER_HELP } from './handler_shared';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _timerListener: vscode.Disposable | undefined;
let _ctx: vscode.ExtensionContext | undefined;
const TIMED_COLLAPSED_STATE_KEY = 'dartscript.timedEditor.collapsedEntryIds';
let _collapsedEntryIds = new Set<string>();

function loadCollapsedTimedState(ctx: vscode.ExtensionContext): void {
  const stored = ctx.workspaceState.get<string[]>(TIMED_COLLAPSED_STATE_KEY, []);
  _collapsedEntryIds = new Set((stored || []).filter(id => typeof id === 'string' && id));
}

async function persistCollapsedTimedState(): Promise<void> {
  if (!_ctx) { return; }
  await _ctx.workspaceState.update(TIMED_COLLAPSED_STATE_KEY, Array.from(_collapsedEntryIds));
}

// ============================================================================
// Registration
// ============================================================================

export function registerTimedRequestsEditorCommand(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('dartscript.openTimedRequestsEditor', () => openEditor(ctx))
    );
}

// ============================================================================
// Open / Reveal
// ============================================================================

function openEditor(ctx: vscode.ExtensionContext): void {
    if (_panel) { _panel.reveal(); return; }
  _ctx = ctx;
  loadCollapsedTimedState(ctx);

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    _panel = vscode.window.createWebviewPanel(
        'dartscript.timedRequestsEditor',
        'Timed Requests',
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

    try {
        const te = TimerEngine.instance;
        _timerListener = te.onDidChange(() => sendState());
    } catch (e) {
        console.error('[TimedRequestsEditor] Failed to bind onDidChange:', e);
    }

    _panel.onDidDispose(() => {
        _panel = undefined;
        _timerListener?.dispose();
        _timerListener = undefined;
    });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    // Handle non-timer messages first
    switch (msg.type) {
        case 'getState':
            sendState();
            return;
        case 'openContextSettings':
            await vscode.commands.executeCommand('dartscript.openContextSettingsEditor');
            return;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('dartscript.openChatVariablesEditor');
            return;
        case 'showFile': {
            const { openPanelFile } = await import('../utils/panelYamlStore.js');
            await openPanelFile('timed');
            return;
        }
        case 'setDetailsExpanded': {
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const expanded = msg.expanded !== false;
          if (expanded) {
            _collapsedEntryIds.delete(id);
          } else {
            _collapsedEntryIds.add(id);
          }
          await persistCollapsedTimedState();
          return;
        }
        case 'setAllDetailsExpanded': {
          const ids = Array.isArray(msg.ids) ? msg.ids.filter((id: unknown) => typeof id === 'string' && !!id) as string[] : [];
          const expanded = msg.expanded !== false;
          if (expanded) {
            ids.forEach(id => _collapsedEntryIds.delete(id));
          } else {
            ids.forEach(id => _collapsedEntryIds.add(id));
          }
          await persistCollapsedTimedState();
          return;
        }
        case 'previewEntry': {
            const { showPreviewPanel, expandPlaceholders } = await import('./handler_shared.js');
            let previewContent = msg.text || '';
            const template = msg.template || '';
            const answerWrapper = msg.answerWrapper || false;
            
            // Use the exact same expansion logic as real prompt processing
            previewContent = await expandPlaceholders(previewContent);
            previewContent = await applyTemplateWrapping(previewContent, template, answerWrapper);
            
            await showPreviewPanel('Timed Request Preview', previewContent);
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
    }

    // Timer-dependent messages
    let te: TimerEngine;
    try { te = TimerEngine.instance; } catch {
        vscode.window.showWarningMessage('Timer engine not available');
        return;
    }

    switch (msg.type) {
        case 'addEntry':
            try {
                console.log('[TimedRequestsEditor] addEntry received, text length:', msg.text?.length);
                te.addEntry({
                    enabled: true,
                    template: msg.template || '(None)',
                    answerWrapper: msg.answerWrapper || false,
                    originalText: msg.text || '',
                    scheduleMode: msg.scheduleMode || 'interval',
                    intervalMinutes: msg.intervalMinutes ?? 30,
                    scheduledTimes: msg.scheduledTimes ?? [],
                  reminderEnabled: !!msg.reminderEnabled,
                    reminderTemplateId: msg.reminderTemplateId,
                    reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
                  reminderRepeat: !!msg.reminderRepeat,
                });
                console.log('[TimedRequestsEditor] addEntry created successfully');
                _panel?.webview.postMessage({ type: 'addSuccess' });
                sendState(); // Explicit state push after add
            } catch (e: any) {
                console.error('[TimedRequestsEditor] addEntry error:', e);
                _panel?.webview.postMessage({ type: 'addError', error: e?.message || 'Failed to add entry' });
            }
            break;
        case 'updateEntry':
            te.updateEntry(msg.id, msg.patch);
            break;
        case 'removeEntry':
            te.removeEntry(msg.id);
            break;
        case 'toggleTimer':
            te.timerActivated = !te.timerActivated;
            sendState();
            break;
        case 'enableAll':
            te.enableAll();
            break;
        case 'disableAll':
            te.disableAll();
            break;
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
  if (!_ctx) return;
  if (id) {
    openGlobalTemplateEditor(_ctx, { category: 'reminder', itemId: id });
  } else {
    openGlobalTemplateEditor(_ctx, { category: 'reminder' });
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
  if (!_ctx) return;
  if (currentName) {
    openGlobalTemplateEditor(_ctx, { category: 'copilot', itemId: currentName });
  } else {
    openGlobalTemplateEditor(_ctx, { category: 'copilot' });
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
    let entries: readonly TimedRequest[] = [];
    let reminderTemplates: { id: string; name: string }[] = [];
    let timerActivated = true;

    try {
        const te = TimerEngine.instance;
        entries = te.entries;
        timerActivated = te.timerActivated;
        console.log('[TimedRequestsEditor] buildState: entries count =', entries.length);
    } catch (e) {
        console.error('[TimedRequestsEditor] buildState: TimerEngine not ready:', e);
    }
    try {
        reminderTemplates = ReminderSystem.instance.templates.map(t => ({ id: t.id, name: t.name }));
    } catch { /* */ }

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
        entries: [...entries],  // spread to plain array for serialisation
        timerActivated,
        reminderTemplates,
        promptTemplates,
      collapsedIds: Array.from(_collapsedEntryIds),
        context: { quest, role, activeProjects },
    };
}

function sendState(): void {
    if (!_panel) { return; }
    const state = buildState();
    console.log('[TimedRequestsEditor] sendState posting to webview, entries:', (state.entries as unknown[]).length);
    _panel.webview.postMessage(state).then(
        ok => console.log('[TimedRequestsEditor] postMessage result:', ok),
        err => console.error('[TimedRequestsEditor] postMessage failed:', err),
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
  .toolbar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
  .toolbar button:not(.ctx-btn-icon) { padding: 4px 10px; border: 1px solid var(--border); background: var(--btnBg); color: var(--btnFg); cursor: pointer; border-radius: 3px; font-size: 0.85em; }
  .entries { display: flex; flex-direction: column; gap: 10px; }
  .entry { border: 1px solid var(--border); border-radius: 4px; padding: 10px; }
  .entry-sections { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; }
  .entry-section { flex: 0 1 auto; min-width: 160px; }
  .entry.completed { opacity: 0.4; }
  .status-bar { padding: 3px 10px; border-radius: 3px; font-size: 0.8em; font-weight: bold; text-transform: uppercase; color: #000; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .status-bar.active { background: #4caf50; }
  .status-bar.paused { background: #ffc107; }
  .status-bar.completed { background: #9e9e9e; }
  label { font-size: 0.85em; font-weight: 600; display: block; margin: 6px 0 2px; }
  textarea { width: 100%; min-height: 40px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); padding: 4px; box-sizing: border-box; }
  input[type="number"], input[type="time"], input[type="date"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); padding: 3px 6px; font-size: 0.9em; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--border); padding: 3px 6px; }
  .schedule-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  .schedule-times { margin-left: 12px; }
  .time-row { display: flex; gap: 6px; align-items: center; margin: 3px 0; }
  .entry-actions { display: flex; gap: 4px; margin-top: 8px; }
  .entry-actions button { padding: 2px 8px; font-size: 0.8em; cursor: pointer; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 3px; }
  .meta { font-size: 0.8em; opacity: 0.7; margin-top: 4px; }
  .empty { text-align: center; opacity: 0.5; padding: 20px; }
  .details-hidden { display: none; }
  .context-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px 8px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; font-size: 0.85em; }
  .context-summary { flex: 1; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-btn { padding: 3px 10px; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border-radius: 3px; font-size: 0.8em; white-space: nowrap; }
  .ctx-btn-icon { padding: 2px 4px; border: none; background: transparent; color: var(--fg); cursor: pointer; border-radius: 3px; font-size: 0.85em; opacity: 0.7; }
  .ctx-btn-icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .add-form { border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin-bottom: 10px; display: none; }
  .add-form.visible { display: block; }
  .add-form-actions { display: flex; gap: 6px; margin-top: 8px; }
  .add-feedback { font-size: 0.85em; margin-top: 6px; padding: 4px 8px; border-radius: 3px; display: none; }
  .add-feedback.success { display: block; color: var(--vscode-charts-green, #388a34); }
  .add-feedback.error { display: block; color: var(--vscode-errorForeground, #f85149); }
</style>
</head>
<body>
<h2>Timed Requests</h2>
<div class="context-bar">
  <span id="contextSummary" class="context-summary"></span>
  <button class="ctx-btn-icon" onclick="openChatVariables()" title="Chat Variables"><span class="codicon codicon-symbol-key"></span></button>
  <button class="ctx-btn-icon" onclick="openContextSettings()" title="Context &amp; Settings"><span class="codicon codicon-tools"></span></button>
  <button class="ctx-btn-icon" onclick="showFile()" title="Show YAML file"><span class="codicon codicon-go-to-file"></span></button>
</div>
<div class="toolbar">
  <button class="ctx-btn-icon" onclick="toggleAddForm()" title="Add New"><span class="codicon codicon-add"></span></button>
  <button class="ctx-btn-icon" id="timerToggleBtn" onclick="toggleTimer()" title="Timer"><span class="codicon codicon-play"></span></button>
  <button onclick="enableAll()">Enable All</button>
  <button onclick="disableAll()">Disable All</button>
  <button onclick="collapseAll()">Collapse All</button>
  <button onclick="expandAll()">Expand All</button>
</div>

<div class="add-form" id="addForm">
  <label>Prompt</label>
  <textarea id="addText" placeholder="Enter timed request prompt…"></textarea>
  <label>Prompt Template</label>
  <div class="schedule-row">
    <select id="addTemplate">
      <option value="">(None)</option>
    </select>
    <button class="ctx-btn-icon" onclick="addPromptTemplate()" title="Add Prompt Template"><span class="codicon codicon-add"></span></button>
    <button class="ctx-btn-icon" onclick="editPromptTemplate('addTemplate')" title="Edit Prompt Template"><span class="codicon codicon-edit"></span></button>
    <button class="ctx-btn-icon" onclick="deletePromptTemplate('addTemplate')" title="Delete Prompt Template"><span class="codicon codicon-trash"></span></button>
    <label style="display:inline;margin:0;"><input type="checkbox" id="addAnswerWrapper" /> Answer Wrapper</label>
  </div>
  <label>Schedule Mode</label>
  <div class="schedule-row">
    <label style="display:inline;"><input type="radio" name="addScheduleMode" value="interval" checked/> Interval</label>
    <label style="display:inline;"><input type="radio" name="addScheduleMode" value="scheduled"/> Scheduled Times</label>
  </div>
  <div id="addIntervalRow" class="schedule-row">
    <span>Every</span> <input type="number" id="addInterval" min="1" value="30" style="width:60px"/> <span>minutes</span>
  </div>
  <label>Reminder</label>
  <div class="schedule-row">
    <label style="display:inline;"><input type="checkbox" id="addReminderEnabled"/> Enabled</label>
    <select id="addReminder"><option value="">Global Default</option></select>
    <button class="ctx-btn-icon" onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>
    <button class="ctx-btn-icon" onclick="editReminderTemplate('addReminder')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>
    <button class="ctx-btn-icon" onclick="deleteReminderTemplate('addReminder')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>
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
    <label style="display:inline;"><input type="checkbox" id="addReminderRepeat"/> Repeat</label>
  </div>
  <div class="add-form-actions">
    <button onclick="submitNewEntry()" style="background:var(--btnBg);color:var(--btnFg);">✅ Create</button>
    <button onclick="cancelAdd()">Cancel</button>
  </div>
  <div id="addFeedback" class="add-feedback"></div>
</div>

<div class="entries" id="entriesList"><div class="empty">Loading…</div></div>
<noscript><div class="empty" style="color:var(--vscode-errorForeground,#f85149);">JavaScript is disabled in this webview.</div></noscript>
<script>
(function() {
  window.__timedRequestsEditorBooted = false;
  var lastBootstrapError = '';
  function showBootstrapFailure(message) {
    var list = document.getElementById('entriesList');
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
  window.__timedWatchdogFail = showBootstrapFailure;
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
    if (window.__timedRequestsEditorBooted !== true) {
      showBootstrapFailure('Timed requests webview script initialization failed.');
    }
  }, 1500);
})();
</script>

<!-- JSON data block: never executed as JS, parsed via JSON.parse -->
<script type="application/json" id="__initial_state__">${safeStateJson}</script>

<script>
/* Error catcher — logs to console only */
window.onerror = function(msg, url, line, col, err) {
  console.error('[TimedRequestsEditor] JS ERROR:', msg, 'line', line, 'col', col);
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
    console.error('[TimedRequestsEditor] acquireVsCodeApi failed:', err);
  }
  return {
    postMessage: function() { return false; },
    setState: function() { /* noop */ },
    getState: function() { return undefined; },
  };
})();
window.__timedRequestsEditorBooted = false;

/* ---- Parse initial state from JSON data block ---- */
var __INITIAL__ = {};
try {
  var __rawJson = document.getElementById('__initial_state__');
  if (__rawJson) {
    __INITIAL__ = JSON.parse(__rawJson.textContent);
  }
} catch (parseErr) {
  console.error('[TimedRequestsEditor] JSON parse error:', parseErr);
}

let entries = __INITIAL__.entries || [];
let timerActivated = __INITIAL__.timerActivated !== undefined ? __INITIAL__.timerActivated : true;
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
  if (!Array.isArray(entries)) { entries = []; }
  entries = entries
    .filter(function(entry) { return !!entry && typeof entry === 'object'; })
    .map(function(entry, index) {
      const safeId = (typeof entry.id === 'string' && entry.id) ? entry.id : ('timed-entry-' + index);
      const safeStatus = (entry.status === 'active' || entry.status === 'paused' || entry.status === 'completed')
        ? entry.status
        : (entry.enabled ? 'active' : 'paused');
      return {
        ...entry,
        id: safeId,
        status: safeStatus,
        originalText: typeof entry.originalText === 'string' ? entry.originalText : '',
        template: typeof entry.template === 'string' ? entry.template : '(None)',
        scheduledTimes: Array.isArray(entry.scheduledTimes) ? entry.scheduledTimes : [],
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
  const list = document.getElementById('entriesList');
  if (!list) return;
  const message = (err && err.message) ? err.message : String(err || 'unknown error');
  list.innerHTML = '<div class="empty" style="color:var(--vscode-errorForeground,#f85149);">Timed requests render error (' + esc(context) + '): ' + esc(message) + '</div>';
}

function formatPromptTemplateName(name) {
  if (!name || name === '(None)') return '(None)';
  if (name === '__answer_file__') return 'Answer Wrapper';
  return name;
}

/* Render immediately from embedded state */
try {
  normalizeState();
  render();
  updateContextSummary();
  populateAddFormDropdowns();
  window.__timedRequestsEditorBooted = true;
} catch (err) {
  console.error('[TimedRequestsEditor] Initial render error:', err);
  showFatalError('initial', err);
  window.__timedRequestsEditorBooted = false;
}

window.addEventListener('message', e => {
  const msg = e.data;
  try {
    if (msg.type === 'state') {
      entries = msg.entries || [];
      timerActivated = msg.timerActivated !== undefined ? msg.timerActivated : true;
      reminderTemplates = msg.reminderTemplates || [];
      promptTemplates = msg.promptTemplates || [];
      currentContext = msg.context || { quest: '', role: '', activeProjects: [] };
      normalizeState();
      render();
      updateContextSummary();
      populateAddFormDropdowns();
    } else if (msg.type === 'addSuccess') {
      showAddFeedback('Entry created ✓', 'success');
      document.getElementById('addText').value = '';
    } else if (msg.type === 'addError') {
      showAddFeedback(msg.error || 'Failed to add entry', 'error');
    }
  } catch (err) {
    console.error('[TimedRequestsEditor Webview] Error in message handler:', err);
    showFatalError('message', err);
  }
});

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

/* ---- Add Form ---- */
function toggleAddForm() {
  const form = document.getElementById('addForm');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    populateAddFormDropdowns();
    document.getElementById('addText').focus();
  }
}

function cancelAdd() {
  document.getElementById('addForm').classList.remove('visible');
  clearAddFeedback();
}

function populateAddFormDropdowns() {
  // Prompt template dropdown
  const tplSel = document.getElementById('addTemplate');
  if (tplSel) {
    const val = tplSel.value;
    tplSel.innerHTML = '<option value="">(None)</option>' +
      promptTemplates.map(k => '<option value="' + esc(k) + '">' + esc(formatPromptTemplateName(k)) + '</option>').join('');
    tplSel.value = val;
  }
  // Reminder template dropdown
  const remSel = document.getElementById('addReminder');
  if (remSel) {
    const val = remSel.value;
    remSel.innerHTML = '<option value="">Global Default</option>' +
      reminderTemplates.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('');
    remSel.value = val;
  }
}

function submitNewEntry() {
  const text = document.getElementById('addText').value.trim();
  const template = document.getElementById('addTemplate').value || '(None)';
  const answerWrapper = document.getElementById('addAnswerWrapper').checked;
  const modeRadios = document.querySelectorAll('input[name="addScheduleMode"]');
  let scheduleMode = 'interval';
  modeRadios.forEach(r => { if (r.checked) scheduleMode = r.value; });
  const intervalMinutes = parseInt(document.getElementById('addInterval').value) || 30;
  const reminderTemplateId = document.getElementById('addReminder').value || undefined;
  const reminderTimeoutMinutes = parseInt(document.getElementById('addReminderTimeout').value || '60', 10) || 60;
  const reminderEnabled = !!document.getElementById('addReminderEnabled').checked;
  const reminderRepeat = !!document.getElementById('addReminderRepeat').checked;

  if (!text) {
    showAddFeedback('Please enter a prompt', 'error');
    return;
  }

  clearAddFeedback();
  vscode.postMessage({
    type: 'addEntry',
    text, template, answerWrapper, scheduleMode, intervalMinutes,
    scheduledTimes: [],
    reminderEnabled, reminderTemplateId, reminderTimeoutMinutes, reminderRepeat,
  });
}

function showAddFeedback(text, cls) {
  const el = document.getElementById('addFeedback');
  if (!el) return;
  el.textContent = text;
  el.className = 'add-feedback ' + cls;
  if (cls === 'success') setTimeout(() => clearAddFeedback(), 3000);
}

function clearAddFeedback() {
  const el = document.getElementById('addFeedback');
  if (el) { el.textContent = ''; el.className = 'add-feedback'; }
}

/* ---- Rendering ---- */
function render() {
  /* Timer toggle button */
  const timerBtn = document.getElementById('timerToggleBtn');
  if (timerBtn) {
    timerBtn.innerHTML = timerActivated ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>';
    timerBtn.title = timerActivated ? 'Timer ON (click to pause)' : 'Timer OFF (click to resume)';
    timerBtn.style.opacity = timerActivated ? '1' : '0.5';
  }

  const list = document.getElementById('entriesList');
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty">No timed requests configured</div>';
    return;
  }

  /* Reversed display: newest at top, oldest at bottom */
  const displayEntries = [...entries].reverse();
  list.innerHTML = displayEntries.map((entry, displayIndex) => {
    const entryId = entry.id || ('entry-' + displayIndex);
    const safeStatus = (entry.status === 'active' || entry.status === 'paused' || entry.status === 'completed')
      ? entry.status
      : (entry.enabled ? 'active' : 'paused');
    const expanded = detailsExpanded[entryId] !== false;
    const isInterval = entry.scheduleMode === 'interval';
    const isEditable = safeStatus === 'paused';
    const disabledAttr = isEditable ? '' : ' disabled';
    const lastSent = entry.lastSentAt ? new Date(entry.lastSentAt).toLocaleString() : 'Never';
    const hasAnswerWrapper = entry.answerWrapper || entry.template === '__answer_file__';
    const displayTemplate = (entry.template === '__answer_file__' || !entry.template || entry.template === '(None)') ? '' : entry.template;

    let scheduledTimesHtml = '';
    if (!isInterval && entry.scheduledTimes) {
      scheduledTimesHtml = entry.scheduledTimes.map((st, ti) =>
        '<div class="time-row">' +
          '<input type="time" value="' + esc(st.time) + '"' + disabledAttr + ' onchange="updateScheduledTime(\\'' + entry.id + '\\',' + ti + ',\\'time\\',this.value)"/>' +
          '<input type="date" value="' + esc(st.date || '') + '"' + disabledAttr + ' onchange="updateScheduledTime(\\'' + entry.id + '\\',' + ti + ',\\'date\\',this.value)" title="Leave empty for recurring"/>' +
          '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="removeScheduledTime(\\'' + entry.id + '\\',' + ti + ')" title="Remove"><span class="codicon codicon-close"></span></button>' +
        '</div>'
      ).join('') +
      '<button class="ctx-btn-icon" style="font-size:0.8em;margin-top:2px;"' + disabledAttr + ' onclick="addScheduledTime(\\'' + entry.id + '\\')"><span class="codicon codicon-add"></span> Add Time</button>';
    }

    const reminderOpts = reminderTemplates.map(t =>
      '<option value="' + t.id + '"' + (entry.reminderTemplateId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'
    ).join('');

    const tplOpts = promptTemplates.map(k =>
      '<option value="' + esc(k) + '"' + (entry.template === k ? ' selected' : '') + '>' + esc(formatPromptTemplateName(k)) + '</option>'
    ).join('');

    return '<div class="entry ' + safeStatus + '">' +
      '<div class="status-bar ' + safeStatus + '">' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\\'' + entryId + '\\')" title="Toggle details"></span>' +
          safeStatus.toUpperCase() +
          (safeStatus === 'active'
            ? '<span class="codicon codicon-debug-pause" style="cursor:pointer;color:#000;" onclick="updateField(\\'' + entry.id + '\\',\\'enabled\\',false)" title="Pause"></span>'
            : (safeStatus === 'paused'
              ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="updateField(\\'' + entry.id + '\\',\\'enabled\\',true)" title="Resume"></span>'
              : '')) +
          '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="confirmDelete(\\'' + entry.id + '\\')" title="Delete"></span>' +
        '</span>' +
        '<label style="display:inline;margin:0;font-weight:normal;color:#000;"><input type="checkbox"' + (entry.enabled ? ' checked' : '') +
          (isEditable ? ' onchange="toggleEnabled(\\'' + entry.id + '\\', this.checked)"' : ' disabled') + '/> Enabled</label>' +
      '</div>' +
      '<div class="entry-sections ' + (expanded ? '' : 'details-hidden') + '">' +
        '<div class="entry-section">' +
          '<label>Prompt</label>' +
          '<textarea' + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'originalText\\',this.value)">' + esc(entry.originalText) + '</textarea>' +
        '</div>' +
        '<div class="entry-section">' +
          '<label>Template</label>' +
          '<div class="schedule-row">' +
            '<select' + disabledAttr + ' onchange="updateEntryTemplate(\\'' + entry.id + '\\',this.value)">' +
              '<option value=""' + (!displayTemplate ? ' selected' : '') + '>(None)</option>' + tplOpts +
            '</select>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="addPromptTemplate()" title="Add Prompt Template"><span class="codicon codicon-add"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="editPromptTemplateByName(\\'' + escapeJsSingleQuoted(entry.template || '') + '\\')" title="Edit Prompt Template"><span class="codicon codicon-edit"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="deletePromptTemplateByName(\\'' + escapeJsSingleQuoted(entry.template || '') + '\\')" title="Delete Prompt Template"><span class="codicon codicon-trash"></span></button>' +
            '<label style="display:inline;margin:0;"><input type="checkbox"' + (hasAnswerWrapper ? ' checked' : '') +
              disabledAttr + ' onchange="toggleAnswerWrapper(\\'' + entry.id + '\\',this.checked)"/> AW</label>' +
            '<button class="ctx-btn-icon" onclick="previewEntry(\\'' + entry.id + '\\')" title="Preview"><span class="codicon codicon-eye"></span></button>' +
          '</div>' +
          '<label>Schedule</label>' +
          '<div class="schedule-row">' +
            '<label style="display:inline;"><input type="radio" name="mode_' + entry.id + '"' + (isInterval ? ' checked' : '') +
              disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'scheduleMode\\',\\'interval\\')"/> Interval</label>' +
            '<label style="display:inline;"><input type="radio" name="mode_' + entry.id + '"' + (!isInterval ? ' checked' : '') +
              disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'scheduleMode\\',\\'scheduled\\')"/> Scheduled</label>' +
          '</div>' +
          (isInterval
            ? '<div class="schedule-row"><span>Every</span> <input type="number" min="1" value="' + (entry.intervalMinutes || 30) + '" style="width:60px"' + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'intervalMinutes\\',parseInt(this.value))"/> <span>min</span></div>'
            : '<div class="schedule-times">' + scheduledTimesHtml + '</div>') +
        '</div>' +
        '<div class="entry-section">' +
          '<label>Reminder</label>' +
          '<div class="schedule-row">' +
            '<label style="display:inline;"><input type="checkbox"' + (entry.reminderEnabled ? ' checked' : '') + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'reminderEnabled\\',this.checked)"/> Enabled</label>' +
            '<select' + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'reminderTemplateId\\',this.value)">' +
              '<option value="">Global Default</option>' +
              reminderOpts +
            '</select>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="editReminderTemplateById(\\'' + (entry.reminderTemplateId || '') + '\\')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="deleteReminderTemplateById(\\'' + (entry.reminderTemplateId || '') + '\\')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>' +
            '<label style="display:inline;"><input type="checkbox"' + (entry.reminderRepeat ? ' checked' : '') + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'reminderRepeat\\',this.checked)"/> Repeat</label>' +
          '</div>' +
          '<div class="schedule-row">' +
            '<span>Timeout:</span> <select' + disabledAttr + ' onchange="updateField(\\'' + entry.id + '\\',\\'reminderTimeoutMinutes\\',parseInt(this.value||\\\'60\\\',10)||60)">' +
              [5,10,15,30,60,120,240,480].map(function(m){ return '<option value="' + m + '"' + ((entry.reminderTimeoutMinutes || 60) === m ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<div class="meta">Last sent: ' + lastSent + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleDetails(entryId) {
  detailsExpanded[entryId] = !(detailsExpanded[entryId] !== false);
  vscode.postMessage({ type: 'setDetailsExpanded', id: entryId, expanded: detailsExpanded[entryId] !== false });
  render();
}

function collapseAll() {
  const ids = [];
  entries.forEach(function(entry, idx) {
    const entryId = entry.id || ('entry-' + idx);
    detailsExpanded[entryId] = false;
    ids.push(entryId);
  });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: ids, expanded: false });
  render();
}

function expandAll() {
  const ids = [];
  entries.forEach(function(entry, idx) {
    const entryId = entry.id || ('entry-' + idx);
    detailsExpanded[entryId] = true;
    ids.push(entryId);
  });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: ids, expanded: true });
  render();
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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

function toggleTimer() { vscode.postMessage({ type: 'toggleTimer' }); }
function enableAll() { vscode.postMessage({ type: 'enableAll' }); }
function disableAll() { vscode.postMessage({ type: 'disableAll' }); }
function removeEntry(id) { vscode.postMessage({ type: 'removeEntry', id }); }
function confirmDelete(id) {
  const entry = entries.find(e => e.id === id);
  const snippet = entry ? entry.originalText.substring(0, 50) : id;
  if (confirm('Delete timed request?\\n\\n"' + snippet + '..."')) {
    removeEntry(id);
  }
}
function toggleEnabled(id, checked) { updateField(id, 'enabled', checked); }

function updateField(id, field, value) {
  const patch = {};
  patch[field] = value;
  vscode.postMessage({ type: 'updateEntry', id, patch });
}

function updateScheduledTime(entryId, timeIdx, field, value) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry || !entry.scheduledTimes) return;
  const times = [...entry.scheduledTimes];
  times[timeIdx] = { ...times[timeIdx], [field]: value || undefined };
  updateField(entryId, 'scheduledTimes', times);
}

function addScheduledTime(entryId) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  const times = [...(entry.scheduledTimes || []), { time: '09:00' }];
  updateField(entryId, 'scheduledTimes', times);
}

function removeScheduledTime(entryId, timeIdx) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry || !entry.scheduledTimes) return;
  const times = entry.scheduledTimes.filter((_, i) => i !== timeIdx);
  updateField(entryId, 'scheduledTimes', times);
}

function updateEntryTemplate(entryId, value) {
  updateField(entryId, 'template', value || '(None)');
}

function toggleAnswerWrapper(entryId, checked) {
  updateField(entryId, 'answerWrapper', checked);
}

function previewEntry(entryId) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  vscode.postMessage({ type: 'previewEntry', id: entryId, text: entry.originalText, template: entry.template, answerWrapper: entry.answerWrapper || false });
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

function addReminderTemplate() {
  vscode.postMessage({ type: 'addReminderTemplate' });
}

function editReminderTemplate(selectId) {
  const sel = document.getElementById(selectId || 'addReminder');
  vscode.postMessage({ type: 'editReminderTemplate', id: sel && sel.value ? sel.value : undefined });
}

function deleteReminderTemplate(selectId) {
  const sel = document.getElementById(selectId || 'addReminder');
  vscode.postMessage({ type: 'deleteReminderTemplate', id: sel && sel.value ? sel.value : undefined });
}

function editReminderTemplateById(id) {
  vscode.postMessage({ type: 'editReminderTemplate', id: id || undefined });
}

function deleteReminderTemplateById(id) {
  vscode.postMessage({ type: 'deleteReminderTemplate', id: id || undefined });
}

// Fallback: also request state via message in case embedded state was stale
vscode.postMessage({ type: 'getState' });
</script>
<script>
(function() {
  if (window.__timedRequestsEditorBooted === true) {
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
  const list = document.getElementById('entriesList');
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
      'panel=timed',
      'fallbackActive=true',
      'mainBootFlag=' + String(!!window.__timedRequestsEditorBooted),
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
    const entries = Array.isArray(state && state.entries) ? state.entries : [];
    diagnostics.lastStateSummary = 'entries=' + entries.length + ', keys=' + Object.keys(state || {}).join(',');
    diagnostics.lastStateRaw = safeStringify(state);
    addEvent('state.received', diagnostics.lastStateSummary);
    if (!list) {
      return;
    }
    if (entries.length === 0) {
      setText('No timed requests configured (fallback mode)');
      return;
    }
    list.innerHTML = entries.map(function(entry, idx) {
      const status = (entry && typeof entry.status === 'string') ? entry.status.toUpperCase() : 'PAUSED';
      const text = (entry && typeof entry.originalText === 'string') ? entry.originalText : '';
      return '<div class="entry" style="border-left:3px solid var(--vscode-inputValidation-warningBorder,#d7ba7d);">' +
        '<div class="meta">#' + (idx + 1) + ' · ' + esc(status) + ' · fallback mode</div>' +
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

  addEvent('fallback.activated', 'Timed requests fallback booted because main script flag was missing');
  renderDebug();
  setText('Fallback mode active. Loading state…');
  addEvent('postMessage', 'requesting state');
  vscode.postMessage({ type: 'getState' });
})();
</script>
</body>
</html>`;
}
