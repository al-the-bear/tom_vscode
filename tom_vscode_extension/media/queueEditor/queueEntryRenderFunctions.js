// @ts-nocheck
/* eslint-disable no-undef */
// queueEntryRenderFunctions — extracted verbatim from queueEntryRenderFunctions() in src/handlers/queueEntryComponent.ts (Phase B.13 webview
// restructuring). This is a host-scope mixin: its functions reference page
// globals (currentItems, vscode, detailsExpanded, reminderTemplates, editorMode,
// render, …) declared by media/queueEditor/main.js, so no-undef is disabled.
// The same file is also concatenated into the queue template editor script via
// queueEntryComponent.ts (readMediaText), keeping a single source of truth.
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
  // "SENDING (PAUSED)" — only meaningful in the queue editor (the
  // template editor doesn't define `autoSend`). The in-flight rep
  // has finished or will finish naturally; the pause gate refuses to
  // start the *next* one. Clicking auto-send resumes from the
  // persisted counter.
  if (isSending && typeof autoSend !== 'undefined' && autoSend === false) {
    statusLabel = 'SENDING (PAUSED)';
  }

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

  // Main prompt repeat progress: "MP 1/3 (varName)" with input + skip button when sending/staged.
  // For staged/pending, also expose the start-rep-number as an input so the
  // user can skip ahead (or replay) a specific rep without round-tripping
  // through a tools call. Value is 1-based to match the displayed format
  // (currentRepeatNumber = repeatIndex + 1); the JS wrapper translates back
  // to the 0-based repeatIndex.
  var mainRepeatLabel = formatRepeatLabel(repeatCountRaw, item.repeatIndex, item.resolvedRepeatCount);
  var repeatProgress = '';
  var mpStartNumber = Math.max(1, repeatIndex + 1);
  if (mainRepeatLabel || isSending || isStaged || isPending) {
    if (isStaged || isPending) {
      // Replace the static "current rep number" portion of the label with
      // an editable input. The label was only synthesised above for the
      // non-editable path, so we re-render the count-side manually here.
      repeatProgress = '  [MP <input type="text" value="' + mpStartNumber
        + '" style="width:28px" title="Main-prompt start rep number — 1-based; the next dispatch will fire this rep" placeholder="1"'
        + ' onclick="event.stopPropagation()" onkeydown="submitRepeatStartIndexFromStatus(event, \'' + safeId + '\', this)">/'
        + '<input type="text" value="' + escapeHtml(repeatCountDisplay)
        + '" style="width:38px" title="Update main prompt repeat count (Enter)" placeholder="1 or var" onclick="event.stopPropagation()"'
        + ' onkeydown="submitRepeatCountFromStatus(event, \'' + safeId + '\', ' + repeatIndex + ', this)">';
    } else {
      if (mainRepeatLabel) {
        repeatProgress = '  [MP ' + mainRepeatLabel;
      } else {
        repeatProgress = '  [MP ';
      }
      if (isSending) {
        repeatProgress += ' <input type="text" value="' + escapeHtml(repeatCountDisplay) + '" style="width:38px" title="Update main prompt repeat count (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitRepeatCountFromStatus(event, \'' + safeId + '\', ' + repeatIndex + ', this)">';
      }
    }
    if (isSending && mainRepeatLabel) {
      repeatProgress += ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeId + '\')" title="Skip to next iteration"></span>';
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
  if (isStaged || isPending) {
    // Expose the template start index as an editable input. The
    // display convention for templateRepeatIndex is 0-based — the
    // user sees "0/3" for "next iteration is #1 of 3", "1/3" for
    // "iteration 1 done, next is #2". Keep the input on the same
    // 0-based axis to match what is already on screen.
    tplRepeatProgress = '  [T <input type="text" value="' + tplCurrent
      + '" style="width:28px" title="Template start iteration index — 0-based; next iteration to dispatch" placeholder="0"'
      + ' onclick="event.stopPropagation()" onkeydown="submitTemplateStartIndexFromStatus(event, \'' + safeId + '\', this)">/'
      + '<input type="text" value="' + escapeHtml(tplRepeatCountDisplay) + '" style="width:38px" title="Update template repeat total (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitTemplateRepeatFromStatus(event, \'' + safeId + '\', this)">'
      + ']';
  } else if (isSending) {
    tplRepeatProgress = '  [T ' + tplCurrent + '/'
      + '<input type="text" value="' + escapeHtml(tplRepeatCountDisplay) + '" style="width:38px" title="Update template repeat total (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitTemplateRepeatFromStatus(event, \'' + safeId + '\', this)">'
      + ((tplRepeatCount > 1 || tplRepeatIsVar) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeId + '\')" title="Skip to next template iteration"></span>' : '')
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
         '<select onchange="updateItemTemplate(\'' + safeId + '\', this.value)">' +
           '<option value="">(None)</option>' +
           mpTplOptions +
         '</select>')
      : '';
    templateRow = '<div class="template-row">' +
      templateSelectHtml +
      '<label style="font-size:0.85em;font-weight:600;margin-left:' + (showTemplateSelect ? '0' : '0') + ';">Reminder:</label>' +
      '<select onchange="updateItemReminder(\'' + safeId + '\', \'template\', this.value)">' +
        '<option value=""' + (!noReminderSelected && !item.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
        '<option value="__none__"' + (noReminderSelected ? ' selected' : '') + '>No reminder</option>' +
        reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (item.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
      '</select>' +
      '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
      '<select onchange="updateItemReminder(\'' + safeId + '\', \'timeout\', this.value)">' + reminderTimeoutOptions(item.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
      '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Queue Repeats:</span>' +
      '<input type="text" value="' + escapeHtml(repeatCountDisplay) + '" style="width:50px" placeholder="1 or var" title="Number or variable name (e.g. batchCount)" onchange="updateItemRepeat(\'' + safeId + '\', { repeatCount: this.value })">' +
      '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait (min):</span>' +
      '<input type="number" min="0" step="1" value="' + Math.max(0, parseInt(String(item.answerWaitMinutes || 0), 10) || 0) + '" style="width:33px" title="Minutes to wait before auto-advancing (0 = wait for answer file)" onchange="updateItemRepeat(\'' + safeId + '\', { answerWaitMinutes: this.value })">' +
    '</div>' +
    '<div class="repeat-affix-row">' +
      '<label style="font-size:0.8em;opacity:0.9;">Repeat Prefix (supports ${repeatNumber}, ${repeatIndex}, ${repeatCount})</label>' +
      '<textarea onchange="updateItemRepeat(\'' + safeId + '\', { repeatPrefix: this.value })">' + escapeHtml(repeatPrefix) + '</textarea>' +
      '<label style="font-size:0.8em;opacity:0.9;">Repeat Suffix (supports ${repeatNumber}, ${repeatIndex}, ${repeatCount})</label>' +
      '<textarea onchange="updateItemRepeat(\'' + safeId + '\', { repeatSuffix: this.value })">' + escapeHtml(repeatSuffix) + '</textarea>' +
      '<label style="font-size:0.8em;opacity:0.9;margin-top:8px;">Template Repeat Count (repeat entire template)</label>' +
      '<input type="text" value="' + escapeHtml(templateRepeatCountDisplay) + '" style="width:50px" placeholder="1" title="How many times to repeat the entire template" onchange="updateItemRepeat(\'' + safeId + '\', { templateRepeatCount: this.value })">' +
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
          '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\'' + safeId + '\')" title="Toggle details"></span>' +
          statusLabel + repeatProgress + tplRepeatProgress + transportBadge +
          (item.template && item.template !== '(None)' && item.template !== '__answer_file__' ? '  [' + escapeHtml(item.template) + ']' : '') +
          (item.template && item.template !== '(None)' ? '  [AW]' : '') +
          '<span class="status-icons">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;color:#000;" onclick="previewItem(\'' + safeId + '\')" title="Preview"></span>' +
          (isStaged ? '<span class="codicon codicon-arrow-right" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'pending\')" title="Set to Pending"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Move back to Staged"></span>' : '') +
          (isSending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Interrupt and move to Staged"></span>' : '') +
          (isSent ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Stage again"></span>' : '') +
          ((isPending || isStaged) ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="sendNow(\'' + safeId + '\')" title="Send Now"></span>' : '') +
          (isSending ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="continueSending(\'' + safeId + '\')" title="Continue"></span>' : '') +
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
            ? '<span class="codicon codicon-history" style="cursor:pointer;color:#000;" onclick="resetToPending(\'' + safeId + '\')" title="Set to Pending (does not send — re-enable auto-send to resume the queue)"></span>'
            : '') +
          // Resend last dispatch — available once there is a recorded
          // lastDispatched (i.e. at least one stage has been sent) and
          // the item isn't currently in-flight or errored. Re-sends
          // the exact expanded text byte-for-byte; repetition
          // counters are not touched, so the queue continues from
          // where it was.
          (item.lastDispatched && !isSending && !isError
            ? '<span class="codicon codicon-refresh" style="cursor:pointer;color:#000;" onclick="resendLastPrompt(\'' + safeId + '\')" title="Resend last prompt (keeps repetition counters)"></span>'
            : '') +
          (isPending ? '<span class="codicon codicon-arrow-up" style="cursor:pointer;color:#000;" onclick="moveDown(\'' + safeId + '\')" title="Move up (away from send)"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-down" style="cursor:pointer;color:#000;" onclick="moveUp(\'' + safeId + '\')" title="Move down (closer to send)"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-circle-up" style="cursor:pointer;color:#000;" onclick="moveToFront(\'' + safeId + '\')" title="Send next (move to front of pending queue)"></span>' : '') +
          (isSending ? '<span class="codicon ' + (reminderEnabled ? 'codicon-bell' : 'codicon-bell-slash') + '" style="cursor:pointer;color:' + (reminderEnabled ? '#000' : '#888') + ';" onclick="toggleReminder(\'' + safeId + '\', ' + !reminderEnabled + ')" title="' + (reminderEnabled ? 'Reminders ON - click to disable' : 'Reminders OFF - click to enable') + '"></span>' : '') +
          // Staged-only: once an item is pending or sending, the
          // manager rejects transport updates (isEditableStatus). Hide
          // the gear so users don't click a no-op.
          (isStaged ? '<span class="codicon codicon-settings" style="cursor:pointer;color:#000;" onclick="editItemTransport(\'' + safeId + '\')" title="Change transport (Copilot / Anthropic + profile + config)"></span>' : '') +
          '<span class="codicon codicon-go-to-file" style="cursor:pointer;color:#000;" onclick="openEntryFile(\'' + safeId + '\')" title="Open YAML file"></span>' +
          '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="remove(\'' + safeId + '\')" title="Delete"></span>' +
          '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          '#' + queuePos + '  ' + time + (sentTime ? ' \u2192 ' + sentTime : '') +
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
        (fullText.length > 600 ? '<span id="' + ansId + '-toggle" class="codicon codicon-chevron-down answer-toggle-icon" style="margin-left:auto;cursor:pointer;color:var(--fg);opacity:1;" onclick="toggleAnswerExpand(\'' + ansId + '\')" title="Expand / collapse"></span>' : '') +
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
      ? '<textarea onchange="updateText(\'' + safeId + '\', this.value)">' + escapeHtml(item.originalText) + '</textarea>'
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
    var doneMark = ppStatus === 'sent' ? '\u2713 ' : ppStatus === 'error' ? '\u2717 ' : '';
    var templateLabel = formatPromptTemplateName(pp.template || '(None)');
    var isActive = idx === activePrePromptIndex;
    var ppRepeatCountRaw = pp.repeatCount;
    var ppRepeatCountDisplay = ppRepeatCountRaw ? String(ppRepeatCountRaw) : '1';
    var ppRepeatLabel = formatRepeatLabel(ppRepeatCountRaw, pp.repeatIndex, pp.resolvedRepeatCount);
    var ppSkipBtn = (isActive && ppRepeatLabel) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeItemId + '\')" title="Skip to next PP iteration"></span>' : '';
    var ppAnswerWait = Math.max(0, parseInt(String(pp.answerWaitMinutes || 0), 10) || 0);
    var ppHasExplicitReminder = pp.reminderEnabled === true || !!pp.reminderTemplateId;
    var ppNoReminderSelected = !ppHasExplicitReminder;
    return '<div class="preprompt-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="preprompt-item-head">' +
        '<span>' + doneMark + 'Pre-prompt #' + (idx + 1) + (pp.template ? ' [' + escapeHtml(templateLabel) + ']' : '') + (ppRepeatLabel ? ' [PP ' + ppRepeatLabel + ppSkipBtn + ']' : '') +
        (pp.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (pp.anthropicProfileId ? ':' + escapeHtml(pp.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editPrePromptTransport(\'' + safeItemId + '\', ' + idx + ')" title="Change transport (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removePrePrompt(\'' + safeItemId + '\', ' + idx + ')" title="Delete pre-prompt"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var ppShowTpl = editorMode !== 'template';
            var ppTplHtml = ppShowTpl
              ? ('<label style="font-size:0.85em;font-weight:600;">Template:</label>' +
                 '<select onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'template\', this.value)">' +
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
            return '<textarea onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'text\', this.value)">' + escapeHtml(pp.text || '') + '</textarea>' +
          '<div class="template-row">' +
            ppTplHtml +
            '<select onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'reminderTemplateId\', this.value)">' +
              '<option value=""' + (!ppNoReminderSelected && !pp.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
              '<option value="__none__"' + (ppNoReminderSelected ? ' selected' : '') + '>No reminder</option>' +
              reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (pp.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
            '</select>' +
            '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
            '<select onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'reminderTimeoutMinutes\', this.value)">' + reminderTimeoutOptions(pp.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
            '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
            '<input type="text" value="' + escapeHtml(ppRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'repeatCount\', this.value)">' +
            '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait:</span>' +
            '<input type="number" min="0" step="1" value="' + ppAnswerWait + '" style="width:33px" title="Minutes to wait" onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'answerWaitMinutes\', this.value)">' +
          '</div>';
          })()
        : '<div class="preprompt-content" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(pp.text || '') + '</div>') +
    '</div>';
  }).join('');

  return '<div class="preprompt-block indented">' +
    '<div style="font-size:0.85em;opacity:0.85;display:flex;align-items:center;gap:6px;">' +
      'Pre-Prompts (sent before main prompt)' +
      (isEditable ? '<button class="ctx-btn-icon" onclick="addPrePrompt(\'' + safeItemId + '\')" title="Add Pre-prompt"><span class="codicon codicon-add"></span></button>' : '') +
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
    var doneMark = idx < sentFollowUps ? '\u2713 ' : '';
    var templateLabel = formatPromptTemplateName(f.template || '(None)');
    var isActive = idx === activeFollowUpIndex;
    var fuRepeatCountRaw = f.repeatCount;
    var fuRepeatCountDisplay = fuRepeatCountRaw ? String(fuRepeatCountRaw) : '1';
    var fuRepeatLabel = formatRepeatLabel(fuRepeatCountRaw, f.repeatIndex, f.resolvedRepeatCount);
    var fuSkipBtn = (isActive && fuRepeatLabel) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeItemId + '\')" title="Skip to next FU iteration"></span>' : '';
    var fuAnswerWait = Math.max(0, parseInt(String(f.answerWaitMinutes || 0), 10) || 0);
    return '<div class="followup-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="followup-item-head">' +
        '<span>' + doneMark + 'Follow-up #' + (idx + 1) + (f.template ? (' [' + escapeHtml(templateLabel) + ']') : '') + (fuRepeatLabel ? ' [FU ' + fuRepeatLabel + fuSkipBtn + ']' : '') + ' [AW]' +
        (f.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (f.anthropicProfileId ? ':' + escapeHtml(f.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;" onclick="previewFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Preview follow-up"></span>' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editFollowUpTransport(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Change transport (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removeFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Delete follow-up"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var fuShowTpl = editorMode !== 'template';
            var fuTplHtml = fuShowTpl
              ? ('<span style="font-size:0.8em;opacity:0.85;">Template:</span>' +
                 '<select onchange="updateFollowUpTemplate(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', this.value)">' +
                   '<option value="">(None)</option>' +
                   ((f.transport || item.transport) === 'anthropic'
                     ? (anthropicUserMessageTemplates || []).map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + ((f.template || '') === t.id ? ' selected' : '') + '>' + escapeHtml(t.name || t.id) + '</option>'; }).join('')
                     : (promptTemplates || []).map(function(name){ return '<option value="' + escapeHtml(name) + '"' + ((f.template || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>'; }).join('')) +
                 '</select>')
              : '';
            return '<textarea onchange="updateFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', this.value)">' + escapeHtml(f.originalText || '') + '</textarea>' +
          '<div class="followup-actions">' +
            '<div class="followup-row">' +
              fuTplHtml +
              '<select onchange="updateFollowUpReminder(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', \'template\', this.value)">' +
                '<option value=""' + (!noReminderSelected && !f.reminderTemplateId ? ' selected' : '') + '>Global Default</option>' +
                '<option value="__none__"' + (noReminderSelected ? ' selected' : '') + '>No reminder</option>' +
                reminderTemplates.map(function(t){ return '<option value="' + escapeHtml(t.id) + '"' + (f.reminderTemplateId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>'; }).join('') +
              '</select>' +
              '<span style="font-size:0.8em;opacity:0.85;">Wait:</span>' +
              '<select onchange="updateFollowUpReminder(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', \'timeout\', this.value)">' + reminderTimeoutOptions(f.reminderTimeoutMinutes || responseTimeoutMinutes) + '</select>' +
              '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
              '<input type="text" value="' + escapeHtml(fuRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updateFollowUpField(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', \'repeatCount\', this.value)">' +
              '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Answer Wait:</span>' +
              '<input type="number" min="0" step="1" value="' + fuAnswerWait + '" style="width:33px" title="Minutes to wait" onchange="updateFollowUpField(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', \'answerWaitMinutes\', this.value)">' +
            '</div>' +
          '</div>';
          })()
        : '<div class="followup-content" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(f.originalText || '') + '</div>') +
    '</div>';
  }).join('');

  return '<div class="followup-block indented">' +
    '<div style="font-size:0.85em;opacity:0.85;display:flex;align-items:center;gap:6px;">' +
      'Follow-up Prompts (all wrapped with Answer Wrapper)' +
      (isEditable ? '<button class="ctx-btn-icon" onclick="addEmptyFollowUp(\'' + safeItemId + '\')" title="Add Follow-up"><span class="codicon codicon-add"></span></button>' : '') +
    '</div>' +
    '<div class="followup-list">' + rows + (followUps.length === 0 ? '<div style="opacity:0.75;font-size:0.8em;">No follow-up prompts yet.</div>' : '') + '</div>' +
  '</div>';
}
