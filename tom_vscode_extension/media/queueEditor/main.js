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
window.__tomVscodeApi = vscode; // shared completion.js reads this

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
/* The quest's process runs and the window's run (vscimpb45): the run filter, Group by run, the add form's run. */
let processRuns = Array.isArray(__INITIAL__.processRuns) ? __INITIAL__.processRuns : ['default'];
let currentRun = __INITIAL__.currentRun || 'default';
const __runViewState = (typeof vscode !== 'undefined' && vscode && typeof vscode.getState === 'function' && vscode.getState()) || {};
let runFilter = typeof __runViewState.runFilter === 'string' ? __runViewState.runFilter : 'all';
let groupByRun = __runViewState.groupByRun === true;
// The lanes, one per run (each says whether its run is paused), and the queue settings of each run (from the host).
let lanes = Array.isArray(__INITIAL__.lanes) ? __INITIAL__.lanes : [];
let runQueueSettings = (__INITIAL__.runQueueSettings && typeof __INITIAL__.runQueueSettings === 'object') ? __INITIAL__.runQueueSettings : {};

/** The run the toolbar's settings are for: the run the Run filter shows, else the window's run. */
function settingsRun() { return runFilter !== 'all' ? runFilter : currentRun; }

/** Take the settings run's values into the toolbar's state (auto-send, Auto-Start / -Pause / -Continue, defaults, Copilot timeout and reminder). */
function applyRunSettings() {
  const s = runQueueSettings[settingsRun()];
  if (!s) { return; }
  autoSend = s.autoSend === true;
  autoStart = s.autoStart === true;
  autoPause = s.autoPause !== false;
  autoContinue = s.autoContinue === true;
  responseTimeoutMinutes = s.responseTimeoutMinutes || 60;
  defaultReminderTemplateId = s.defaultReminderTemplateId || '';
  queueDefaultTransport = s.defaultTransport || 'copilot';
  queueDefaultSessionLabel = s.defaultAgentSdkSession || 'default';
  queueDefaultAnthropicProfileId = s.defaultAnthropicProfileId || '';
  queueDefaultMessageTemplateId = s.defaultMessageTemplateId || '';
}

/** Tell the host which run the toolbar's settings are for (the transport picker's messages carry none). */
function postSettingsRun() { vscode.postMessage({ type: 'setSettingsRun', run: settingsRun() }); }
// Pending items whose prompt is open for editing: item id -> the draft text.
// The host holds the queue for them (beginTextEdit) until Save or Cancel.
var queueTextEdits = {};
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
// The default profile's key is missing too (the pickers mark it, as the host does).
let defaultProfileNoApiKey = __INITIAL__.defaultProfileNoApiKey === true;
// Same label as NO_API_KEY_LABEL in src/utils/anthropicApiKeyCheck.ts.
const NO_API_KEY_LABEL = ' (no API key)';

