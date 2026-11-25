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
//   2. The codicons stylesheet and the add form's transport picker are
//      injected at runtime from __INIT__ (codiconsUri / addFormPickerHtml) —
//      see index.html for why (no node_modules placeholder, picker rendered
//      host-side). The run's default transport, profile and template are links
//      in the context bar (host pickers).

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
/** "From the chat panel only" (the toolbar's filter): kept with the view's state. */
let chatOnly = __runViewState.chatOnly === true;
/** An item queued from the @CHAT panel: a chat send, or queued with its Save to Queue / Queue next. */
function isFromChatPanel(item) {
  return !!item && (!!item.fromChatPanel || !!item.chatSource || item.status === 'chat' || item.status === 'chat-sent');
}
/** The filter button: on, the list shows only the items from the chat panel. */
function toggleChatOnly() {
  chatOnly = !chatOnly;
  if (typeof vscode !== 'undefined' && vscode && typeof vscode.setState === 'function') {
    const prev = (typeof vscode.getState === 'function' && vscode.getState()) || {};
    vscode.setState(Object.assign({}, prev, { chatOnly: chatOnly }));
  }
  render();
}
function renderChatOnlyButton() {
  const btn = document.getElementById('chatOnlyBtn');
  if (!btn) { return; }
  btn.classList.toggle('active', chatOnly);
  btn.setAttribute('aria-pressed', chatOnly ? 'true' : 'false');
  btn.style.opacity = chatOnly ? '1' : '0.5';
  btn.title = chatOnly
    ? 'From the chat panel only: on — only the items queued from the @CHAT panel and its chat sends are shown. Click to show every item'
    : 'From the chat panel only: show only the items queued from the @CHAT panel (its Save to Queue and Queue next buttons) and its chat sends';
}
// One tab per run (vscimpb60b): the selected tab is kept in the view state over a reload; the window's run first.
let selectedRun = typeof __runViewState.queueTab === 'string' && __runViewState.queueTab ? __runViewState.queueTab : currentRun;
// The lanes, one per run (each says whether its run is paused), and the queue settings of each run (from the host).
let lanes = Array.isArray(__INITIAL__.lanes) ? __INITIAL__.lanes : [];
let runQueueSettings = (__INITIAL__.runQueueSettings && typeof __INITIAL__.runQueueSettings === 'object') ? __INITIAL__.runQueueSettings : {};
// The start values (queue-settings.yaml's top-level keys): what a run without settings of its own starts from (vscimpb60g).
let startQueueSettings = (__INITIAL__.startQueueSettings && typeof __INITIAL__.startQueueSettings === 'object') ? __INITIAL__.startQueueSettings : null;
/* The settings Make default copies (utils/runQueueSettings.ts DEFAULT_SETTING_FIELDS): every per-run setting a tab shows. */
const DEFAULT_SETTING_FIELDS = ['autoSend', 'autoStart', 'autoPause', 'autoContinue', 'responseTimeoutMinutes', 'defaultReminderTemplateId',
  'defaultTransport', 'defaultAnthropicProfileId', 'defaultAnthropicConfigId', 'defaultAgentSdkSession', 'defaultMessageTemplateId', 'defaultRole'];

/** The shown settings in which the tab's run differs from the start values ([] = Make default has nothing to write). */
function defaultSettingsDiff() {
  const s = runQueueSettings[settingsRun()];
  if (!s || !startQueueSettings) { return []; }
  return DEFAULT_SETTING_FIELDS.filter(function(f) {
    const a = s[f] === undefined || s[f] === null ? '' : s[f];
    const b = startQueueSettings[f] === undefined || startQueueSettings[f] === null ? '' : startQueueSettings[f];
    return a !== b;
  });
}

/** The Make default button: enabled only while the tab's settings differ from the start values. */
function renderMakeDefault() {
  const btn = document.getElementById('makeDefaultBtn');
  if (!btn) { return; }
  const diff = defaultSettingsDiff();
  btn.disabled = diff.length === 0;
  btn.style.opacity = diff.length ? '1' : '0.4';
  btn.title = diff.length
    ? 'Make these settings the default for new runs (run ' + settingsRun() + ' differs in: ' + diff.join(', ') + ')'
    : 'Make these settings the default for new runs (they already are)';
}

/** The run of the selected tab: its items, its toolbar and its settings. */
function settingsRun() { return selectedRun || currentRun; }

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

/**
 * The session a run's items run in when they name none, as runQueueSession
 * (src/utils/runSessions.ts) resolves it: the queue default in the `default`
 * run, `<default>@<run>` in any other (`chat`, `tmp-…` and a name already
 * naming its run are kept).
 */
function runQueueSessionName(queueDefault, run) {
  const base = queueDefault || 'default';
  if (!run || run === 'default') { return base; }
  if (base.indexOf('@') >= 0 || base === 'chat' || base.indexOf('tmp-') === 0) { return base; }
  return base + '@' + run;
}

/** How a session is shown: the `default` run's queue session `default` as `default@default`, like every run's `default@<run>`. */
function sessionDisplayName(name) { return name === 'default' ? 'default@default' : name; }

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
// Each run's context for its tab's links: position, role, chat variables (vscimpb60c; from the host).
let runContexts = (__INITIAL__.runContexts && typeof __INITIAL__.runContexts === 'object') ? __INITIAL__.runContexts : {};
/* The guideline picker's sections and shared levels (gsel5, services/aspectPickerState.ts): quest default, window, roles. */
let aspectState = (__INITIAL__.aspects && typeof __INITIAL__.aspects === 'object') ? __INITIAL__.aspects : null;
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
// The context bar's links act on the tab's run: Role and Session open VS Code pickers on the host, Position
// opens the run's process state file, Variables the Chat Variables editor for the run (vscimpb60c).
// Both context bars: the run's context and its defaults.
['contextSummary', 'runDefaultsSummary'].forEach(function(barId) {
  var __ctxSummary = document.getElementById(barId);
  if (!__ctxSummary) { return; }
  __ctxSummary.addEventListener('click', function(e) {
    var link = e.target && e.target.closest ? e.target.closest('.ctx-link') : null;
    if (!link) { return; }
    e.preventDefault();
    var pick = link.dataset.pick;
    // The run's guidelines open the picker (the document's aspect listener below).
    if (pick === 'guidelines') { return; }
    vscode.postMessage(pick === 'role' ? { type: 'pickRole' }
      : pick === 'position' ? { type: 'openRunStateFile', run: settingsRun() }
      : pick === 'variables' ? { type: 'openChatVariablesEditor', run: settingsRun() }
      : pick === 'defaultRole' ? { type: 'pickQueueDefaultRole', run: settingsRun() }
      : pick === 'transport' ? { type: 'pickQueueDefaultTransport', run: settingsRun() }
      : pick === 'profile' ? { type: 'pickQueueDefaultProfile', run: settingsRun() }
      : pick === 'template' ? { type: 'pickQueueDefaultTemplate', run: settingsRun() }
      : { type: 'pickQueueDefaultSession', run: settingsRun() });
  });
});
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
  // The defaults row holding them goes with them.
  var row = document.getElementById('copilotDefaultsRow');
  if (row) { row.style.display = queueDefaultTransport === 'copilot' ? '' : 'none'; }
  var addRow = document.getElementById('addReminderRow');
  var addT = document.querySelector('#addTransportRow select[id$="-transport-t"]');
  var addTransport = addT && addT.value ? addT.value : queueDefaultTransport;
  if (addRow) { addRow.style.display = addTransport === 'copilot' ? '' : 'none'; }
}

