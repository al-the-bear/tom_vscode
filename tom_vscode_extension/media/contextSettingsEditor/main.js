// @ts-nocheck
/*
 * Context & Settings Editor client script — extracted verbatim from the inline
 * <script> in _getHtml() of src/handlers/contextSettingsEditor-handler.ts
 * (Phase B.16 webview restructuring).
 *
 * All data flows in via postMessage after the initial getContextData request
 * at the bottom; there is no init.state payload. The only init value consumed
 * is codiconsUri, injected as a <link> at runtime (no placeholder exists for
 * the node_modules codicons asset).
 */
var vscode = acquireVsCodeApi();

// ── Codicons stylesheet (injected from init; cspSource-served, no placeholder) ──
var __INIT = window.__INIT__ || {};
if (__INIT.codiconsUri) {
    var __codiconsLink = document.createElement('link');
    __codiconsLink.rel = 'stylesheet';
    __codiconsLink.href = __INIT.codiconsUri;
    document.head.appendChild(__codiconsLink);
}

var selectedProjects = [];

// ── Populate helpers ──
function populateContextForm(data) {
    var questSel = document.getElementById('ctx-quest');
    if (questSel) {
        questSel.innerHTML = '<option value="">(None)</option>' + (data.quests || []).map(function(q) {
            return '<option value="' + q + '"' + (q === data.currentQuest ? ' selected' : '') + '>' + q + '</option>';
        }).join('');
    }
    var roleSel = document.getElementById('ctx-role');
    if (roleSel) {
        roleSel.innerHTML = '<option value="">(None)</option>' + (data.roles || []).map(function(r) {
            return '<option value="' + r + '"' + (r === data.currentRole ? ' selected' : '') + '>' + r + '</option>';
        }).join('');
    }
    selectedProjects = data.activeProjects || [];
    updateProjectsDisplay();
    var todoFileSel = document.getElementById('ctx-todoFile');
    if (todoFileSel) {
        todoFileSel.innerHTML = '<option value="">(None)</option>' + (data.todoFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === data.currentTodoFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }
    var todoSel = document.getElementById('ctx-todo');
    if (todoSel) {
        todoSel.innerHTML = '<option value="">(None)</option>' + (data.todos || []).map(function(t) {
            var statusIcon = t.status === 'completed' ? '✓' : t.status === 'in-progress' ? '▶' : t.status === 'blocked' ? '⏸' : '○';
            return '<option value="' + t.id + '"' + (t.id === data.currentTodo ? ' selected' : '') + '>' + statusIcon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
        }).join('');
    }
    var reminderCb = document.getElementById('ctx-reminder-enabled');
    if (reminderCb) reminderCb.checked = !!data.reminderEnabled;
    var reminderTimeout = document.getElementById('ctx-reminder-timeout');
    if (reminderTimeout && data.reminderTimeout) reminderTimeout.value = String(data.reminderTimeout);
    var templateSel = document.getElementById('ctx-reminder-template');
    if (templateSel) {
        templateSel.innerHTML = '<option value="">(None)</option>' + (data.reminderTemplates || []).map(function(t) {
            return '<option value="' + t.id + '">' + t.name + '</option>';
        }).join('');
    }
    var autohideSel = document.getElementById('ctx-autohide');
    if (autohideSel) autohideSel.value = String(data.autoHideDelay || 0);
}

function updateProjectsDisplay() {
    var input = document.getElementById('ctx-projects');
    if (input) input.value = selectedProjects.length > 0 ? selectedProjects.join(', ') : '';
}

function getProjectsFromInput() {
    var input = document.getElementById('ctx-projects');
    if (!input || !input.value.trim()) return [];
    return input.value.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
}

// ── Event listeners ──
// Note: Quest change no longer affects todo file selection (todo files are independent)
document.getElementById('ctx-todoFile').addEventListener('change', function() {
    vscode.postMessage({ type: 'getTodosForFile', file: this.value });
});
document.getElementById('btn-pick-projects').addEventListener('click', function() {
    vscode.postMessage({ type: 'pickProjects' });
});
document.getElementById('btn-add-template').addEventListener('click', function() {
    vscode.postMessage({ type: 'addReminderTemplate' });
});
document.getElementById('btn-edit-template').addEventListener('click', function() {
    var sel = document.getElementById('ctx-reminder-template');
    if (sel && sel.value) vscode.postMessage({ type: 'editReminderTemplate', id: sel.value });
});
document.getElementById('btn-delete-template').addEventListener('click', function() {
    var sel = document.getElementById('ctx-reminder-template');
    if (sel && sel.value) vscode.postMessage({ type: 'deleteReminderTemplate', id: sel.value });
});
document.getElementById('btn-open-chat-variables').addEventListener('click', function() {
    vscode.postMessage({ type: 'openChatVariablesEditor' });
});
document.getElementById('btn-apply').addEventListener('click', function() {
    vscode.postMessage({
        type: 'applyContext',
        quest: document.getElementById('ctx-quest').value,
        role: document.getElementById('ctx-role').value,
        activeProjects: getProjectsFromInput(),
        todoFile: document.getElementById('ctx-todoFile').value,
        todo: document.getElementById('ctx-todo').value,
        reminderEnabled: document.getElementById('ctx-reminder-enabled').checked,
        reminderTimeout: parseInt(document.getElementById('ctx-reminder-timeout').value) || 600000,
        autoHideDelay: parseInt(document.getElementById('ctx-autohide').value) || 0
    });
});
document.getElementById('btn-cancel').addEventListener('click', function() {
    vscode.postMessage({ type: 'close' });
});

// ── Message listener ──
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'contextData') {
        populateContextForm(msg);
    } else if (msg.type === 'contextTodoFiles') {
        var todoFileSel = document.getElementById('ctx-todoFile');
        if (todoFileSel) {
            todoFileSel.innerHTML = '<option value="">(None)</option>' + (msg.todoFiles || []).map(function(f) {
                return '<option value="' + f + '">' + f + '</option>';
            }).join('');
        }
        var todoSel = document.getElementById('ctx-todo');
        if (todoSel) todoSel.innerHTML = '<option value="">(None)</option>';
    } else if (msg.type === 'contextTodosUpdate') {
        var todoSelUpd = document.getElementById('ctx-todo');
        if (todoSelUpd) {
            todoSelUpd.innerHTML = '<option value="">(None)</option>' + (msg.todos || []).map(function(t) {
                var statusIcon = t.status === 'completed' ? '✓' : t.status === 'in-progress' ? '▶' : t.status === 'blocked' ? '⏸' : '○';
                return '<option value="' + t.id + '">' + statusIcon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
            }).join('');
        }    } else if (msg.type === 'projectsPicked') {
        selectedProjects = msg.projects || [];
        updateProjectsDisplay();    }
});

// Initial load
vscode.postMessage({ type: 'getContextData' });
