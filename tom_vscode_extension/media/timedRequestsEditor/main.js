// @ts-nocheck
// Timed Requests Editor webview client — extracted verbatim from the inline
// <script> blocks of getHtml() in src/handlers/timedRequestsEditor-handler.ts
// (Phase B.10 webview restructuring). First-paint state + codicons URI arrive
// via window.__INIT__ (state at __INIT__.state); live updates via postMessage.
// index.html uses inline on*= handlers, so it ships a hand-written
// 'unsafe-inline' CSP (migration guide §7) — therefore the functions below MUST
// stay GLOBAL (top-level function declarations). Do NOT wrap the main block in
// an IIFE or the inline handlers won't resolve them.
// @ts-nocheck: verbatim legacy extraction (loose getElementById access predates
// the strict checkJs gate).

// Inject codicons stylesheet (its URI is resolved by the extension host).
(function () {
  var __init = window.__INIT__ || {};
  if (__init.codiconsUri) {
    var __link = document.createElement('link');
    __link.rel = 'stylesheet';
    __link.href = String(__init.codiconsUri);
    document.head.appendChild(__link);
  }
})();

// ── Bootstrap watchdog ──
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

/* Error catcher — logs to console only */
window.onerror = function(msg, url, line, col, err) {
  console.error('[TimedRequestsEditor] JS ERROR:', msg, 'line', line, 'col', col);
  return false;
};

// ── Main script (functions stay global for the inline on*= handlers) ──
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
window.__tomVscodeApi = vscode; // shared completion.js reads this
window.__timedRequestsEditorBooted = false;