/* Night mode (services/nightMode.ts): the button shows the window's night-mode chat variable; a click asks the host. */
function renderNightMode(on) {
  const btn = document.getElementById('nightModeBtn');
  if (!btn) { return; }
  btn.classList.toggle('active', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.style.opacity = on ? '1' : '0.55';
  btn.title = on
    ? 'Night mode: on — the agents work on without asking, take the decisions themselves and record them for the morning (chat variable night-mode, the Interaction level guideline). Click to switch it off, here or in every window'
    : 'Night mode: off — click to switch it on (here or in every window): the agents then work on without asking and record the decisions they take for the morning';
}
const nightModeBtn = document.getElementById('nightModeBtn');
if (nightModeBtn) { nightModeBtn.addEventListener('click', function () { vscode.postMessage({ type: 'toggleNightMode' }); }); }

/* The compaction / memory-extraction model buttons open VS Code's picker on the host (gsel22). */
document.querySelectorAll('[data-pick-model]').forEach(function (a) {
  a.addEventListener('click', function (ev) {
    ev.preventDefault();
    vscode.postMessage({ type: 'pickCompactionModel', purpose: a.dataset.pickModel === 'memory' ? 'memory' : 'compaction' });
  });
});

/* Render immediately from embedded state */
try {
  renderCompactionPickers(__INITIAL__.compactionPickers);
  renderNightMode(__INITIAL__.nightMode === true);
  renderAspectToolbar();
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
      startQueueSettings = (msg.startQueueSettings && typeof msg.startQueueSettings === 'object') ? msg.startQueueSettings : null;
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
      runContexts = (msg.runContexts && typeof msg.runContexts === 'object') ? msg.runContexts : {};
      applyRunSettings();
      questRefreshActive = msg.questRefreshActive === true;
      renderCompactionPickers(msg.compactionPickers);
      renderNightMode(msg.nightMode === true);
      aspectState = (msg.aspects && typeof msg.aspects === 'object') ? msg.aspects : null;
      renderAspectToolbar();
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
 * The two context bars of the tab's run, one field per setting: its label above, its value below
 * (`.ctx-field`: `.ctx-label` over `.ctx-value`).
 *   - #contextSummary (with the icon buttons): Position, Role, Default role, Guidelines, Variables.
 *   - #runDefaultsSummary: the defaults the run's items take — Transport, Model (the Anthropic
 *     profile; Anthropic only), Session, Template — label-less (gsel22): the value alone, what it
 *     is in its hover help.
 * A value that can be changed is a link (`.ctx-link`, `data-pick`): a click opens a VS Code picker
 * on the host (role, default role, transport, profile, session, template), the guideline picker,
 * the run's state file or its chat variables. Quest and run are not shown: the window's title and
 * the run tabs show them.
 */
function updateContextSummary() {
  const el = document.getElementById('contextSummary');
  if (!el) return;
  const defaultsEl = document.getElementById('runDefaultsSummary');
  el.textContent = '';
  if (defaultsEl) { defaultsEl.textContent = ''; }
  const link = (pick, text, title) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'ctx-link';
    a.dataset.pick = pick;
    a.title = title;
    a.textContent = text;
    return a;
  };
  const plain = (text, title) => {
    const t = document.createElement('span');
    t.className = 'ctx-text';
    t.textContent = text;
    if (title) { t.title = title; }
    return t;
  };
  const field = (target, label, value, key) => {
    if (!target) { return undefined; }
    const f = document.createElement('span');
    f.className = 'ctx-field';
    if (key) { f.dataset.field = key; }
    const l = document.createElement('span');
    l.className = 'ctx-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'ctx-value';
    v.appendChild(value);
    f.appendChild(l);
    f.appendChild(v);
    target.appendChild(f);
    return f;
  };
  // The tab's run's context (vscimpb60c): its position, role and chat variables.
  const run = settingsRun();
  const ctx = runContexts[run] || {};
  const settings = runQueueSettings[run] || {};
  el.dataset.run = run;
  field(el, 'Position', link('position', ctx.position || '(no process)',
    'The process position of run ' + run + (ctx.process ? ' (' + ctx.process + ')' : '') + ' — click to open its state file'), 'position');
  if (run === currentRun) {
    field(el, 'Role', link('role', currentContext.role || '(none)', 'The role of the prompts — click to choose another'), 'role');
  } else {
    const roleText = plain(ctx.role || '(none)', 'The role run ' + run + '\'s step names (its Proceed prompts run in it)');
    roleText.classList.add('ctx-run-role');
    field(el, 'Role', roleText, 'role');
  }
  // The run's default role (gsel3): what its items run as when neither their todo, they nor a step name one.
  field(el, 'Default role', link('defaultRole', settings.defaultRole || '(none)',
    'The role run ' + run + '\'s items run as when neither their todo, the item nor a process step names one — click to choose another'), 'defaultRole');
  // The run's guideline selection (gsel5, P-3): a short value — how many aspects the run chose itself, else
  // "Click to select" — since the whole selection does not fit the field; the selection, the run's own starred,
  // is the hover help, and a click opens its picker.
  const runAspects = runAspectView(run);
  if (runAspects) {
    const own = runAspects.sections.filter(function(s) { return s.here !== undefined; }).length;
    const g = link('guidelines', own ? own + ' set by the run' : 'Click to select',
      window.TomAspectPicker.hoverText(runAspects, 'Guidelines of run ' + run) + '\n(* chosen by the run: '
        + window.TomAspectPicker.summary(runAspects, { star: true }) + ') — click to choose');
    g.dataset.aspectOpen = 'run';
    g.id = 'runAspectLink';
    field(el, 'Guidelines', g, 'guidelines');
  }
  const vars = ctx.variables || {};
  const names = Object.keys(vars);
  field(el, 'Variables', link('variables', String(names.length),
    'The chat variables of run ' + run + (names.length ? ': ' + names.map(function(k) { return k + '=' + vars[k]; }).join(', ') : ' (none of its own)') + ' — click to open them'), 'variables');

  // The run's defaults for its items: transport, model (the Anthropic profile), session, template —
  // label-less choice buttons (gsel22): the value as link text, what it is in its hover help.
  const bare = (target, label, value, key) => {
    if (!target) { return undefined; }
    const f = document.createElement('span');
    f.className = 'ctx-field ctx-field-bare';
    if (key) { f.dataset.field = key; }
    value.title = label + ': ' + value.title;
    f.appendChild(value);
    target.appendChild(f);
    return f;
  };
  const transport = settings.defaultTransport === 'anthropic' ? 'anthropic' : 'copilot';
  bare(defaultsEl, 'Transport', link('transport', transport === 'anthropic' ? 'Anthropic' : 'Copilot',
    'The transport run ' + run + '\'s items are sent with unless they name their own — click to choose'), 'transport');
  if (transport === 'anthropic') {
    const pid = settings.defaultAnthropicProfileId || '';
    const profile = (anthropicProfiles || []).find(function(p) { return p && p.id === pid; });
    bare(defaultsEl, 'Model', link('profile', pid ? (profile && profile.name ? profile.name : pid) : '(default profile)',
      'The Anthropic profile (its model and configuration) run ' + run + '\'s items are sent with unless they name their own — click to choose'), 'profile');
  }
  const sessionName = runQueueSessionName(queueDefaultSessionLabel, run);
  const session = describeQueueSession(sessionName, sessionInfo[sessionName]);
  bare(defaultsEl, 'Session', link('session', sessionDisplayName(sessionName) + session.based,
    session.tooltip + ' — Anthropic items run in it unless they name their own. Click to pick another or create one'), 'session');
  const tplId = settings.defaultMessageTemplateId || '';
  const tpl = (anthropicUserMessageTemplates || []).find(function(t) { return t && t.id === tplId; });
  bare(defaultsEl, 'Template', link('template', tplId ? (tpl && tpl.name ? tpl.name : tplId) : '(none)',
    'The prompt template run ' + run + '\'s items take unless they name their own ("Run default") — click to choose'), 'template');
}

