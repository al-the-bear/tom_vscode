/**
 * Queue Template Editor (§3.2e)
 *
 * A command-opened webview panel that shows queue.yaml templates.
 * Uses the same shared entry-editing component as the Prompt Queue Editor.
 *
 * Layout:
 *   - Left sidebar: list of templates (*.template.queue.yaml), + and trash buttons
 *   - Right panel: shared queue.yaml-editor for the selected template
 *   - Bottom: "Queue Prompt" button (copies template to queue) + "Save" button
 *
 * Opened via `tomAi.editor.queueTemplates` command.
 */

import * as vscode from 'vscode';
import {
  readAllTemplates,
  readTemplate,
  writeTemplate,
  writeEntry,
  deleteTemplate,
  QueueTemplateFile,
  QueueFileYaml,
  QueueMetaYaml,
  QueuePromptYaml,
  generateEntryFileName,
  entryIdFromFileName,
  generateId,
} from '../storage/queueFileStorage';
import { queueEntryStyles, queueEntryUtils, queueEntryRenderFunctions, queueEntryMessageHandlers } from './queueEntryComponent';
import { loadSendToChatConfig } from './handler_shared';
import { ReminderSystem } from '../managers/reminderSystem';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;

// ============================================================================
// Registration
// ============================================================================

export function registerQueueTemplateEditorCommand(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tomAi.editor.queueTemplates', () => openQueueTemplateEditor(ctx)),
  );
}

// ============================================================================
// Open / Reveal
// ============================================================================

function openQueueTemplateEditor(ctx: vscode.ExtensionContext): void {
  if (_panel) { _panel.reveal(); return; }
  _ctx = ctx;

  const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

  _panel = vscode.window.createWebviewPanel(
    'tomAi.queueTemplateEditor',
    'Queue Templates',
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

  _panel.webview.onDidReceiveMessage(handleMessage);

  const initialState = buildState();
  const safeJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
  _panel.webview.html = getHtml(webviewCodiconsUri.toString(), safeJson);

  sendState();

  _panel.onDidDispose(() => {
    _panel = undefined;
  });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
  switch (msg.type) {
    case 'getState':
      sendState();
      return;

    case 'loadTemplate':
      sendState(msg.templateId);
      return;

    case 'createTemplate': {
      // Use VS Code input box since browser prompt() doesn't work in webviews
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new queue template',
        placeHolder: 'e.g. code-review, bug-fix, feature-request',
        validateInput: (value) => {
          if (!value || !value.trim()) { return 'Template name is required'; }
          return null;
        },
      });
      if (!name) { return; }
      const templateId = generateId();
      const doc = buildEmptyDoc(name.trim());
      writeTemplate(templateId, doc);
      sendState(templateId);
      return;
    }

    case 'deleteCurrentTemplate': {
      const templateId = msg.templateId?.trim();
      if (!templateId) { return; }
      const ok = deleteTemplate(templateId);
      if (ok) { sendState(); }
      return;
    }

    case 'saveTemplate': {
      saveCurrentTemplate(msg);
      return;
    }

    case 'queuePrompt': {
      await queueFromTemplate(msg);
      return;
    }

    // Entry-level messages handled identically to queue editor
    case 'updateText':
      // In template mode, updates the template's main prompt text (the saved template, not the prompt-to-send)
      break;
    case 'updateItemTemplate':
    case 'updateItemReminder':
    case 'addEmptyFollowUp':
    case 'updateFollowUp':
    case 'removeFollowUp':
    case 'addPrePrompt':
    case 'updatePrePrompt':
    case 'removePrePrompt':
      // These all modify the current template's doc — forward to saveTemplate with full doc
      break;

    default:
      return;
  }
}

// ============================================================================
// Build state
// ============================================================================

