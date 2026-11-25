// @ts-nocheck
/* The statuses a person may set an item's status from (src/utils/queueStatusChange.ts queueStatusChoices), and those
   in which a turn runs or holds (changing them stops it first). */
var QUEUE_MANUAL_STATUS_FROM = ['staged', 'pending', 'sent', 'error', 'waiting', 'retry', 'sending', 'interrupted', 'todo-blocked', 'decision-needed'];
var QUEUE_ACTIVE_STATUSES = ['sending', 'interrupted', 'todo-blocked', 'decision-needed'];
/* The statuses an item may move to another run or session from (canRelocateQueueItem): everything not sent. */
var QUEUE_RELOCATABLE_STATUSES = ['staged', 'pending', 'error', 'waiting', 'retry', 'sending', 'interrupted', 'todo-blocked', 'decision-needed'];
/* eslint-disable no-undef */
// queueEntryRenderFunctions — extracted verbatim from queueEntryRenderFunctions() in src/handlers/queueEntryComponent.ts (Phase B.13 webview
// restructuring). This is a host-scope mixin: its functions reference page
// globals (currentItems, vscode, detailsExpanded, editorMode,
// render, …) declared by the host panel main.js (media/queueEditor or media/queueTemplateEditor), so no-undef is disabled. Promoted to media/shared in B.14 (used by both editors).
// Both the queue editor and the queue template editor load this file as a
// <script src> from media/shared/ (loader {{sharedUri}}), keeping one source of truth.
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
  var safeId = escapeJsSingleQuoted(item.id);
  var safeStatus = normalizeQueueStatus(item.status);
  // A chat send (status `chat` while it runs, `chat-sent` after; src/utils/chatQueueItems.ts): drawn like
  // every other item, with its own headline colour (`chat-kind`). The queue never sends it, so only the
  // controls that read it stay (the session and run chips, the live trail, the YAML file, Delete).
  var isChat = safeStatus === 'chat' || safeStatus === 'chat-sent';
  var isChatRunning = safeStatus === 'chat';
  var queuePos = idx + 1;
  var typeIconClass = item.type === 'timed' ? 'codicon-watch' : 'codicon-comment';
  var cls = [safeStatus];
  if (isChat) cls.push('chat-item');
  // Yellow left border for items carrying an interruption warning
  // (rate limit / quota / overloaded / cancelled / interrupted).
  if ((item.warning && item.warning.kind) || (Array.isArray(item.apiKeyWarnings) && item.apiKeyWarnings.length > 0)) cls.push('warned');
  // Its running prompt waits for the user (a question or an approval is open): a colour of its own.
  // (An ended chat send waits for nothing.)
  var waitingForUser = Array.isArray(item.waitingForUser) && item.waitingForUser.length > 0 && safeStatus !== 'chat-sent';
  if (waitingForUser) cls.push('waiting-for-user');
  var time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : '';
  var sentTime = item.sentAt ? new Date(item.sentAt).toLocaleTimeString() : '';
  var isPending = safeStatus === 'pending';
  var isStaged = safeStatus === 'staged';
  // The item's effective session (its own, else the queue default), with its base and lifetime:
  // from the session file, or — for a session not created yet — from the item's spec.
  var chipSessionName = item.session || (typeof queueDefaultSessionLabel !== 'undefined' ? queueDefaultSessionLabel : 'default');
  var knownSessions = typeof sessionInfo !== 'undefined' && sessionInfo ? sessionInfo : {};
  var chipSpecPending = !!(item.session && item.sessionCreate && !knownSessions[item.session]);
  var chipSession = describeQueueSession(chipSessionName, chipSpecPending ? item.sessionCreate : knownSessions[chipSessionName], chipSpecPending);
  var isSending = safeStatus === 'sending';
  var isSent = safeStatus === 'sent';
  var isError = safeStatus === 'error';
  var isWaiting = safeStatus === 'waiting';
  var isRetry = safeStatus === 'retry';
  var isInterrupted = safeStatus === 'interrupted';
  var isTodoBlocked = safeStatus === 'todo-blocked';
  var pauseAfter = item.pauseAfter === true;
  var isEditable = editorMode === 'template' || isStaged;
  // A pending item's text opened for editing in the queue editor (queueTextEdits,
  // its draft by item id): the queue waits for it until it is saved or cancelled.
  var textEditDraft = (isPending && typeof queueTextEdits !== 'undefined' && queueTextEdits && Object.prototype.hasOwnProperty.call(queueTextEdits, item.id))
    ? queueTextEdits[item.id] : undefined;
  var isMainPromptActive = safeStatus === 'sending' && !!item.requestId && (item.followUpIndex || 0) === 0;
  var statusBarCls = isChat ? 'chat-kind' + (isChatRunning ? ' running' : '') : safeStatus;
  // The label: status and kind in one (vscimpb128: PENDING TODO, SENDING GROUP, STAGED PROMPT, …;
  // queueStatusKindLabel in queueEntryUtils.js), then what holds or delays it (`stateDetail`).
  var stateWord = safeStatus;
  var stateDetail = '';
  var stateDetailHtml = '';
  // Paused sending item — only meaningful in the queue editor (the template
  // editor doesn't define `autoSend`). Distinguish two cases so the user can
  // tell whether the current iteration is still running or already done:
  //   • awaitingAnswer → a prompt is still in flight → "SENDING TODO (PAUSED)" (green)
  //   • else           → iteration done, idle, waiting to resume → "PAUSED TODO" (amber)
  // Clicking auto-send resumes from the persisted counter.
  if (isSending && typeof autoSend !== 'undefined' && autoSend === false) {
    if (item.awaitingAnswer) { stateDetail = '(PAUSED)'; } else { stateWord = 'paused'; }
  }
  // A direct send inside its retry loop: rate limited until the reset the API
  // stated, or backing off after an overload / 5xx (sendWait, set by the
  // manager while the wait lasts), e.g. "SENDING TODO — RATE LIMITED, RETRY 2 AT 14:32:05".
  if (isSending && item.sendWait && item.sendWait.until) {
    var swd = new Date(item.sendWait.until);
    var swTime = isNaN(swd.getTime()) ? '' : swd.toLocaleTimeString();
    var swWhat = item.sendWait.kind === 'rate_limit' ? 'RATE LIMITED' : 'API BUSY';
    stateWord = 'sending';
    stateDetail = '\u2014 ' + swWhat + ', RETRY ' + (parseInt(String(item.sendWait.attempt || 0), 10) || 0)
      + (swTime ? ' AT ' + swTime.toUpperCase() : '');
  }
  // Rate-limit parked item: show the human-friendly reset time from the
  // "resets <time> (<tz>)" clause, or the reset a direct send was told by
  // the API. The manager persists the stated reset label (waitingResetLabel);
  // the item auto-retries 5 min after a "resets" clause, at once after an API reset.
  if (isWaiting) {
    stateDetail = 'FOR ' + (item.waitingResetLabel ? String(item.waitingResetLabel).toUpperCase() : 'RESET');
  }
  // Retry-parked item: show attempt count + the next-retry clock time so the
  // user can see the backoff progress (e.g. "RETRYING TODO 2/7 — NEXT 11:05:30").
  if (isRetry) {
    var retryAttemptNum = Math.max(0, parseInt(String(item.retryAttempt || 0), 10) || 0);
    var retryNextTime = '';
    if (item.retryUntil) {
      var rd = new Date(item.retryUntil);
      if (!isNaN(rd.getTime())) { retryNextTime = rd.toLocaleTimeString(); }
    }
    stateWord = 'retrying';
    stateDetail = retryAttemptNum + '/7' + (retryNextTime ? ' \u2014 NEXT ' + retryNextTime.toUpperCase() : '');
  }

  // Interrupt-for-continuation: held on purpose; the label says what will
  // happen so the user knows re-arming auto-send is all it takes.
  if (isInterrupted) {
    stateDetail = '\u2014 RESENDS ON RESUME';
  }
  // Interrupt for continuation, soft (vscimpb112), and what else holds a running turn: a state of its own each,
  // after the label ("SENDING TODO — ❓ ANSWER NEEDED").
  var softLabel = isSending ? softInterruptRowLabel(item) : '';
  if (softLabel) { stateWord = 'sending'; stateDetail = ''; stateDetailHtml = '\u2014 ' + softLabel; }
  var statusKind = queueStatusKindLabel(stateWord, queueItemKindOf(item));
  // The status set by hand (the queue editor): error, waiting and retry back to pending or staged, or sent when the
  // work was done; a running or held item stopped first (src/utils/queueStatusChange.ts, the host's pickItemStatus).
  var statusChangeable = editorMode === 'queue' && !isChat && QUEUE_MANUAL_STATUS_FROM.indexOf(safeStatus) >= 0;
  var statusLabel = '<span class="' + statusKind.cls + (statusChangeable ? ' status-pick' : '') + '"'
    + (statusChangeable ? ' role="button" style="cursor:pointer;" onclick="event.stopPropagation();pickItemStatus(\'' + safeId + '\')"' : '')
    + ' title="' + (isChat
      ? (isChatRunning ? 'A chat send, running' : 'A chat send, ended') + ' \u2014 shown here, never sent by the queue'
      : 'Status and kind of the item' + (statusChangeable ? ' \u2014 click to set it: pending, staged or sent' + (QUEUE_ACTIVE_STATUSES.indexOf(safeStatus) >= 0 ? ' (the running or held turn is stopped first)' : '') : '')) + '">' + escapeHtml(statusKind.text) + '</span>' +
    (stateDetail ? ' ' + escapeHtml(stateDetail) : '') + (stateDetailHtml ? ' ' + stateDetailHtml : '');

  // Green→amber header for the head-of-queue item. The queue is "active" while
  // it will proceed on its own (auto-send on) OR a prompt is genuinely in
  // flight (some sending item is awaiting an answer). When neither holds the
  // queue is idle/paused, so the currently-sending item (between iterations)
  // and the next pending item turn amber — a stopped queue is visually
  // distinct from a running one, and the amber says "waiting to be started".
  var queueActive = (typeof autoSend !== 'undefined' && autoSend === true)
    || (typeof currentItems !== 'undefined' && Array.isArray(currentItems)
        && currentItems.some(function(it) { return it && it.status === 'sending' && it.awaitingAnswer; }));
  if (!queueActive && (isSending || isPending)) {
    statusBarCls += ' idle';
  }

  var followUps = Array.isArray(item.followUps) ? item.followUps : [];
  var sentFollowUps = item.followUpIndex || 0;
  // repeatCount can be a number or a string (variable name)
  var repeatCountRaw = item.repeatCount;
  var repeatCountIsVar = typeof repeatCountRaw === 'string' && isNaN(parseInt(repeatCountRaw, 10));
  var repeatCount = repeatCountIsVar ? 0 : Math.max(0, parseInt(String(repeatCountRaw || 0), 10) || 0);
  var repeatCountDisplay = repeatCountIsVar ? String(repeatCountRaw) : String(Math.max(1, repeatCount));
  var repeatIndex = Math.max(0, parseInt(String(item.repeatIndex || 0), 10) || 0);
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
  // A todo walk — `<prefix>*`, a GROUP item (`group:<quest>/<id>`) or a TODO item (`todo:<quest>/<id>`) — is driven
  // by the quest todos' status, not by a counter: its header shows what it walks instead of the repeat counters
  // (`todos wwremind*`, `todo group <id>`, `todo <id>`), the todo being worked on beside it.
  var walkInfo = todoWalkInfo(repeatCountRaw);
  if (walkInfo) {
    repeatProgress = '  <span class="walk-info" title="' + escapeHtml(walkInfo.title) + '">' + escapeHtml(walkInfo.label) + '</span>'
      + (isSending ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeId + '\')" title="Skip to next todo"></span>' : '');
    if (item.repeatTodoId && walkInfo.kind !== 'todo') {
      repeatProgress += '  <span style="background:#6f42c1;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="Quest todo this main prompt is working on">['
        + escapeHtml(String(item.repeatTodoId)) + ']</span>';
    }
  } else if (mainRepeatLabel || isSending || isStaged || isPending) {
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
    } else if (isSending) {
      // Sending: expose the current rep index (1-based, editable) alongside
      // the count so the running loop can be steered — the change applies on
      // the next repetition. Mirrors the staged/pending "index/count" pair.
      repeatProgress = '  [MP <input type="text" value="' + mpStartNumber
        + '" style="width:28px" title="Current main-prompt rep number — 1-based; takes effect on the next repetition" placeholder="1"'
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
    // Sending: expose the current template iteration index (0-based, editable)
    // alongside the total so the running template loop can be steered — the
    // change applies on the next iteration. Mirrors the staged/pending pair.
    tplRepeatProgress = '  [T <input type="text" value="' + tplCurrent
      + '" style="width:28px" title="Current template iteration index — 0-based; takes effect on the next iteration" placeholder="0"'
      + ' onclick="event.stopPropagation()" onkeydown="submitTemplateStartIndexFromStatus(event, \'' + safeId + '\', this)">/'
      + '<input type="text" value="' + escapeHtml(tplRepeatCountDisplay) + '" style="width:38px" title="Update template repeat total (Enter)" placeholder="1 or var" onclick="event.stopPropagation()" onkeydown="submitTemplateRepeatFromStatus(event, \'' + safeId + '\', this)">'
      + ((tplRepeatCount > 1 || tplRepeatIsVar) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeId + '\')" title="Skip to next template iteration"></span>' : '')
      + ']';
  } else if (tplRepeatCount > 1 || tplRepeatIsVar) {
    tplRepeatProgress = '  [T ' + tplCurrent + '/' + tplTotal + ' (' + escapeHtml(tplRepeatCountDisplay) + ')]';
  }
  // A todo walk shows no counters: the template counter only when the item really repeats its template.
  if (walkInfo && !(tplRepeatCount > 1 || tplRepeatIsVar)) { tplRepeatProgress = ''; }

  var expanded = detailsExpanded[item.id] !== false;

  /* --- Template picker row --- */
  var templateRow = '';
  if (isEditable) {
    var repeatPrefix = (typeof item.repeatPrefix === 'string') ? item.repeatPrefix : '';
    var repeatSuffix = (typeof item.repeatSuffix === 'string') ? item.repeatSuffix : '';
    var templateRepeatCountRaw = item.templateRepeatCount;
    var templateRepeatCountDisplay = templateRepeatCountRaw ? String(templateRepeatCountRaw) : '1';
    // The template dropdown lists the user-message templates.
    // Queue-template editor (editorMode='template') no longer exposes
    // a per-item template — all main prompts inherit the queue-level
    // template at queue-dispatch time.
    var mpTplOptions = promptTemplateOptionsHtml(item.template);
    var showTemplateSelect = editorMode !== 'template';
    var templateSelectHtml = showTemplateSelect
      ? ('<label style="font-size:0.85em;font-weight:600;" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">Prompt template:</label>' +
         '<select onchange="updateItemTemplate(\'' + safeId + '\', this.value)" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">' +
           runDefaultTemplateOption(item, item.template) +
           '<option value=""' + (!item.template || item.template === '(None)' ? ' selected' : '') + '>(None)</option>' +
           mpTplOptions +
         '</select>')
      : '';
    templateRow = '<div class="template-row">' +
      templateSelectHtml +
      '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Queue Repeats:</span>' +
      '<input type="text" value="' + escapeHtml(repeatCountDisplay) + '" style="width:50px" placeholder="1 or var" title="Number or variable name (e.g. batchCount)" onchange="updateItemRepeat(\'' + safeId + '\', { repeatCount: this.value })">' +
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
  /* The profile the item runs with (src/utils/queueItemProfile.ts): its own as a
   * clickable name, else an icon button — it runs with the session's profile or
   * the queue default, named in the tooltip. A click opens the profile picker
   * (every profile, whatever its transport) until the item has finished.
   */
  var transportBadge = renderItemProfile(item, safeId);
  /* Process position: the step the item belongs to (a Proceed prompt, what it
   * queued, or the process-move marker that moves the process on after them). */
  // A tomAi_askUser question the turn waits in: since when, and a button that opens it
  // (the question stays pending when its tab is closed).
  var pendingQuestionBadge = item.pendingQuestionSince
    ? '  <span class="waiting-user-badge" title="The running prompt waits for your answer to a question. Open question shows it again, also when its tab was closed.">[\u23f3 waiting for your answer ' + escapeHtml(String(item.pendingQuestionSince)) + ']</span>'
      + ' <button class="open-question-btn" onclick="event.stopPropagation();openPendingQuestion(\'' + safeId + '\')" title="Open the question this item\'s turn waits for">Open question</button>'
    : '';
  var userWaitBadge = pendingQuestionBadge ? pendingQuestionBadge : waitingForUser ? waitingForUserBadge(item, safeId) : '';
  // A walk iteration still unfinished after its continuations: the item stopped (auto-send off).
  // Held because the todo it is about waits for one that is not completed (blockedOn names both).
  var blockedBadge = item.status === 'todo-blocked'
    ? '  <span class="todo-blocked-badge" title="' + escapeHtml('Held: ' + String(item.blockedOn || 'its todo is blocked') + '. It goes back to pending once the blocker is completed; resume the run then.') + '">[\u26d4 blocked: ' + escapeHtml(String(item.blockedOn || 'its todo is blocked')) + ']</span>'
    : '';
  var attentionBadge = item.needsAttention
    ? '  <span class="needs-attention-badge" title="' + escapeHtml(String(item.needsAttention)) + '">[\u26a0 needs attention]</span>'
    : '';
  var processBadge = userWaitBadge + blockedBadge + attentionBadge + (item.sendBetween
    ? '  <span class="send-between-badge" style="background:#b5179e;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="Sent after the running loop\'s current iteration, before its next one">[⇄ between iterations]</span>'
    : '')
    // "Let the next item go first" armed (vscimpb60e): shown until it yields.
    + (item.yieldAfterIteration
      ? '  <span class="yield-badge" style="background:#0e7c86;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="After its running iteration this item steps back and the next item of its lane goes first; the walk resumes after it. Click the step-over button again to keep iterating.">[yields after this iteration]</span>'
      : '');
  // A chat send runs in the session this item runs in: it waits and goes once that send ended.
  if (item.waitingForSession) {
    processBadge += '  <span class="waiting-session-badge" style="background:#3794ff;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="A chat send runs in this session: the item goes once it has ended (two prompts never share a conversation)">[waiting for session ' + escapeHtml(String(item.waitingForSession)) + ']</span>';
  }
  // The process run the item belongs to (vscimpb45): a chip like the todo chip beside it (runChip, in the header's
  // right part). A staged or pending item's chip opens the run picker: the item moves into that run's queue.
  var itemRunName = item.run || (item.processRun && item.processRun.run) || 'default';
  // The run and session chips of an item not sent (staged, pending, parked after a failure, running or held) start
  // the move flow (the host's relocateItem: run, session, place); an item of a Proceed run keeps its run.
  var relocatable = editorMode === 'queue' && !isChat && QUEUE_RELOCATABLE_STATUSES.indexOf(safeStatus) >= 0 && !item.processMove;
  var runMovable = relocatable && !item.processRun;
  var runChip = '<span class="queue-from-chip queue-run-chip' + (runMovable ? ' movable' : '') + '" data-run="' + escapeHtml(itemRunName) + '" data-qid="' + escapeHtml(String(item.id)) + '"'
    + (runMovable ? ' onclick="event.stopPropagation();relocateItem(\'' + safeId + '\')"' : '')
    + ' title="' + escapeHtml('The process run of the quest this item belongs to' + (itemRunName === 'default' ? ' (the quest\'s own position)' : '')
      + (runMovable ? '. Click to move it: the run, its session there (or a new one), and its place — at the end, at the top, or next between iterations'
        + (QUEUE_ACTIVE_STATUSES.indexOf(safeStatus) >= 0 ? ' (its running or held turn is stopped; it goes on as pending)' : '') + '.'
        : relocatable ? '. It belongs to a Proceed run, so it stays in this run.' : '')) + '">'
    + (runMovable ? '<span class="codicon codicon-arrow-swap"></span>' : '') + 'run ' + escapeHtml(itemRunName) + '</span>';
  if (item.processMove) {
    processBadge += '  <span class="process-badge process-move" style="background:#8a63d2;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;" title="Process-move marker: never sent to a model. When the queue reaches it with the step\'s items done, it moves the process (' +
      escapeHtml(item.processPosition || '') + ' → ' + escapeHtml(item.processMove.to) + ').">[⏭ process move]</span>';
  } else if (item.processPosition) {
    processBadge += '  <span class="process-badge" style="border:1px solid #8a63d2;padding:0 4px;border-radius:3px;font-size:10px;" title="Runs as this process position">[⚙ ' + escapeHtml(item.processPosition) + ']</span>';
  }
  // A process item (vscimpb97): the work of a process step; it does not count towards the quest refresh.
  if (item.processItem && !item.processMove) {
    processBadge += '  <span class="process-badge process-item" style="border:1px dashed #8a63d2;padding:0 4px;border-radius:3px;font-size:10px;" title="A process item: the work of a process step. It does not count towards the quest refresh and triggers no refresh that is due.">[process item]</span>';
  }
  // The tokens the item's stages used in this run (summed by the host), so a
  // cache miss on a walk shows while it runs.
  if (item.sendUsageLine) {
    processBadge += '  <span class="usage-badge" style="border:1px solid #6a737d;padding:0 4px;border-radius:3px;font-size:10px;" title="Tokens this run of the item used, summed over its stages">[Σ ' + escapeHtml(item.sendUsageLine) + ']</span>';
  }
  if (editorMode === 'queue') {
    headerHtml = '<div class="item-header">' +
      '<div class="status-bar ' + statusBarCls + '">' +
        '<span class="status-left">' +
          '<span class="codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="cursor:pointer;color:#000;" onclick="toggleDetails(\'' + safeId + '\')" title="Toggle details"></span>' +
          statusLabel + repeatProgress + tplRepeatProgress + transportBadge + processBadge +
          (!isChat && item.template && item.template !== '(None)' && item.template !== '__answer_file__' ? '  [' + escapeHtml(item.template) + ']' : '') +
          (isChat ? chatSourceChip(item) : '') +
          '<span class="status-icons">' +
          (isChat ? '' : '<span class="codicon codicon-eye" style="cursor:pointer;color:#000;" onclick="previewItem(\'' + safeId + '\')" title="Preview"></span>') +
          (isStaged ? '<span class="codicon codicon-arrow-right" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'pending\')" title="Set to Pending"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Move back to Staged"></span>' : '') +
          (isSending ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Interrupt and move to Staged"></span>' : '') +
          // Interrupt for continuation — the disconnect icon: stop now, but hold
          // this exact rep and resend it when auto-send is re-enabled.
          (isSending ? '<span class="codicon ' + interruptButtonIcon(item) + '" style="cursor:pointer;color:#000;" onclick="interruptForContinuation(\'' + safeId + '\')" title="' + escapeHtml(interruptButtonTitle(item)) + '"></span>' : '') +
          (isInterrupted ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Abandon the continuation and move back to Staged"></span>' : '') +
          // Held at a blocked todo: Stop (back to staged, e.g. to renumber the todos and restart it), Continue past
          // the todo (a walk or GROUP item) and Run anyway (the blocking information may be out of date).
          (isTodoBlocked ? '<span class="codicon codicon-debug-stop" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Stop: move back to Staged (rearrange the todos, then set it to Pending to restart it)"></span>' : '') +
          (isTodoBlocked && item.blockedActions && item.blockedActions.canSkip ? '<span class="codicon codicon-debug-step-over" style="cursor:pointer;color:#000;" onclick="skipBlockedTodo(\'' + safeId + '\')" title="Continue: skip the blocked todo and go on with the next one"></span>' : '') +
          (isTodoBlocked && item.blockedActions && item.blockedActions.canRunAnyway ? '<span class="codicon codicon-run-all" style="cursor:pointer;color:#000;" onclick="runBlockedTodoAnyway(\'' + safeId + '\')" title="Run anyway: run the blocked todo now without waiting for its blockers"></span>' : '') +
          (isSent ? '<span class="codicon codicon-arrow-left" style="cursor:pointer;color:#000;" onclick="setItemStatus(\'' + safeId + '\', \'staged\')" title="Stage again"></span>' : '') +
          ((isPending || isStaged) ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="sendNow(\'' + safeId + '\')" title="Send Now"></span>' : '') +
          // A sent item can be sent again: the whole item runs once more from its first prompt.
          (isSent ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="sendNow(\'' + safeId + '\')" title="Send Now again (runs the whole item once more from its first prompt)"></span>' : '') +
          (isSending ? '<span class="codicon codicon-play" style="cursor:pointer;color:#000;" onclick="continueSending(\'' + safeId + '\')" title="Continue (asks first: answer the question, resend this stage, or skip)"></span>' : '') +
          // Resend the running stage: its turn is ended and the same prompt sent again (the agent is told).
          (isSending && item.lastDispatched ? '<span class="codicon codicon-refresh" style="cursor:pointer;color:#000;" onclick="resendSendingStage(\'' + safeId + '\')" title="Resend this stage (end the running turn and send the same prompt again)"></span>' : '') +
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
          // Waiting (rate-limit parked) items get a "retry now" control that
          // cuts the reset countdown short and sends immediately. The
          // codicon-debug-restart icon reads as 'try again now'.
          (isWaiting
            ? '<span class="codicon codicon-debug-restart" style="cursor:pointer;color:#000;" onclick="retryWaitingNow(\'' + safeId + '\')" title="Retry now (skip the rate-limit reset wait and send immediately)"></span>'
            : '') +
          // Retry (backoff-parked) items get a "retry now" control that cuts
          // the backoff countdown short and sends immediately, plus a "stop
          // retrying" control that gives up (→ error) and pauses the queue.
          (isRetry
            ? '<span class="codicon codicon-debug-restart" style="cursor:pointer;color:#000;" onclick="retryRetryingNow(\'' + safeId + '\')" title="Retry now (skip the backoff wait and send immediately)"></span>'
              + '<span class="codicon codicon-stop-circle" style="cursor:pointer;color:#000;" onclick="stopRetrying(\'' + safeId + '\')" title="Stop retrying (give up — mark as error and pause the queue)"></span>'
            : '') +
          // Resend last dispatch — available once there is a recorded
          // lastDispatched (i.e. at least one stage has been sent) and
          // the item isn't currently in-flight or errored. Re-sends
          // the exact expanded text byte-for-byte; repetition
          // counters are not touched, so the queue continues from
          // where it was.
          (item.lastDispatched && !isChat && !isSending && !isError && !isRetry
            ? '<span class="codicon codicon-refresh" style="cursor:pointer;color:#000;" onclick="resendLastPrompt(\'' + safeId + '\')" title="Resend last prompt (keeps repetition counters)"></span>'
            : '') +
          // Edit the prompt of a pending item in place (the queue waits while it is open).
          (isPending && editorMode !== 'template' && textEditDraft === undefined
            ? '<span class="codicon codicon-edit" style="cursor:pointer;color:#000;" onclick="startTextEdit(\'' + safeId + '\')" title="Edit the prompt (the item keeps its place; the queue waits until you save or cancel)"></span>'
            : '') +
          (isPending ? '<span class="codicon codicon-arrow-up" style="cursor:pointer;color:#000;" onclick="moveUp(\'' + safeId + '\')" title="Move up (closer to queue top — sent sooner)"></span>' : '') +
          (isPending ? '<span class="codicon codicon-arrow-down" style="cursor:pointer;color:#000;" onclick="moveDown(\'' + safeId + '\')" title="Move down (closer to queue end — sent later)"></span>' : '') +
          // Directly under a running loop, Send next sends the item between two
          // of the loop's iterations instead (the host flags it: canSendBetween).
          (isPending && (item.canSendBetween || item.sendBetween)
            ? '<span class="codicon codicon-debug-step-into send-between-btn" style="cursor:pointer;color:' + (item.sendBetween ? '#b5179e' : '#000') + ';" onclick="toggleSendBetween(\'' + safeId + '\')" title="' +
              (item.sendBetween ? 'Marked: sent after the running loop\'s current iteration, before its next one. Click to unmark.' : 'Send between iterations: after the running loop\'s current iteration, before its next one') + '"></span>'
            : (isPending ? '<span class="codicon codicon-arrow-circle-up" style="cursor:pointer;color:#000;" onclick="moveToFront(\'' + safeId + '\')" title="Send next (move to front of pending queue)"></span>' : '')) +
          // Let the next item go first (vscimpb60e): an iteration item, pending or sending. Disabled (with the
          // reason) when no pending item follows it in its lane; armed (inverted) until it yields.
          ((isPending || isSending) && (item.canLetNextGoFirst !== undefined || item.yieldAfterIteration)
            ? (item.yieldAfterIteration
              ? '<span class="codicon codicon-debug-step-over yield-btn armed" style="cursor:pointer;color:#fff;background:#0e7c86;border-radius:3px;padding:1px 3px;" onclick="letNextGoFirst(\'' + safeId + '\')" title="Yields after this iteration — click to keep iterating instead"></span>'
              : item.canLetNextGoFirst
                ? '<span class="codicon codicon-debug-step-over yield-btn" style="cursor:pointer;color:#000;" onclick="letNextGoFirst(\'' + safeId + '\')" title="' + (isSending ? 'Let the next item go first: this iteration finishes, then the next item of its lane is sent; the walk resumes after it' : 'Let the next item go first: this item moves behind the next item of its lane') + '"></span>'
                : '<span class="codicon codicon-debug-step-over yield-btn disabled" aria-disabled="true" style="color:#999;cursor:not-allowed;" title="Let the next item go first — not now: ' + escapeHtml(String(item.letNextGoFirstUnavailable || '')) + '"></span>')
            : '') +
          // Pause after this — let the item finish its repeat loop, then hold
          // the queue instead of starting the next item. Shown wherever the
          // item can still run, plus on any item that carries the flag so a
          // leftover one is never invisible. Armed state renders inverted
          // (white on black) because a plain colour change is too subtle to
          // read against the status bar's own colour.
          (isStaged || isPending || isSending || pauseAfter
            ? '<span class="codicon codicon-debug-pause" style="cursor:pointer;'
              + (pauseAfter
                ? 'color:#fff;background:#000;border-radius:3px;padding:1px 3px;'
                : 'color:#000;')
              + '" onclick="setPauseAfter(\'' + safeId + '\', ' + !pauseAfter + ')" title="'
              + (pauseAfter
                ? 'Pause after this is ON — this item finishes its repeats, then the queue stops. Click to turn off.'
                : 'Pause after this — let this item finish, then hold the queue instead of sending the next item')
              + '"></span>'
            : '') +
          // Adopt queue settings — copies the queue-level default
          // transport + profile (the dropdowns above the queue) onto this
          // item. Shown in every status (including a repeating item): for
          // a sending item the next repetition uses the new transport/
          // profile. Distinct from the staged-only gear below, which opens
          // the full transport picker.
          (isChat ? '' : '<span class="codicon codicon-arrow-circle-down" style="cursor:pointer;color:#000;" onclick="applyQueueDefaultTransport(\'' + safeId + '\')" title="Set the profile to the default of its run. Works while repeating — the next repetition uses it."></span>') +
          // Staged-only: once an item is pending or sending, the
          // manager rejects profile updates (isEditableStatus). Hide
          // the gear so users don't click a no-op.
          (isStaged ? '<span class="codicon codicon-settings" style="cursor:pointer;color:#000;" onclick="editItemTransport(\'' + safeId + '\')" title="Change its profile and configuration"></span>' : '') +
          // The item's session: its name (the queue default when unset);
          // staged / pending items can change it.
          ('<span class="queue-session-chip" style="' + (relocatable ? 'cursor:pointer;' : '') + 'color:#000;display:inline-flex;align-items:center;gap:2px;"'
              + (relocatable ? ' onclick="event.stopPropagation();relocateItem(\'' + safeId + '\')"' : '')
              + ' title="' + escapeHtml(chipSession.tooltip) + (item.session ? '' : ' (queue default)') + (relocatable ? ' — click to change its run, session and place' : '') + '">'
              + '<span class="codicon codicon-comment-discussion"></span><span style="font-size:0.85em;">'
              + escapeHtml(chipSessionName) + (chipSession.marked ? '*' : '') + '</span></span>') +
          // The role the item runs as (gsel3, gsel11): its todo's, its own, its process step's or its
          // run's default, with where it comes from; a staged or pending item can set, change or clear its own.
          (!isChat ? queueRoleChip(item, safeId, isStaged || isPending) : '') +
          // The item's own guideline choices (gsel5): an indicator only, the details on hover;
          // the button is in the item's details (queueItemAspectRow).
          (!isChat && typeof queueItemAspectIndicator === 'function' ? queueItemAspectIndicator(item) : '') +
          '<span class="codicon codicon-go-to-file" style="cursor:pointer;color:#000;" onclick="openEntryFile(\'' + safeId + '\')" title="Open YAML file"></span>' +
          // A chat send is always removable: a send still running is stopped with its entry; a stale one is only removed.
          '<span class="codicon codicon-trash" style="cursor:pointer;color:#000;" onclick="remove(\'' + safeId + '\')" title="' + (isChat
            ? (isChatRunning && item.chatActive ? 'Stop this chat send and remove it from the list' : 'Remove from the list')
            : 'Delete') + '"></span>' +
          '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          // Sent by another quest's window (tomAi_sendItemToQuest), and the notification of which item.
          (item.from && item.from.quest
            ? '<span class="queue-from-chip" title="' + escapeHtml('Sent by the quest ' + item.from.quest + (item.from.sentAt ? ' at ' + item.from.sentAt : '')) + '">from ' + escapeHtml(item.from.quest) + '</span>'
            : '') +
          (item.notificationOf
            ? '<span class="queue-from-chip" title="' + escapeHtml('The done-notification of item ' + item.notificationOf) + '"><span class="codicon codicon-bell"></span> notification of ' + escapeHtml(String(item.notificationOf).slice(0, 8)) + '</span>'
            : '') +
          // Its done notification went to another quest and waits there for a window (vscimpb71).
          (item.doneNotificationPosted && item.doneNotificationPosted.waiting
            ? '<span class="queue-from-chip" title="' + escapeHtml('The done notification was posted to ' + item.doneNotificationPosted.quest + ' (run ' + item.doneNotificationPosted.run + '); no window of that quest is running, so it waits in its inbox until one starts') + '"><span class="codicon codicon-watch"></span> notification waits in ' + escapeHtml(item.doneNotificationPosted.quest) + '</span>'
            : '') +
          runChip +
          // The Status Page's "Send prompt after reload" (vscimpb109): queued at the front when the window started.
          (item.reloadPrompt
            ? '<span class="queue-from-chip queue-reload-chip" title="' + escapeHtml('Send prompt after reload: queued at the front of this run\'s queue when the window started, and sent as Continue sends it') + '"><span class="codicon codicon-debug-restart"></span> after reload</span>'
            : '') +
          // The todos it runs (todoIdPattern): a todo id or several. Not on a todo walk: its header names what it walks
          // (`todo group <id>`, `todos <prefix>*`, `todo <id>`) and a GROUP item lists its members under the header,
          // so the pattern (a group's every member id) would only repeat them and push the header out of shape.
          (item.todoIdPattern && !walkInfo
            ? '<span class="queue-from-chip queue-todo-chip" title="' + escapeHtml('Runs the todos ' + item.todoIdPattern + ' (marked as queued in the todo panel)') + '">todos ' + escapeHtml(String(item.todoIdPattern)) + '</span>'
            : '') +
          '#' + queuePos + '  ' + time + (sentTime ? ' \u2192 ' + sentTime : '') +
          // The speech bubble: on a running prompt that takes a message it opens the message box (with Open live
          // trail in it); otherwise it opens the live trail of the item's session.
          (item.canMessageRunning
            ? ' <button class="icon-btn queue-live-trail-btn queue-message-btn" type="button" onclick="event.stopPropagation(); toggleRunningMessage(\'' + safeId + '\')"'
              + ' title="' + escapeHtml('Write to the running prompt (session ' + chipSessionName + '): your message goes into the running conversation and the agent answers it in the same turn') + '">'
            : ' <button class="icon-btn queue-live-trail-btn" type="button" onclick="event.stopPropagation(); openItemLiveTrail(\'' + safeId + '\')"'
              + ' title="' + escapeHtml('Open the live trail of session ' + chipSessionName + ' (the session this prompt runs in)'
                + (item.runningMessageUnavailable ? '. No message can go into this prompt: ' + item.runningMessageUnavailable + '.' : '')) + '">')
            + '<span class="codicon ' + typeIconClass + '" style="color:#000;"></span></button>' +
        '</span>' +
      '</div>' +
    '</div>';
  } else {
    /* Template mode: simple collapsible header without status controls */
    headerHtml = '<div class="item-header">' +
      '<div class="status-bar template-mode">' +
        '<span>' +
          (item.template && item.template !== '(None)' ? '[' + escapeHtml(item.template) + ']' : '') +
        '</span>' +
      '</div>' +
    '</div>';
  }


  var answerBlock = renderAnswerBlock(item, safeId);

  return '<div class="queue-item ' + cls.join(' ') + '" data-qid="' + escapeHtml(String(item.id)) + '">' +
    headerHtml +
    // A GROUP item's members, under the header: always visible (vscimpb129).
    renderGroupMembers(item, safeId) +
    // Waiting for its background work: always visible, with the ? list and the three choices.
    renderBackgroundWait(item, safeId) +
    renderWaitFor(item, safeId) +
    // A soft interrupt waits for its hold point (or holds): what it waits for, Hard interrupt now, Cancel interruption.
    renderSoftInterruptPanel(item, safeId) +
    // The speech bubble's message box: a message into the running prompt.
    renderRunningMessageBox(item, safeId) +
    // What the user wrote to the turn (a wait, the running prompt), with the answers, while no wait panel shows (vscimpb173).
    renderWaitMessagesAlone(item) +
    // What the turn asks, answered right here (vscimpb173).
    renderItemAsks(item, safeId) +
    '<div class="' + (expanded ? '' : 'details-hidden') + '">' +
    // The chips come first, under the header: they say why the item will
    // not be sent, or why its last send did not complete — easy to miss below
    // the prompt, its stages and its answer.
    // A stage stopped for a too-low credit balance: continue on a profile, or resend.
    renderOutOfBudget(item, safeId) +
    // A stage on a direct-API profile whose key is not in this VS Code's environment: every send would fail.
    (Array.isArray(item.apiKeyWarnings) && item.apiKeyWarnings.length > 0
      ? item.apiKeyWarnings.map(function(line) {
          return '<div class="warning-chip api-key-warning">'
            + '<span class="codicon codicon-key"></span>'
            + '<span><strong>No API key:</strong> ' + escapeHtml(line) + '</span>'
            + '</div>';
        }).join('')
      : '') +
    // Yellow interruption chip — explains why the send didn't complete.
    (item.warning && item.warning.kind
      ? '<div class="warning-chip" title="' + escapeHtml(item.warning.at || '') + '">'
        + '<span class="codicon codicon-warning"></span>'
        + '<span><strong>' + escapeHtml(warningKindLabel(item.warning.kind)) + ':</strong> '
        + escapeHtml(item.warning.message || '')
        + '</span></div>'
      : '') +
    (textEditDraft !== undefined
      ? '<div class="qe-text-edit-box">'
        + '<textarea id="qe-edit-' + safeId + '" class="qe-text-edit" oninput="textEditInput(\'' + safeId + '\', this.value)">' + escapeHtml(textEditDraft) + '</textarea>'
        + '<div class="qe-text-edit-bar" style="display:flex;align-items:center;gap:6px;margin:2px 0 4px;">'
        + '<button type="button" onclick="saveTextEdit(\'' + safeId + '\')" title="Save the prompt; the queue goes on">Save</button>'
        + '<button type="button" onclick="cancelTextEdit(\'' + safeId + '\')" title="Discard the changes; the queue goes on">Cancel</button>'
        + (item.textEditing ? '<span style="font-size:0.8em;opacity:0.8;">The queue waits for this edit when it is this item&#39;s turn.</span>' : '')
        + '</div></div>'
      : isEditable
      ? '<textarea onchange="updateText(\'' + safeId + '\', this.value)">' + escapeHtml(item.originalText) + '</textarea>'
      : '<div class="mainprompt-content' + (isMainPromptActive ? ' is-active' : '') + '" style="margin:4px 0; white-space:pre-wrap;">' + escapeHtml(item.originalText) + '</div>') +
    templateRow +
    // The item editor's guideline button and choices (gsel5; queue editor only).
    (!isChat && typeof queueItemAspectRow === 'function' ? queueItemAspectRow(item) : '') +
    (editorMode === 'template' || isChat ? '' : renderDoneNotification(item, safeId, safeStatus)) +
    renderPrePrompts(item, safeStatus) +
    renderFollowUps(item, safeStatus) +
    answerBlock +
    (item.error ? '<div style="color:var(--vscode-charts-red);font-size:0.8em;margin-top:4px;">Error: ' + escapeHtml(item.error) + '</div>' : '') +
    '</div>' +
  '</div>';
}

/**
 * What a todo walk's repeat count walks, for the item header: `<prefix>*` → `todos <prefix>*`,
 * `group:<quest>/<id>` → `todo group <id>`, `todo:<quest>/<id>` → `todo <id>`; null for anything else.
 * @param {unknown} raw
 * @returns {{kind: string, label: string, title: string} | null}
 */
function todoWalkInfo(raw) {
  if (typeof raw !== 'string') { return null; }
  var v = raw.trim();
  var m = /^(group|todo):([^/]+)\/(.+)$/.exec(v);
  if (m) {
    return m[1] === 'group'
      ? { kind: 'group', label: 'todo group ' + m[3], title: 'Walks the members of the group todo ' + m[3] + ' (quest ' + m[2] + '), listed below' }
      : { kind: 'todo', label: 'todo ' + m[3], title: 'Runs the todo ' + m[3] + ' (quest ' + m[2] + ')' };
  }
  if (/\*$/.test(v) && v.length > 1) {
    return { kind: 'prefix', label: 'todos ' + v, title: 'Walks the todos ' + v + ', lowest number first, listed below' };
  }
  return null;
}

/*
 * A GROUP item's members (vscimpb129, src/utils/groupItemSelection.ts), in
 * comprised_of order: → the member being sent, ✓ with the outcome for those it
 * sent, a checkbox for the others — checked when the walk will send it. The
 * boxes start from the walk's rules; any member can be checked or unchecked
 * while the item is staged, pending or sending (or held because its walk had
 * nothing to send), with Select all and Reset to rules.
 */
function renderGroupMembers(item, safeId) {
  var members = item.groupMembers;
  if (!Array.isArray(members) || members.length === 0) { return ''; }
  var editable = item.status === 'staged' || item.status === 'pending' || item.status === 'sending'
    || (item.status === 'error' && typeof item.error === 'string' && item.error.indexOf('Nothing to iterate over') === 0);
  var rows = members.map(function(m) {
    var mark;
    if (m.marker === 'sending') {
      mark = '<span class="gm-mark gm-sending" title="Being sent now">\u2192</span>';
    } else if (m.marker === 'sent') {
      // The mark alone (✓ completed, ⚠ needs attention); the outcome is its tooltip.
      var attention = m.outcome === 'needs attention';
      mark = '<span class="gm-mark gm-sent' + (attention ? ' gm-attention' : '') + '" title="' + escapeHtml('Sent by this item' + (m.outcome ? ': ' + m.outcome : '')) + '">'
        + (attention ? '\u26a0' : '\u2713') + '</span>';
    } else {
      var held = m.status === 'blocked' || m.status === 'decision-needed';
      var why = m.chosen ? (m.checked ? 'Checked by hand' : 'Unchecked by hand')
        : (m.checked ? (held ? 'The walk sends it once it is no longer ' + m.status + ' (it waits there, as a prefix walk does)' : 'The walk sends it (its rules)') : 'The walk passes it (its rules)');
      mark = '<input type="checkbox" class="gm-box" data-member="' + escapeHtml(m.id) + '"' + (m.checked ? ' checked' : '') + (editable ? '' : ' disabled')
        + ' onchange="setGroupMember(\'' + safeId + '\', \'' + escapeHtml(m.id) + '\', this.checked)" title="' + escapeHtml(why) + '">';
    }
    return '<div class="gm-row gm-' + escapeHtml(m.marker) + (m.chosen ? ' gm-chosen' : '') + '" data-member="' + escapeHtml(m.id) + '">'
      + mark
      + ' <span class="gm-id">' + escapeHtml(m.id) + '</span>'
      + ' <span class="gm-status">' + escapeHtml(m.status || '') + '</span>'
      + ' <span class="gm-title">' + escapeHtml(m.title || '') + '</span>'
      + '</div>';
  }).join('');
  var bar = editable
    ? '<div class="gm-bar">'
      + '<button type="button" class="gm-all" onclick="setGroupSelectAll(\'' + safeId + '\')" title="Check every member still to come">Select all</button>'
      + '<button type="button" class="gm-rules" onclick="resetGroupSelection(\'' + safeId + '\')" title="Back to what the walk\'s rules send: every open member — a blocked or decision-needed one too, the walk waits there — not the user\'s own">Reset to rules</button>'
      + '</div>'
    : '';
  // A `<prefix>*` walk lists its todos the same way (lowest number first).
  var head = typeof item.repeatCount === 'string' && /\*\s*$/.test(item.repeatCount) ? 'Todos' : 'Members';
  return '<div class="group-members"><div class="gm-head">' + head + '</div>' + rows + bar + '</div>';
}

/*
 * The done-notification section under the item's prompt (src/utils/doneNotification.ts):
 * collapsed unless the item has a prompt; editable until the item is sent; the bell icon
 * switches it off (the prompt is kept but not queued) and on again.
 */
/* Anthropic answerText inline preview (spec §4.10). Displayed only
 * when the item produced direct text (anthropic transport). The
 * authoritative trail is the Anthropic trail file; this is the
 * practical at-a-glance view. Truncated to 600 chars by default
 * with a toggle to expand to full; the two markdown preview buttons show the
 * full answer. Used by renderEntry. */
/**
 * The answer chips of a repeated item (repetitionAnswers): one per repetition,
 * the todo id for a todo walk or the repetition number; the one shown is
 * active. A click shows that repetition's answer (showRepetitionAnswer).
 */
function renderRepetitionChips(item, reps, shownKey) {
  if (!reps.length) return '';
  return '<div class="rep-answer-chips" title="The answer of each repetition: click one to show it">' +
    reps.map(function(r) {
      var active = r.key === shownKey;
      // Red: the repetition's turn ended with background work still running (the limit, or Stop waiting).
      return '<button type="button" class="rep-answer-chip' + (active ? ' active' : '') + (r.backgroundLeft ? ' bg-left' : '') + '"' +
        ' data-qid="' + escapeHtml(String(item.id)) + '" data-rep-key="' + escapeHtml(String(r.key)) + '"' +
        ' title="' + escapeHtml('The answer of ' + (/^[0-9]+$/.test(String(r.key)) ? 'repetition ' : 'todo ') + r.key + (r.at ? ' (' + new Date(r.at).toLocaleString() + ')' : '')
          + (r.backgroundLeft ? ' \u2014 it ended with background work still running; the answer names it' : '')
          + (r.continuations ? ' \u2014 ' + continuationMark(r.continuations) + ': the todo was not completed after the turn' : '')) + '">' +
        escapeHtml(String(r.key)) +
        (r.continuations ? '<span class="rep-cont-mark">' + escapeHtml(continuationMark(r.continuations)) + '</span>' : '') +
        '</button>';
    }).join('') +
  '</div>';
}

/** Show the answer of repetition `key` of item `id` (the editor redraws). */
function showRepetitionAnswer(id, key) {
  window.__queueRepSelected = window.__queueRepSelected || {};
  window.__queueRepSelected[id] = key;
  if (typeof render === 'function') { render(); }
}

/* The chips: one delegated listener (no inline handler). */
document.addEventListener('click', function(e) {
  var chip = e.target && e.target.closest ? e.target.closest('.rep-answer-chip') : null;
  if (!chip) return;
  e.preventDefault();
  showRepetitionAnswer(chip.getAttribute('data-qid'), chip.getAttribute('data-rep-key'));
});

/**
 * A sending item whose turn waits in tomAi_waitFor (waitForView, built by the
 * host; vscimpb82): the reason, until when and how long is left (kept current
 * by tickWaitForLines), and Interrupt the wait — the agent ends its turn with
 * a note and the item steps back behind the next item of its run.
 */
function renderWaitFor(item, safeId) {
  var view = item.waitForView;
  if (!view || item.status !== 'sending') { return ''; }
  var tip = 'The turn waits on something outside it (tomAi_waitFor) since ' + String(view.since) + (view.details ? ': ' + String(view.details) : '');
  return '<div class="wait-for" data-qid="' + escapeHtml(String(item.id)) + '">'
    + '<span class="wait-for-badge" title="' + escapeHtml(tip) + '">\u23f3 Waiting: ' + escapeHtml(String(view.reason)) + ' \u2014 '
    + '<span class="wait-for-left" data-until="' + escapeHtml(String(view.until)) + '">' + escapeHtml(String(view.left)) + '</span></span>'
    + ' <button type="button" class="wait-for-btn" onclick="event.stopPropagation();interruptWaitFor(\'' + safeId + '\')" title="The agent is told you moved on and ends its turn with a note of what is still to do; the item steps back behind the next item of its run and goes on from that note when it runs again">Interrupt the wait and move on</button>'
    + renderWaitMessageBox(item, safeId)
    + renderWaitMessages(item)
    + '</div>';
}

/** `until 14:20 (1 h 5 min left)` for a wait ending at `untilIso`, as the host words it (utils/waitFor.ts). */
function waitForLeftLabel(untilIso, now) {
  var until = Date.parse(untilIso);
  if (!isFinite(until)) { return ''; }
  var d = new Date(until);
  var t = new Date(now);
  var two = function(n) { return n < 10 ? '0' + n : String(n); };
  var clock = two(d.getHours()) + ':' + two(d.getMinutes());
  if (d.toDateString() !== t.toDateString()) { clock = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + clock; }
  var minutes = Math.floor(Math.max(0, until - now) / 60000);
  var left = minutes < 1 ? 'under a minute' : minutes < 60 ? minutes + ' min'
    : (minutes % 60 === 0 ? Math.floor(minutes / 60) + ' h' : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min');
  return 'until ' + clock + ' (' + left + ' left)';
}

/** Keep every waiting line's time left current (called each 30 s by the editor). */
// eslint-disable-next-line no-unused-vars -- called by media/queueEditor/main.js
function tickWaitForLines(root, now) {
  var spans = (root || document).querySelectorAll('.wait-for-left[data-until]');
  for (var i = 0; i < spans.length; i++) {
    spans[i].textContent = waitForLeftLabel(spans[i].getAttribute('data-until'), now === undefined ? Date.now() : now);
  }
}

/**
 * A sending item whose turn waits for its background work (backgroundWaitView,
 * built by the host): the line (count, running time, limit), a ? that opens
 * the list of running tasks with their commands and output file / handle, and
 * the three choices — Wait without limit, Keep waiting up to <limit>, Stop
 * waiting. The open list is kept per item over redraws.
 */
function renderBackgroundWait(item, safeId) {
  var view = item.backgroundWaitView;
  if (!view || item.status !== 'sending') { return ''; }
  window.__bgWaitOpen = window.__bgWaitOpen || {};
  var open = window.__bgWaitOpen[item.id] === true;
  var list = !open ? '' : '<div class="bg-wait-list">' + (view.items || []).map(function(t) {
    return '<div class="bg-wait-task">'
      + '<span class="bg-wait-task-name">' + escapeHtml(String(t.description || t.command || t.id)) + '</span>'
      + ' <span class="bg-wait-task-id">[' + escapeHtml(String(t.kind === 'command' ? 'handle ' + t.id : t.id)) + ']</span>'
      + (t.command && t.command !== t.description ? '<div class="bg-wait-task-cmd"><code>' + escapeHtml(String(t.command)) + '</code></div>' : '')
      + (t.outputFile ? '<div class="bg-wait-task-out">output: <code>' + escapeHtml(String(t.outputFile)) + '</code></div>' : '')
      + '</div>';
  }).join('') + '</div>';
  return '<div class="bg-wait" data-qid="' + escapeHtml(String(item.id)) + '">'
    + '<span class="bg-wait-badge" title="The turn ended while background work it started still runs: the queue waits for it">\u23f3 Waiting for background work \u2014 ' + escapeHtml(String(view.line)) + '</span>'
    + ' <button type="button" class="bg-wait-help" onclick="event.stopPropagation();toggleBackgroundTasks(\'' + safeId + '\')" title="The running tasks with their commands">?</button>'
    + ' <button type="button" class="bg-wait-btn" data-bg-action="waitWithoutLimit" onclick="event.stopPropagation();backgroundWaitAction(\'' + safeId + '\', \'waitWithoutLimit\')"' + (view.unlimited ? ' disabled' : '') + ' title="Wait until the work ends, however long">Wait without limit</button>'
    + ' <button type="button" class="bg-wait-btn" data-bg-action="keepWaiting" onclick="event.stopPropagation();backgroundWaitAction(\'' + safeId + '\', \'keepWaiting\')" title="Start the limit again from now">Keep waiting up to ' + escapeHtml(String(view.limit)) + '</button>'
    + ' <button type="button" class="bg-wait-btn stop" data-bg-action="stopWaiting" onclick="event.stopPropagation();backgroundWaitAction(\'' + safeId + '\', \'stopWaiting\')" title="End the turn now (its answer names what still runs); the queue goes on">Stop waiting</button>'
    + renderWaitMessageBox(item, safeId)
    + list
    + renderWaitMessages(item)
    + '</div>';
}

/* ---- Writing to a waiting turn from the item (vscimpb173) -------------------- */

/** A key of the per-item / per-ask state maps kept over redraws. */
function waitUiState(name) {
  window[name] = window[name] || {};
  return window[name];
}

/**
 * The Message button of a wait panel and, once clicked, the text area with
 * Send and Cancel right there in the item (canMessageWait, set by the host
 * while a message can reach the turn). The draft is kept over redraws.
 */
function renderWaitMessageBox(item, safeId) {
  if (!item.canMessageWait) { return ''; }
  var open = waitUiState('__waitMsgOpen')[item.id] === true;
  var btn = ' <button type="button" class="wait-msg-btn" data-wait-msg="open" onclick="event.stopPropagation();toggleWaitMessage(\'' + safeId + '\')"'
    + ' title="Write to the waiting turn: the agent gets your message at once, answers, and goes on waiting">Message</button>';
  if (!open) { return btn; }
  var draft = waitUiState('__waitMsgDraft')[item.id] || '';
  return btn + '<div class="wait-msg-box" onclick="event.stopPropagation()">'
    + '<textarea id="waitMsg-' + escapeHtml(String(item.id)) + '" class="wait-msg-text keep-focus" rows="3" placeholder="Your message to the waiting turn (Ctrl/Cmd+Enter sends)"'
    + ' oninput="waitMessageDraft(\'' + safeId + '\', this.value)" onkeydown="waitMessageKey(event, \'' + safeId + '\')">' + escapeHtml(draft) + '</textarea>'
    + '<div class="wait-msg-bar">'
    + '<button type="button" class="wait-msg-btn primary" data-wait-msg="send" onclick="event.stopPropagation();sendWaitMessage(\'' + safeId + '\')" title="Send to this item\'s own turn (its session and run); the wait goes on after the agent has read it">Send</button>'
    + ' <button type="button" class="wait-msg-btn" data-wait-msg="cancel" onclick="event.stopPropagation();cancelWaitMessage(\'' + safeId + '\')">Cancel</button>'
    + '</div></div>';
}

/** The messages written to the item's waiting turn, each with what became of it. */
function renderWaitMessages(item) {
  var views = Array.isArray(item.waitMessagesView) ? item.waitMessagesView : [];
  if (!views.length) { return ''; }
  return '<div class="wait-msgs">' + views.map(function(m) {
    var d = new Date(m.at);
    var two = function(n) { return n < 10 ? '0' + n : String(n); };
    var when = isNaN(d.getTime()) ? '' : two(d.getHours()) + ':' + two(d.getMinutes());
    return '<div class="wait-msg">'
      + '<div class="wait-msg-head">You' + (when ? ', ' + when : '') + ' — <span class="wait-msg-state">' + escapeHtml(String(m.state)) + '</span></div>'
      + '<div class="wait-msg-body">' + escapeHtml(String(m.text)) + '</div>'
      + (m.answer ? '<div class="wait-msg-answer"><span class="wait-msg-answer-head">Answer:</span> ' + escapeHtml(String(m.answer)) + '</div>' : '')
      + '</div>';
  }).join('') + '</div>';
}

/** The messages on their own, while no wait panel shows: also once the item has ended, with their answers. */
function renderWaitMessagesAlone(item) {
  if (item.waitForView || item.backgroundWaitView) { return ''; }
  var list = renderWaitMessages(item);
  return list ? '<div class="wait-msgs-alone" data-qid="' + escapeHtml(String(item.id)) + '">' + list + '</div>' : '';
}

/**
 * The message box of the header's speech bubble (canMessageRunning): a text area, Send, Cancel and Open live
 * trail, right under the header. The draft is kept over redraws.
 */
function renderRunningMessageBox(item, safeId) {
  if (!item.canMessageRunning || waitUiState('__runMsgOpen')[item.id] !== true) { return ''; }
  var draft = waitUiState('__runMsgDraft')[item.id] || '';
  return '<div class="wait-msg-box run-msg-box" data-qid="' + escapeHtml(String(item.id)) + '" onclick="event.stopPropagation()">'
    + '<textarea id="runMsg-' + escapeHtml(String(item.id)) + '" class="wait-msg-text keep-focus" rows="3" placeholder="Your message to the running prompt (Ctrl/Cmd+Enter sends)"'
    + ' oninput="runningMessageDraft(\'' + safeId + '\', this.value)" onkeydown="runningMessageKey(event, \'' + safeId + '\')">' + escapeHtml(draft) + '</textarea>'
    + '<div class="wait-msg-bar">'
    + '<button type="button" class="wait-msg-btn primary" data-run-msg="send" onclick="event.stopPropagation();sendRunningMessage(\'' + safeId + '\')" title="Send into this item\'s running conversation; the agent answers it in the same turn">Send</button>'
    + ' <button type="button" class="wait-msg-btn" data-run-msg="cancel" onclick="event.stopPropagation();cancelRunningMessage(\'' + safeId + '\')">Cancel</button>'
    + ' <button type="button" class="wait-msg-btn" data-run-msg="trail" onclick="event.stopPropagation();openItemLiveTrail(\'' + safeId + '\')" title="Open the live trail of the session this prompt runs in">Open live trail</button>'
    + '</div></div>';
}

// eslint-disable-next-line no-unused-vars -- called by the speech bubble's onclick
function toggleRunningMessage(id) {
  var open = waitUiState('__runMsgOpen');
  open[id] = !open[id];
  if (typeof render === 'function') { render(); }
  if (open[id]) {
    var ta = document.getElementById('runMsg-' + id);
    if (ta && ta.focus) { ta.focus(); }
  }
}

// eslint-disable-next-line no-unused-vars -- called by the message text area's oninput
function runningMessageDraft(id, text) { waitUiState('__runMsgDraft')[id] = text; }

// eslint-disable-next-line no-unused-vars -- called by the message text area's onkeydown
function runningMessageKey(e, id) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendRunningMessage(id); }
}

/** Send the speech bubble's message box: the item id and the text; an empty text sends nothing. */
function sendRunningMessage(id) {
  var ta = document.getElementById('runMsg-' + id);
  var text = ta ? ta.value : (waitUiState('__runMsgDraft')[id] || '');
  if (!String(text).trim()) { return; }
  waitUiState('__runMsgOpen')[id] = false;
  waitUiState('__runMsgDraft')[id] = '';
  if (typeof postRunningMessage === 'function') { postRunningMessage(id, text); }
  if (typeof render === 'function') { render(); }
}

// eslint-disable-next-line no-unused-vars -- called by Cancel's onclick (renderRunningMessageBox)
function cancelRunningMessage(id) {
  waitUiState('__runMsgOpen')[id] = false;
  waitUiState('__runMsgDraft')[id] = '';
  if (typeof render === 'function') { render(); }
}

// eslint-disable-next-line no-unused-vars -- called by the Message button's onclick (renderWaitMessageBox)
function toggleWaitMessage(id) {
  var open = waitUiState('__waitMsgOpen');
  open[id] = !open[id];
  if (typeof render === 'function') { render(); }
  if (open[id]) {
    var ta = document.getElementById('waitMsg-' + id);
    if (ta && ta.focus) { ta.focus(); }
  }
}

// eslint-disable-next-line no-unused-vars -- called by the message text area's oninput
function waitMessageDraft(id, text) { waitUiState('__waitMsgDraft')[id] = text; }

// eslint-disable-next-line no-unused-vars -- called by the message text area's onkeydown
function waitMessageKey(e, id) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendWaitMessage(id); }
}

/** Send the item's message box: the item id and the text; an empty text sends nothing. */
function sendWaitMessage(id) {
  var ta = document.getElementById('waitMsg-' + id);
  var text = ta ? ta.value : (waitUiState('__waitMsgDraft')[id] || '');
  if (!String(text).trim()) { return; }
  waitUiState('__waitMsgOpen')[id] = false;
  waitUiState('__waitMsgDraft')[id] = '';
  if (typeof postWaitMessage === 'function') { postWaitMessage(id, text); }
  if (typeof render === 'function') { render(); }
}

// eslint-disable-next-line no-unused-vars -- called by Cancel's onclick (renderWaitMessageBox)
function cancelWaitMessage(id) {
  waitUiState('__waitMsgOpen')[id] = false;
  waitUiState('__waitMsgDraft')[id] = '';
  if (typeof render === 'function') { render(); }
}

/* ---- The item's ask panel (vscimpb173) ---------------------------------------- */

/** The answer choice selected per question of ask `ask`: the user's, else the preselected ones. */
function askSelection(ask) {
  var all = waitUiState('__askSel');
  if (!all[ask.id]) {
    var sel = {};
    var choices = Array.isArray(ask.data.choices) ? ask.data.choices : [];
    var layout = Array.isArray(ask.data.layout) ? ask.data.layout : [];
    layout.forEach(function(place, qi) {
      var ids = [];
      (place && Array.isArray(place.segments) ? place.segments : []).forEach(function(s) { if (s.choiceId !== undefined) { ids.push(s.choiceId); } });
      (place && Array.isArray(place.below) ? place.below : []).forEach(function(id) { ids.push(id); });
      ids.forEach(function(id) {
        var c = choices.filter(function(x) { return x.id === id; })[0];
        if (c && c.kind === 'answer' && c.selected && sel[qi] === undefined) { sel[qi] = c.id; }
      });
    });
    all[ask.id] = sel;
  }
  return all[ask.id];
}

function askChoiceButton(ask, itemSafe, askSafe, id, qi) {
  var choices = Array.isArray(ask.data.choices) ? ask.data.choices : [];
  var c = choices.filter(function(x) { return x.id === id; })[0];
  if (!c) { return escapeHtml('{{choice:' + id + '}}'); }
  var cid = escapeJsSingleQuoted(String(c.id));
  if (c.kind === 'answer') {
    var on = askSelection(ask)[qi] === c.id;
    return '<button type="button" class="item-ask-choice answer' + (on ? ' selected' : '') + '" data-ask-choice="' + escapeHtml(String(c.id)) + '" data-question="' + qi + '" aria-pressed="' + (on ? 'true' : 'false') + '"'
      + ' onclick="event.stopPropagation();askToggleChoice(\'' + askSafe + '\', ' + qi + ', \'' + cid + '\')" title="Select this answer (click again to clear); sent with Send">' + escapeHtml(String(c.label)) + '</button>';
  }
  return '<button type="button" class="item-ask-choice act" data-ask-choice="' + escapeHtml(String(c.id)) + '" data-question="' + qi + '"'
    + ' onclick="event.stopPropagation();askChoiceAct(\'' + itemSafe + '\', \'' + askSafe + '\', \'' + cid + '\')" title="' + escapeHtml(c.kind === 'move' ? 'Moves the process to ' + c.target + ' when clicked' : String(c.label) + ' (acts when clicked)') + '">' + escapeHtml(String(c.label)) + '</button>';
}

function renderAskQuestion(ask, itemSafe, askSafe) {
  var questions = Array.isArray(ask.data.questions) ? ask.data.questions : [];
  var layout = Array.isArray(ask.data.layout) ? ask.data.layout : [];
  var list = questions.map(function(q, qi) {
    var place = layout[qi];
    var body;
    if (place && Array.isArray(place.segments)) {
      body = place.segments.map(function(seg) {
        return seg.choiceId !== undefined ? askChoiceButton(ask, itemSafe, askSafe, seg.choiceId, qi) : escapeHtml(String(seg.text));
      }).join('');
      if (Array.isArray(place.below) && place.below.length) {
        body += '<div class="item-ask-choice-row">' + place.below.map(function(id) { return askChoiceButton(ask, itemSafe, askSafe, id, qi); }).join(' ') + '</div>';
      }
    } else {
      body = escapeHtml(String(q));
    }
    return '<li>' + body + '</li>';
  }).join('');
  var draft = waitUiState('__askDraft')[ask.id] || '';
  return '<ol class="item-ask-questions">' + list + '</ol>'
    + '<textarea id="askText-' + escapeHtml(String(ask.id)) + '" class="item-ask-text keep-focus" rows="3" placeholder="Your answer (Ctrl/Cmd+Enter sends)"'
    + ' oninput="askDraft(\'' + askSafe + '\', this.value)" onkeydown="askKey(event, \'' + itemSafe + '\', \'' + askSafe + '\')">' + escapeHtml(draft) + '</textarea>'
    + '<div class="item-ask-bar"><button type="button" class="item-ask-btn primary" data-ask-action="send" onclick="event.stopPropagation();askSend(\'' + itemSafe + '\', \'' + askSafe + '\')"'
    + ' title="Answer the question from here; it closes everywhere (the user-input panel, Telegram)">Send</button></div>';
}

function renderAskPicker(ask, itemSafe, askSafe) {
  var items = Array.isArray(ask.data.items) ? ask.data.items : [];
  var many = ask.data.canPickMany === true;
  var picked = waitUiState('__askPick')[ask.id] || {};
  var rows = items.map(function(it, idx) {
    return '<label class="item-ask-pick"><input type="' + (many ? 'checkbox' : 'radio') + '" name="askPick-' + escapeHtml(String(ask.id)) + '" data-ask-pick="' + idx + '"' + (picked[idx] ? ' checked' : '')
      + ' onclick="event.stopPropagation();askPickToggle(\'' + askSafe + '\', ' + idx + ', ' + (many ? 'true' : 'false') + ', this.checked)"> '
      + escapeHtml(String(it.label || '')) + (it.description ? ' — ' + escapeHtml(String(it.description)) : '') + '</label>';
  }).join('');
  var draft = waitUiState('__askDraft')[ask.id] || '';
  return (ask.data.prompt ? '<div class="item-ask-hint">' + escapeHtml(String(ask.data.prompt)) + '</div>' : '')
    + '<div class="item-ask-picks">' + rows + '</div>'
    + '<input type="text" id="askText-' + escapeHtml(String(ask.id)) + '" class="item-ask-other keep-focus" placeholder="Other… (your own answer)" value="' + escapeHtml(draft) + '" oninput="askDraft(\'' + askSafe + '\', this.value)">'
    + '<div class="item-ask-bar">'
    + '<button type="button" class="item-ask-btn primary" data-ask-action="choose" onclick="event.stopPropagation();askPickSend(\'' + itemSafe + '\', \'' + askSafe + '\', false)">Choose</button>'
    + ' <button type="button" class="item-ask-btn" data-ask-action="dismiss" onclick="event.stopPropagation();askPickSend(\'' + itemSafe + '\', \'' + askSafe + '\', true)" title="Close the picker without a choice">Dismiss</button>'
    + '</div>';
}

function renderAskMdBrowser(ask, itemSafe, askSafe) {
  var buttons = Array.isArray(ask.data.buttons) ? ask.data.buttons : [];
  return '<div class="item-ask-hint">' + escapeHtml(String(ask.data.file || '')) + '</div>'
    + '<div class="item-ask-bar">'
    + buttons.map(function(b) {
      return '<button type="button" class="item-ask-btn primary" data-ask-md="' + escapeHtml(String(b.id)) + '" onclick="event.stopPropagation();askMdButton(\'' + itemSafe + '\', \'' + askSafe + '\', \'' + escapeJsSingleQuoted(String(b.id)) + '\')"'
        + ' title="Answers the ask as this button in the MD Browser does">' + escapeHtml(String(b.label)) + '</button>';
    }).join(' ')
    + ' <button type="button" class="item-ask-btn" data-ask-action="show" onclick="event.stopPropagation();askShowDocument(\'' + itemSafe + '\', \'' + askSafe + '\')" title="Bring the document forward in the MD Browser">Show document</button>'
    + '</div>';
}

/**
 * What the item's turn asks (askViews, built by the host), always visible like
 * the wait panels: a question with its choices and a text area, a picker's
 * items, an MD Browser ask's buttons. Answering here answers the ask exactly
 * as the user-input panel, the picker or the MD Browser does. A tool approval
 * and a plan proposal are named; they are answered in the full panel.
 */
function renderItemAsks(item, safeId) {
  var asks = Array.isArray(item.askViews) ? item.askViews : [];
  if (!asks.length || item.status !== 'sending') { return ''; }
  var known = waitUiState('__askViews');
  return asks.map(function(ask) {
    ask.data = ask.data || {};
    known[ask.id] = ask;
    var askSafe = escapeJsSingleQuoted(String(ask.id));
    var what = ask.kind === 'question' ? 'asks' : ask.kind === 'picker' ? 'asks you to pick' : ask.kind === 'mdBrowser' ? 'asks in the MD Browser' : ask.kind === 'plan' ? 'proposes a plan' : 'asks for approval';
    var body = ask.kind === 'question' ? renderAskQuestion(ask, safeId, askSafe)
      : ask.kind === 'picker' ? renderAskPicker(ask, safeId, askSafe)
        : ask.kind === 'mdBrowser' ? renderAskMdBrowser(ask, safeId, askSafe)
          : '<div class="item-ask-hint">Answered in the full panel.</div>';
    return '<div class="item-ask" data-qid="' + escapeHtml(String(item.id)) + '" data-ask="' + escapeHtml(String(ask.id)) + '" data-ask-kind="' + escapeHtml(String(ask.kind)) + '" onclick="event.stopPropagation()">'
      + '<div class="item-ask-head"><span class="item-ask-badge">❓ The turn ' + what + ': ' + escapeHtml(String(ask.title || '')) + '</span>'
      + ' <button type="button" class="item-ask-btn" data-ask-action="open" onclick="event.stopPropagation();openPendingQuestion(\'' + safeId + '\')" title="Open it in the full panel">Open question</button></div>'
      + body + '</div>';
  }).join('');
}

// eslint-disable-next-line no-unused-vars -- called by an answer choice's onclick
function askToggleChoice(askId, qi, choiceId) {
  var ask = waitUiState('__askViews')[askId];
  if (!ask) { return; }
  var sel = askSelection(ask);
  sel[qi] = sel[qi] === choiceId ? undefined : choiceId;
  if (typeof render === 'function') { render(); }
}

function askForget(askId) {
  delete waitUiState('__askSel')[askId];
  delete waitUiState('__askDraft')[askId];
  delete waitUiState('__askPick')[askId];
}

function askPost(itemId, askId, response) {
  askForget(askId);
  if (typeof postItemAsk === 'function') { postItemAsk(itemId, askId, response); }
}

// eslint-disable-next-line no-unused-vars -- called by a choice that acts at once (move, branch, subprocess)
function askChoiceAct(itemId, askId, choiceId) {
  askPost(itemId, askId, { type: 'choice', requestId: askId, choiceId: choiceId });
}

// eslint-disable-next-line no-unused-vars -- called by the ask's text field's oninput
function askDraft(askId, text) { waitUiState('__askDraft')[askId] = text; }

// eslint-disable-next-line no-unused-vars -- called by the ask's text area's onkeydown
function askKey(e, itemId, askId) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); askSend(itemId, askId); }
}

