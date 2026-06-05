// @ts-nocheck
/* eslint-disable no-undef */
// Queue Template Editor webview script — extracted from getHtml() in
// src/handlers/queueTemplateEditor-handler.ts (Phase B.14 webview restructuring).
//
// Host-scope script: it declares the page globals (vscode, currentItems,
// reminderTemplates, promptTemplates, editorMode, detailsExpanded,
// responseTimeoutMinutes, …) consumed by the shared queue-entry component
// (media/shared/queueEntry{Utils,RenderFunctions,MessageHandlers}.js), and it
// calls + overrides the functions those partials define — so no-undef is
// disabled. The component scripts load BEFORE this one (their globals exist
// when init runs, and the originals exist for the override block to capture).
//
// Two changes vs the original inline script:
//   1. First-paint data now arrives via the loader's window.__INIT__ instead of
//      a #__initial_state__ JSON block (state under __INIT__.state).
//   2. The codicons stylesheet is injected at runtime from __INIT__.codiconsUri
//      (no node_modules placeholder exists).

const vscode = (() => {
  try { if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi(); }
  catch (e) { console.error('[TemplateEditor] acquireVsCodeApi failed:', e); }
  return { postMessage: function() {}, setState: function() {}, getState: function() {} };
})();

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
    showFeedback('Queued ✓', 'success');
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
    return '<div class="' + cls + '" onclick="selectTemplate(\'' + escapeJsSingleQuoted(entry.id) + '\')">' + escapeHtml(entry.displayName) + '</div>';
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

function copyCurrentTemplate() {
  if (!selectedId) { showFeedback('No template selected', 'error'); return; }
  vscode.postMessage({ type: 'copyCurrentTemplate', templateId: selectedId });
}

function renameCurrentTemplate() {
  if (!selectedId) { showFeedback('No template selected', 'error'); return; }
  vscode.postMessage({ type: 'renameCurrentTemplate', templateId: selectedId });
}

function openCurrentTemplateFile() {
  if (!selectedId) { showFeedback('No template selected', 'error'); return; }
  vscode.postMessage({ type: 'showTemplateFile', templateId: selectedId });
}

function deleteCurrentTemplate() {
  if (!selectedId) return;
  if (!confirm('Delete template "' + selectedName + '"?')) return;
  vscode.postMessage({ type: 'deleteCurrentTemplate', templateId: selectedId });
}

function saveTemplate() {
  if (!selectedId || currentItems.length === 0) return;
  vscode.postMessage({ type: 'saveTemplate', templateId: selectedId, item: currentItems[0] });
  showFeedback('Saved ✓', 'success');
}

function queuePrompt() {
  var ta = document.getElementById('promptInput');
  var text = ta ? ta.value.trim() : '';
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

var __updateItemRepeat = updateItemRepeat;
updateItemRepeat = function(id, patch) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    var localPatch = patch;
    if (localPatch === null || typeof localPatch !== 'object') {
      localPatch = { repeatCount: patch };
    }
    if (Object.prototype.hasOwnProperty.call(localPatch, 'repeatCount')) {
      var rcStr = String(localPatch.repeatCount || '0').trim();
      currentItems[0].repeatCount = /^[0-9]+$/.test(rcStr) ? Math.max(0, parseInt(rcStr, 10)) : rcStr;
    }
    if (Object.prototype.hasOwnProperty.call(localPatch, 'repeatPrefix')) {
      currentItems[0].repeatPrefix = String(localPatch.repeatPrefix || '');
    }
    if (Object.prototype.hasOwnProperty.call(localPatch, 'repeatSuffix')) {
      currentItems[0].repeatSuffix = String(localPatch.repeatSuffix || '');
    }
    if (Object.prototype.hasOwnProperty.call(localPatch, 'answerWaitMinutes')) {
      currentItems[0].answerWaitMinutes = Math.max(0, parseInt(String(localPatch.answerWaitMinutes || '0'), 10) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(localPatch, 'templateRepeatCount')) {
      currentItems[0].templateRepeatCount = localPatch.templateRepeatCount;
    }
    renderEditor();
  }
  __updateItemRepeat(id, patch);
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

var __updatePrePromptField = updatePrePromptField;
updatePrePromptField = function(id, index, field, value) {
  if (currentItems.length > 0 && currentItems[0].id === id) {
    if (Array.isArray(currentItems[0].prePrompts) && currentItems[0].prePrompts[index]) {
      var pp = currentItems[0].prePrompts[index];
      if (field === 'text') pp.text = value;
      if (field === 'template') pp.template = value || '';
      if (field === 'repeatCount') {
        var rcStr = String(value || '').trim();
        pp.repeatCount = /^[0-9]+$/.test(rcStr) ? Math.max(0, parseInt(rcStr, 10)) : rcStr;
      }
      if (field === 'answerWaitMinutes') pp.answerWaitMinutes = Math.max(0, parseInt(String(value || '0'), 10) || 0);
      if (field === 'reminderTemplateId') {
        if (value === '__none__') {
          pp.reminderEnabled = false;
          pp.reminderTemplateId = '';
        } else {
          pp.reminderTemplateId = value || '';
          pp.reminderEnabled = true;
        }
      }
      if (field === 'reminderTimeoutMinutes') pp.reminderTimeoutMinutes = parseInt(String(value || '0'), 10) || undefined;
    }
  }
  __updatePrePromptField(id, index, field, value);
};

var __updateFollowUpField = updateFollowUpField;
updateFollowUpField = function(id, followUpId, field, value) {
  if (currentItems.length > 0 && currentItems[0].id === id && Array.isArray(currentItems[0].followUps)) {
    var fu = currentItems[0].followUps.find(function(f) { return f.id === followUpId; });
    if (fu) {
      if (field === 'repeatCount') {
        var rcStr = String(value || '').trim();
        fu.repeatCount = /^[0-9]+$/.test(rcStr) ? Math.max(0, parseInt(rcStr, 10)) : rcStr;
      }
      if (field === 'answerWaitMinutes') fu.answerWaitMinutes = Math.max(0, parseInt(String(value || '0'), 10) || 0);
    }
  }
  __updateFollowUpField(id, followUpId, field, value);
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