/** A profile option's label: name (id), marked when its direct-API key is missing. */
function profileOptionLabel(p) {
  return (p.name ? (p.name + ' (' + p.id + ')') : p.id) + (p.noApiKey ? NO_API_KEY_LABEL : '');
}
let anthropicConfigs = __INITIAL__.anthropicConfigs || [];
let anthropicUserMessageTemplates = __INITIAL__.anthropicUserMessageTemplates || [];
let queueDefaultTransport = __INITIAL__.queueDefaultTransport || 'copilot';
// The queue's default Agent SDK session, as shown on items without their own.
let queueDefaultSessionLabel = __INITIAL__.queueDefaultSession || 'default';
// Base and lifetime per session name ({basedOn?, mode}), from the host.
let sessionInfo = __INITIAL__.sessionInfo || {};
let queueDefaultAnthropicProfileId = __INITIAL__.queueDefaultAnthropicProfileId || '';
let queueDefaultMessageTemplateId = __INITIAL__.queueDefaultMessageTemplateId || '';
let currentContext = __INITIAL__.context || { quest: '', role: '', activeProjects: [] };
// Whether a Quest Refresh dispatch is in flight — drives the orange banner
// between the queue header and the first item.
let questRefreshActive = __INITIAL__.questRefreshActive === true;
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
      return {
        ...item,
        id: safeId,
        status: normalizeQueueStatus(item.status),
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
// Role and Session in the context bar open VS Code pickers on the host.
var __ctxSummary = document.getElementById('contextSummary');
if (__ctxSummary) {
  __ctxSummary.addEventListener('click', function(e) {
    var link = e.target && e.target.closest ? e.target.closest('.ctx-link') : null;
    if (!link) { return; }
    e.preventDefault();
    vscode.postMessage(link.dataset.pick === 'role' ? { type: 'pickRole' } : { type: 'pickQueueDefaultSession', run: settingsRun() });
  });
}
var __afSlot = document.getElementById('addTransportRow');
if (__afSlot && __INIT.addFormPickerHtml) { __afSlot.innerHTML = __INIT.addFormPickerHtml; }
if (__afSlot) { __afSlot.addEventListener('change', function () { syncCopilotOnlyFields(); }); }

/**
 * Copilot-only settings (the answer timeout, the reminder template, the add
 * form's reminder): shown only where the transport is Copilot — the toolbar's
 * when the queue's default transport is, the add form's when its picker is.
 */
function syncCopilotOnlyFields() {
  var bar = document.getElementById('copilotQueueSettings');
  if (bar) { bar.style.display = queueDefaultTransport === 'copilot' ? '' : 'none'; }
  var addRow = document.getElementById('addReminderRow');
  var addT = document.querySelector('#addTransportRow select[id$="-transport-t"]');
  var addTransport = addT && addT.value ? addT.value : queueDefaultTransport;
  if (addRow) { addRow.style.display = addTransport === 'copilot' ? '' : 'none'; }
}

/* The compaction / memory-extraction model pickers post their choice to the host. */
[['compactionModelPick', 'compaction'], ['memoryModelPick', 'memory']].forEach(function (pair) {
  var sel = document.getElementById(pair[0]);
  if (sel) { sel.addEventListener('change', function () { setCompactionModel(pair[1], sel.value); }); }
});

/* Render immediately from embedded state */
try {
  renderCompactionPickers(__INITIAL__.compactionPickers);
  applyRunSettings();
  postSettingsRun();
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
    if (msg.type === 'markdownHtml') {
      // The host's safe render of an answer (queueAnswerMarkdown): the overlay over the queue.
      tomMdOverlayShow(msg.title, msg.html);
      return;
    }
    if (msg.type === 'textEditRefused') {
      // The item went out (or was removed) before the edit could open.
      delete queueTextEdits[msg.id];
      render();
      return;
    }
    if (msg.type === 'state') {
      currentItems = msg.items || [];
      if (Array.isArray(msg.processRuns)) { processRuns = msg.processRuns; }
      if (typeof msg.currentRun === 'string') { currentRun = msg.currentRun; }
      lanes = Array.isArray(msg.lanes) ? msg.lanes : [];
      runQueueSettings = (msg.runQueueSettings && typeof msg.runQueueSettings === 'object') ? msg.runQueueSettings : {};
      // An open edit of an item that is no longer pending has nothing to save into.
      Object.keys(queueTextEdits).forEach(function(id) {
        var it = currentItems.find(function(i) { return i.id === id; });
        if (!it || it.status !== 'pending') { delete queueTextEdits[id]; }
      });
      autoSend = msg.autoSend;
      autoStart = msg.autoStart !== undefined ? msg.autoStart : false;
      autoPause = msg.autoPause !== undefined ? msg.autoPause : true;
      autoContinue = msg.autoContinue !== undefined ? msg.autoContinue : false;
      responseTimeoutMinutes = msg.responseTimeoutMinutes || 60;
      defaultReminderTemplateId = msg.defaultReminderTemplateId || '';
      reminderTemplates = msg.reminderTemplates || [];
      promptTemplates = msg.promptTemplates || [];
      anthropicProfiles = msg.anthropicProfiles || [];
      defaultProfileNoApiKey = msg.defaultProfileNoApiKey === true;
      anthropicConfigs = msg.anthropicConfigs || [];
      anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
      queueDefaultTransport = msg.queueDefaultTransport || 'copilot';
      queueDefaultSessionLabel = msg.queueDefaultSession || 'default';
      sessionInfo = msg.sessionInfo || {};
      queueDefaultAnthropicProfileId = msg.queueDefaultAnthropicProfileId || '';
      queueDefaultMessageTemplateId = msg.queueDefaultMessageTemplateId || '';
      currentContext = msg.context || { quest: '', role: '', activeProjects: [] };
      applyRunSettings();
      questRefreshActive = msg.questRefreshActive === true;
      renderCompactionPickers(msg.compactionPickers);
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

/**
 * The context bar: Quest, Role and the queue's default Agent SDK session, then
 * the active projects. Role and Session are links: a click opens a VS Code
 * picker on the host (pickRole / pickQueueDefaultSession).
 */
function updateContextSummary() {
  const el = document.getElementById('contextSummary');
  if (!el) return;
  el.textContent = '';
  const sep = () => el.appendChild(document.createTextNode('  |  '));
  const link = (pick, text, title) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'ctx-link';
    a.dataset.pick = pick;
    a.title = title;
    a.textContent = text;
    return a;
  };
  if (currentContext.quest) { el.appendChild(document.createTextNode('Quest: ' + currentContext.quest)); sep(); }
  el.appendChild(document.createTextNode('Role: '));
  el.appendChild(link('role', currentContext.role || '(none)', 'The role of the prompts — click to choose another'));
  sep();
  el.appendChild(document.createTextNode('Session: '));
  const sessionName = queueDefaultSessionLabel || 'default';
  const session = describeQueueSession(sessionName, sessionInfo[sessionName]);
  el.appendChild(link('session', sessionName + session.based,
    session.tooltip + ' — Anthropic items run in it unless they name their own. Click to pick another or create one'));
  if (currentContext.activeProjects && currentContext.activeProjects.length) {
    sep();
    el.appendChild(document.createTextNode('Projects: ' + currentContext.activeProjects.join(', ')));
  }
}

function openContextSettings() {
  vscode.postMessage({ type: 'openContextSettings' });
}

function openChatVariables() {
  vscode.postMessage({ type: 'openChatVariablesEditor' });
}

function updateQuestRefreshBanner() {
  const banner = document.getElementById('questRefreshBanner');
  if (!banner) { return; }
  banner.style.display = questRefreshActive ? 'block' : 'none';
}

function render() {
  updateQuestRefreshBanner();
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

  // The answer timeout and reminder template act on Copilot answer files only: shown when the queue sends on Copilot.
  syncCopilotOnlyFields();
  const timeoutSel = document.getElementById('responseTimeout');
  if (timeoutSel) timeoutSel.value = String(responseTimeoutMinutes || 60);


  const staged = currentItems.filter(i => i.status === 'staged').length;
  const pending = currentItems.filter(i => i.status === 'pending').length;
  const sending = currentItems.filter(i => i.status === 'sending').length;
  const sent = currentItems.filter(i => i.status === 'sent').length;
  const blocked = currentItems.filter(i => i.status === 'decision-needed').length;
  const interrupted = currentItems.filter(i => i.status === 'interrupted').length;
  // A chat send shown in the queue while it runs (never sent by the queue).
  const chatRunning = currentItems.filter(i => i.status === 'chat').length;

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
  const interruptBtn = document.getElementById('interruptForContinuationBtn');
  if (interruptBtn) {
    const canInterrupt = sending > 0;
    interruptBtn.disabled = !canInterrupt;
    interruptBtn.style.opacity = canInterrupt ? '1' : '0.4';
    interruptBtn.style.cursor = canInterrupt ? 'pointer' : 'not-allowed';
    interruptBtn.title = canInterrupt
      ? 'Interrupt for continuation (stop now; the running prompt is resent when auto-send is re-enabled)'
      : 'Interrupt for continuation — no prompt is currently running';
  }
  document.getElementById('countLabel').textContent =
    'Sending: ' + sending + '  |  Pending: ' + pending + '  |  Staged: ' + staged + '  |  Sent: ' + sent
    // Only shown when non-zero: a blocked queue looks idle otherwise, and the
    // count is the one number that explains why nothing is moving.
    + (blocked > 0 ? '  |  Decision needed: ' + blocked : '')
    + (interrupted > 0 ? '  |  Interrupted: ' + interrupted : '')
    + (chatRunning > 0 ? '  |  Chat: running' : '')
    + '  |  Timeout: ' + (responseTimeoutMinutes || 60) + 'm';

  renderRunControls();
  const list = document.getElementById('queueList');
  if (currentItems.length === 0) {
    list.innerHTML = '<div class="empty">Queue is empty</div>';
    return;
  }

  const runItems = runFilter === 'all' ? currentItems : currentItems.filter(function(i) { return queueItemRun(i) === runFilter; });
  if (runItems.length === 0) {
    list.innerHTML = '<div class="empty">No item of the run ' + escapeHtml(runFilter) + '</div>';
    return;
  }
  const sortedItems = [...runItems]
    .map(function(item, idx) { return { item: item, idx: idx }; })
    .sort(function(a, b) {
      var statusA = a.item.status || 'staged';
      var statusB = b.item.status || 'staged';
      var rankDiff = statusSortRank(statusA) - statusSortRank(statusB);
      if (rankDiff !== 0) return rankDiff;
      // Sent items and finished chat sends: one history, newest first.
      if (statusSortRank(statusA) === statusSortRank('sent')) return (new Date(b.item.createdAt || 0).getTime()) - (new Date(a.item.createdAt || 0).getTime());
      return a.idx - b.idx;
    })
    .map(function(x) { return x.item; });
  const displayItems = groupByRun ? groupItemsByRun(sortedItems) : sortedItems;

  // A prompt being edited survives the redraw a state push causes: its
  // focus, caret and scroll position are put back.
  const active = document.activeElement;
  const editFocus = active && active.classList && active.classList.contains('qe-text-edit')
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop }
    : null;
  let lastGroup = null;
  list.innerHTML = displayItems.map(function(item, idx) {
    let head = '';
    if (groupByRun) {
      const g = queueItemRun(item);
      if (g !== lastGroup) {
        const n = displayItems.filter(function(i) { return queueItemRun(i) === g; }).length;
        head = '<div class="run-group-head" data-run="' + escapeHtml(g) + '">' + (g ? '<span class="codicon codicon-run-all"></span> Run ' + escapeHtml(g) + (g === currentRun ? ' <span class="muted">(this window\'s)</span>' : '') : '<span class="codicon codicon-comment-discussion"></span> Chat sends') + ' <span class="muted">(' + n + ')</span></div>';
        lastGroup = g;
      }
    }
    return head + renderEntry(item, idx);
  }).join('');
  if (editFocus) {
    const ta = document.getElementById(editFocus.id);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(editFocus.start, editFocus.end);
      ta.scrollTop = editFocus.scroll;
    }
  }
}