/**
 * Send a question's answer: with answer choices, every question's selected
 * choice and the text (the user-input panel's Send answers); without, the
 * text (its Submit).
 */
function askSend(itemId, askId) {
  var ask = waitUiState('__askViews')[askId];
  if (!ask) { return; }
  var field = document.getElementById('askText-' + askId);
  var text = field ? field.value : (waitUiState('__askDraft')[askId] || '');
  var choices = Array.isArray(ask.data.choices) ? ask.data.choices : [];
  var questions = Array.isArray(ask.data.questions) ? ask.data.questions : [];
  if (choices.some(function(c) { return c.kind === 'answer'; })) {
    var sel = askSelection(ask);
    var answers = questions.map(function(_q, qi) {
      var a = { text: '' };
      if (sel[qi] !== undefined) { a.choiceId = sel[qi]; }
      return a;
    });
    askPost(itemId, askId, { type: 'answers', requestId: askId, answers: answers, text: text });
    return;
  }
  askPost(itemId, askId, { type: 'submit', requestId: askId, text: text });
}

// eslint-disable-next-line no-unused-vars -- called by a picker item's onclick
function askPickToggle(askId, idx, many, checked) {
  var all = waitUiState('__askPick');
  if (!many || !all[askId]) { all[askId] = many && all[askId] ? all[askId] : {}; }
  all[askId][idx] = checked;
}