function buildState(selectedId?: string): Record<string, unknown> {
  const templates = readAllTemplates();
  const ids = templates.map(t => t.templateId);

  let selected: string | undefined = selectedId;
  if (!selected && ids.length > 0) { selected = ids[0]; }

  let currentItem: Record<string, unknown> | undefined;
  if (selected) {
    const tpl = templates.find(t => t.templateId === selected);
    if (tpl) {
      currentItem = docToTemplateItem(tpl.templateId, tpl.data);
    }
  }

  let reminderTemplates: { id: string; name: string }[] = [];
  try {
    const rs = ReminderSystem.instance;
    reminderTemplates = rs.templates.map(t => ({ id: t.id, name: t.name }));
  } catch { /* not ready */ }

  let promptTemplates: string[] = [];
  try {
    const config = loadSendToChatConfig();
    const tpls = config?.copilot?.templates;
    if (tpls) {
      promptTemplates = Object.keys(tpls).filter(k => tpls[k].showInMenu !== false);
    }
  } catch { /* */ }

  // Build display info: { id, displayName }
  const templateEntries = templates.map(t => ({
    id: t.templateId,
    displayName: t.data.meta.name || t.templateId,
  }));

  return {
    type: 'state',
    templateEntries,
    templateNames: templateEntries.map(e => e.displayName),
    templateIds: ids,
    selectedId: selected || '',
    selectedName: selected ? (templateEntries.find(e => e.id === selected)?.displayName || selected) : '',
    currentItem,
    reminderTemplates,
    promptTemplates,
  };
}

function sendState(selectedId?: string): void {
  if (!_panel) { return; }
  const state = buildState(selectedId);
  _panel.webview.postMessage(state);
}

// ============================================================================
// Template helpers
// ============================================================================

function buildEmptyDoc(name?: string): QueueFileYaml {
  return {
    meta: {
      id: generateId(),
      name: name || 'Untitled',
      status: 'staged' as const,
    },
    'prompt-queue': [
      {
        id: 'P1',
        type: 'main',
        'prompt-text': '',
      } as QueuePromptYaml,
    ],
  };
}

/** Convert a QueueFileYaml doc into the item shape the webview expects. */
function docToTemplateItem(templateId: string, doc: QueueFileYaml): Record<string, unknown> {
  const mainPrompt = doc['prompt-queue']?.find(p => p.type === 'main');
  const prePrompts = (doc['prompt-queue'] || []).filter(p => p.type === 'preprompt');
  const followUps = (doc['prompt-queue'] || []).filter(p => p.type === 'followup');
  const meta = doc.meta || {};

  return {
    id: templateId,
    originalText: mainPrompt?.['prompt-text'] || '',
    template: mainPrompt?.template || '(None)',
    answerWrapper: mainPrompt?.['answer-wrapper'] || false,
    status: 'staged',
    type: 'normal',
    createdAt: (meta as any).created || new Date().toISOString(),
    reminderEnabled: mainPrompt?.reminder?.enabled || false,
    reminderTemplateId: mainPrompt?.reminder?.['template-id'] || '',
    reminderTimeoutMinutes: mainPrompt?.reminder?.['timeout-minutes'] || 60,
    reminderRepeat: mainPrompt?.reminder?.repeat || false,
    prePrompts: prePrompts.map(pp => ({
      text: pp['prompt-text'] || '',
      template: pp.template || '',
      status: 'pending',
    })),
    followUps: followUps.map(fu => ({
      id: fu.id || generateId(),
      originalText: fu['prompt-text'] || '',
      template: fu.template || '',
      reminderEnabled: fu.reminder?.enabled || false,
      reminderTemplateId: fu.reminder?.['template-id'] || '',
      reminderTimeoutMinutes: fu.reminder?.['timeout-minutes'] || 60,
      reminderRepeat: fu.reminder?.repeat || false,
      createdAt: new Date().toISOString(),
    })),
    followUpIndex: 0,
  };
}