function openReminderSettings() {
  vscode.postMessage({ type: 'openReminderSettings' });
}

function openChatVariables() {
  vscode.postMessage({ type: 'openChatVariablesEditor', run: settingsRun() });
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

  renderMakeDefault();
  renderChatOnlyButton();

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


  renderRunTabs();
  // The selected tab is its run's queue: its items only, counted for its toolbar.
  const runItems = currentItems.filter(function(i) { return tabRunOf(i) === settingsRun(); });
  const staged = runItems.filter(i => i.status === 'staged').length;
  const pending = runItems.filter(i => i.status === 'pending').length;
  const sending = runItems.filter(i => i.status === 'sending').length;
  const sent = runItems.filter(i => i.status === 'sent').length;
  const blocked = runItems.filter(i => i.status === 'decision-needed').length;
  const todoBlocked = runItems.filter(i => i.status === 'todo-blocked').length;
  const interrupted = runItems.filter(i => i.status === 'interrupted').length;
  // A chat send shown in the queue while it runs (never sent by the queue).
  const chatRunning = runItems.filter(i => i.status === 'chat').length;

  const stopBtn = document.getElementById('stopActiveBtn');
  if (stopBtn) {
    // A held item (blocked at a todo) is stopped too: back to staged.
    const hasSending = sending > 0 || todoBlocked > 0;
    stopBtn.disabled = !hasSending;
    stopBtn.style.opacity = hasSending ? '1' : '0.4';
    stopBtn.style.cursor = hasSending ? 'pointer' : 'not-allowed';
    stopBtn.title = sending > 0
      ? 'Stop currently running prompt (revert to staged)'
      : todoBlocked > 0
        ? 'Stop the item held at a blocked todo (revert to staged)'
        : 'Stop — no prompt is currently running';
  }
  const interruptBtn = document.getElementById('interruptForContinuationBtn');
  if (interruptBtn) {
    const canInterrupt = sending > 0 || todoBlocked > 0;
    // The tab's sending item (vscimpb112): after the first click it shows the stop icon — a second click is the hard interrupt.
    const sendingItem = runItems.find(i => i.status === 'sending');
    interruptBtn.disabled = !canInterrupt;
    interruptBtn.style.opacity = canInterrupt ? '1' : '0.4';
    interruptBtn.style.cursor = canInterrupt ? 'pointer' : 'not-allowed';
    interruptBtn.title = sendingItem
      ? interruptButtonTitle(sendingItem)
      : canInterrupt
        ? 'Interrupt the item held at a blocked todo (it has no turn running: it goes back to staged)'
        : 'Interrupt for continuation — no prompt is currently running';
    const icon = interruptBtn.querySelector('.codicon');
    if (icon) {
      icon.className = 'codicon ' + (sendingItem ? interruptButtonIcon(sendingItem) : 'codicon-debug-disconnect');
    }
  }
  document.getElementById('countLabel').textContent =
    'Sending: ' + sending + '  |  Pending: ' + pending + '  |  Staged: ' + staged + '  |  Sent: ' + sent
    // Only shown when non-zero: a blocked queue looks idle otherwise, and the
    // count is the one number that explains why nothing is moving.
    + (blocked > 0 ? '  |  Decision needed: ' + blocked : '')
    + (todoBlocked > 0 ? '  |  Blocked: ' + todoBlocked : '')
    + (interrupted > 0 ? '  |  Interrupted: ' + interrupted : '')
    + (chatRunning > 0 ? '  |  Chat: running' : '')
    + '  |  Timeout: ' + (responseTimeoutMinutes || 60) + 'm';

  renderAddRun();
  const list = document.getElementById('queueList');
  if (runItems.length === 0) {
    list.innerHTML = '<div class="empty">The queue of run ' + escapeHtml(settingsRun()) + ' is empty</div>';
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
  const displayItems = chatOnly ? sortedItems.filter(isFromChatPanel) : sortedItems;
  if (displayItems.length === 0) {
    list.innerHTML = '<div class="empty">No item of run ' + escapeHtml(settingsRun()) + ' comes from the chat panel (the filter is on)</div>';
    return;
  }

  // A prompt being edited survives the redraw a state push causes: its
  // focus, caret and scroll position are put back.
  const active = document.activeElement;
  const editFocus = active && active.classList && (active.classList.contains('qe-text-edit') || active.classList.contains('keep-focus'))
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop }
    : null;
  list.innerHTML = displayItems.map(function(item, idx) { return renderEntry(item, idx); }).join('');
  if (editFocus) {
    const ta = document.getElementById(editFocus.id);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(editFocus.start, editFocus.end);
      ta.scrollTop = editFocus.scroll;
    }
  }
}