// eslint-disable-next-line no-unused-vars -- called by Choose / Dismiss of a picker
function askPickSend(itemId, askId, dismissed) {
  var picked = waitUiState('__askPick')[askId] || {};
  var selected = Object.keys(picked).filter(function(k) { return picked[k]; }).map(Number).sort(function(a, b) { return a - b; });
  var field = document.getElementById('askText-' + askId);
  var other = field ? field.value : (waitUiState('__askDraft')[askId] || '');
  askPost(itemId, askId, { type: 'picker', id: askId, dismissed: dismissed, selected: selected, other: other });
}

// eslint-disable-next-line no-unused-vars -- called by an MD Browser ask's button
function askMdButton(itemId, askId, buttonId) {
  askPost(itemId, askId, { type: 'mdButton', id: askId, buttonId: buttonId });
}

// eslint-disable-next-line no-unused-vars -- called by Show document
function askShowDocument(itemId, askId) {
  if (typeof postItemAsk === 'function') { postItemAsk(itemId, askId, { type: 'reveal', id: askId }); }
}

/** `1 continuation`, `2 continuations` (utils/walkCompletionCheck.ts continuationMark). */
function continuationMark(n) {
  return n + ' continuation' + (n === 1 ? '' : 's');
}

/** The answers of a continued iteration's earlier turns, folded: they ended before the work was done. */
function renderEarlierAnswers(rep) {
  if (!rep || !Array.isArray(rep.earlier) || !rep.earlier.length) { return ''; }
  return '<details class="earlier-answers"><summary>' + escapeHtml(rep.earlier.length === 1 ? 'Earlier answer' : rep.earlier.length + ' earlier answers') +
    ' \u2014 ended before its work was done</summary>' +
    rep.earlier.map(function(t, i) {
      return '<div class="earlier-answer"><div class="earlier-answer-head">Turn ' + (i + 1) + '</div><div style="white-space:pre-wrap;">' + escapeHtml(String(t)) + '</div></div>';
    }).join('') +
  '</details>';
}