/* ---- Process runs (vscimpb45) ---------------------------------------------- */

/** The run an item belongs to: its own, else its Proceed's, else `default`; '' for a chat send (outside the runs). */
function queueItemRun(item) {
  if (!item || item.status === 'chat' || item.status === 'chat-sent') { return ''; }
  return item.run || (item.processRun && item.processRun.run) || 'default';
}

/** The runs to choose from: the quest's, and any an item still names; `default` first. */
function knownRuns() {
  const set = {};
  processRuns.forEach(function(r) { set[r] = true; });
  currentItems.forEach(function(i) { const r = queueItemRun(i); if (r) { set[r] = true; } });
  return Object.keys(set).sort(function(a, b) { return a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : a > b ? 1 : 0; });
}

/** The items grouped per run (`default` first, then by name, chat sends last), each group in its order. */
function groupItemsByRun(items) {
  const order = knownRuns().concat(['']);
  return items.map(function(item, i) { return { item: item, i: i, g: order.indexOf(queueItemRun(item)) }; })
    .sort(function(a, b) { return (a.g - b.g) || (a.i - b.i); })
    .map(function(x) { return x.item; });
}

/** The toolbar's run filter, Group by run, and the add form's run picker. */
function renderRunControls() {
  const runs = knownRuns();
  if (runFilter !== 'all' && runs.indexOf(runFilter) < 0) { runFilter = 'all'; }
  const filter = document.getElementById('runFilter');
  if (filter) {
    filter.innerHTML = ['<option value="all"' + (runFilter === 'all' ? ' selected' : '') + '>All runs</option>'].concat(runs.map(function(r) {
      return '<option value="' + escapeHtml(r) + '"' + (r === runFilter ? ' selected' : '') + '>' + escapeHtml(r) + (r === currentRun ? ' (this window\'s)' : '') + '</option>';
    })).join('');
  }
  const group = document.getElementById('groupByRun');
  if (group) { group.checked = groupByRun; }
  const label = document.getElementById('settingsRunLabel');
  if (label) {
    label.textContent = 'Settings of run ' + settingsRun() + (settingsRun() === currentRun ? ' (this window\'s)' : '');
    label.title = 'The auto-send, Auto-Start / -Pause / -Continue, the defaults and the Copilot answer timeout and reminder template here are those of this run; pick another run in Run: to change its settings.';
  }
  renderLaneStrip();
  const add = document.getElementById('addRun');
  if (add) {
    const chosen = add.dataset.touched === '1' && processRuns.indexOf(add.value) >= 0 ? add.value : currentRun;
    add.innerHTML = processRuns.map(function(r) {
      return '<option value="' + escapeHtml(r) + '"' + (r === chosen ? ' selected' : '') + '>' + escapeHtml(r) + (r === currentRun ? ' (this window\'s)' : '') + '</option>';
    }).join('');
    add.onchange = function() { add.dataset.touched = '1'; };
  }
}