/* ---- Process runs: one tab per run (vscimpb45, vscimpb60b) ------------------- */

/** The tab an item shows in: its run (its own, else its Proceed's); a chat send the run it ran in; else `default`. */
function tabRunOf(item) {
  if (!item) { return 'default'; }
  return item.run || (item.processRun && item.processRun.run) || 'default';
}

/** The tabs: the quest's runs and any run that has items; `default` first. */
function knownRuns() {
  const set = {};
  processRuns.forEach(function(r) { set[r] = true; });
  currentItems.forEach(function(i) { set[tabRunOf(i)] = true; });
  return Object.keys(set).sort(function(a, b) { return a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : a > b ? 1 : 0; });
}

/**
 * Whether `run`'s tab belongs to a deleted run (vscimpb86): it is not among the quest's runs any more and
 * shows only because items still name it. `default` never is. Decided on every render, so a run created
 * again under the same name is a live tab again.
 */
function isOrphanedRun(run) {
  return run !== 'default' && processRuns.indexOf(run) < 0;
}

/**
 * What a run's tab shows (vscimpb112), in this precedence: `held` (a soft interrupt holds its sending item),
 * `question` (its turn waits for the user's answer), `wait` (its turn waits in tomAi_waitFor), `sending`, `paused`
 * (auto-send off, or a hard-interrupted item), `waiting` (pending items), `idle`.
 */
function runTabState(run) {
  const items = currentItems.filter(function(i) { return tabRunOf(i) === run && i.status !== 'chat' && i.status !== 'chat-sent'; });
  const sendingItems = items.filter(function(i) { return i.status === 'sending'; });
  if (sendingItems.some(function(i) { return i.softInterruptView && i.softInterruptView.phase === 'held'; })) { return 'held'; }
  if (sendingItems.some(function(i) { return Array.isArray(i.waitingForUser) && i.waitingForUser.indexOf('question') >= 0; })) { return 'question'; }
  if (sendingItems.some(function(i) { return i.waitForView; })) { return 'wait'; }
  if (sendingItems.length > 0) { return 'sending'; }
  const settings = runQueueSettings[run];
  if ((settings && settings.autoSend === false) || items.some(function(i) { return i.status === 'interrupted'; })) { return 'paused'; }
  if (items.some(function(i) { return i.status === 'pending'; })) { return 'waiting'; }
  return 'idle';
}

/** The tab's tooltip text beyond its state word: what holds or waits (vscimpb112; tomAi_waitFor, vscimpb82). */
function runTabNote(run, state) {
  const sendingItem = currentItems.find(function(i) {
    if (tabRunOf(i) !== run || i.status !== 'sending') { return false; }
    if (state === 'held') { return i.softInterruptView && i.softInterruptView.phase === 'held'; }
    if (state === 'question') { return Array.isArray(i.waitingForUser) && i.waitingForUser.indexOf('question') >= 0; }
    if (state === 'wait') { return !!i.waitForView; }
    return !!(i.softInterruptView);
  });
  if (!sendingItem) { return ''; }
  if (state === 'held') { return '; ' + escapeHtml(softInterruptText(sendingItem.softInterruptView)); }
  if (state === 'question') { return '; ' + escapeHtml(questionText(sendingItem)); }
  if (state === 'wait') { return '; waiting: ' + escapeHtml(waitForText(sendingItem.waitForView)); }
  return sendingItem.softInterruptView ? '; ' + escapeHtml(softInterruptText(sendingItem.softInterruptView)) : '';
}

/** A run tab's state: its icon (a codicon, or an emoji) and word (a function, so the first render — before this point of the script — can use it). */
function runTabStateView(state) {
  return {
    held: { icon: 'codicon-debug-disconnect', label: 'held for continuation' },
    question: { emoji: '\u2753', label: 'answer needed' },
    wait: { emoji: '\u23f3', label: 'waiting (tomAi_waitFor)' },
    sending: { icon: 'codicon-sync', label: 'sending' },
    waiting: { icon: 'codicon-clock', label: 'waiting' },
    paused: { icon: 'codicon-debug-pause', label: 'paused' },
    idle: { icon: 'codicon-circle-outline', label: 'idle' },
  }[state];
}

/** The tab's icon markup. */
function runTabIconHtml(view) {
  return view.emoji
    ? '<span class="run-tab-emoji"' + (view.emoji === '\u2753' ? ' style="color:#e51400;"' : '') + '>' + view.emoji + '</span>'
    : '<span class="codicon ' + view.icon + '"></span>';
}

/** The tab row: one tab per run, the selected one marked; a click switches to that run's queue. */
function renderRunTabs() {
  const runs = knownRuns();
  if (runs.indexOf(selectedRun) < 0) { selectedRun = runs.indexOf(currentRun) >= 0 ? currentRun : runs[0]; }
  const row = document.getElementById('runTabs');
  if (!row) { return; }
  row.innerHTML = runs.map(function(run) {
    const state = runTabState(run);
    const n = currentItems.filter(function(i) { return tabRunOf(i) === run && i.status !== 'sent' && i.status !== 'chat-sent'; }).length;
    const active = run === selectedRun;
    const orphaned = isOrphanedRun(run);
    const tab = '<button class="run-tab run-tab-' + state + (active ? ' active' : '') + (orphaned ? ' run-tab-orphaned' : '') + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '"'
      + ' data-run="' + escapeHtml(run) + '" data-state="' + state + '"' + (orphaned ? ' data-orphaned="true"' : '')
      + ' title="Run ' + escapeHtml(run) + (orphaned ? ' (deleted run: its items are kept until you remove its queue)' : '') + (run === currentRun ? ' (this window\'s run)' : '') + ': ' + runTabStateView(state).label + (n ? ', ' + n + ' open item' + (n === 1 ? '' : 's') : '') + runTabNote(run, state) + '">'
      + runTabIconHtml(runTabStateView(state)) + ' ' + escapeHtml(run)
      + (orphaned ? ' <span class="muted run-tab-deleted">(deleted run)</span>' : '')
      + (run === currentRun ? ' <span class="muted">(this window)</span>' : '')
      + (n ? ' <span class="run-tab-count">' + n + '</span>' : '')
      + '</button>';
    // A deleted run's tab: remove its queue (the host confirms and deletes its items).
    const remove = orphaned
      ? '<button class="run-tab-remove" data-run="' + escapeHtml(run) + '" title="Remove this deleted run\'s queue: delete its items" aria-label="Remove the queue of the deleted run ' + escapeHtml(run) + '"><span class="codicon codicon-trash"></span></button>'
      : '';
    return '<span class="run-tab-wrap">' + tab + remove + '</span>';
  }).join('');
  row.querySelectorAll('.run-tab').forEach(function(btn) {
    btn.addEventListener('click', function() { selectRunTab(btn.dataset.run); });
  });
  row.querySelectorAll('.run-tab-remove').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'removeRunQueue', run: btn.dataset.run });
    });
  });
}