/** Open or close the ? list of an item's running tasks. */
// eslint-disable-next-line no-unused-vars -- called by the ? button's onclick (renderBackgroundWait)
function toggleBackgroundTasks(id) {
  window.__bgWaitOpen = window.__bgWaitOpen || {};
  window.__bgWaitOpen[id] = !window.__bgWaitOpen[id];
  if (typeof render === 'function') { render(); }
}

/**
 * The options of a Prompt template dropdown: the user-message templates, by
 * name where the page has them (`anthropicUserMessageTemplates`), else by id
 * (`promptTemplates`), `selected` marked.
 */
function promptTemplateOptionsHtml(selected) {
  var named = typeof anthropicUserMessageTemplates !== 'undefined' && Array.isArray(anthropicUserMessageTemplates) ? anthropicUserMessageTemplates : [];
  if (named.length) {
    return named.map(function(t) {
      return '<option value="' + escapeHtml(t.id) + '"' + ((selected || '') === t.id ? ' selected' : '') + '>' + escapeHtml(t.name || t.id) + '</option>';
    }).join('');
  }
  return (typeof promptTemplates !== 'undefined' && Array.isArray(promptTemplates) ? promptTemplates : []).map(function(name) {
    return '<option value="' + escapeHtml(name) + '"' + ((selected || '') === name ? ' selected' : '') + '>' + escapeHtml(formatPromptTemplateName(name)) + '</option>';
  }).join('');
}

