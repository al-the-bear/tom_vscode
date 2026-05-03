/**
 * Shared Queue Entry Editor Component (§3.2e)
 *
 * Provides reusable HTML/CSS/JS generation functions used by both the
 * Prompt Queue Editor and the Prompt Template Editor.
 *
 * Both editors render queue-entry YAML documents using the same visual
 * component.  Differences are controlled via a `mode` flag:
 *
 *   - `'queue'` → full status bar, send/move/delete controls, auto-send
 *   - `'template'` → always editable, prompt-text textarea (not persisted),
 *     "Queue Prompt" + "Save" buttons
 */

// ============================================================================
// Shared CSS
// ============================================================================

/**
 * CSS for rendering queue entry items.
 * Queue-specific and template-specific layout CSS is NOT here — only the
 * styles that are shared between both editors.
 */
export function queueEntryStyles(): string {
  return `
  :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border); --btnBg: var(--vscode-button-background); --btnFg: var(--vscode-button-foreground); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--fg); background: var(--bg); margin: 0; padding: 8px; }
  h2 { margin: 0 0 8px; font-size: 1.1em; }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar button:not(.ctx-btn-icon) { padding: 4px 10px; border: 1px solid var(--border); background: var(--btnBg); color: var(--btnFg); cursor: pointer; border-radius: 3px; font-size: 0.85em; }
  .toolbar .toggle.active { background: var(--vscode-inputValidation-infoBorder, #007acc); }
  .queue-list { display: flex; flex-direction: column; gap: 8px; }
  .queue-item { border: 1px solid var(--border); border-radius: 4px; padding: 8px; position: relative; }
  .queue-item.sending { border-left: 3px solid var(--vscode-inputValidation-infoBorder, #007acc); }
  /* Sent items: dim only the header bar so the answer + content stay readable. */
  .queue-item.sent > .item-header { opacity: 0.55; }
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
  .status-bar.template-mode { background: var(--vscode-textBlockQuote-background); color: var(--fg); font-weight: normal; }
  textarea { width: 100%; min-height: 50px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); padding: 4px; box-sizing: border-box; }
  .empty { text-align: center; opacity: 0.5; padding: 20px; }
  .context-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px 8px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; font-size: 0.85em; }
  .context-summary { flex: 1; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-btn { padding: 3px 10px; border: 1px solid var(--border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border-radius: 3px; font-size: 0.8em; white-space: nowrap; }
  .ctx-btn-icon { padding: 2px 4px; border: none; background: transparent; color: var(--fg); cursor: pointer; border-radius: 3px; font-size: 0.85em; opacity: 0.7; }
  .ctx-btn-icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  /* Answer expand/collapse toggle: full opacity, with hover affordance. */
  .answer-toggle-icon { opacity: 1 !important; padding: 2px 4px; border-radius: 3px; }
  .answer-toggle-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
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
  .mainprompt-content.is-active { font-weight: 700; }
  .preprompt-block { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .preprompt-block.indented { margin-left: 16px; }
  .preprompt-list { display: flex; flex-direction: column; gap: 6px; }
  .preprompt-item { border: 1px solid var(--border); border-radius: 3px; padding: 6px; }
  .preprompt-item-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.8em; opacity: 0.8; margin-bottom: 4px; }
  .preprompt-item.is-active { border-color: var(--vscode-focusBorder, #007acc); }
  .preprompt-item.is-active .preprompt-item-head { opacity: 1; font-weight: 700; }
  .preprompt-item.is-active .preprompt-content { font-weight: 700; }
  .template-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 0.85em; flex-wrap: wrap; }
  .repeat-affix-row { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .repeat-affix-row textarea { min-height: 42px; }
  .followup-item.is-active { border-color: var(--vscode-focusBorder, #007acc); }
  .followup-item.is-active .followup-item-head { opacity: 1; font-weight: 700; }
  .followup-item.is-active .followup-content { font-weight: 700; }
  /* Yellow interruption chip — rate-limit / quota / overload / cancelled /
     mid-stream interrupt. Distinct from the red .queue-item.error border so
     the user can tell a recoverable send apart from a hard failure. */
  .queue-item.warned { border-left: 3px solid var(--vscode-inputValidation-warningBorder, #e9a700); }
  .warning-chip { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px;
    padding: 4px 8px; border-radius: 4px; font-size: 0.8em; font-weight: 600;
    background: rgba(233, 167, 0, 0.15); color: var(--vscode-inputValidation-warningBorder, #e9a700);
    border: 1px solid rgba(233, 167, 0, 0.35); }
  .warning-chip .codicon { font-size: 13px; }
  `;
}

// ============================================================================
// Shared JS — Utility functions
// ============================================================================

/**
 * JS utility functions shared between queue editor and template editor.
 */
export function queueEntryUtils(): string {
  return `
function escapeHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeJsSingleQuoted(s) {
  var value = String(s || '');
  var backslash = String.fromCharCode(92);
  var singleQuote = String.fromCharCode(39);
  var out = '';
  for (var i = 0; i < value.length; i++) {
    var ch = value[i];
    if (ch === backslash) { out += backslash + backslash; }
    else if (ch === singleQuote) { out += backslash + singleQuote; }
    else { out += ch; }
  }
  return out;
}

function formatPromptTemplateName(name) {
  if (!name || name === '(None)') return '(None)';
  if (name === '__answer_file__') return 'Answer Wrapper';
  return name;
}

function reminderTimeoutOptions(selectedMinutes) {
  var options = [5, 10, 15, 30, 60, 120, 240, 480];
  var selected = Math.max(1, parseInt(String(selectedMinutes || 0), 10) || 0);
  var rendered = options.map(function(m) {
    return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + ' min</option>';
  }).join('');
  return rendered || '<option value="60">60 min</option>';
}

function statusSortRank(status) {
  if (status === 'sending') return 0;
  if (status === 'pending') return 1;
  if (status === 'staged') return 2;
  if (status === 'sent') return 3;
  return 4;
}
`;
}