/** The add form adds to the selected tab's run (shown, not chosen). */
function renderAddRun() {
  const label = document.getElementById('addRunLabel');
  if (label) { label.textContent = 'Run: ' + settingsRun() + (settingsRun() === currentRun ? ' (this window\'s)' : ''); }
}

function saveRunViewState() {
  if (typeof vscode !== 'undefined' && vscode && typeof vscode.setState === 'function') {
    const prev = (typeof vscode.getState === 'function' && vscode.getState()) || {};
    vscode.setState(Object.assign({}, prev, { queueTab: selectedRun }));
  }
}

/** Switch to a run's tab: its items, its toolbar, its settings. */
/** Where each run tab's list was scrolled to: a tab opens where it was left. */
const runScrollTops = {};

function selectRunTab(run) {
  const scroller = document.getElementById('queueScroll');
  if (scroller) { runScrollTops[selectedRun] = scroller.scrollTop; }
  selectedRun = run || currentRun;
  saveRunViewState();
  postSettingsRun();
  applyRunSettings();
  render();
  updateContextSummary();
  if (typeof populateAddForm === 'function') { populateAddForm(); }
  if (scroller) { scroller.scrollTop = runScrollTops[selectedRun] || 0; }
}

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

/** The items of the selected tab (Collapse / Expand act on them). */
function tabItems() { return currentItems.filter(function(i) { return tabRunOf(i) === settingsRun(); }); }

function collapseAll() {
  const items = tabItems();
  items.forEach(function(item) { detailsExpanded[item.id] = false; });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: items.map(function(item) { return item.id; }), expanded: false });
  render();
}

function expandAll() {
  const items = tabItems();
  items.forEach(function(item) { detailsExpanded[item.id] = true; });
  vscode.postMessage({ type: 'setAllDetailsExpanded', ids: items.map(function(item) { return item.id; }), expanded: true });
  render();
}

function toggleAutoSend() { vscode.postMessage({ type: 'toggleAutoSend', run: settingsRun() }); }
function toggleAutoStart() { vscode.postMessage({ type: 'toggleAutoStart', run: settingsRun() }); }
function toggleAutoPause() { vscode.postMessage({ type: 'toggleAutoPause', run: settingsRun() }); }
function toggleAutoContinue() { vscode.postMessage({ type: 'toggleAutoContinue', run: settingsRun() }); }
function makeRunSettingsDefault() {
  if (!defaultSettingsDiff().length) { return; }
  vscode.postMessage({ type: 'makeRunSettingsDefault', run: settingsRun() });
}
/** The run's default template (its queue settings), for the "Run default" entry of an item's template select. */
function runDefaultTemplateOf(item) {
  const s = runQueueSettings[item ? tabRunOf(item) : settingsRun()];
  return (s && s.defaultMessageTemplateId) || '';
}

// ---- Move items to another run: an overlay over the queue ----
/** Why an item of the tab cannot move, or '' (as PromptQueueManager.moveItemToRun refuses). */
function moveBlockedReason(item) {
  if (item.processMove) { return 'a process-move marker stays with its Proceed run'; }
  if (item.processRun) { return 'it belongs to a Proceed run'; }
  if (item.status !== 'staged' && item.status !== 'pending') { return 'only staged and pending items move (this one is ' + item.status + ')'; }
  return '';
}