/* ---- Parse initial state from window.__INIT__ ---- */
var __INITIAL__ = (window.__INIT__ && window.__INIT__.state) || {};

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
  const _bootErrMsg = err && err.message ? err.message : String(err);
  const _bootErrStack = err && err.stack ? err.stack : '';
  window.__timedBootError = _bootErrMsg + (_bootErrStack ? '\n' + _bootErrStack : '');
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
  const sendMaximum = Math.max(0, parseInt(String(document.getElementById('addSendMaximum').value || '0'), 10) || 0);
  const answerWaitMinutes = Math.max(0, parseInt(String(document.getElementById('addAnswerWait').value || '0'), 10) || 0);
  const reminderTemplateId = document.getElementById('addReminder').value || undefined;
  const reminderTimeoutMinutes = parseInt(document.getElementById('addReminderTimeout').value || '60', 10) || 60;
  const reminderEnabled = !!document.getElementById('addReminderEnabled').checked;
  const repeatCount = Math.max(1, parseInt(String(document.getElementById('addRepeatCount').value || '1'), 10) || 1);
  const repeatPrefix = document.getElementById('addRepeatPrefix').value || '';
  const repeatSuffix = document.getElementById('addRepeatSuffix').value || '';
  var intervalWeekdays = [];
  if (scheduleMode === 'interval') {
    var wdInputs = document.querySelectorAll('#addIntervalWeekdaysRow input[type="checkbox"]');
    var checkedDays = [];
    wdInputs.forEach(function(el) { if (el.checked) { checkedDays.push(parseInt(el.getAttribute('data-day'), 10)); } });
    // All 7 days selected → no filter (store as empty array)
    intervalWeekdays = checkedDays.length >= 7 ? [] : checkedDays;
  }

  if (!text) {
    showAddFeedback('Please enter a prompt', 'error');
    return;
  }

  clearAddFeedback();
  vscode.postMessage({
    type: 'addEntry',
    text, template, answerWrapper, scheduleMode, intervalMinutes, sendMaximum, answerWaitMinutes,
    intervalWeekdays,
    scheduledTimes: [],
    reminderEnabled, reminderTemplateId, reminderTimeoutMinutes,
    repeatCount, repeatPrefix, repeatSuffix,
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

/* Focus preservation across innerHTML rebuilds.
 *
 * Every edit in an entry row (text, time, date, select, checkbox, …)
 * fires an updateEntry message to the extension, which persists the
 * change and emits onDidChange; the handler pushes a fresh state
 * message, which lands here and triggers a full render() that wipes
 * entriesList.innerHTML. Without focus preservation the input the
 * user was typing into gets destroyed mid-keystroke — catastrophic
 * for <input type="time"> / <input type="date"> where each segment
 * completion also fires change, so the user sees focus ripped away
 * after typing just two digits (see issue "focus loss on scheduled
 * time/date inputs").
 *
 * Each editable control carries a stable data-focus-id so we can
 * identify the focused element across rebuilds. captureFocusSnapshot
 * reads the id (and selection range, where the browser exposes it);
 * restoreFocusSnapshot re-queries by id after the rebuild and
 * restores focus + selection. */
function captureFocusSnapshot() {
  const list = document.getElementById('entriesList');
  const active = document.activeElement;
  if (!list || !active || !list.contains(active)) return null;
  const focusId = active.getAttribute && active.getAttribute('data-focus-id');
  if (!focusId) return null;
  let selStart = null, selEnd = null;
  try {
    if (typeof active.selectionStart === 'number') {
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    }
  } catch (e) { /* some inputs (type="date"/"time"/"number") throw on selection reads */ }
  return { focusId: focusId, selStart: selStart, selEnd: selEnd };
}

function restoreFocusSnapshot(snap) {
  if (!snap) return;
  const sel = '[data-focus-id="' + (window.CSS && CSS.escape ? CSS.escape(snap.focusId) : snap.focusId.replace(/"/g, '\\"')) + '"]';
  const el = document.querySelector(sel);
  if (!el) return;
  try { el.focus(); } catch (e) { return; }
  if (snap.selStart !== null && snap.selStart !== undefined) {
    try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch (e) { /* ignore */ }
  }
}

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

  const focusSnap = captureFocusSnapshot();

  /* Reversed display: newest at top, oldest at bottom */
  const displayEntries = [...entries].reverse();
  list.innerHTML = displayEntries.map((entry, displayIndex) => {
    const entryId = entry.id || ('entry-' + displayIndex);
    const safeStatus = (entry.status === 'active' || entry.status === 'paused' || entry.status === 'completed')
      ? entry.status
      : (entry.enabled ? 'active' : 'paused');
    const expanded = detailsExpanded[entryId] !== false;
    const isInterval = entry.scheduleMode === 'interval';
    // Active entries are now editable in-place (see TimerEngine.updateEntry
    // rewrite): the tick loop rereads fresh state on every iteration so
    // edits are safe mid-run, and the previous "active is locked" UX made
    // scheduled entries impossible to configure without a pause/resume
    // round-trip. Completed entries stay locked.
    const isEditable = safeStatus !== 'completed';
    const disabledAttr = isEditable ? '' : ' disabled';
    const lastSent = entry.lastSentAt ? new Date(entry.lastSentAt).toLocaleString() : 'Never';
    const hasAnswerWrapper = entry.answerWrapper || entry.template === '__answer_file__';
    const displayTemplate = (entry.template === '__answer_file__' || !entry.template || entry.template === '(None)') ? '' : entry.template;

    let scheduledTimesHtml = '';
    if (!isInterval && entry.scheduledTimes) {
      // Day-of-week definitions in Mon→Sun display order (0=Sun,1=Mon…6=Sat)
      const dayDefs = [{d:1,lbl:'M'},{d:2,lbl:'Tu'},{d:3,lbl:'W'},{d:4,lbl:'Th'},{d:5,lbl:'F'},{d:6,lbl:'Sa'},{d:0,lbl:'Su'}];
      scheduledTimesHtml = entry.scheduledTimes.map(function(st, ti) {
        // Absent weekdays means "all days" (legacy: fire every day)
        const wds = Array.isArray(st.weekdays) ? st.weekdays : [0,1,2,3,4,5,6];
        const wdHtml = '<span class="weekdays-row">' +
          dayDefs.map(function(df) {
            const chk = wds.indexOf(df.d) >= 0 ? ' checked' : '';
            return '<label>' + df.lbl + '<input type="checkbox"' + chk + disabledAttr +
              ' data-entry-id="' + esc(entry.id) + '" data-time-idx="' + ti + '" data-day="' + df.d + '"' +
              ' onchange="commitScheduledWeekdays(\'' + entry.id + '\',' + ti + ')"/></label>';
          }).join('') +
          '</span>';
        return '<div class="time-row">' +
          '<input type="text" class="time-input" placeholder="HH:MM"' +
            ' data-focus-id="sched-time-' + entry.id + '-' + ti + '"' +
            ' value="' + esc(st.time) + '"' + disabledAttr +
            ' data-entry-id="' + esc(entry.id) + '" data-time-idx="' + ti + '"' +
            ' oninput="validateTimeInputLive(this)"' +
            ' onkeydown="if(event.key===\'Enter\'){this.blur();}"' +
            ' onblur="commitScheduledTime(\'' + entry.id + '\',' + ti + ',this.value)"' +
            ' title="24-hour time, e.g. 09:00"/>' +
          '<input type="text" class="date-input" placeholder="dd.mm.yyyy"' +
            ' data-focus-id="sched-date-' + entry.id + '-' + ti + '"' +
            ' value="' + esc(isoToDdMmYyyy(st.date || '')) + '"' + disabledAttr +
            ' data-entry-id="' + esc(entry.id) + '" data-time-idx="' + ti + '"' +
            ' onkeydown="if(event.key===\'Enter\'){this.blur();}"' +
            ' onblur="updateScheduledDate(\'' + entry.id + '\',' + ti + ',this.value)"' +
            ' title="Leave empty for recurring; dd.mm.yyyy for one-shot"/>' +
          wdHtml +
          '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="removeScheduledTime(\'' + entry.id + '\',' + ti + ')" title="Remove"><span class="codicon codicon-close"></span></button>' +
        '</div>';
      }).join('') +
      '<button class="ctx-btn-icon" style="font-size:0.8em;margin-top:2px;"' + disabledAttr + ' onclick="addScheduledTime(\'' + entry.id + '\')"><span class="codicon codicon-add"></span> Add Time</button>';
    }

    // Interval weekday row — rendered only when isInterval is true
    const dayDefsIv = [{d:1,lbl:'M'},{d:2,lbl:'Tu'},{d:3,lbl:'W'},{d:4,lbl:'Th'},{d:5,lbl:'F'},{d:6,lbl:'Sa'},{d:0,lbl:'Su'}];
    const iWds = Array.isArray(entry.intervalWeekdays) ? entry.intervalWeekdays : [];
    const intervalWdHtml = '<div class="schedule-row" style="margin-top:3px;align-items:center;">' +
      '<span style="font-size:0.85em;white-space:nowrap;">Days:</span>' +
      '<span class="weekdays-row">' +
      dayDefsIv.map(function(df) {
        var chkd = (iWds.length === 0 || iWds.indexOf(df.d) >= 0) ? ' checked' : '';
        return '<label>' + df.lbl + '<input type="checkbox"' + chkd + disabledAttr +
          ' onchange="updateIntervalWeekday(\'' + entry.id + '\',' + df.d + ',this.checked)"/></label>';
      }).join('') +
      '</span>' +
      '<span style="font-size:0.75em;opacity:0.6;margin-left:4px;">(all&nbsp;=&nbsp;any&nbsp;day)</span>' +
      '</div>';

    const reminderOpts = reminderTemplates.map(t =>
      '<option value="' + t.id + '"' + (entry.reminderTemplateId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'
    ).join('');

    const tplOpts = promptTemplates.map(k =>
      '<option value="' + esc(k) + '"' + (entry.template === k ? ' selected' : '') + '>' + esc(formatPromptTemplateName(k)) + '</option>'
    ).join('');

    return '<div class="entry ' + safeStatus + '">' +
      '<div class="status-bar ' + safeStatus + '">' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\'' + entryId + '\')" title="Toggle details"></span>' +
          safeStatus.toUpperCase() +
          (safeStatus === 'active'
            ? '<span class="codicon codicon-debug-pause" style="cursor:pointer;color:#000;" onclick="updateField(\'' + entry.id + '\',\'enabled\',false)" title="Pause"></span>'
            : (safeStatus === 'paused'
              ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="updateField(\'' + entry.id + '\',\'enabled\',true)" title="Resume"></span>'
              : '')) +
          '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="confirmDelete(\'' + entry.id + '\')" title="Delete"></span>' +
        '</span>' +
        '<label style="display:inline;margin:0;font-weight:normal;color:#000;"><input type="checkbox"' + (entry.enabled ? ' checked' : '') +
          (isEditable ? ' onchange="toggleEnabled(\'' + entry.id + '\', this.checked)"' : ' disabled') + '/> Enabled</label>' +
      '</div>' +
      '<div class="prompt-section ' + (expanded ? '' : 'details-hidden') + '">' +
        '<label>Prompt</label>' +
        '<textarea' + disabledAttr + ' data-completion="on" onchange="updateField(\'' + entry.id + '\',\'originalText\',this.value)">' + esc(entry.originalText) + '</textarea>' +
      '</div>' +
      '<div class="entry-sections ' + (expanded ? '' : 'details-hidden') + '">' +
        '<div class="entry-section">' +
          '<label>Template</label>' +
          '<div class="schedule-row">' +
            '<select' + disabledAttr + ' onchange="updateEntryTemplate(\'' + entry.id + '\',this.value)">' +
              '<option value=""' + (!displayTemplate ? ' selected' : '') + '>(None)</option>' + tplOpts +
            '</select>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="addPromptTemplate()" title="Add Prompt Template"><span class="codicon codicon-add"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="editPromptTemplateByName(\'' + escapeJsSingleQuoted(entry.template || '') + '\')" title="Edit Prompt Template"><span class="codicon codicon-edit"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="deletePromptTemplateByName(\'' + escapeJsSingleQuoted(entry.template || '') + '\')" title="Delete Prompt Template"><span class="codicon codicon-trash"></span></button>' +
            '<label style="display:inline;margin:0;"><input type="checkbox"' + (hasAnswerWrapper ? ' checked' : '') +
              disabledAttr + ' onchange="toggleAnswerWrapper(\'' + entry.id + '\',this.checked)"/> AW</label>' +
            '<button class="ctx-btn-icon" onclick="previewEntry(\'' + entry.id + '\')" title="Preview"><span class="codicon codicon-eye"></span></button>' +
          '</div>' +
          '<label>Schedule</label>' +
          '<div class="schedule-row">' +
            '<label style="display:inline;"><input type="radio" name="mode_' + entry.id + '"' + (isInterval ? ' checked' : '') +
              disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'scheduleMode\',\'interval\')"/> Interval</label>' +
            '<label style="display:inline;"><input type="radio" name="mode_' + entry.id + '"' + (!isInterval ? ' checked' : '') +
              disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'scheduleMode\',\'scheduled\')"/> Scheduled</label>' +
          '</div>' +
          (isInterval
            ? '<div class="schedule-row"><span>Every</span> <input type="number" min="1" value="' + (entry.intervalMinutes || 30) + '" style="width:60px"' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'intervalMinutes\',parseInt(this.value))"/> <span>min</span>' +
              '<span style="margin-left:8px;">Send max:</span> <input type="number" min="0" value="' + (Math.max(0, parseInt(String(entry.sendMaximum || 0), 10) || 0)) + '" style="width:60px"' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'sendMaximum\',Math.max(0,parseInt(this.value||\'0\',10)||0))" title="0 = unlimited"/>' +
              '<span style="margin-left:8px;">Wait:</span> <input type="number" min="0" value="' + (Math.max(0, parseInt(String(entry.answerWaitMinutes || 0), 10) || 0)) + '" style="width:60px"' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'answerWaitMinutes\',Math.max(0,parseInt(this.value||\'0\',10)||0))" title="Minutes to wait before auto-advancing (0 = wait for answer file)"/>' +
              (entry.sentCount ? '<span class="meta" style="margin-left:8px;">(sent ' + entry.sentCount + ')</span>' : '') +
              '</div>' +
              intervalWdHtml
            : '<div class="schedule-times">' + scheduledTimesHtml + '</div>') +
        '</div>' +
        '<div class="entry-section">' +
          '<label>Reminder</label>' +
          '<div class="schedule-row">' +
            '<label style="display:inline;"><input type="checkbox"' + (entry.reminderEnabled ? ' checked' : '') + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'reminderEnabled\',this.checked)"/> Enabled</label>' +
            '<select' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'reminderTemplateId\',this.value)">' +
              '<option value="">Global Default</option>' +
              reminderOpts +
            '</select>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="addReminderTemplate()" title="Add Reminder Template"><span class="codicon codicon-add"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="editReminderTemplateById(\'' + (entry.reminderTemplateId || '') + '\')" title="Edit Reminder Template"><span class="codicon codicon-edit"></span></button>' +
            '<button class="ctx-btn-icon"' + disabledAttr + ' onclick="deleteReminderTemplateById(\'' + (entry.reminderTemplateId || '') + '\')" title="Delete Reminder Template"><span class="codicon codicon-trash"></span></button>' +
          '</div>' +
          '<div class="schedule-row">' +
            '<span>Timeout:</span> <select' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'reminderTimeoutMinutes\',parseInt(this.value||\'60\',10)||60)">' +
              [5,10,15,30,60,120,240,480].map(function(m){ return '<option value="' + m + '"' + ((entry.reminderTimeoutMinutes || 60) === m ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<div class="meta">Last sent: ' + lastSent + '</div>' +
          '<label>Repetition</label>' +
          '<div class="schedule-row">' +
            '<span>Repeat Count:</span> <input type="number" min="1" step="1" value="' + (Math.max(1, parseInt(String(entry.repeatCount || 1), 10) || 1)) + '" style="width:80px"' + disabledAttr + ' onchange="updateField(\'' + entry.id + '\',\'repeatCount\',Math.max(1,parseInt(this.value||\'1\',10)||1))"/>' +
          '</div>' +
        '</div>' +
        '<div class="entry-section fill">' +
          '<label>Repeat Prefix (supports ${repeatNumber}, ${repeatIndex}, ${repeatCount})</label>' +
          '<textarea rows="2"' + disabledAttr + ' data-completion="on" onchange="updateField(\'' + entry.id + '\',\'repeatPrefix\',this.value)">' + esc(entry.repeatPrefix || '') + '</textarea>' +
          '<label>Repeat Suffix (supports ${repeatNumber}, ${repeatIndex}, ${repeatCount})</label>' +
          '<textarea rows="2"' + disabledAttr + ' data-completion="on" onchange="updateField(\'' + entry.id + '\',\'repeatSuffix\',this.value)">' + esc(entry.repeatSuffix || '') + '</textarea>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  restoreFocusSnapshot(focusSnap);
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

/** Convert stored ISO date (YYYY-MM-DD) to display format (dd.mm.yyyy). Returns '' for empty/invalid. */
function isoToDdMmYyyy(iso) {
  if (!iso || iso.length !== 10) return '';
  var parts = iso.split('-');
  if (parts.length !== 3) return '';
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

/** Convert dd.mm.yyyy input back to ISO (YYYY-MM-DD) for storage. Returns '' for empty/invalid. */
function ddMmYyyyToIso(s) {
  if (!s) return '';
  var parts = s.trim().split('.');
  if (parts.length !== 3) return '';
  var day   = parts[0].padStart(2, '0');
  var month = parts[1].padStart(2, '0');
  var year  = parts[2];
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) return '';
  return year + '-' + month + '-' + day;
}

/** Called from the date text input's onblur. Converts dd.mm.yyyy → ISO before storing. */
function updateScheduledDate(entryId, timeIdx, displayValue) {
  var iso = ddMmYyyyToIso(displayValue);
  updateScheduledTime(entryId, timeIdx, 'date', iso);
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

function toggleTimer() { vscode.postMessage({ type: 'toggleTimer' }); }
function enableAll() { vscode.postMessage({ type: 'enableAll' }); }
function disableAll() { vscode.postMessage({ type: 'disableAll' }); }
function removeEntry(id) { vscode.postMessage({ type: 'removeEntry', id }); }
function confirmDelete(id) {
  // VS Code webviews don't support window.confirm(); ask the extension host
  // to show a native modal and perform the delete on confirmation.
  const entry = entries.find(e => e.id === id);
  const snippet = entry ? entry.originalText.substring(0, 50) : id;
  vscode.postMessage({ type: 'confirmRemoveEntry', id, snippet });
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

function updateIntervalWeekday(entryId, day, checked) {
  var entry = entries.find(function(e) { return e.id === entryId; });
  if (!entry) { return; }
  // Empty intervalWeekdays means "all days"; expand to full set before toggling
  var wds = (Array.isArray(entry.intervalWeekdays) && entry.intervalWeekdays.length > 0)
    ? entry.intervalWeekdays.slice()
    : [0, 1, 2, 3, 4, 5, 6];
  if (checked) {
    if (wds.indexOf(day) < 0) { wds.push(day); }
  } else {
    wds = wds.filter(function(d) { return d !== day; });
  }
  // All 7 days selected → store empty array (no filter, any day)
  updateField(entryId, 'intervalWeekdays', wds.length >= 7 ? [] : wds);
}

function addScheduledTime(entryId) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  // Default: weekdays Mon–Fri checked, Sat/Sun unchecked
  const times = [...(entry.scheduledTimes || []), { time: '09:00', weekdays: [1,2,3,4,5] }];
  updateField(entryId, 'scheduledTimes', times);
}

function removeScheduledTime(entryId, timeIdx) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry || !entry.scheduledTimes) return;
  const times = entry.scheduledTimes.filter((_, i) => i !== timeIdx);
  updateField(entryId, 'scheduledTimes', times);
}

/**
 * Validate 24-hour time. Accepts H:MM or HH:MM (0–23 hours, 00–59 minutes).
 * Returns canonical HH:MM on success, '' on failure.
 *
 * Hand-rolled instead of a single regex so the rejection of edge cases
 * is explicit: multiple colons, signs ('+', '-'), decimal points, embedded
 * whitespace, and the parseInt('1e3', 10) = 1 trap all return '' here.
 */
function validateHhmm(s) {
  var t = (s || '').trim();
  if (!t) { return ''; }
  var colon = t.indexOf(':');
  if (colon < 1 || colon !== t.lastIndexOf(':')) { return ''; }
  var hStr = t.slice(0, colon);
  var mStr = t.slice(colon + 1);
  // Reject anything other than digits in either segment (avoids '+', '-', '.', whitespace, NaN-from-parseInt).
  if (!/^\d+$/.test(hStr) || mStr.length !== 2 || !/^\d+$/.test(mStr)) { return ''; }
  var h = Number(hStr), m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) { return ''; }
  if (h < 0 || h > 23 || m < 0 || m > 59) { return ''; }
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Live-feedback validator for the time text input.  Toggles the
 * "time-input-error" class as the user types — does NOT save.  Empty
 * input is treated as "no error yet" so the field doesn't flash red
 * immediately after focus.
 */
function validateTimeInputLive(el) {
  if (!el) { return; }
  var raw = (el.value || '').trim();
  if (raw === '') {
    el.classList.remove('time-input-error');
    return;
  }
  if (validateHhmm(raw)) {
    el.classList.remove('time-input-error');
  } else {
    el.classList.add('time-input-error');
  }
}

/**
 * Commit a single scheduled-time HH:MM value on input blur.  Validates
 * the user's text, normalises it to canonical HH:MM, and sends a
 * targeted updateEntry patch via updateScheduledTime so backend state
 * stays in sync row-by-row instead of relying on a batch Save button.
 *
 * If validation fails, restore the last-known-good value from the
 * cached entries array, mark the field with the error class, and alert
 * the user — no backend round-trip happens.
 */
function commitScheduledTime(entryId, timeIdx, displayValue) {
  var entry = entries.find(function(e) { return e.id === entryId; });
  if (!entry || !entry.scheduledTimes || !entry.scheduledTimes[timeIdx]) { return; }
  var st = entry.scheduledTimes[timeIdx];
  var canonical = validateHhmm(displayValue);
  var el = document.querySelector('[data-entry-id="' + entryId + '"][data-time-idx="' + timeIdx + '"].time-input');

  if (!canonical) {
    // Invalid input — flag the field, alert, revert displayed value to stored one.
    if (el) {
      el.classList.add('time-input-error');
      el.value = st.time || '';
    }
    alert('"' + displayValue + '" is not a valid 24-hour HH:MM time. Reverted to ' + (st.time || '(empty)') + '.');
    return;
  }

  // Valid — clear any error class, update display to canonical form, persist.
  if (el) {
    el.classList.remove('time-input-error');
    if (el.value !== canonical) { el.value = canonical; }
  }
  if (canonical !== st.time) {
    updateScheduledTime(entryId, timeIdx, 'time', canonical);
  }
}

/**
 * Commit weekday checkbox state for a single scheduled-time row on
 * change.  Reads the current DOM state of all data-day checkboxes for
 * this row and persists via updateScheduledTime.  7 checked = "all
 * days" → store empty/absent (legacy: fires every day).
 */
function commitScheduledWeekdays(entryId, timeIdx) {
  var wdEls = document.querySelectorAll('[data-entry-id="' + entryId + '"][data-time-idx="' + timeIdx + '"][data-day]');
  var weekdays = [];
  wdEls.forEach(function(el) {
    if (el.checked) { weekdays.push(parseInt(el.getAttribute('data-day'), 10)); }
  });
  // 7 checked = all days = clear the field
  var value = (weekdays.length > 0 && weekdays.length < 7) ? weekdays : undefined;
  updateScheduledTime(entryId, timeIdx, 'weekdays', value);
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

// ── Fallback diagnostics panel (boots only if the main script flag is missing) ──
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
    const bootError = window.__timedBootError || '';
    const info = [
      'panel=timed',
      'fallbackActive=true',
      'mainBootFlag=' + String(!!window.__timedRequestsEditorBooted),
      bootError ? ('bootError=' + bootError) : 'bootError=(none)',
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
