// @ts-nocheck
/* eslint-disable no-undef */
// Prompt Queue Editor webview script — extracted from getHtml() in
// src/handlers/queueEditor-handler.ts (Phase B.13 webview restructuring).
//
// Host-scope script: it declares the page globals (currentItems, vscode,
// detailsExpanded, reminderTemplates, editorMode, render, …) consumed by the
// component partials (queueEntryUtils/RenderFunctions/MessageHandlers.js) and
// transportPicker.js, and it calls the functions those partials define — so
// no-undef is disabled. Component scripts load BEFORE this one (their globals
// exist when init runs); transportPicker.js + fallback.js load AFTER.
//
// Two changes vs the original inline script:
//   1. First-paint data now arrives via the loader's window.__INIT__ instead of
//      a #__initial_state__ JSON block (state under __INIT__.state).
//   2. The codicons stylesheet and the two transport-picker fragments are
//      injected at runtime from __INIT__ (codiconsUri / queueDefaultPickerHtml /
//      addFormPickerHtml) — see index.html for why (no node_modules placeholder,
//      pickers rendered host-side).

// ── Bootstrap watchdog (was the first inline <script>) ──
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

// ── Error catcher (was the second inline <script>) ──
window.onerror = function(msg, url, line, col, err) {
  console.error('[QueueEditor] JS ERROR:', msg, 'line', line, 'col', col);
  return false;
};

// ── Main editor script (was the large inline <script>) ──
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

/* ---- First-paint data from loader (window.__INIT__) ---- */
var __INIT = window.__INIT__ || {};
var __INITIAL__ = __INIT.state || {};

/* ---- Inject codicons stylesheet (URI from loader init) ---- */
if (__INIT.codiconsUri) {
  var __codiconLink = document.createElement('link');
  __codiconLink.rel = 'stylesheet';
  __codiconLink.href = __INIT.codiconsUri;
  document.head.appendChild(__codiconLink);
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

function showFatalError(context, err) {
  const list = document.getElementById('queueList');
  if (!list) return;
  const message = (err && err.message) ? err.message : String(err || 'unknown error');
  list.innerHTML = '<div class="empty" style="color:var(--vscode-errorForeground,#f85149);">Queue render error (' + escapeHtml(context) + '): ' + escapeHtml(message) + '</div>';
}

/* ---- Inject transport-picker fragments (rendered host-side, spec §4.15) ---- */
var __qdSlot = document.getElementById('queueDefaultPickerSlot');
if (__qdSlot && __INIT.queueDefaultPickerHtml) { __qdSlot.innerHTML = __INIT.queueDefaultPickerHtml; }
var __afSlot = document.getElementById('addTransportRow');
if (__afSlot && __INIT.addFormPickerHtml) { __afSlot.innerHTML = __INIT.addFormPickerHtml; }

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