/** Rebuild a QueueFileYaml from webview state for saving. */
function templateItemToDoc(item: any, existingDoc?: QueueFileYaml): QueueFileYaml {
  const prompts: QueuePromptYaml[] = [];

  // Main prompt
  const main: QueuePromptYaml = {
    id: 'P1',
    type: 'main',
    'prompt-text': item.originalText || '',
    template: item.template && item.template !== '(None)' ? item.template : undefined,
    'answer-wrapper': item.answerWrapper || undefined,
    reminder: item.reminderEnabled ? {
      enabled: true,
      'template-id': item.reminderTemplateId || undefined,
      'timeout-minutes': item.reminderTimeoutMinutes || 60,
      repeat: item.reminderRepeat || false,
    } : undefined,
    'pre-prompt-refs': [] as string[],
    'follow-up-refs': [] as string[],
  };

  // Pre-prompts
  const prePrompts = Array.isArray(item.prePrompts) ? item.prePrompts : [];
  prePrompts.forEach((pp: any, idx: number) => {
    const ppId = `pre-${idx + 1}`;
    prompts.push({
      id: ppId,
      type: 'preprompt',
      'prompt-text': pp.text || '',
      template: pp.template || undefined,
    } as QueuePromptYaml);
    main['pre-prompt-refs']!.push(ppId);
  });

  // Follow-ups
  const followUps = Array.isArray(item.followUps) ? item.followUps : [];
  followUps.forEach((fu: any, idx: number) => {
    const fuId = fu.id || `fu-${idx + 1}`;
    prompts.push({
      id: fuId,
      type: 'followup',
      'prompt-text': fu.originalText || '',
      template: fu.template || undefined,
      reminder: fu.reminderEnabled ? {
        enabled: true,
        'template-id': fu.reminderTemplateId || undefined,
        'timeout-minutes': fu.reminderTimeoutMinutes || 60,
        repeat: fu.reminderRepeat || false,
      } : undefined,
    } as QueuePromptYaml);
    main['follow-up-refs']!.push(fuId);
  });

  // Clean empty ref arrays
  if (main['pre-prompt-refs']!.length === 0) { delete main['pre-prompt-refs']; }
  if (main['follow-up-refs']!.length === 0) { delete main['follow-up-refs']; }

  prompts.unshift(main);

  const meta: QueueMetaYaml = existingDoc?.meta
    ? { ...existingDoc.meta }
    : { id: generateId(), status: 'staged' as const };
  meta.updated = new Date().toISOString();

  return { meta, 'prompt-queue': prompts };
}

function saveCurrentTemplate(msg: any): void {
  const templateId = msg.templateId?.trim();
  if (!templateId) { return; }
  const item = msg.item;
  if (!item) { return; }

  // Read existing to preserve meta
  const templates = readAllTemplates();
  const existing = templates.find(t => t.templateId === templateId);
  const doc = templateItemToDoc(item, existing?.data);
  writeTemplate(templateId, doc);
  sendState(templateId);
}