// ============================================================================
// Shared JS — Entry rendering
// ============================================================================

/**
 * JS functions for rendering a single queue entry item.
 *
 * Provides `renderEntry(item, idx)`, `renderFollowUps(item, status)`,
 * and `renderPrePrompts(item, status)`.
 *
 * These functions depend on global JS variables that each editor page
 * must define before calling them:
 *   - `editorMode`  ('queue' | 'template')
 *   - `reminderTemplates`  (array of {id, name})
 *   - `promptTemplates`    (array of template name strings)
 *   - `responseTimeoutMinutes` (number)
 *   - `detailsExpanded`    (object mapping item-id → boolean)
 */
export function queueEntryRenderFunctions(): string {
  return `
function formatRepeatLabel(repeatCountRaw, repeatIndex, resolvedRepeatCount) {
  // Returns e.g. "1/3 (batchCount)" or "1/3 (3)" or "" if no repeat
  // repeatIndex is already 1-based after dispatch (0 = not yet sent, 1 = sent once, etc.)
  // resolvedRepeatCount: optional cached numeric value when repeatCountRaw is a variable name
  var isVar = typeof repeatCountRaw === 'string' && isNaN(parseInt(repeatCountRaw, 10));
  var resolved = resolvedRepeatCount ? Math.max(0, parseInt(String(resolvedRepeatCount), 10) || 0) : 0;
  var repeatCount = resolved > 0 ? resolved : (isVar ? 0 : Math.max(0, parseInt(String(repeatCountRaw || 0), 10) || 0));
  var idx = Math.max(0, parseInt(String(repeatIndex || 0), 10) || 0);
  if (repeatCount <= 1 && !isVar) return '';
  var current = Math.max(1, idx);
  if (isVar && repeatCount > 0) {
    return current + '/' + repeatCount + ' (' + String(repeatCountRaw) + ')';
  }
  if (isVar) {
    return current + '/? (' + String(repeatCountRaw) + ')';
  }
  return current + '/' + repeatCount + ' (' + repeatCount + ')';
}

function renderEntry(item, idx) {
  var safeStatus = (item.status === 'staged' || item.status === 'pending' || item.status === 'sending' || item.status === 'sent' || item.status === 'error')
    ? item.status : 'staged';
  var queuePos = idx + 1;
  var typeIconClass = item.type === 'timed' ? 'codicon-watch' : item.type === 'reminder' ? 'codicon-bell' : 'codicon-comment';
  var cls = [safeStatus];
  if (item.type === 'reminder') cls.push('reminder');
  // Yellow left border for items carrying an interruption warning
  // (rate limit / quota / overloaded / cancelled / interrupted).
  if (item.warning && item.warning.kind) cls.push('warned');
  var time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : '';
  var sentTime = item.sentAt ? new Date(item.sentAt).toLocaleTimeString() : '';
  var isPending = safeStatus === 'pending';
  var isStaged = safeStatus === 'staged';
  var isSending = safeStatus === 'sending';
  var isSent = safeStatus === 'sent';
  var isError = safeStatus === 'error';
  var reminderEnabled = item.reminderEnabled !== false;
  var isEditable = editorMode === 'template' || isStaged;
  var isMainPromptActive = safeStatus === 'sending' && !!item.requestId && (item.followUpIndex || 0) === 0;
  var statusBarCls = item.type === 'reminder' ? 'reminder' : safeStatus;
  var statusLabel = safeStatus.toUpperCase();

  var followUps = Array.isArray(item.followUps) ? item.followUps : [];
  var sentFollowUps = item.followUpIndex || 0;
  // repeatCount can be a number or a string (variable name)
  var repeatCountRaw = item.repeatCount;
  var repeatCountIsVar = typeof repeatCountRaw === 'string' && isNaN(parseInt(repeatCountRaw, 10));
  var repeatCount = repeatCountIsVar ? 0 : Math.max(0, parseInt(String(repeatCountRaw || 0), 10) || 0);
  var repeatCountDisplay = repeatCountIsVar ? String(repeatCountRaw) : String(Math.max(1, repeatCount));
  var repeatIndex = Math.max(0, parseInt(String(item.repeatIndex || 0), 10) || 0);
  var safeId = escapeJsSingleQuoted(item.id);
  var currentRepeatNumber = repeatCount > 0 ? Math.min(repeatIndex + 1, repeatCount) : 0;

  // Main prompt repeat progress: "MP 1/3 (varName)" with input + skip button when sending/staged
  var mainRepeatLabel = formatRepeatLabel(repeatCountRaw, item.repeatIndex, item.resolvedRepeatCount);
  var repeatProgress = '';
  if (mainRepeatLabel || isSending || isStaged || isPending) {
    if (mainRepeatLabel) {
      repeatProgress = '  [MP ' + mainRepeatLabel;
    } else {
      repeatProgress = '  [MP ';
    }
    if (isSending || isStaged || isPending) {
      repeatProgress += ' <input type="text" value="' + escapeHtml(repeatCountDisplay) + '" style="width:38px" title="Update main prompt repeat count (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitRepeatCountFromStatus(event, \\'' + safeId + '\\', ' + repeatIndex + ', this)">';
    }
    if (isSending && mainRepeatLabel) {
      repeatProgress += ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\\'' + safeId + '\\')" title="Skip to next iteration"></span>';
    }
    repeatProgress += ']';
  }

  // Template repeat progress: "T 0/1" with editable input field
  var tplRepeatCountRaw = item.templateRepeatCount;
  var tplRepeatIsVar = typeof tplRepeatCountRaw === 'string' && isNaN(parseInt(tplRepeatCountRaw, 10));
  var tplRepeatCount = tplRepeatIsVar ? 0 : Math.max(0, parseInt(String(tplRepeatCountRaw || 0), 10) || 0);
  var tplRepeatIndex = Math.max(0, parseInt(String(item.templateRepeatIndex || 0), 10) || 0);
  var tplRepeatCountDisplay = tplRepeatIsVar ? String(tplRepeatCountRaw) : String(Math.max(1, tplRepeatCount));
  var tplRepeatProgress = '';
  var tplCurrent = Math.max(0, tplRepeatIndex);
  var tplTotal = tplRepeatIsVar ? '?' : String(Math.max(1, tplRepeatCount));
  if (isSending || isStaged || isPending) {
    tplRepeatProgress = '  [T ' + tplCurrent + '/'
      + '<input type="text" value="' + escapeHtml(tplRepeatCountDisplay) + '" style="width:38px" title="Update template repeat total (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitTemplateRepeatFromStatus(event, \\\'' + safeId + '\\\', this)">'
      + (isSending && (tplRepeatCount > 1 || tplRepeatIsVar) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\\'' + safeId + '\\')" title="Skip to next template iteration"></span>' : '')
      + ']';
  } else if (tplRepeatCount > 1 || tplRepeatIsVar) {
    tplRepeatProgress = '  [T ' + tplCurrent + '/' + tplTotal + ' (' + escapeHtml(tplRepeatCountDisplay) + ')]';
  }

  var expanded = detailsExpanded[item.id] !== false;

  /* --- Template picker row --- */
  var templateRow = '';
  if (isEditable) {
    var noReminderSelected = item.reminderEnabled === false && !item.reminderTemplateId;
    var repeatPrefix = (typeof item.repeatPrefix === 'string') ? item.repeatPrefix : '';
    var repeatSuffix = (typeof item.repeatSuffix === 'string') ? item.repeatSuffix : '';
    var templateRepeatCountRaw = item.templateRepeatCount;
    var templateRepeatCountDisplay = templateRepeatCountRaw ? String(templateRepeatCountRaw) : '1';
    // Spec §4.16 — template dropdown filters by the item's effective
    // transport. Anthropic items pull from the anthropic user-message
    // templates store; Copilot items stay on the Copilot store.
    // Queue-template editor (editorMode='template') no longer exposes
    // a per-item template — all main prompts inherit the queue-level
    // template at queue-dispatch time. Reminder dropdown stays.
    var mpIsAnthropic = item.transport === 'anthropic';
    var mpTplOptions = mpIsAnthropic
      ? (anthropicUserMessageTemplates || []).map(function(t) {
          return '<option value="' + escapeHtml(t.id) + '"' + ((item.template || '') === t.id ? ' selected' : '') + '>' + escapeHtml(t.name || t.id) + '</option>';
        }).join('')
      : (promptTemplates || []).map(function(name) {
          return '<option value="' + escapeHtml(name) + '"' + ((item.template || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>';
        }).join('');
    var showTemplateSelect = editorMode !== 'template';
    var templateSelectHtml = showTemplateSelect
      ? ('<label style="font-size:0.85em;font-weight:600;">Template:</label>' +
         '<select onchange="updateItemTemplate(\\'' + safeId + '\\', this.value)">' +
           '<option value="">(None)</option>' +
           mpTplOptions +
         '</select>')
      : '';
    templateRow = '<div class="template-row">' +
      templateSelectHtml +
      '<label style="font-size:0.85em;font-weight:600;margin-left:' + (showTemplateSelect ? '0' : '0') + ';">Reminder:</label>' +
      '<select onchange="updateItemReminder(\\'' + safeId + '\\', \\'template\\', this.value)">' +
        '<option value=""' + (!noReminderSelected && !item.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
        '<option value="__none__"' + (noReminderSelected ? ' selected' : '') + '>No reminder</option>' +
        reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (item.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
      '</select>' +
      '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
      '<select onchange="updateItemReminder(\\'' + safeId + '\\', \\'timeout\\', this.value)">' + reminderTimeoutOptions(item.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
      '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Queue Repeats:</span>' +
      '<input type="text" value="' + escapeHtml(repeatCountDisplay) + '" style="width:50px" placeholder="1 or var" title="Number or variable name (e.g. batchCount)" onchange="updateItemRepeat(\\'' + safeId + '\\', { repeatCount: this.value })">' +
      '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait (min):</span>' +
      '<input type="number" min="0" step="1" value="' + Math.max(0, parseInt(String(item.answerWaitMinutes || 0), 10) || 0) + '" style="width:33px" title="Minutes to wait before auto-advancing (0 = wait for answer file)" onchange="updateItemRepeat(\\'' + safeId + '\\', { answerWaitMinutes: this.value })">' +
    '</div>' +
    '<div class="repeat-affix-row">' +
      '<label style="font-size:0.8em;opacity:0.9;">Repeat Prefix (supports \${repeatNumber}, \${repeatIndex}, \${repeatCount})</label>' +
      '<textarea onchange="updateItemRepeat(\\'' + safeId + '\\', { repeatPrefix: this.value })">' + escapeHtml(repeatPrefix) + '</textarea>' +
      '<label style="font-size:0.8em;opacity:0.9;">Repeat Suffix (supports \${repeatNumber}, \${repeatIndex}, \${repeatCount})</label>' +
      '<textarea onchange="updateItemRepeat(\\'' + safeId + '\\', { repeatSuffix: this.value })">' + escapeHtml(repeatSuffix) + '</textarea>' +
      '<label style="font-size:0.8em;opacity:0.9;margin-top:8px;">Template Repeat Count (repeat entire template)</label>' +
      '<input type="text" value="' + escapeHtml(templateRepeatCountDisplay) + '" style="width:50px" placeholder="1" title="How many times to repeat the entire template" onchange="updateItemRepeat(\\'' + safeId + '\\', { templateRepeatCount: this.value })">' +
    '</div>';
  }

  /* --- Status bar (queue mode) or simple header (template mode) --- */
  var headerHtml = '';
  /* Transport badge — spec §4.10 visible indicator that this item
   * routes through anthropic instead of the default Copilot flow.
   * Shown only for non-copilot items so the default state stays
   * uncluttered. Profile id is included when set so users can tell
   * multi-profile queues apart at a glance.
   */
  var transportBadge = '';
  if (item.transport === 'anthropic') {
    var pid = typeof item.anthropicProfileId === 'string' && item.anthropicProfileId
      ? ':' + item.anthropicProfileId : '';
    transportBadge = '  <span style="background:#4a9eff;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="Queue item dispatches through AnthropicHandler.sendMessage (auto-approve forced). Profile: ' +
      escapeHtml(item.anthropicProfileId || '(default)') + '">[anthropic' + escapeHtml(pid) + ']</span>';
  }
  if (editorMode === 'queue') {
    headerHtml = '<div class="item-header">' +
      '<div class="status-bar ' + statusBarCls + '">' +
        '<span class="status-left">' +
          '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\\'' + safeId + '\\')" title="Toggle details"></span>' +
          statusLabel + repeatProgress + tplRepeatProgress + transportBadge +
          (item.template && item.template !== '(None)' && item.template !== '__answer_file__' ? '  [' + escapeHtml(item.template) + ']' : '') +
          (item.template && item.template !== '(None)' ? '  [AW]' : '') +
          '<span class="status-icons">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;color:#000;" onclick="previewItem(\\'' + safeId + '\\')" title="Preview"></span>' +
          (isStaged ? '<span class="codicon codicon-arrow-right" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + safeId + '\\', \\'pending\\')" title="Set to Pending"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + safeId + '\\', \\'staged\\')" title="Move back to Staged"></span>' : '') +
          (isSending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + safeId + '\\', \\'staged\\')" title="Interrupt and move to Staged"></span>' : '') +
          (isSent ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\\'' + safeId + '\\', \\'staged\\')" title="Stage again"></span>' : '') +
          ((isPending || isStaged) ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="sendNow(\\'' + safeId + '\\')" title="Send Now"></span>' : '') +
          (isSending ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="continueSending(\\'' + safeId + '\\')" title="Continue"></span>' : '') +
          // Error items get a "Set to Pending" button instead of a
          // resend control. The error transition flipped auto-send
          // off, so the user has explicitly opted out of further
          // sends — a direct resend would contradict that. This
          // button just flips the item back to pending and never
          // sends, even when auto-send is later re-enabled by the
          // user via the queue toggle. The codicon-history icon
          // reads as 'back in line / waiting' and is deliberately
          // distinct from the refresh icon used for the non-error
          // Resend button below.
          (isError
            ? '<span class="codicon codicon-history" style="cursor:pointer;color:#000;" onclick="resetToPending(\\'' + safeId + '\\')" title="Set to Pending (does not send — re-enable auto-send to resume the queue)"></span>'
            : '') +
          // Resend last dispatch — available once there is a recorded
          // lastDispatched (i.e. at least one stage has been sent) and
          // the item isn't currently in-flight or errored. Re-sends
          // the exact expanded text byte-for-byte; repetition
          // counters are not touched, so the queue continues from
          // where it was.
          (item.lastDispatched && !isSending && !isError
            ? '<span class="codicon codicon-refresh" style="cursor:pointer;color:#000;" onclick="resendLastPrompt(\\'' + safeId + '\\')" title="Resend last prompt (keeps repetition counters)"></span>'
            : '') +
          (isPending ? '<span class="codicon codicon-arrow-up" style="cursor:pointer;color:#000;" onclick="moveDown(\\'' + safeId + '\\')" title="Move up (away from send)"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-down" style="cursor:pointer;color:#000;" onclick="moveUp(\\'' + safeId + '\\')" title="Move down (closer to send)"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-circle-up" style="cursor:pointer;color:#000;" onclick="moveToFront(\\'' + safeId + '\\')" title="Send next (move to front of pending queue)"></span>' : '') +
          (isSending ? '<span class="codicon ' + (reminderEnabled ? 'codicon-bell' : 'codicon-bell-slash') + '" style="cursor:pointer;color:' + (reminderEnabled ? '#000' : '#888') + ';" onclick="toggleReminder(\\'' + safeId + '\\', ' + !reminderEnabled + ')" title="' + (reminderEnabled ? 'Reminders ON - click to disable' : 'Reminders OFF - click to enable') + '"></span>' : '') +
          // Staged-only: once an item is pending or sending, the
          // manager rejects transport updates (isEditableStatus). Hide
          // the gear so users don't click a no-op.
          (isStaged ? '<span class="codicon codicon-settings" style="cursor:pointer;color:#000;" onclick="editItemTransport(\\'' + safeId + '\\')" title="Change transport (Copilot / Anthropic + profile + config)"></span>' : '') +
          '<span class="codicon codicon-go-to-file" style="cursor:pointer;color:#000;" onclick="openEntryFile(\\'' + safeId + '\\')" title="Open YAML file"></span>' +
          '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="remove(\\'' + safeId + '\\')" title="Delete"></span>' +
          '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          '#' + queuePos + '  ' + time + (sentTime ? ' \\u2192 ' + sentTime : '') +
          ' <span class="codicon ' + typeIconClass + '" style="color:#000;"></span>' +
        '</span>' +
      '</div>' +
    '</div>';
  } else {
    /* Template mode: simple collapsible header without status controls */
    headerHtml = '<div class="item-header">' +
      '<div class="status-bar template-mode">' +
        '<span>' +
          (item.template && item.template !== '(None)' ? '[' + escapeHtml(item.template) + ']' : '') +
          (item.template && item.template !== '(None)' ? '  [AW]' : '') +
        '</span>' +
      '</div>' +
    '</div>';
  }

  /* Reminder row (queue mode only for main prompt, template mode always) */
  var reminderRow = '';
  if (isEditable) {
    reminderRow = '';
  }

  /* Anthropic answerText inline preview (spec §4.10). Displayed only
   * when the item produced direct text (anthropic transport). The
   * authoritative trail is the Anthropic trail file; this is the
   * practical at-a-glance view. Truncated to 600 chars by default
   * with a toggle to expand to full. */
  var answerBlock = '';
  if (typeof item.answerText === 'string' && item.answerText.length > 0) {
    var ansId = 'ans-' + safeId;
    var fullText = item.answerText;
    var truncated = fullText.length > 600 ? fullText.slice(0, 600) + '…' : fullText;
    answerBlock = '<div class="answer-preview" style="margin-top:6px;padding:6px 8px;border-left:3px solid #4a9eff;background:rgba(74,158,255,0.06);font-size:0.85em;">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
        '<strong style="color:#4a9eff;">Answer</strong>' +
        '<span style="opacity:0.7;font-size:10px;">' + fullText.length + ' chars</span>' +
        (fullText.length > 600 ? '<span id="' + ansId + '-toggle" class="codicon codicon-chevron-down answer-toggle-icon" style="margin-left:auto;cursor:pointer;color:var(--fg);opacity:1;" onclick="toggleAnswerExpand(\\'' + ansId + '\\')" title="Expand / collapse"></span>' : '') +
      '</div>' +
      '<div id="' + ansId + '" data-full="' + escapeHtml(fullText) + '" data-truncated="' + escapeHtml(truncated) + '" data-expanded="false" style="white-space:pre-wrap;max-height:200px;overflow:auto;">' +
        escapeHtml(truncated) +
      '</div>' +
    '</div>';
  }

  return '<div class="queue-item ' + cls.join(' ') + '">' +
    headerHtml +
    '<div class="' + (expanded ? '' : 'details-hidden') + '">' +
    (isEditable
      ? '<textarea onchange="updateText(\\'' + safeId + '\\', this.value)">' + escapeHtml(item.originalText) + '</textarea>'
      : '<div class="mainprompt-content' + (isMainPromptActive ? ' is-active' : '') + '" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(item.originalText) + '</div>') +
    templateRow +
    reminderRow +
    renderPrePrompts(item, safeStatus) +
    renderFollowUps(item, safeStatus) +
    answerBlock +
    // Yellow interruption chip — explains why the send didn't complete.
    (item.warning && item.warning.kind
      ? '<div class="warning-chip" title="' + escapeHtml(item.warning.at || '') + '">'
        + '<span class="codicon codicon-warning"></span>'
        + '<span><strong>' + escapeHtml(warningKindLabel(item.warning.kind)) + ':</strong> '
        + escapeHtml(item.warning.message || '')
        + '</span></div>'
      : '') +
    (item.error ? '<div style="color:var(--vscode-charts-red);font-size:0.8em;margin-top:4px;">Error: ' + escapeHtml(item.error) + '</div>' : '') +
    '</div>' +
  '</div>';
}

function warningKindLabel(kind) {
  switch (kind) {
    case 'rate_limit': return 'Rate limit';
    case 'quota_exceeded': return 'Quota exceeded';
    case 'overloaded': return 'Overloaded';
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted';
    default: return 'Warning';
  }
}

function renderPrePrompts(item, status) {
  var prePrompts = Array.isArray(item.prePrompts) ? item.prePrompts : [];
  var isEditable = editorMode === 'template' || status === 'staged';
  if (prePrompts.length === 0 && !isEditable) return '';

  var activePrePromptIndex = -1;
  if (status === 'sending' && !item.requestId && prePrompts.length > 0) {
    var sentPrePromptCount = prePrompts.filter(function(pp) { return pp.status === 'sent'; }).length;
    if (sentPrePromptCount > 0) {
      activePrePromptIndex = Math.min(sentPrePromptCount - 1, prePrompts.length - 1);
    }
  }

  var safeItemId = escapeJsSingleQuoted(item.id);
  var rows = prePrompts.map(function(pp, idx) {
    var ppStatus = pp.status || 'pending';
    var doneMark = ppStatus === 'sent' ? '\\u2713 ' : ppStatus === 'error' ? '\\u2717 ' : '';
    var templateLabel = formatPromptTemplateName(pp.template || '(None)');
    var isActive = idx === activePrePromptIndex;
    var ppRepeatCountRaw = pp.repeatCount;
    var ppRepeatCountDisplay = ppRepeatCountRaw ? String(ppRepeatCountRaw) : '1';
    var ppRepeatLabel = formatRepeatLabel(ppRepeatCountRaw, pp.repeatIndex, pp.resolvedRepeatCount);
    var ppSkipBtn = (isActive && ppRepeatLabel) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\\'' + safeItemId + '\\')" title="Skip to next PP iteration"></span>' : '';
    var ppAnswerWait = Math.max(0, parseInt(String(pp.answerWaitMinutes || 0), 10) || 0);
    var ppHasExplicitReminder = pp.reminderEnabled === true || !!pp.reminderTemplateId;
    var ppNoReminderSelected = !ppHasExplicitReminder;
    return '<div class="preprompt-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="preprompt-item-head">' +
        '<span>' + doneMark + 'Pre-prompt #' + (idx + 1) + (pp.template ? ' [' + escapeHtml(templateLabel) + ']' : '') + (ppRepeatLabel ? ' [PP ' + ppRepeatLabel + ppSkipBtn + ']' : '') +
        (pp.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (pp.anthropicProfileId ? ':' + escapeHtml(pp.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editPrePromptTransport(\\'' + safeItemId + '\\', ' + idx + ')" title="Change transport (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removePrePrompt(\\'' + safeItemId + '\\', ' + idx + ')" title="Delete pre-prompt"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var ppShowTpl = editorMode !== 'template';
            var ppTplHtml = ppShowTpl
              ? ('<label style="font-size:0.85em;font-weight:600;">Template:</label>' +
                 '<select onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'template\\', this.value)">' +
                   '<option value="">(None)</option>' +
                   ((pp.transport || item.transport) === 'anthropic'
                     ? (anthropicUserMessageTemplates || []).map(function(t) {
                         return '<option value="' + escapeHtml(t.id) + '"' + ((pp.template || '') === t.id ? ' selected' : '') + '>' + escapeHtml(t.name || t.id) + '</option>';
                       }).join('')
                     : (promptTemplates || []).map(function(name) {
                         return '<option value="' + escapeHtml(name) + '"' + ((pp.template || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>';
                       }).join('')) +
                 '</select>')
              : '';
            return '<textarea onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'text\\', this.value)">' + escapeHtml(pp.text || '') + '</textarea>' +
          '<div class="template-row">' +
            ppTplHtml +
            '<select onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'reminderTemplateId\\', this.value)">' +
              '<option value=""' + (!ppNoReminderSelected && !pp.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
              '<option value="__none__"' + (ppNoReminderSelected ? ' selected' : '') + '>No reminder</option>' +
              reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (pp.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
            '</select>' +
            '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
            '<select onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'reminderTimeoutMinutes\\', this.value)">' + reminderTimeoutOptions(pp.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
            '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
            '<input type="text" value="' + escapeHtml(ppRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'repeatCount\\', this.value)">' +
            '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait:</span>' +
            '<input type="number" min="0" step="1" value="' + ppAnswerWait + '" style="width:33px" title="Minutes to wait" onchange="updatePrePromptField(\\'' + safeItemId + '\\', ' + idx + ', \\'answerWaitMinutes\\', this.value)">' +
          '</div>';
          })()
        : '<div class="preprompt-content" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(pp.text || '') + '</div>') +
    '</div>';
  }).join('');

  return '<div class="preprompt-block indented">' +
    '<div style="font-size:0.85em;opacity:0.85;display:flex;align-items:center;gap:6px;">' +
      'Pre-Prompts (sent before main prompt)' +
      (isEditable ? '<button class="ctx-btn-icon" onclick="addPrePrompt(\\'' + safeItemId + '\\')" title="Add Pre-prompt"><span class="codicon codicon-add"></span></button>' : '') +
    '</div>' +
    '<div class="preprompt-list">' + rows + (prePrompts.length === 0 ? '<div style="opacity:0.75;font-size:0.8em;">No pre-prompts yet.</div>' : '') + '</div>' +
  '</div>';
}

function renderFollowUps(item, status) {
  var followUps = Array.isArray(item.followUps) ? item.followUps : [];
  var isEditable = editorMode === 'template' || status === 'staged';
  if (followUps.length === 0 && !isEditable) return '';
  var sentFollowUps = item.followUpIndex || 0;
  var activeFollowUpIndex = -1;
  if (status === 'sending' && item.requestId && sentFollowUps > 0 && sentFollowUps <= followUps.length) {
    activeFollowUpIndex = sentFollowUps - 1;
  }
  var safeItemId = escapeJsSingleQuoted(item.id);

  var rows = followUps.map(function(f, idx) {
    var safeFollowUpId = escapeJsSingleQuoted(f.id || '');
    var safeTemplate = escapeJsSingleQuoted(f.template || '');
    var safeReminderTemplateId = escapeJsSingleQuoted(f.reminderTemplateId || '');
    var fuHasExplicitReminder = f.reminderEnabled === true || !!f.reminderTemplateId;
    var noReminderSelected = !fuHasExplicitReminder;
    var doneMark = idx < sentFollowUps ? '\\u2713 ' : '';
    var templateLabel = formatPromptTemplateName(f.template || '(None)');
    var isActive = idx === activeFollowUpIndex;
    var fuRepeatCountRaw = f.repeatCount;
    var fuRepeatCountDisplay = fuRepeatCountRaw ? String(fuRepeatCountRaw) : '1';
    var fuRepeatLabel = formatRepeatLabel(fuRepeatCountRaw, f.repeatIndex, f.resolvedRepeatCount);
    var fuSkipBtn = (isActive && fuRepeatLabel) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\\'' + safeItemId + '\\')" title="Skip to next FU iteration"></span>' : '';
    var fuAnswerWait = Math.max(0, parseInt(String(f.answerWaitMinutes || 0), 10) || 0);
    return '<div class="followup-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="followup-item-head">' +
        '<span>' + doneMark + 'Follow-up #' + (idx + 1) + (f.template ? (' [' + escapeHtml(templateLabel) + ']') : '') + (fuRepeatLabel ? ' [FU ' + fuRepeatLabel + fuSkipBtn + ']' : '') + ' [AW]' +
        (f.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (f.anthropicProfileId ? ':' + escapeHtml(f.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;" onclick="previewFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\')" title="Preview follow-up"></span>' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editFollowUpTransport(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\')" title="Change transport (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removeFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\')" title="Delete follow-up"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var fuShowTpl = editorMode !== 'template';
            var fuTplHtml = fuShowTpl
              ? ('<span style="font-size:0.8em;opacity:0.85;">Template:</span>' +
                 '<select onchange="updateFollowUpTemplate(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', this.value)">' +
                   '<option value="">(None)</option>' +
                   ((f.transport || item.transport) === 'anthropic'
                     ? (anthropicUserMessageTemplates || []).map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + ((f.template || '') === t.id ? ' selected' : '') + '>' + escapeHtml(t.name || t.id) + '</option>'; }).join('')
                     : (promptTemplates || []).map(function(name){ return '<option value="' + escapeHtml(name) + '"' + ((f.template || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>'; }).join('')) +
                 '</select>')
              : '';
            return '<textarea onchange="updateFollowUp(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', this.value)">' + escapeHtml(f.originalText || '') + '</textarea>' +
          '<div class="followup-actions">' +
            '<div class="followup-row">' +
              fuTplHtml +
              '<select onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \\'template\\', this.value)">' +
                '<option value=""' + (!noReminderSelected && !f.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
                '<option value="__none__"' + (noReminderSelected ? ' selected' : '') + '>No reminder</option>' +
                reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (f.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
              '</select>' +
              '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
              '<select onchange="updateFollowUpReminder(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \\'timeout\\', this.value)">' + reminderTimeoutOptions(f.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
              '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
              '<input type="text" value="' + escapeHtml(fuRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updateFollowUpField(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \\'repeatCount\\', this.value)">' +
              '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait:</span>' +
              '<input type="number" min="0" step="1" value="' + fuAnswerWait + '" style="width:33px" title="Minutes to wait" onchange="updateFollowUpField(\\'' + safeItemId + '\\', \\'' + safeFollowUpId + '\\', \\'answerWaitMinutes\\', this.value)">' +
            '</div>' +
          '</div>';
          })()
        : '<div class="followup-content" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(f.originalText || '') + '</div>') +
    '</div>';
  }).join('');

  return '<div class="followup-block indented">' +
    '<div style="font-size:0.85em;opacity:0.85;display:flex;align-items:center;gap:6px;">' +
      'Follow-up Prompts (all wrapped with Answer Wrapper)' +
      (isEditable ? '<button class="ctx-btn-icon" onclick="addEmptyFollowUp(\\'' + safeItemId + '\\')" title="Add Follow-up"><span class="codicon codicon-add"></span></button>' : '') +
    '</div>' +
    '<div class="followup-list">' + rows + (followUps.length === 0 ? '<div style="opacity:0.75;font-size:0.8em;">No follow-up prompts yet.</div>' : '') + '</div>' +
  '</div>';
}
`;
}