/** The title of the Prompt template dropdowns. */
var PROMPT_TEMPLATE_TITLE = 'The prompt template that wraps this prompt (the template store the ANTHROPIC/LLM panel\'s User Prompt uses).';

function renderAnswerBlock(item, safeId) {
  var answerBlock = '';
  var reps = Array.isArray(item.repetitionAnswers) ? item.repetitionAnswers.filter(function(r) { return r && typeof r.text === 'string'; }) : [];
  var selectedKey = window.__queueRepSelected ? window.__queueRepSelected[item.id] : undefined;
  var selected = reps.filter(function(r) { return r.key === selectedKey; })[0];
  // The answer shown: the chosen repetition's, else the latest (answerText, else the last repetition's).
  var shownText = selected ? selected.text
    : (typeof item.answerText === 'string' && item.answerText.length > 0 ? item.answerText : (reps.length ? reps[reps.length - 1].text : ''));
  var shownKey = selected ? selected.key
    : (reps.length && (reps[reps.length - 1].text === shownText) ? reps[reps.length - 1].key : undefined);
  // The answer shown ended with background work still running: red, with the hint in its text.
  var shownRep = reps.filter(function(r) { return r.key === shownKey; })[0];
  var bgLeft = shownRep ? shownRep.backgroundLeft === true : (!selected && item.answerBackgroundLeft === true);
  if (shownText.length > 0) {
    var ansId = 'ans-' + safeId;
    var fullText = shownText;
    var truncated = fullText.length > 600 ? fullText.slice(0, 600) + '…' : fullText;
    /* The full answer for the markdown preview buttons (queueAnswerMarkdown), by item id. */
    var promptLine = String(item.originalText || item.expandedText || '').split('\n')[0].trim();
    window.__queueAnswers = window.__queueAnswers || {};
    window.__queueAnswers[item.id] = { text: fullText, title: 'Answer \u2014 ' + (promptLine.length > 60 ? promptLine.slice(0, 60) + '…' : promptLine || item.id) };
    var mdBtns = '<span class="qe-md-btns">' +
      '<button class="icon-btn qe-md-btn" type="button" data-qe-md-mode="overlay" data-qid="' + escapeHtml(String(item.id)) + '" title="Show the answer as markdown over the queue"><span class="codicon codicon-eye"></span></button>' +
      '<button class="icon-btn qe-md-btn" type="button" data-qe-md-mode="editor" data-qid="' + escapeHtml(String(item.id)) + '" title="Open the answer in the markdown preview editor"><span class="codicon codicon-open-preview"></span></button>' +
      '</span>';
    var answerColor = bgLeft ? '#e5534b' : '#4a9eff';
    answerBlock = '<div class="answer-preview' + (bgLeft ? ' bg-left' : '') + '" style="margin-top:6px;padding:6px 8px;border-left:3px solid ' + answerColor + ';background:' + (bgLeft ? 'rgba(229,83,75,0.07)' : 'rgba(74,158,255,0.06)') + ';font-size:0.85em;">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
        '<strong style="color:' + answerColor + ';">Answer' + (shownKey !== undefined && reps.length > 1 ? ' \u2014 ' + escapeHtml(String(shownKey)) : '') + '</strong>' +
        (bgLeft ? '<span class="bg-left-note" title="The turn ended with background work still running (the limit, or Stop waiting); the answer names it">background work still running</span>' : '') +
        '<span style="opacity:0.7;font-size:10px;">' + fullText.length + ' chars</span>' +
        mdBtns +
        (fullText.length > 600 ? '<span id="' + ansId + '-toggle" class="codicon codicon-chevron-down answer-toggle-icon" style="margin-left:auto;cursor:pointer;color:var(--fg);opacity:1;" onclick="toggleAnswerExpand(\'' + ansId + '\')" title="Expand / collapse"></span>' : '') +
      '</div>' +
      '<div id="' + ansId + '" data-full="' + escapeHtml(fullText) + '" data-truncated="' + escapeHtml(truncated) + '" data-expanded="false" style="white-space:pre-wrap;max-height:200px;overflow:auto;">' +
        escapeHtml(truncated) +
      '</div>' +
      // The turns before the last of a continued iteration: folded under its final answer.
      renderEarlierAnswers(shownRep) +
      renderRepetitionChips(item, reps, shownKey) +
    '</div>';
  }

  return answerBlock;
}