async function queueFromTemplate(msg: any): Promise<void> {
  const promptText = msg.promptText?.trim() || '';
  const templateId = msg.templateId?.trim() || '';
  if (!templateId || !promptText) { return; }

  try {
    const template = readTemplate(templateId);
    if (!template?.data) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Clone full template doc so custom/manual fields are preserved.
    const doc: QueueFileYaml = JSON.parse(JSON.stringify(template.data));
    const prompts = doc['prompt-queue'] || [];
    const mainId = doc.meta?.['main-prompt'] || 'P1';
    const main = prompts.find(p => p.id === mainId) || prompts.find(p => p.type === 'main') || prompts[0];

    if (!main) {
      throw new Error('Template has no main prompt');
    }

    main['prompt-text'] = promptText;
    if (typeof main['expanded-text'] === 'string') {
      delete main['expanded-text'];
    }
    if (main.execution) {
      delete main.execution;
    }

    // Fresh queue entry identity/status while preserving additional metadata.
    doc.meta = doc.meta || ({ id: generateId() } as QueueMetaYaml);
    doc.meta.id = generateId();
    doc.meta.status = 'staged';
    doc.meta.created = new Date().toISOString();
    doc.meta.updated = doc.meta.created;
    doc.meta['main-prompt'] = main.id || mainId;

    const fileName = generateEntryFileName(undefined, 'prompt', new Date());
    writeEntry(entryIdFromFileName(fileName), doc, fileName);

    // Explicitly nudge Prompt Queue to refresh now (watcher also updates shortly after).
    try {
      const queueModule = await import('../managers/promptQueueManager.js');
      const qm = queueModule.PromptQueueManager.instance as any;
      if (typeof qm._reloadFromDisk === 'function') {
        qm._reloadFromDisk();
      }
    } catch {
      // Queue manager may not be initialized yet; file watcher will still pick up the new entry.
    }

    _panel?.webview.postMessage({ type: 'queueSuccess' });
  } catch (e: any) {
    _panel?.webview.postMessage({ type: 'queueError', error: e?.message || 'Failed to queue' });
  }
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
/* Template editor layout */
.tpl-layout { display: flex; height: calc(100vh - 60px); gap: 8px; }
.tpl-sidebar { width: 220px; min-width: 180px; border-right: 1px solid var(--border); padding-right: 8px; overflow-y: auto; display: flex; flex-direction: column; }
.tpl-sidebar-header { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; font-size: 0.85em; font-weight: 600; }
.tpl-sidebar-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.tpl-sidebar-item { padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tpl-sidebar-item:hover { background: var(--vscode-list-hoverBackground); }
.tpl-sidebar-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.tpl-main { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.tpl-editor-area { flex: 1; overflow-y: auto; }
.tpl-bottom-bar { display: flex; gap: 6px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); margin-top: 8px; }
.tpl-bottom-bar button { padding: 4px 14px; border: 1px solid var(--border); cursor: pointer; border-radius: 3px; font-size: 0.85em; }
.tpl-bottom-bar .primary { background: var(--btnBg); color: var(--btnFg); }
.tpl-prompt-input { margin-top: 8px; }
.tpl-prompt-input label { font-size: 0.85em; font-weight: 600; display: block; margin-bottom: 2px; }
.tpl-feedback { font-size: 0.8em; margin-left: 8px; transition: opacity 0.3s; }
.tpl-feedback.success { color: var(--vscode-charts-green, #388a34); }
.tpl-feedback.error { color: var(--vscode-charts-red, #f44); }
</style>
</head>
<body>
<h2>Queue Templates</h2>

<div class="tpl-layout">
  <div class="tpl-sidebar">
    <div class="tpl-sidebar-header">
      Templates
      <button class="ctx-btn-icon" onclick="createTemplate()" title="New Template"><span class="codicon codicon-add"></span></button>
      <button class="ctx-btn-icon" onclick="deleteCurrentTemplate()" title="Delete Template"><span class="codicon codicon-trash"></span></button>
    </div>
    <div class="tpl-sidebar-list" id="templateList"></div>
  </div>
  <div class="tpl-main">
    <div class="tpl-editor-area" id="editorArea"><div class="empty">Select or create a template</div></div>
    <div class="tpl-prompt-input">
      <label>Prompt Text (not saved with template)</label>
      <textarea id="promptInput" placeholder="Enter prompt text to queue with this template..." rows="3"></textarea>
    </div>
    <div class="tpl-bottom-bar">
      <button class="primary" onclick="queuePrompt()">Queue Prompt</button>
      <button onclick="saveTemplate()">Save</button>
      <span id="tplFeedback" class="tpl-feedback"></span>
    </div>
  </div>
</div>

<script type="application/json" id="__initial_state__">${safeStateJson}</script>
<script>
const vscode = (() => {
  try { if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi(); }
  catch (e) { console.error('[TemplateEditor] acquireVsCodeApi failed:', e); }
  return { postMessage: function() {}, setState: function() {}, getState: function() {} };
})();

var __INITIAL__ = {};
try {
  var el = document.getElementById('__initial_state__');
  if (el) __INITIAL__ = JSON.parse(el.textContent);
} catch (e) { console.error('[TemplateEditor] parse error:', e); }

var templateNames = __INITIAL__.templateNames || [];
var templateEntries = __INITIAL__.templateEntries || [];
var selectedName = __INITIAL__.selectedName || '';
var selectedId = __INITIAL__.selectedId || '';
var currentItems = __INITIAL__.currentItem ? [__INITIAL__.currentItem] : [];
var reminderTemplates = __INITIAL__.reminderTemplates || [];
var promptTemplates = __INITIAL__.promptTemplates || [];
var responseTimeoutMinutes = 60;
var detailsExpanded = {};
var editorMode = 'template';

/* ---- Shared component ---- */
${queueEntryUtils()}
${queueEntryRenderFunctions()}
${queueEntryMessageHandlers()}

/* ---- Initial render ---- */
try {
  renderSidebar();
  renderEditor();
} catch (err) {
  console.error('[TemplateEditor] init error:', err);
}

/* ---- Message listener ---- */
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'state') {
    templateNames = msg.templateNames || [];
    templateEntries = msg.templateEntries || [];
    selectedName = msg.selectedName || '';
    selectedId = msg.selectedId || '';
    currentItems = msg.currentItem ? [msg.currentItem] : [];
    reminderTemplates = msg.reminderTemplates || [];
    promptTemplates = msg.promptTemplates || [];
    renderSidebar();
    renderEditor();
  } else if (msg.type === 'queueSuccess') {
    showFeedback('Queued \\u2713', 'success');
  } else if (msg.type === 'queueError') {
    showFeedback('Error: ' + (msg.error || 'Failed'), 'error');
  }
});

/* ---- Sidebar ---- */
function renderSidebar() {
  var list = document.getElementById('templateList');
  if (!list) return;
  if (templateEntries.length === 0) {
    list.innerHTML = '<div style="opacity:0.5;font-size:0.85em;padding:8px;">No templates yet</div>';
    return;
  }
  list.innerHTML = templateEntries.map(function(entry) {
    var cls = entry.id === selectedId ? 'tpl-sidebar-item selected' : 'tpl-sidebar-item';
    return '<div class="' + cls + '" onclick="selectTemplate(\\'' + escapeJsSingleQuoted(entry.id) + '\\')">' + escapeHtml(entry.displayName) + '</div>';
  }).join('');
}

/* ---- Editor ---- */
function renderEditor() {
  var area = document.getElementById('editorArea');
  if (!area) return;
  if (currentItems.length === 0 || !selectedId) {
    area.innerHTML = '<div class="empty">Select or create a template</div>';
    return;
  }
  area.innerHTML = '<div class="queue-list">' + renderEntry(currentItems[0], 0) + '</div>';
}

/* ---- Template actions ---- */
function selectTemplate(templateId) {
  selectedId = templateId;
  vscode.postMessage({ type: 'loadTemplate', templateId: templateId });
}

function createTemplate() {
  // Extension host will show VS Code input box
  vscode.postMessage({ type: 'createTemplate' });
}

function deleteCurrentTemplate() {
  if (!selectedId) return;
  if (!confirm('Delete template "' + selectedName + '"?')) return;
  vscode.postMessage({ type: 'deleteCurrentTemplate', templateId: selectedId });
}

function saveTemplate() {
  if (!selectedId || currentItems.length === 0) return;
  vscode.postMessage({ type: 'saveTemplate', templateId: selectedId, item: currentItems[0] });
  showFeedback('Saved \\u2713', 'success');
}

function queuePrompt() {
  var ta = document.getElementById('promptInput');
  var text = ta ? ta.value.trim() : '';
  if (!text) { showFeedback('Enter prompt text first', 'error'); return; }
  if (!selectedId) { showFeedback('No template selected', 'error'); return; }
  vscode.postMessage({ type: 'queuePrompt', templateId: selectedId, promptText: text });
}

function showFeedback(text, cls) {
  var el = document.getElementById('tplFeedback');
  if (!el) return;
  el.textContent = text;
  el.className = 'tpl-feedback ' + cls;
  setTimeout(function() { el.textContent = ''; el.className = 'tpl-feedback'; }, 3000);
}

/* ---- Overrides for component message handlers ---- */
/* The shared component sends messages like updateText, updateItemTemplate, etc.
   In template mode these update the in-memory currentItems[0] and trigger re-render.
   They also send the message to the extension host but we intercept some here. */
var _origUpdateText = typeof updateText === 'function' ? updateText : null;
// Override updateText to update local state too
var __updateText = updateText;
updateText = function(id, text) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    currentItems[0].originalText = text;
  }
  __updateText(id, text);
};

var __updateItemTemplate = updateItemTemplate;
updateItemTemplate = function(id, template) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    currentItems[0].template = template || '(None)';
    // Auto-set answerWrapper based on template selection
    currentItems[0].answerWrapper = !!(template && template !== '(None)');
  }
  __updateItemTemplate(id, template);
};