// ============================================================================
// Shared JS — Message handlers for entry-level operations
// ============================================================================

/**
 * JS functions for sending webview messages related to entry editing.
 * Both editors use the same message types; the TypeScript handler
 * routes them appropriately.
 */
export function queueEntryMessageHandlers(): string {
  return `
function updateText(id, text) { vscode.postMessage({ type: 'updateText', id: id, text: text }); }
function updateItemRepeat(id, patch) {
  var nextPatch = patch;
  if (patch === null || typeof patch !== 'object') {
    nextPatch = { repeatCount: patch };
  }
  var msg = {
    type: 'updateItemRepeat',
    id: id,
    repeatCount: undefined,
    repeatPrefix: undefined,
    repeatSuffix: undefined,
    answerWaitMinutes: undefined,
    templateRepeatCount: undefined,
  };
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'repeatCount')) {
    // Accept both number and string (variable name)
    var rcVal = String(nextPatch.repeatCount || '').trim();
    var rcNum = parseInt(rcVal, 10);
    msg.repeatCount = isNaN(rcNum) ? rcVal : Math.max(0, rcNum);
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'repeatPrefix')) {
    msg.repeatPrefix = String(nextPatch.repeatPrefix || '');
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'repeatSuffix')) {
    msg.repeatSuffix = String(nextPatch.repeatSuffix || '');
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'answerWaitMinutes')) {
    msg.answerWaitMinutes = Math.max(0, parseInt(String(nextPatch.answerWaitMinutes || '0'), 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'templateRepeatCount')) {
    var trcVal = String(nextPatch.templateRepeatCount || '').trim();
    var trcNum = parseInt(trcVal, 10);
    msg.templateRepeatCount = isNaN(trcNum) ? trcVal : Math.max(0, trcNum);
  }
  vscode.postMessage(msg);
}
function submitRepeatCountFromStatus(event, id, currentRepeatNumber, inputEl) {
  if (!event || event.key !== 'Enter') { return; }
  event.preventDefault();
  event.stopPropagation();
  var raw = String(inputEl && inputEl.value || '').trim();
  if (!raw) return;
  var isNum = /^[0-9]+$/.test(raw);
  var val = isNum ? Math.max(1, parseInt(raw, 10) || 1) : raw;
  if (inputEl) {
    inputEl.value = String(val);
    if (typeof inputEl.blur === 'function') { inputEl.blur(); }
  }
  updateItemRepeat(id, { repeatCount: val });
}
function submitTemplateRepeatFromStatus(event, id, inputEl) {
  if (!event || event.key !== 'Enter') { return; }
  event.preventDefault();
  event.stopPropagation();
  var raw = String(inputEl && inputEl.value || '').trim();
  if (!raw) return;
  var isNum = /^[0-9]+$/.test(raw);
  var val = isNum ? Math.max(1, parseInt(raw, 10) || 1) : raw;
  if (inputEl) {
    inputEl.value = String(val);
    if (typeof inputEl.blur === 'function') { inputEl.blur(); }
  }
  updateItemRepeat(id, { templateRepeatCount: val });
}
function updateItemTemplate(id, template) { vscode.postMessage({ type: 'updateItemTemplate', id: id, template: template || '' }); }
function updateItemReminder(id, field, value) {
  var msg = { type: 'updateItemReminder', id: id };
  if (field === 'enabled') msg.reminderEnabled = !!value;
  if (field === 'template') {
    if (value === '__none__') {
      msg.reminderEnabled = false;
      msg.reminderTemplateId = '';
    } else {
      msg.reminderTemplateId = value || '';
      msg.reminderEnabled = true; // Enable reminders when selecting a template
    }
  }
  if (field === 'timeout') msg.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
  if (field === 'repeat') msg.reminderRepeat = !!value;
  vscode.postMessage(msg);
}
function addEmptyFollowUp(id) { vscode.postMessage({ type: 'addEmptyFollowUp', id: id }); }
function updateFollowUp(id, followUpId, text) { vscode.postMessage({ type: 'updateFollowUp', id: id, followUpId: followUpId, text: text }); }
function updateFollowUpTemplate(id, followUpId, template) { vscode.postMessage({ type: 'updateFollowUp', id: id, followUpId: followUpId, template: template || '' }); }
function updateFollowUpReminder(id, followUpId, field, value) {
  var msg = { type: 'updateFollowUp', id: id, followUpId: followUpId };
  if (field === 'enabled') msg.reminderEnabled = !!value;
  if (field === 'template') {
    if (value === '__none__') {
      msg.reminderEnabled = false;
      msg.reminderTemplateId = '';
    } else {
      msg.reminderTemplateId = value || '';
      msg.reminderEnabled = true;
    }
  }
  if (field === 'timeout') msg.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
  if (field === 'repeat') msg.reminderRepeat = !!value;
  vscode.postMessage(msg);
}
function removeFollowUp(id, followUpId) { vscode.postMessage({ type: 'removeFollowUp', id: id, followUpId: followUpId }); }
function addPrePrompt(id) { vscode.postMessage({ type: 'addPrePrompt', id: id, text: '', template: '' }); }
function updatePrePrompt(id, index, text, template) {
  var msg = { type: 'updatePrePrompt', id: id, index: index };
  if (text !== null) msg.text = text;
  if (template !== null) msg.template = template;
  vscode.postMessage(msg);
}
function updatePrePromptField(id, index, field, value) {
  var msg = { type: 'updatePrePrompt', id: id, index: index };
  if (field === 'text') msg.text = value;
  if (field === 'template') msg.template = value || '';
  if (field === 'repeatCount') {
    var rcVal = String(value || '').trim();
    var rcNum = parseInt(rcVal, 10);
    msg.repeatCount = isNaN(rcNum) ? rcVal : Math.max(0, rcNum);
  }
  if (field === 'answerWaitMinutes') msg.answerWaitMinutes = Math.max(0, parseInt(String(value || '0'), 10) || 0);
  if (field === 'reminderTemplateId') {
    if (value === '__none__') {
      msg.reminderEnabled = false;
      msg.reminderTemplateId = '';
    } else {
      msg.reminderTemplateId = value || '';
      msg.reminderEnabled = true;
    }
  }
  if (field === 'reminderTimeoutMinutes') msg.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
  vscode.postMessage(msg);
}
function updateFollowUpField(id, followUpId, field, value) {
  var msg = { type: 'updateFollowUp', id: id, followUpId: followUpId };
  if (field === 'repeatCount') {
    var rcVal = String(value || '').trim();
    var rcNum = parseInt(rcVal, 10);
    msg.repeatCount = isNaN(rcNum) ? rcVal : Math.max(0, rcNum);
  }
  if (field === 'answerWaitMinutes') msg.answerWaitMinutes = Math.max(0, parseInt(String(value || '0'), 10) || 0);
  vscode.postMessage(msg);
}
function removePrePrompt(id, index) { vscode.postMessage({ type: 'removePrePrompt', id: id, index: index }); }
function previewItem(id) {
  var item = currentItems.find(function(i) { return i.id === id; });
  if (item) vscode.postMessage({
    type: 'previewItem',
    id: id,
    text: item.originalText,
    template: item.template || '',
    answerWrapper: item.answerWrapper || false,
    // Spec §4.16 — preview applies the template from the effective
    // transport's store; include the item's pinned transport so the
    // backend resolver hits the right store.
    transport: item.transport || 'copilot',
  });
}
function openEntryFile(id) {
  vscode.postMessage({ type: 'showEntryFile', id: id });
}
function editItemTransport(id) {
  // Spec §4.10 — per-item Advanced override. The backend opens a
  // QuickPick flow (transport → profile → config) and calls
  // updateItemTransport when the user confirms.
  vscode.postMessage({ type: 'editItemTransport', id: id });
}
function editPrePromptTransport(id, index) {
  // Spec §4.10 — per-stage Advanced override for a pre-prompt.
  vscode.postMessage({ type: 'editPrePromptTransport', id: id, index: index });
}
function editFollowUpTransport(id, followUpId) {
  // Spec §4.10 — per-stage Advanced override for a follow-up.
  vscode.postMessage({ type: 'editFollowUpTransport', id: id, followUpId: followUpId });
}
function toggleAnswerExpand(ansId) {
  // Spec §4.10 — expand/collapse the inline answerText preview.
  var el = document.getElementById(ansId);
  if (!el) { return; }
  var isExpanded = el.getAttribute('data-expanded') === 'true';
  el.textContent = isExpanded ? el.getAttribute('data-truncated') : el.getAttribute('data-full');
  el.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
  el.style.maxHeight = isExpanded ? '200px' : 'none';
  // Flip the toggle chevron so the icon mirrors the state.
  var toggle = document.getElementById(ansId + '-toggle');
  if (toggle) {
    toggle.classList.remove('codicon-chevron-down');
    toggle.classList.remove('codicon-chevron-up');
    toggle.classList.add(isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-up');
  }
}
function previewFollowUp(id, followUpId) {
  var item = currentItems.find(function(i) { return i.id === id; });
  if (!item || !Array.isArray(item.followUps)) return;
  var follow = item.followUps.find(function(f) { return f.id === followUpId; });
  if (follow) vscode.postMessage({
    type: 'previewFollowUp',
    id: id,
    followUpId: followUpId,
    text: follow.originalText || '',
    template: follow.template || '',
    // Spec §4.16 — stage-level transport wins, falls back to item-level.
    transport: follow.transport || item.transport || 'copilot',
  });
}
`;
}