function saveRunViewState() {
  if (typeof vscode !== 'undefined' && vscode && typeof vscode.setState === 'function') {
    const prev = (typeof vscode.getState === 'function' && vscode.getState()) || {};
    vscode.setState(Object.assign({}, prev, { runFilter: runFilter, groupByRun: groupByRun }));
  }
}
/* A row per lane (run) — sending / pending, and Pause / Resume: the run's auto-send. */
function renderLaneStrip() {
  const strip = document.getElementById('laneStrip');
  if (!strip) { return; }
  if (lanes.length === 0) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
  strip.style.display = '';
  strip.innerHTML = lanes.map(function(l) {
    const state = l.held ? 'held' : (l.sending > 0 ? 'sending' : (l.pending > 0 ? 'waiting' : 'idle'));
    const action = l.held
      ? '<button class="lane-btn" data-run="' + escapeHtml(l.run) + '" data-held="0" title="Resume this run: its auto-send comes on and its lane sends again">Resume</button>'
      : '<button class="lane-btn" data-run="' + escapeHtml(l.run) + '" data-held="1" title="Pause this run: its auto-send goes off; its lane starts nothing and its sending item stops before its next prompt">Pause</button>';
    return '<span class="lane lane-' + state + '" data-lane="' + escapeHtml(l.run) + '">'
      + '<b>' + escapeHtml(l.run) + '</b>' + (l.run === currentRun ? ' (this window\'s)' : '')
      + ' · ' + l.sending + ' sending · ' + l.pending + ' pending'
      + (l.held ? ' · <i>paused</i>' : '') + ' ' + action + '</span>';
  }).join('');
  strip.querySelectorAll('.lane-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setRunHeld(btn.dataset.run, btn.dataset.held === '1'); });
  });
}
function setRunHeld(run, held) { vscode.postMessage({ type: 'setRunHeld', run: run, held: !!held }); }