/* Override follow-up handlers to update local state and re-render */
var __addEmptyFollowUp = addEmptyFollowUp;
addEmptyFollowUp = function(id) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (!Array.isArray(currentItems[0].followUps)) { currentItems[0].followUps = []; }
    var newId = 'fu-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    currentItems[0].followUps.push({
      id: newId,
      originalText: '',
      template: '',
      reminderEnabled: false,
      reminderTemplateId: '',
      reminderTimeoutMinutes: 60,
      reminderRepeat: false,
      createdAt: new Date().toISOString()
    });
    renderEditor();
  }
  __addEmptyFollowUp(id);
};

var __removeFollowUp = removeFollowUp;
removeFollowUp = function(id, followUpId) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (Array.isArray(currentItems[0].followUps)) {
      currentItems[0].followUps = currentItems[0].followUps.filter(function(f) { return f.id !== followUpId; });
      renderEditor();
    }
  }
  __removeFollowUp(id, followUpId);
};

var __updateFollowUp = updateFollowUp;
updateFollowUp = function(id, followUpId, text) {
  if (currentItems.length > 0 && currentItems[0].id === id && Array.isArray(currentItems[0].followUps)) {
    var fu = currentItems[0].followUps.find(function(f) { return f.id === followUpId; });
    if (fu) { fu.originalText = text; }
  }
  __updateFollowUp(id, followUpId, text);
};