/** The overlay: the tab's items with a peek of their prompt, checkboxes, Select all, the target run, Move. */
function openMoveItemsOverlay() {
  closeMoveItemsOverlay();
  const run = settingsRun();
  const items = currentItems.filter(function(i) { return tabRunOf(i) === run; });
  const targets = processRuns.filter(function(r) { return r !== run; });
  const overlay = document.createElement('div');
  overlay.className = 'move-items-overlay';
  overlay.id = 'moveItemsOverlay';
  const rows = items.map(function(item) {
    const why = moveBlockedReason(item);
    const text = String(item.originalText || item.expandedText || '');
    const first = (text.split('\n').find(function(l) { return l.trim(); }) || '(empty)').trim();
    const meta = [item.status, item.transport || '', item.session ? 'session ' + item.session : '', item.role ? 'role ' + item.role : '',
      item.template && item.template !== '(None)' ? 'template ' + item.template : ''].filter(Boolean);
    return '<label class="move-item' + (why ? ' disabled' : '') + '"' + (why ? ' title="' + escapeHtml(why) + '"' : '') + '>' +
      '<input type="checkbox" data-move-id="' + escapeHtml(item.id) + '"' + (why ? ' disabled' : '') + '>' +
      '<span class="move-item-body"><span class="move-item-meta"><b>' + escapeHtml(first.length > 90 ? first.slice(0, 88) + '…' : first) + '</b>' +
      meta.map(function(m) { return '<span>' + escapeHtml(m) + '</span>'; }).join('') + (why ? '<span>— ' + escapeHtml(why) + '</span>' : '') + '</span>' +
      '<pre class="move-item-peek" title="Click to see more of the prompt">' + escapeHtml(text.slice(0, 4000)) + '</pre></span></label>';
  }).join('');
  overlay.innerHTML = '<div class="move-items-box" role="dialog" aria-label="Move items to another run">' +
    '<div class="move-items-head"><span class="codicon codicon-arrow-swap"></span><span class="grow">Move items of run ' + escapeHtml(run) + ' to another run</span>' +
      '<button class="ctx-btn-icon" id="moveItemsClose" title="Close"><span class="codicon codicon-close"></span></button></div>' +
    '<div class="move-items-head" style="font-weight:normal"><label><input type="checkbox" id="moveItemsAll"> Select all</label><span class="grow"></span>' +
      '<span class="move-items-note" id="moveItemsCount"></span></div>' +
    '<div class="move-items-list">' + (rows || '<div class="move-items-note">This run has no items.</div>') + '</div>' +
    '<div class="move-items-foot"><label>To run <select id="moveItemsTarget">' +
      targets.map(function(r) { return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>'; }).join('') + '</select></label>' +
      '<span class="move-items-note grow">' + (targets.length ? 'Moved items lose their own profile, session, role and template: they follow the target run\'s defaults.' : 'The quest has no other run (create one in the PROCESS view).') + '</span>' +
      '<button id="moveItemsCancel">Cancel</button><button id="moveItemsGo" class="primary">Move</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const boxes = function() { return Array.prototype.slice.call(overlay.querySelectorAll('input[data-move-id]:not([disabled])')); };
  const update = function() {
    const all = boxes();
    const picked = all.filter(function(b) { return b.checked; });
    const allBox = document.getElementById('moveItemsAll');
    allBox.checked = all.length > 0 && picked.length === all.length;
    allBox.indeterminate = picked.length > 0 && picked.length < all.length;
    allBox.disabled = all.length === 0;
    document.getElementById('moveItemsCount').textContent = picked.length + ' of ' + all.length + ' movable item' + (all.length === 1 ? '' : 's') + ' selected';
    document.getElementById('moveItemsGo').disabled = picked.length === 0 || targets.length === 0;
  };
  overlay.addEventListener('change', function(e) {
    if (e.target && e.target.id === 'moveItemsAll') { boxes().forEach(function(b) { b.checked = e.target.checked; }); }
    update();
  });
  overlay.addEventListener('click', function(e) {
    const t = e.target;
    if (t === overlay || (t.closest && (t.closest('#moveItemsClose') || t.closest('#moveItemsCancel')))) { closeMoveItemsOverlay(); return; }
    if (t.classList && t.classList.contains('move-item-peek')) { e.preventDefault(); t.classList.toggle('open'); return; }
    if (t.closest && t.closest('#moveItemsGo')) {
      const ids = boxes().filter(function(b) { return b.checked; }).map(function(b) { return b.getAttribute('data-move-id'); });
      const to = document.getElementById('moveItemsTarget').value;
      if (!ids.length || !to) { return; }
      vscode.postMessage({ type: 'moveItemsToRun', ids: ids, run: to });
      closeMoveItemsOverlay();
    }
  });
  document.addEventListener('keydown', moveItemsEscape);
  update();
}
function moveItemsEscape(e) { if (e.key === 'Escape') { closeMoveItemsOverlay(); } }
function closeMoveItemsOverlay() {
  const old = document.getElementById('moveItemsOverlay');
  if (old) { old.remove(); }
  document.removeEventListener('keydown', moveItemsEscape);
}

/** Apply run defaults to all items: the host asks which settings (profile, template, session, role) and whether to remove the items' own. */
function applyRunDefaultsToItems() { vscode.postMessage({ type: 'applyRunDefaultsToItems', run: settingsRun() }); }
function restartQueue() { vscode.postMessage({ type: 'restartQueue', run: settingsRun() }); }
function stopActiveItem() { vscode.postMessage({ type: 'stopActiveItem', run: settingsRun() }); }
function interruptActiveForContinuation() { vscode.postMessage({ type: 'interruptActiveForContinuation', run: settingsRun() }); }
function sendAllStaged() { vscode.postMessage({ type: 'sendAllStaged', run: settingsRun() }); }
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
function clearSent() { vscode.postMessage({ type: 'clearSent', run: settingsRun() }); }
function clearAll() { vscode.postMessage({ type: 'clearAll', run: settingsRun() }); }
function retryAllErrors() { vscode.postMessage({ type: 'retryAllErrors', run: settingsRun() }); }
function clearErrors() { vscode.postMessage({ type: 'clearErrors', run: settingsRun() }); }
function remove(id) { vscode.postMessage({ type: 'remove', id }); }
function moveUp(id) { vscode.postMessage({ type: 'moveUp', id }); }
function moveDown(id) { vscode.postMessage({ type: 'moveDown', id }); }
function moveToFront(id) { vscode.postMessage({ type: 'moveToFront', id }); }
function toggleSendBetween(id) { vscode.postMessage({ type: 'toggleSendBetween', id }); }
/** Let the next item go first (vscimpb60e); again while armed: keep iterating. */
// eslint-disable-next-line no-unused-vars -- called by the item's step-over button (onclick, queueEntryRenderFunctions.js)
function letNextGoFirst(id) { vscode.postMessage({ type: 'letNextGoFirst', id }); }
/** The run chip of a staged or pending item: the host asks for the run it moves to. */
function moveItemToRun(id) { vscode.postMessage({ type: 'moveItemToRun', id }); }
// eslint-disable-next-line no-unused-vars -- the run and session chips (queueEntryRenderFunctions.js)
function relocateItem(id) { vscode.postMessage({ type: 'relocateItem', id }); }
// eslint-disable-next-line no-unused-vars -- the status label (queueEntryRenderFunctions.js)
function pickItemStatus(id) { vscode.postMessage({ type: 'pickItemStatus', id }); }
function sendNow(id) { vscode.postMessage({ type: 'sendNow', id }); }
function continueSending(id) { vscode.postMessage({ type: 'continueSending', id }); }
function resendLastPrompt(id) { vscode.postMessage({ type: 'resendLastPrompt', id }); }
// eslint-disable-next-line no-unused-vars -- called by a running item's resend button (queueEntryRenderFunctions.js)
function resendSendingStage(id) { vscode.postMessage({ type: 'resendSendingStage', id }); }
// eslint-disable-next-line no-unused-vars -- called by a waiting item's background-wait buttons (queueEntryRenderFunctions.js)
function backgroundWaitAction(id, action) { vscode.postMessage({ type: 'backgroundWaitAction', id, action }); }
// eslint-disable-next-line no-unused-vars -- called by a wait panel's message box (sendWaitMessage, queueEntryRenderFunctions.js)
function postWaitMessage(id, text) { vscode.postMessage({ type: 'messageWaitingItem', id, text }); }
// eslint-disable-next-line no-unused-vars -- called by the item's ask panel (askPost, queueEntryRenderFunctions.js)
function postItemAsk(id, askId, response) { vscode.postMessage({ type: 'answerItemAsk', id, askId, response }); }
// eslint-disable-next-line no-unused-vars -- called by a waiting item's Interrupt button (renderWaitFor)
function interruptWaitFor(id) { vscode.postMessage({ type: 'interruptWaitFor', id }); }
// The waiting lines' time left (renderWaitFor) moves on without a redraw.
setInterval(function() { if (typeof tickWaitForLines === 'function') { tickWaitForLines(document); } }, 30000);
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
// eslint-disable-next-line no-unused-vars -- called by a held item's Continue button (queueEntryRenderFunctions.js)
function skipBlockedTodo(id) { vscode.postMessage({ type: 'skipBlockedTodo', id }); }
// eslint-disable-next-line no-unused-vars -- called by a held item's Run anyway button (queueEntryRenderFunctions.js)
function runBlockedTodoAnyway(id) { vscode.postMessage({ type: 'runBlockedTodoAnyway', id }); }
// eslint-disable-next-line no-unused-vars -- called by the soft interrupt panel (queueEntryRenderFunctions.js)
function hardInterruptNow(id) { vscode.postMessage({ type: 'hardInterruptNow', id }); }
// eslint-disable-next-line no-unused-vars -- called by the soft interrupt panel (queueEntryRenderFunctions.js)
function cancelSoftInterrupt(id) { vscode.postMessage({ type: 'cancelSoftInterrupt', id }); }
function resetToPending(id) { vscode.postMessage({ type: 'resetToPending', id }); }
function retryWaitingNow(id) { vscode.postMessage({ type: 'retryWaitingNow', id }); }
function retryRetryingNow(id) { vscode.postMessage({ type: 'retryRetryingNow', id }); }
function stopRetrying(id) { vscode.postMessage({ type: 'stopRetrying', id }); }
function toggleReminder(id, enabled) { vscode.postMessage({ type: 'toggleReminder', id, enabled }); }
/** The item headline's icon: open the live trail of the session the item runs in. */
function openItemLiveTrail(id) { vscode.postMessage({ type: 'openItemLiveTrail', id: id }); }
// eslint-disable-next-line no-unused-vars -- called by the speech bubble's message box (queueEntryRenderFunctions.js)
function postRunningMessage(id, text) { vscode.postMessage({ type: 'messageRunningItem', id: id, text: String(text) }); }
function setPauseAfter(id, pauseAfter) { vscode.postMessage({ type: 'setPauseAfter', id, pauseAfter }); }
function updateDoneNotification(id, prompt) { vscode.postMessage({ type: 'updateDoneNotification', id, prompt: String(prompt || '') }); }
function setDoneNotificationDisabled(id, disabled) { vscode.postMessage({ type: 'setDoneNotificationDisabled', id, disabled: !!disabled }); }
// eslint-disable-next-line no-unused-vars -- called by the done notification's target button (queueEntryRenderFunctions.js)
function pickDoneNotificationTarget(id) { vscode.postMessage({ type: 'pickDoneNotificationTarget', id }); }
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
  // The selected tab's run: the item belongs to it.
  msg.run = settingsRun();
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
  // Label-less (gsel22): the chosen model's name, the rest in the hover help; the Status Page's wording for "nothing chosen".
  const pickers = [
    ['compactionModelLink', 'compactionModel', 'no compaction', 'Compaction model', 'compacts the history (compaction.compactionModel)'],
    ['memoryModelLink', 'memoryExtractionModel', 'no memory extraction', 'Memory extraction model', 'extracts memory (compaction.memoryExtractionModel)'],
  ];
  for (const [id, key, none, title, what] of pickers) {
    const link = document.getElementById(id);
    if (!link || !state) { continue; }
    const value = state[key] || '';
    const choice = (state.choices || []).find((c) => c.value === value);
    const text = value ? (choice ? choice.label : value + ' (not configured)') : none;
    const span = link.querySelector('.model-choice-text');
    if (span) { span.textContent = text; }
    link.dataset.value = value;
    link.title = title + ': ' + text + ' \u2014 the model that ' + what + '; also on the Status Page, History Compaction. Click to choose.';
  }
}

/* ---- The guideline picker (gsel5; media/shared/aspectPicker.js) -------------- */

/** The shared component, when its script loaded. */
function aspectPicker() { return window.TomAspectPicker || null; }

/** The quest default and the window: every picker of this page starts from them. */
function baseAspectLevels() {
  return { workspace: aspectState ? aspectState.workspace : undefined, questDefault: aspectState ? aspectState.questDefault : undefined, window: aspectState ? aspectState.window : undefined };
}

/** The levels of `run`: the quest default, the window and the run's own choices. */
function runAspectLevels(run) {
  const levels = baseAspectLevels();
  levels.run = (runQueueSettings[run] || {}).guidelines;
  return levels;
}

/** The role an item runs as, as far as the editor knows: its own, the run's default, the run's role. */
function itemAspectRole(item) {
  const run = tabRunOf(item);
  return item.role || (runQueueSettings[run] || {}).defaultRole
    || (run === currentRun ? currentContext.role : (runContexts[run] || {}).role) || '';
}

/** The levels of an item: its run's, its role's and role type's, and its own. */
function itemAspectLevels(item) {
  const levels = runAspectLevels(tabRunOf(item));
  const roles = (aspectState && aspectState.roles) || {};
  const r = roles[itemAspectRole(item)] || {};
  levels.roleType = r.roleType;
  levels.role = r.role;
  levels.item = item.guidelines;
  return levels;
}

function windowAspectView() {
  const p = aspectPicker();
  return p && aspectState ? p.view(aspectState, baseAspectLevels(), 'window') : null;
}

function runAspectView(run) {
  const p = aspectPicker();
  return p && aspectState ? p.view(aspectState, runAspectLevels(run), 'run') : null;
}

function queueItemAspectView(item) {
  const p = aspectPicker();
  return p && aspectState && item ? p.view(aspectState, itemAspectLevels(item), 'item') : null;
}

/** The queue list's indicator of an item (renderEntry): only when the item chose something itself. */
// eslint-disable-next-line no-unused-vars -- called by renderEntry (queueEntryRenderFunctions.js)
function queueItemAspectIndicator(item) {
  const v = queueItemAspectView(item);
  return v ? window.TomAspectPicker.indicatorHtml(v, 'Guidelines of this item') : '';
}

/** The item editor's row (renderEntry, the item's details): the item-level button and its choices as text. */
// eslint-disable-next-line no-unused-vars -- called by renderEntry (queueEntryRenderFunctions.js)
function queueItemAspectRow(item) {
  const v = queueItemAspectView(item);
  if (!v) { return ''; }
  const p = window.TomAspectPicker;
  const editable = item.status === 'staged' || item.status === 'pending';
  const attrs = { 'data-aspect-open': 'item', 'data-aspect-item': String(item.id) };
  if (!editable) { attrs.disabled = 'disabled'; }
  return '<div class="qe-aspect-row" style="display:flex;align-items:center;gap:4px;margin:2px 0;">'
    + '<span style="font-size:0.85em;font-weight:600;">Guidelines:</span>'
    + p.buttonHtml(v, { title: editable ? 'Guidelines of this item' : 'Guidelines of this item (only a staged or pending item can change them)', attrs: attrs })
    + '<span class="tom-aspect-text">' + escapeHtml(p.summary(v, { star: true })) + '</span>'
    + '</div>';
}

/** The window's buttons right of the dropdowns: this window, all windows, Set as / Clear quest default. */
function renderAspectToolbar() {
  const slot = document.getElementById('aspectToolbar');
  const p = aspectPicker();
  if (!slot) { return; }
  const v = windowAspectView();
  if (!p || !v) { slot.innerHTML = ''; return; }
  const hasQuestDefault = !!(aspectState.questDefault && Object.keys(aspectState.questDefault).length);
  const hasWorkspace = !!(aspectState.workspaceOwn && Object.keys(aspectState.workspaceOwn).length);
  // Composed icon buttons (gsel22): the level's icon with save (set from the window), close (clear), book (edit its own selection).
  const levelButtons = function(level, icon, name, has, setTip, clearTip, editId) {
    const attr = level === 'quest' ? 'data-aspect-quest-default' : 'data-aspect-workspace-default';
    const btn = function(id, extra, second, tip, disabled) {
      return '<button type="button" class="ctx-btn-icon ctx-btn-double" id="' + id + '" ' + extra + (disabled ? ' disabled' : '') + ' title="' + escapeHtml(tip) + '" aria-label="' + escapeHtml(tip) + '">'
        + '<span class="codicon codicon-' + icon + '"></span><span class="codicon codicon-' + second + '"></span></button>';
    };
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    return btn('aspectSet' + cap, attr + '="set"', 'save', setTip, false)
      + btn('aspectClear' + cap, attr + '="clear"', 'close', has ? clearTip : 'The ' + (level === 'quest' ? 'quest default' : 'workspace level') + ' has no guideline choices', !has)
      + btn(editId, 'data-aspect-open="' + (level === 'quest' ? 'questDefault' : 'workspace') + '"', 'book',
        (level === 'quest' ? 'Guidelines of the quest default: choose them here' : 'Guidelines of this workspace folder (its workspace_aspects.md / .yaml): choose them here'), false);
  };
  slot.innerHTML = p.buttonHtml(v, { title: 'Guidelines of this window', id: 'aspectWindowBtn', attrs: { 'data-aspect-open': 'window' } })
    // The all-windows button has no level of its own: no dot.
    + p.buttonHtml(Object.assign({}, v, { own: false }), { title: 'Guidelines of every open window (each change one aspect)', icon: 'codicon-broadcast', id: 'aspectAllWindowsBtn', attrs: { 'data-aspect-open': 'allWindows' } })
    + '<span class="aspect-level-group" title="The quest default">'
    + levelButtons('quest', 'compass', 'QuestDefault', hasQuestDefault,
      'Set as quest default: this window\'s guideline choices become the quest default (shared by every machine)',
      'Clear quest default: the quest default has no guideline choices', 'aspectEditQuestDefault')
    + '</span><span class="aspect-level-group" title="The workspace level">'
    + levelButtons('workspace', 'root-folder', 'WorkspaceDefault', hasWorkspace,
      'Set as workspace default: this window\'s guideline choices are written into this workspace folder\'s workspace_aspects.md / .yaml',
      'Clear workspace default: this workspace folder\'s workspace_aspects.md / .yaml are emptied (their free text stays)', 'aspectEditWorkspace')
    + '</span>';
}

/** Open the picker of a level: the window, all windows, the tab's run, an item. */
function openQueueAspectPicker(kind, anchor, itemId) {
  const p = aspectPicker();
  if (!p || !aspectState) { return; }
  const run = settingsRun();
  const msg = { type: 'aspectChoose', level: kind };
  let v = null;
  let title = '';
  let note = '';
  if (kind === 'window') {
    v = windowAspectView(); title = 'Guidelines \u2014 this window';
  } else if (kind === 'allWindows') {
    v = windowAspectView(); title = 'Guidelines \u2014 all open windows';
    note = 'Each change goes to every window open now, one section at a time.';
  } else if (kind === 'run') {
    v = runAspectView(run); title = 'Guidelines \u2014 run ' + run; msg.run = run;
  } else if (kind === 'item') {
    const item = currentItems.find(function(i) { return String(i.id) === String(itemId); });
    v = queueItemAspectView(item); title = 'Guidelines \u2014 this item'; msg.itemId = itemId;
  } else if (kind === 'questDefault') {
    // The quest default's own selection (gsel22), over the workspace level and each aspect's default.
    v = p.view(aspectState, { workspace: aspectState.workspace, questDefault: aspectState.questDefault }, 'questDefault');
    title = 'Guidelines \u2014 the quest default'; note = 'Shared by every machine of this quest.';
  } else if (kind === 'workspace') {
    // The workspace level as it resolves (the root's and the folders' down to this one); this folder's own entries are its choices here.
    v = p.view(aspectState, { workspace: aspectState.workspace }, 'workspace');
    const own = aspectState.workspaceOwn || {};
    v.sections.forEach(function(s) { if (own[s.id] !== undefined) { s.here = own[s.id]; } else { delete s.here; } });
    v.own = Object.keys(own).length > 0;
    title = 'Guidelines \u2014 this workspace folder'; note = 'Written to its workspace_aspects.md / .yaml; the root\'s files apply below it.';
  }
  if (!v) { return; }
  p.open(anchor, v, {
    title: title,
    note: note,
    onChoose: function(section, value) { vscode.postMessage(Object.assign({}, msg, { section: section, value: value })); },
    onEditSections: function() { vscode.postMessage({ type: 'aspectEditSections' }); },
  });
}

// The picker's buttons and links (the toolbar, the run's info line, an item's button): one delegated listener.
document.addEventListener('click', function(ev) {
  const t = ev.target && ev.target.closest ? ev.target.closest('[data-aspect-open],[data-aspect-quest-default],[data-aspect-workspace-default]') : null;
  if (!t || t.disabled) { return; }
  ev.preventDefault();
  if (t.dataset.aspectQuestDefault) {
    vscode.postMessage({ type: 'aspectQuestDefault', action: t.dataset.aspectQuestDefault });
    return;
  }
  if (t.dataset.aspectWorkspaceDefault) {
    vscode.postMessage({ type: 'aspectWorkspaceDefault', action: t.dataset.aspectWorkspaceDefault });
    return;
  }
  openQueueAspectPicker(t.dataset.aspectOpen, t, t.dataset.aspectItem);
});