function setRunFilter(value) {
  runFilter = value || 'all';
  saveRunViewState();
  // The toolbar's settings follow the run shown.
  postSettingsRun();
  applyRunSettings();
  render();
  if (typeof populateAddForm === 'function') { populateAddForm(); }
}
function setGroupByRun(on) { groupByRun = !!on; saveRunViewState(); render(); }

/* Editing a pending item's prompt: the draft lives here, the host holds the queue. */
function startTextEdit(id) {
  const item = currentItems.find(function(i) { return i.id === id; });
  if (!item) { return; }
  queueTextEdits[id] = item.originalText || '';
  detailsExpanded[id] = true;
  vscode.postMessage({ type: 'beginTextEdit', id });
  render();
  const ta = document.getElementById('qe-edit-' + id);
  if (ta) { ta.focus(); }
}
function textEditInput(id, value) { queueTextEdits[id] = value; }
function saveTextEdit(id) {
  if (!Object.prototype.hasOwnProperty.call(queueTextEdits, id)) { return; }
  const text = queueTextEdits[id];
  delete queueTextEdits[id];
  vscode.postMessage({ type: 'saveTextEdit', id, text });
  render();
}
function cancelTextEdit(id) {
  delete queueTextEdits[id];
  vscode.postMessage({ type: 'cancelTextEdit', id });
  render();
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

function toggleAutoSend() { vscode.postMessage({ type: 'toggleAutoSend', run: settingsRun() }); }
function toggleAutoStart() { vscode.postMessage({ type: 'toggleAutoStart', run: settingsRun() }); }
function toggleAutoPause() { vscode.postMessage({ type: 'toggleAutoPause', run: settingsRun() }); }
function toggleAutoContinue() { vscode.postMessage({ type: 'toggleAutoContinue', run: settingsRun() }); }
function restartQueue() { vscode.postMessage({ type: 'restartQueue' }); }
function stopActiveItem() { vscode.postMessage({ type: 'stopActiveItem' }); }
function interruptActiveForContinuation() { vscode.postMessage({ type: 'interruptActiveForContinuation' }); }
function sendAllStaged() { vscode.postMessage({ type: 'sendAllStaged' }); }
function setResponseTimeout(minutes) { vscode.postMessage({ type: 'setResponseTimeout', minutes: parseInt(minutes || '60', 10) || 60, run: settingsRun() }); }
function setDefaultReminderTemplate(templateId) {
  const normalizedTemplateId = templateId || '';
  defaultReminderTemplateId = normalizedTemplateId;
  const addSel = document.getElementById('addReminderTemplate');
  if (addSel) {
    addSel.value = normalizedTemplateId;
  }
  vscode.postMessage({ type: 'setDefaultReminderTemplate', templateId: normalizedTemplateId, run: settingsRun() });
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
function toggleSendBetween(id) { vscode.postMessage({ type: 'toggleSendBetween', id }); }
function sendNow(id) { vscode.postMessage({ type: 'sendNow', id }); }
function continueSending(id) { vscode.postMessage({ type: 'continueSending', id }); }
function resendLastPrompt(id) { vscode.postMessage({ type: 'resendLastPrompt', id }); }
// eslint-disable-next-line no-unused-vars -- called by a running item's resend button (queueEntryRenderFunctions.js)
function resendSendingStage(id) { vscode.postMessage({ type: 'resendSendingStage', id }); }
// eslint-disable-next-line no-unused-vars -- called by a waiting item's background-wait buttons (queueEntryRenderFunctions.js)
function backgroundWaitAction(id, action) { vscode.postMessage({ type: 'backgroundWaitAction', id, action }); }
// eslint-disable-next-line no-unused-vars -- called by the Open question button of an item waiting for an answer
function openPendingQuestion(id) { vscode.postMessage({ type: 'openPendingQuestion', id }); }
function continueOnProfile(id, profileId) { vscode.postMessage({ type: 'continueOnProfile', id, profileId }); }
// The out-of-budget panel's buttons (renderOutOfBudget): one delegated listener.
document.addEventListener('click', function(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('[data-oob-action]') : null;
  if (!btn || btn.disabled) return;
  var id = btn.getAttribute('data-oob-id');
  if (btn.getAttribute('data-oob-action') === 'resend') { resendLastPrompt(id); return; }
  var panel = btn.closest('.out-of-budget');
  var select = panel ? panel.querySelector('select[data-oob-profile]') : null;
  if (select && select.value) { continueOnProfile(id, select.value); }
});
// The answer block's markdown preview buttons (queueEntryRenderFunctions): one delegated listener.
document.addEventListener('click', function(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('.qe-md-btn') : null;
  if (!btn) return;
  queueAnswerMarkdown(btn.getAttribute('data-qid'), btn.getAttribute('data-qe-md-mode'));
});
function interruptForContinuation(id) { vscode.postMessage({ type: 'interruptForContinuation', id }); }
function resetToPending(id) { vscode.postMessage({ type: 'resetToPending', id }); }
function retryWaitingNow(id) { vscode.postMessage({ type: 'retryWaitingNow', id }); }
function retryRetryingNow(id) { vscode.postMessage({ type: 'retryRetryingNow', id }); }
function stopRetrying(id) { vscode.postMessage({ type: 'stopRetrying', id }); }
function toggleReminder(id, enabled) { vscode.postMessage({ type: 'toggleReminder', id, enabled }); }
function setPauseAfter(id, pauseAfter) { vscode.postMessage({ type: 'setPauseAfter', id, pauseAfter }); }
function updateDoneNotification(id, prompt) { vscode.postMessage({ type: 'updateDoneNotification', id, prompt: String(prompt || '') }); }
function setDoneNotificationDisabled(id, disabled) { vscode.postMessage({ type: 'setDoneNotificationDisabled', id, disabled: !!disabled }); }
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
  // The process run the item belongs to (default the window's).
  var runSel = document.getElementById('addRun');
  if (runSel && runSel.value) { msg.run = runSel.value; }
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
      pSel.innerHTML = '';
      var defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '(default profile)' + (defaultProfileNoApiKey ? NO_API_KEY_LABEL : '');
      pSel.appendChild(defOpt);
      (anthropicProfiles || []).forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = profileOptionLabel(p);
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
    profSel.innerHTML = '';
    var defProf = document.createElement('option');
    defProf.value = '';
    defProf.textContent = '(default profile)' + (defaultProfileNoApiKey ? NO_API_KEY_LABEL : '');
    profSel.appendChild(defProf);
    (anthropicProfiles || []).forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = profileOptionLabel(p);
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
  // the effective transport; both read the one template store,
  // config.anthropic.userMessageTemplates (Copilot via the
  // promptTemplates ids). Selection is blanked on
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

/**
 * The compaction and memory-extraction model pickers above the queue, from the
 * host's compactionPickerState: the Status Page's choices, '' = none chosen.
 */
function renderCompactionPickers(state) {
  // The Status Page's wording for "nothing chosen".
  const pickers = [['compactionModelPick', 'compactionModel', '(not set — no compaction)'], ['memoryModelPick', 'memoryExtractionModel', '(not set — no memory extraction)']];
  for (const [id, key, none] of pickers) {
    const sel = document.getElementById(id);
    if (!sel || !state) { continue; }
    const value = state[key] || '';
    const choices = state.choices || [];
    const options = ['<option value="">' + none + '</option>'].concat(choices.map((c) =>
      '<option value="' + escapeHtml(c.value) + '"' + (c.value === value ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>'));
    if (value && !choices.some((c) => c.value === value)) {
      options.push('<option value="' + escapeHtml(value) + '" selected>' + escapeHtml(value) + ' (not configured)</option>');
    }
    sel.innerHTML = options.join('');
    sel.value = value;
  }
}

function setCompactionModel(purpose, value) {
  vscode.postMessage({ type: 'setCompactionModel', purpose: purpose, value: value || '' });
}