var __updateFollowUpTemplate = updateFollowUpTemplate;
updateFollowUpTemplate = function(id, followUpId, template) {
  if (currentItems.length > 0 && currentItems[0].id === id && Array.isArray(currentItems[0].followUps)) {
    var fu = currentItems[0].followUps.find(function(f) { return f.id === followUpId; });
    if (fu) { fu.template = template || ''; }
  }
  __updateFollowUpTemplate(id, followUpId, template);
};

var __updateFollowUpReminder = updateFollowUpReminder;
updateFollowUpReminder = function(id, followUpId, field, value) {
  if (currentItems.length > 0 && currentItems[0].id === id && Array.isArray(currentItems[0].followUps)) {
    var fu = currentItems[0].followUps.find(function(f) { return f.id === followUpId; });
    if (fu) {
      if (field === 'enabled') fu.reminderEnabled = !!value;
      if (field === 'template') {
        if (value === '__none__') {
          fu.reminderEnabled = false;
          fu.reminderTemplateId = '';
        } else {
          fu.reminderTemplateId = value || '';
          fu.reminderEnabled = true;
        }
      }
      if (field === 'timeout') fu.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || 60;
      if (field === 'repeat') fu.reminderRepeat = !!value;
    }
  }
  __updateFollowUpReminder(id, followUpId, field, value);
};

/* Override pre-prompt handlers */
var __addPrePrompt = addPrePrompt;
addPrePrompt = function(id) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (!Array.isArray(currentItems[0].prePrompts)) { currentItems[0].prePrompts = []; }
    currentItems[0].prePrompts.push({
      text: '',
      template: '',
      status: 'pending'
    });
    renderEditor();
  }
  __addPrePrompt(id);
};

var __removePrePrompt = removePrePrompt;
removePrePrompt = function(id, index) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (Array.isArray(currentItems[0].prePrompts) && currentItems[0].prePrompts[index]) {
      currentItems[0].prePrompts.splice(index, 1);
      renderEditor();
    }
  }
  __removePrePrompt(id, index);
};

var __updatePrePrompt = updatePrePrompt;
updatePrePrompt = function(id, index, text, template) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (Array.isArray(currentItems[0].prePrompts) && currentItems[0].prePrompts[index]) {
      if (text !== null) currentItems[0].prePrompts[index].text = text;
      if (template !== null) currentItems[0].prePrompts[index].template = template;
    }
  }
  __updatePrePrompt(id, index, text, template);
};

/* Override reminder update */
var __updateItemReminder = updateItemReminder;
updateItemReminder = function(id, field, value) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (field === 'enabled') currentItems[0].reminderEnabled = !!value;
    if (field === 'template') {
      if (value === '__none__') {
        currentItems[0].reminderEnabled = false;
        currentItems[0].reminderTemplateId = '';
      } else {
        currentItems[0].reminderTemplateId = value || '';
        currentItems[0].reminderEnabled = true;
      }
    }
    if (field === 'timeout') currentItems[0].reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || 60;
    if (field === 'repeat') currentItems[0].reminderRepeat = !!value;
  }
  __updateItemReminder(id, field, value);
};

/* Request state */
vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}
