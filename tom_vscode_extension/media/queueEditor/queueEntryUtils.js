// @ts-nocheck
/* eslint-disable no-undef */
// queueEntryUtils — extracted verbatim from queueEntryUtils() in src/handlers/queueEntryComponent.ts (Phase B.13 webview
// restructuring). This is a host-scope mixin: its functions reference page
// globals (currentItems, vscode, detailsExpanded, reminderTemplates, editorMode,
// render, …) declared by media/queueEditor/main.js, so no-undef is disabled.
// The same file is also concatenated into the queue template editor script via
// queueEntryComponent.ts (readMediaText), keeping a single source of truth.
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