/**
 * What a running item (or chat send) waits for the user for (vscimpb81): a
 * clickable badge — the user-input panel opens on the item's run tab, or its
 * MD Browser comes to the front.
 */
function waitingForUserBadge(item, safeId) {
  var kinds = Array.isArray(item.waitingForUser) ? item.waitingForUser : [];
  if (!kinds.length) { return ''; }
  var what = kinds.indexOf('question') !== -1 ? 'your reply'
    : kinds.indexOf('approval') !== -1 ? 'your approval'
      : kinds.indexOf('plan') !== -1 ? 'your decision on a plan'
        : kinds.indexOf('mdBrowser') !== -1 ? 'your answer in the MD Browser' : 'you';
  var where = kinds.length === 1 && kinds[0] === 'mdBrowser' ? 'Click to bring its MD Browser to the front' : 'Click to open it in the user-input panel (on this item\'s run tab)';
  return '  <span class="waiting-user-badge clickable" style="cursor:pointer;" onclick="event.stopPropagation();openPendingQuestion(\'' + safeId + '\')" title="The running prompt waits for ' + what + '. ' + where + '.">[\u23f3 waiting for ' + what + ']</span>';
}

/*
 * The role chip of a queue item (gsel3, gsel11). The host's `roleView`
 * (utils/promptRole.ts queueItemRoleView) names the role the item runs as and
 * where it comes from: its todo's (`· from its todo`), its own, its process
 * step's, its run's default — dimmed when not its own; the hover names the
 * order. Without a `roleView` (an entry another page shows) the item's own
 * role. A staged or pending item opens the role picker for its own role.
 */
