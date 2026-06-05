// @ts-nocheck
/* eslint-disable no-undef */
// queueEntryMessageHandlers — extracted verbatim from queueEntryMessageHandlers() in src/handlers/queueEntryComponent.ts (Phase B.13 webview
// restructuring). This is a host-scope mixin: its functions reference page
// globals (currentItems, vscode, detailsExpanded, reminderTemplates, editorMode,
// render, …) declared by the host panel main.js (media/queueEditor or media/queueTemplateEditor), so no-undef is disabled. Promoted to media/shared in B.14 (used by both editors).
// Both the queue editor and the queue template editor load this file as a
// <script src> from media/shared/ (loader {{sharedUri}}), keeping one source of truth.
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
    repeatIndex: undefined,
    repeatPrefix: undefined,
    repeatSuffix: undefined,
    answerWaitMinutes: undefined,
    templateRepeatCount: undefined,
    templateRepeatIndex: undefined,
  };
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'repeatCount')) {
    // Accept both number and string (variable name)
    var rcVal = String(nextPatch.repeatCount || '').trim();
    var rcNum = parseInt(rcVal, 10);
    msg.repeatCount = isNaN(rcNum) ? rcVal : Math.max(0, rcNum);
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'repeatIndex')) {
    // 0-based start index. Caller is responsible for any 1-based → 0-based
    // conversion (the MP status-bar input does that translation before
    // delegating here).
    var riVal = parseInt(String(nextPatch.repeatIndex || '0'), 10);
    msg.repeatIndex = isNaN(riVal) ? 0 : Math.max(0, riVal);
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
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'templateRepeatIndex')) {
    // 0-based start index, matching the displayed convention.
    var triVal = parseInt(String(nextPatch.templateRepeatIndex || '0'), 10);
    msg.templateRepeatIndex = isNaN(triVal) ? 0 : Math.max(0, triVal);
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
// Main-prompt start rep number — 1-based input matching the displayed
// format. Translate to 0-based repeatIndex before forwarding so the
// manager's storage stays internally consistent.
function submitRepeatStartIndexFromStatus(event, id, inputEl) {
  if (!event || event.key !== 'Enter') { return; }
  event.preventDefault();
  event.stopPropagation();
  var raw = String(inputEl && inputEl.value || '').trim();
  if (!raw) return;
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 1) num = 1;
  if (inputEl) {
    inputEl.value = String(num);
    if (typeof inputEl.blur === 'function') { inputEl.blur(); }
  }
  updateItemRepeat(id, { repeatIndex: num - 1 });
}
// Template start iteration — 0-based input (matches the displayed
// "T 0/3" convention). Forwarded verbatim.
function submitTemplateStartIndexFromStatus(event, id, inputEl) {
  if (!event || event.key !== 'Enter') { return; }
  event.preventDefault();
  event.stopPropagation();
  var raw = String(inputEl && inputEl.value || '').trim();
  if (!raw) return;
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 0) num = 0;
  if (inputEl) {
    inputEl.value = String(num);
    if (typeof inputEl.blur === 'function') { inputEl.blur(); }
  }
  updateItemRepeat(id, { templateRepeatIndex: num });
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