function queueRoleChip(item, safeId, editable) {
  var rv = item.roleView || (item.role
    ? { role: item.role, from: 'item', note: '', title: 'Runs as role ' + item.role + ' (unless the todo it runs names its own); the chat variable role shows it while it sends' }
    : { role: '', from: 'none', note: '', title: 'No role of its own: the todo\'s, the process step\'s, the run\'s default or the chat variable role' });
  if (!rv.role && !editable) { return ''; }
  var opacity = !rv.role ? 'opacity:0.45;' : (rv.from === 'item' ? '' : 'opacity:0.7;');
  return '<span class="queue-role-chip" data-role-from="' + escapeHtml(rv.from) + '" style="' + (editable ? 'cursor:pointer;' : '') + 'color:#000;display:inline-flex;align-items:center;gap:2px;' + opacity + '"'
    + (editable ? ' onclick="editItemRole(\'' + safeId + '\')"' : '')
    + ' title="' + escapeHtml(rv.title + (editable ? ' — click to ' + (item.role ? 'change' : 'set') + ' its own role' : '')) + '">'
    + '<span class="codicon codicon-person"></span>'
    + (rv.role ? '<span class="queue-role-name" style="font-size:0.85em;">' + escapeHtml(rv.role) + '</span>' : '')
    + (rv.role && rv.note ? '<span class="queue-role-from" style="font-size:0.85em;font-style:italic;">' + escapeHtml(rv.note) + '</span>' : '')
    + '</span>';
}

/* A chat send's source (`panel`, `editor`, `todo panel`, …), beside its label. */
function chatSourceChip(item) {
  var source = item.chatSource ? String(item.chatSource) : 'chat';
  return '  <span class="chat-source-chip" title="Where the chat send came from">[' + escapeHtml(source) + ']</span>';
}

function renderDoneNotification(item, safeId, safeStatus) {
  var prompt = typeof item.doneNotificationPrompt === 'string' ? item.doneNotificationPrompt : '';
  var disabled = item.doneNotificationDisabled === true;
  var finished = safeStatus === 'sent';
  var toggle = prompt
    ? '<span class="codicon ' + (disabled ? 'codicon-bell-slash' : 'codicon-bell') + '" style="cursor:pointer;margin-left:6px;"'
      + (finished ? '' : ' onclick="event.preventDefault();setDoneNotificationDisabled(\'' + safeId + '\', ' + !disabled + ')"')
      + ' title="' + (disabled ? 'Off: the prompt is kept but not queued' + (finished ? '' : ' — click to switch on') : 'On: queued when the item is done or fails for good' + (finished ? '' : ' — click to switch off')) + '"></span>'
    : '';
  var body = finished
    ? '<div class="done-notification-text" style="white-space:pre-wrap;">' + escapeHtml(prompt) + '</div>'
    : '<textarea class="done-notification-input" placeholder="Queued after this item when it is done, or fails for good. ${itemOutcome}: done / error: <message>; ${itemAnswer}: its answer; ${itemTitle}: its prompt\'s first line; ${itemTodos}: the todos it ran." onchange="updateDoneNotification(\'' + safeId + '\', this.value)">' + escapeHtml(prompt) + '</textarea>';
  if (finished && !prompt) { return ''; }
  return '<details class="done-notification' + (disabled ? ' disabled' : '') + '"' + (prompt ? ' open' : '') + '>'
    + '<summary>Done notification' + toggle + '</summary>'
    + body
    + renderDoneNotificationTarget(item, safeId, finished)
    + '</details>';
}

/**
 * Where the done notification goes (vscimpb71): this queue, another run, or another quest's run; and, once posted to
 * another quest, whether it waits there for a window. The button opens the host's quest and run pickers.
 */
function renderDoneNotificationTarget(item, safeId, finished) {
  var quest = item.doneNotificationQuest || '';
  var itemRun = item.run || 'default';
  var run = item.doneNotificationRun || (quest ? 'default' : itemRun);
  var label = quest ? 'quest ' + quest + ', run ' + run : (run !== itemRun ? 'run ' + run + ' of this quest' : 'this queue');
  var posted = item.doneNotificationPosted;
  var postedText = posted
    ? '<span class="done-notification-posted' + (posted.waiting ? ' waiting' : '') + '" title="' + escapeHtml('Inbox file ' + (posted.file || '') + (posted.at ? ', ' + posted.at : '')) + '">'
      + (posted.waiting
        ? '<span class="codicon codicon-watch"></span> posted to ' + escapeHtml(posted.quest) + ' / ' + escapeHtml(posted.run) + ': no window of that quest is running, it waits in its inbox'
        : '<span class="codicon codicon-check"></span> posted to ' + escapeHtml(posted.quest) + ' / ' + escapeHtml(posted.run))
      + '</span>'
    : '';
  return '<div class="done-notification-target">'
    + '<span>Posted to: </span>'
    + (finished
      ? '<span>' + escapeHtml(label) + '</span>'
      : '<button class="icon-btn" type="button" onclick="pickDoneNotificationTarget(\'' + safeId + '\')" title="Choose the quest and run the notification is queued in">'
        + '<span class="codicon codicon-send"></span> ' + escapeHtml(label) + '</button>')
    + (postedText ? ' ' + postedText : '')
    + '</div>';
}

/**
 * An item header's profile: `item.profileView` from the host. Its own profile is a chip with the profile's
 * name; without one it is an icon button (the default it runs with in the tooltip). Both open the profile
 * picker while the item can still change (`canPick`).
 */
function renderItemProfile(item, safeId) {
  var view = item.profileView;
  // Without the host's view (a page that shows entries on its own): the item's own profile, by its id.
  if (!view && item.transport === 'anthropic' && item.anthropicProfileId) {
    view = { own: true, transport: 'anthropic', id: item.anthropicProfileId, name: item.anthropicProfileId, canPick: false };
  }
  if (!view) return '';
  var runsWith = (view.name || view.id || 'the default profile') + (view.detail ? ' (' + view.detail + ')' : '');
  var click = view.canPick ? ' onclick="event.stopPropagation();pickItemProfile(\'' + safeId + '\')"' : '';
  if (view.own) {
    return '<span class="queue-profile-chip' + (view.canPick ? ' pickable' : '') + '" data-profile="' + escapeHtml(String(view.id || '')) + '"' + click
      + ' title="' + escapeHtml('Profile of this item: ' + runsWith + (view.canPick ? '. Click to choose another profile.' : '')) + '">'
      + escapeHtml(String(view.name || view.id || '')) + '</span>';
  }
  if (!view.canPick) return '';
  return '<span class="codicon codicon-account queue-profile-btn"' + click
    + ' title="' + escapeHtml('No profile of its own: it runs with ' + runsWith + ' (the session\'s profile, else the queue default). Click to choose a profile for this item.') + '"></span>';
}

/**
 * The out-of-budget panel (src/utils/outOfBudget.ts): why the item stopped,
 * a picker of the other profiles (preset to the stopped profile's fallback)
 * and two buttons — continue there with the out-of-budget prompt, or resend
 * the last request as it was. The buttons carry data-oob-action; the editor
 * script handles them with one delegated listener.
 */
function renderOutOfBudget(item, safeId) {
  var mark = item.outOfBudget;
  if (!mark || !mark.profileId) return '';
  var profiles = (typeof anthropicProfiles !== 'undefined' && Array.isArray(anthropicProfiles)) ? anthropicProfiles : [];
  var others = profiles.filter(function(p) { return p && p.id !== mark.profileId; });
  var preset = others.some(function(p) { return p.id === mark.suggestedProfileId; }) ? mark.suggestedProfileId : (others[0] ? others[0].id : '');
  var options = others.map(function(p) {
    var label = (p.name ? (p.name + ' (' + p.id + ')') : p.id) + (p.noApiKey ? ' (no API key)' : '');
    return '<option value="' + escapeHtml(p.id) + '"' + (p.id === preset ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');
  return '<div class="warning-chip out-of-budget" title="' + escapeHtml(mark.at || '') + '">'
    + '<span class="codicon codicon-credit-card"></span>'
    + '<span><strong>Out of budget:</strong> profile "' + escapeHtml(mark.profileName || mark.profileId) + '" in session "' + escapeHtml(mark.session || 'default') + '" — '
    + escapeHtml(mark.message || '') + '</span>'
    + '<select data-oob-profile="' + safeId + '"' + (others.length === 0 ? ' disabled' : '') + '>' + options + '</select>'
    + '<button class="btn-secondary" data-oob-action="continue" data-oob-id="' + safeId + '"' + (others.length === 0 ? ' disabled' : '') + ' title="Send the stopped stage on the picked profile, with a note naming the stopped profile, its session and its live trail">Continue on profile</button>'
    + '<button class="btn-secondary" data-oob-action="resend" data-oob-id="' + safeId + '" title="Send the very last request again as it was (once there is credit again)">Resend</button>'
    + '</div>';
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
    return '<div class="preprompt-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="preprompt-item-head">' +
        '<span>' + doneMark + 'Pre-prompt #' + (idx + 1) + (pp.template ? ' [' + escapeHtml(templateLabel) + ']' : '') + (ppRepeatLabel ? ' [PP ' + ppRepeatLabel + ppSkipBtn + ']' : '') +
        (pp.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (pp.anthropicProfileId ? ':' + escapeHtml(pp.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editPrePromptTransport(\'' + safeItemId + '\', ' + idx + ')" title="Change its profile (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removePrePrompt(\'' + safeItemId + '\', ' + idx + ')" title="Delete pre-prompt"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var ppShowTpl = editorMode !== 'template';
            var ppTplHtml = ppShowTpl
              ? ('<label style="font-size:0.85em;font-weight:600;" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">Prompt template:</label>' +
                 '<select onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'template\', this.value)" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">' +
                   runDefaultTemplateOption(item, pp.template) +
                   '<option value=""' + (!pp.template || pp.template === '(None)' ? ' selected' : '') + '>(None)</option>' +
                   promptTemplateOptionsHtml(pp.template) +
                 '</select>')
              : '';
            return '<textarea onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'text\', this.value)">' + escapeHtml(pp.text || '') + '</textarea>' +
          '<div class="template-row">' +
            ppTplHtml +
            '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
            '<input type="text" value="' + escapeHtml(ppRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updatePrePromptField(\'' + safeItemId + '\', ' + idx + ', \'repeatCount\', this.value)">' +
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
    var doneMark = idx < sentFollowUps ? '\u2713 ' : '';
    var templateLabel = formatPromptTemplateName(f.template || '(None)');
    var isActive = idx === activeFollowUpIndex;
    var fuRepeatCountRaw = f.repeatCount;
    var fuRepeatCountDisplay = fuRepeatCountRaw ? String(fuRepeatCountRaw) : '1';
    var fuRepeatLabel = formatRepeatLabel(fuRepeatCountRaw, f.repeatIndex, f.resolvedRepeatCount);
    var fuSkipBtn = (isActive && fuRepeatLabel) ? ' <span class="codicon codicon-debug-step-over" style="cursor:pointer;font-size:11px;" onclick="event.stopPropagation();continueSending(\'' + safeItemId + '\')" title="Skip to next FU iteration"></span>' : '';
    return '<div class="followup-item' + (isActive ? ' is-active' : '') + '">' +
      '<div class="followup-item-head">' +
        '<span>' + doneMark + 'Follow-up #' + (idx + 1) + (f.template ? (' [' + escapeHtml(templateLabel) + ']') : '') + (fuRepeatLabel ? ' [FU ' + fuRepeatLabel + fuSkipBtn + ']' : '') +
        (f.transport === 'anthropic' ? ' <span style="background:#4a9eff;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">[anthropic' + (f.anthropicProfileId ? ':' + escapeHtml(f.anthropicProfileId) : '') + ']</span>' : '') +
        '</span>' +
        '<span class="followup-tools">' +
          '<span class="codicon codicon-eye" style="cursor:pointer;" onclick="previewFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Preview follow-up"></span>' +
          (isEditable ? '<span class="codicon codicon-settings" style="cursor:pointer;" onclick="editFollowUpTransport(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Change its profile (stage override)"></span>' : '') +
          (isEditable ? '<span class="codicon codicon-trash" style="cursor:pointer;" onclick="removeFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\')" title="Delete follow-up"></span>' : '') +
        '</span>' +
      '</div>' +
      (isEditable
        ? (function() {
            var fuShowTpl = editorMode !== 'template';
            var fuTplHtml = fuShowTpl
              ? ('<span style="font-size:0.8em;opacity:0.85;" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">Prompt template:</span>' +
                 '<select onchange="updateFollowUpTemplate(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', this.value)" title="' + escapeHtml(PROMPT_TEMPLATE_TITLE) + '">' +
                   runDefaultTemplateOption(item, f.template) +
                   '<option value=""' + (!f.template || f.template === '(None)' ? ' selected' : '') + '>(None)</option>' +
                   promptTemplateOptionsHtml(f.template) +
                 '</select>')
              : '';
            return '<textarea onchange="updateFollowUp(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', this.value)">' + escapeHtml(f.originalText || '') + '</textarea>' +
          '<div class="followup-actions">' +
            '<div class="followup-row">' +
              fuTplHtml +
              '<span style="font-size:0.8em;opacity:0.85;margin-left:8px;">Repeats:</span>' +
              '<input type="text" value="' + escapeHtml(fuRepeatCountDisplay) + '" style="width:40px" placeholder="1" title="Number or variable name" onchange="updateFollowUpField(\'' + safeItemId + '\', \'' + safeFollowUpId + '\', \'repeatCount\', this.value)">' +
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

/* ---- Interrupt for continuation, soft (vscimpb112) ----------------------- */

/** `14:05` of an epoch-ms time. */
function softClock(ms) {
  var d = new Date(ms);
  if (isNaN(d.getTime())) { return ''; }
  var p = function(n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** `14:05:30` of an epoch-ms time. */
function softClockSeconds(ms) {
  var d = new Date(ms);
  if (isNaN(d.getTime())) { return ''; }
  var p = function(n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** What a sending item's soft interrupt says: the request (seconds left) or the hold (since when, at what). */
function softInterruptText(view, now) {
  if (!view) { return ''; }
  if (view.phase === 'requested' && view.unlimited) {
    return 'Soft interrupt requested ' + softClock(view.requestedAt) + ': it waits without a limit for the next tool result to hold (or the answer); no hard interrupt by itself';
  }
  if (view.phase === 'requested') {
    var hardAt = view.requestedAt + (view.timeoutMs || 15000);
    var left = Math.max(0, Math.ceil((hardAt - (now === undefined ? Date.now() : now)) / 1000));
    return 'Soft interrupt requested: the next tool result is held; hard interrupt in ' + left + ' s (at ' + softClockSeconds(hardAt) + ') unless it is held';
  }
  var at = view.kind === 'question' ? 'while it waits for your answer'
    : view.kind === 'wait' ? (view.tool === 'background work' ? 'while it waits for its background work' : 'while it waits in tomAi_waitFor')
    : 'at the result of ' + (view.tool || 'a tool');
  return 'held since ' + softClock(view.heldAt) + ' ' + at;
}

/** The first line of the question a turn waits in, and since when. */
function questionText(item) {
  var q = item.questionView;
  if (!q) { return 'The running prompt waits for your answer'; }
  return 'Answer needed: ' + q.firstLine + ' (since ' + q.since + ')';
}

/** `reason, until 14:20 (1 h 5 min left), since 13:10` of a turn waiting in tomAi_waitFor. */
function waitForText(view) {
  if (!view) { return ''; }
  var since = view.since ? softClock(Date.parse(view.since)) : '';
  return view.reason + ', until ' + view.untilLabel + ' (' + String(view.left || '').replace(/^until [^(]*\(/, '').replace(/\)$/, '') + ')' + (since ? ', since ' + since : '');
}

/** The row's state label of a sending item a soft interrupt, a question or a wait holds; '' when none does. */
function softInterruptRowLabel(item) {
  var view = item.softInterruptView;
  if (view && view.phase === 'requested') {
    return '<span class="soft-interrupt-label" title="' + escapeHtml(softInterruptText(view)) + '"><span class="codicon codicon-loading codicon-modifier-spin"></span> INTERRUPTING' + (view.unlimited ? ' (NO LIMIT)' : '') + '</span>';
  }
  if (view && view.phase === 'held') {
    return '<span class="soft-interrupt-label held" title="' + escapeHtml(softInterruptText(view) + ' — resume (auto-send on, or Continue → Resume) to go on') + '"><span class="codicon codicon-debug-disconnect"></span> HELD</span>';
  }
  if (Array.isArray(item.waitingForUser) && item.waitingForUser.indexOf('question') >= 0) {
    return '<span class="answer-needed-label" title="' + escapeHtml(questionText(item)) + '"><span class="answer-needed-icon" style="color:#e51400;">\u2753</span> ANSWER NEEDED</span>';
  }
  if (item.waitForView) {
    return '<span class="wait-for-label" title="' + escapeHtml(waitForText(item.waitForView)) + '">\u23f3 WAITING UNTIL ' + escapeHtml(String(item.waitForView.untilLabel)).toUpperCase() + '</span>';
  }
  return '';
}

/** The Interrupt for continuation button's icon for `item`: the next press's — soft, wait without a limit, hard. */
function interruptButtonIcon(item) {
  var view = item && item.softInterruptView;
  if (!view) { return 'codicon-debug-disconnect'; }
  return view.phase === 'requested' && !view.unlimited ? 'codicon-watch' : 'codicon-debug-stop';
}

/**
 * The panel of a soft interrupt (vscimpb112): it waits for its hold point (15 s, or without a limit) or holds;
 * Hard interrupt now ends the turn at once, Cancel interruption lets it go on as before the press.
 */
function renderSoftInterruptPanel(item, safeId) {
  var view = item.softInterruptView;
  if (!view || item.status !== 'sending') { return ''; }
  var waiting = view.phase === 'requested';
  var line = waiting
    ? (view.unlimited ? 'Waiting for a moment to interrupt softly — no limit: the turn is held at its next tool result, however long its running tool call takes.'
      : 'Waiting for a moment to interrupt softly — up to 15 s, then the hard interrupt (click the interrupt button again to wait without a limit).')
    : 'Held for continuation: ' + softInterruptText(view) + '.';
  return '<div class="soft-interrupt-panel" data-qid="' + escapeHtml(String(item.id)) + '" onclick="event.stopPropagation()">'
    + '<span class="codicon ' + (waiting ? 'codicon-loading codicon-modifier-spin' : 'codicon-debug-disconnect') + '"></span> '
    + '<span class="soft-interrupt-line">' + escapeHtml(line) + '</span>'
    + '<span class="soft-interrupt-actions">'
    + '<button type="button" class="wait-msg-btn" data-soft="hard" onclick="event.stopPropagation();hardInterruptNow(\'' + safeId + '\')" title="End the turn now: the item is interrupted and resent with a note when its run is resumed">Hard interrupt now</button>'
    + ' <button type="button" class="wait-msg-btn" data-soft="cancel" onclick="event.stopPropagation();cancelSoftInterrupt(\'' + safeId + '\')" title="' + escapeHtml(waiting ? 'Withdraw the interruption: the turn goes on, and the run sends again if the press had paused it' : 'Let the held turn go on (as Resume), and the run sends again if the press had paused it') + '">Cancel interruption</button>'
    + '</span></div>';
}

/** The Interrupt for continuation button's tooltip for `item` (toolbar and row). */
function interruptButtonTitle(item) {
  var view = item && item.softInterruptView;
  if (view && view.phase === 'requested' && !view.unlimited) { return 'Soft interrupt requested (waits up to 15 s) — click again to wait for the hold point without a limit; a third click is the hard interrupt'; }
  if (view) { return (view.unlimited && view.phase === 'requested' ? 'Waiting without a limit for the hold point' : 'Held for continuation') + ' — click again for a hard interrupt now'; }
  return 'Interrupt for continuation: soft first — the next tool result is held and the turn goes on where it stopped when auto-send is re-enabled; a hard interrupt after 15 s without a hold point. A second click waits for the hold point without a limit, a third is the hard interrupt';
}


/**
 * The "Run default" entry of a template select (utils/runDefaultChoice.ts): the item's text is built with its run's
 * default template when it is sent. Selected for a template stored as `(Run default)` / `__run_default__`. Its label
 * names the run's current default where the page knows it (the queue editor's `runDefaultTemplateOf`).
 * @param {any} item
 * @param {string | undefined} template
 * @returns {string}
 */
function runDefaultTemplateOption(item, template) {
  var isRunDefault = template === '(Run default)' || template === '__run_default__';
  // @ts-ignore -- defined by the queue editor only
  var known = typeof runDefaultTemplateOf === 'function' ? runDefaultTemplateOf(item) : null;
  var label = 'Run default' + (known === null ? '' : ' (' + (known || 'no template') + ')');
  return '<option value="__run_default__"' + (isRunDefault ? ' selected' : '') + ' title="The run\'s default template when the item is sent">' + escapeHtml(label) + '</option>';
}
