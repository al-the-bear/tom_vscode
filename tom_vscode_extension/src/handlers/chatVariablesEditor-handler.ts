/**
 * Chat Variables Editor — §7
 *
 * A webview panel (opened via command) that displays all current chat
 * variables in a two-column editable table plus a scrollable change log.
 *
 * Command: `dartscript.openChatVariablesEditor`
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatVariablesStore, ChangeSource } from '../managers/chatVariablesStore';
import { scanWorkspaceProjects } from '../managers/questTodoManager';
import { readPanelYaml, writePanelYaml, openPanelFile } from '../utils/panelYamlStore';
import { WsPaths } from '../utils/workspacePaths';

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;

export function openChatVariablesEditor(context: vscode.ExtensionContext): void {
    if (_panel) {
        _panel.reveal();
        return;
    }

    const codiconsUri = vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    _panel = vscode.window.createWebviewPanel(
        'chatVariablesEditor',
        'Chat Variables',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        },
    );

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    // Register message handler BEFORE setting html so no messages are lost
    _panel.webview.onDidReceiveMessage(
        (msg) => handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = getHtml(webviewCodiconsUri.toString());

    // Listen for store changes → push to webview + persist YAML
    let storeListener: vscode.Disposable | undefined;
    try {
        const store = ChatVariablesStore.instance;
        storeListener = store.onDidChange(() => {
            sendState(_panel!);
            _persistYaml(store);
        });
    } catch { /* store not initialised */ }

    // Initial data push
    sendState(_panel);

    _panel.onDidDispose(() => {
        _panel = undefined;
        storeListener?.dispose();
    });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    let store: ChatVariablesStore;
    try { store = ChatVariablesStore.instance; } catch { return; }

    switch (msg.type) {
        case 'setQuest':
            store.set('quest', msg.value, 'user');
            break;
        case 'setRole':
            store.set('role', msg.value, 'user');
            break;
        case 'setActiveProjects':
            store.setActiveProjects(msg.value, 'user');
            break;
        case 'setTodo':
            store.set('todo', msg.value, 'user');
            break;
        case 'setTodoFile':
            store.set('todoFile', msg.value, 'user');
            break;
        case 'setCustom':
            store.set(msg.key, msg.value, 'user');
            break;
        case 'deleteCustom':
            store.set(msg.key, '', 'user');
            break;
        case 'getState':
            if (_panel) { sendState(_panel); }
            break;
        case 'pickProjects':
            await _pickProjects();
            break;
        case 'showFile':
            openPanelFile('chatvars');
            break;
    }
}

function sendState(panel: vscode.WebviewPanel): void {
    let store: ChatVariablesStore;
    try { store = ChatVariablesStore.instance; } catch { return; }

    // Scan available roles
    const roles = _scanRoles();

    panel.webview.postMessage({
        type: 'state',
        quest: store.quest,
        role: store.role,
        roles: roles,
        activeProjects: store.activeProjects,
        todo: store.todo,
        todoFile: store.todoFile,
        custom: store.custom,
        changeLog: store.changeLog,
    });
}

// ============================================================================
// YAML persistence
// ============================================================================

function _persistYaml(store: ChatVariablesStore): void {
    const data: Record<string, any> = {
        quest: store.quest || '',
        role: store.role || '',
        activeProjects: store.activeProjects,
        todo: store.todo || '',
        todoFile: store.todoFile || '',
        custom: store.custom || {},
    };
    writePanelYaml('chatvars', data, '../../.tom/json-schema/panels/chatvars.schema.json').catch(() => { /* best effort */ });
}

// ============================================================================
// Project picker
// ============================================================================

async function _pickProjects(): Promise<void> {
    if (!_panel) return;

    const projects = scanWorkspaceProjects().map(p => p.name);

    let currentProjects: string[] = [];
    try {
        currentProjects = ChatVariablesStore.instance.activeProjects || [];
    } catch { /* */ }

    const items = projects.map(p => ({
        label: p,
        picked: currentProjects.includes(p),
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select active projects',
        title: 'Active Projects',
    });

    if (picked) {
        const selected = picked.map(p => p.label);
        try {
            ChatVariablesStore.instance.setActiveProjects(selected, 'user');
        } catch { /* */ }
    }
}

// ============================================================================
// Role picker
// ============================================================================

function _getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function _scanRoles(): string[] {
    const wsRoot = _getWorkspaceRoot();
    if (!wsRoot) return [];
    
    const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
    if (!fs.existsSync(rolesDir)) return [];
    
    try {
        return fs.readdirSync(rolesDir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.name.endsWith('.md') || e.name.endsWith('.yaml'))
            .map(e => e.isDirectory() ? e.name : e.name.replace(/\.(md|yaml)$/, ''))
            .sort();
    } catch { return []; }
}

// ============================================================================
// HTML
// ============================================================================

function getHtml(codiconsUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${codiconsUri}">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; display: flex; flex-direction: column; height: 100vh; }

h2 { font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.add-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; padding: 2px 8px; font-size: 12px; }
.add-btn:hover { background: var(--vscode-button-hoverBackground); }

/* ── Table ──────────────────────────────────── */
table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
th { text-align: left; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); padding: 4px 8px; border-bottom: 2px solid var(--vscode-panel-border); }
td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
.var-name { font-weight: 600; font-size: 12px; min-width: 120px; }
.var-value input, .var-value textarea { width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 3px 6px; font-size: 12px; font-family: inherit; }
.var-value textarea { resize: vertical; min-height: 28px; }
.var-actions { width: 32px; text-align: center; }
.delete-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; font-size: 14px; padding: 2px; }
.delete-btn:hover { opacity: 0.8; }
.select-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; padding: 2px 6px; font-size: 11px; margin-left: 4px; }
.select-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.file-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px 4px; opacity: 0.7; }
.file-btn:hover { opacity: 1; }

/* ── New variable row ──────────────────────── */
.new-row { display: none; }
.new-row.visible { display: table-row; }
.new-row input { width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 3px 6px; font-size: 12px; }
.confirm-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; padding: 2px 6px; font-size: 11px; }

/* ── Change log ────────────────────────────── */
.log-section { flex: 1; display: flex; flex-direction: column; min-height: 100px; }
.log-section h3 { font-size: 13px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
.log-list { flex: 1; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.6; background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; }
.log-entry { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-time { color: var(--vscode-descriptionForeground); margin-right: 8px; }
.log-var { font-weight: 600; color: var(--vscode-foreground); }
.log-source { font-style: italic; color: var(--vscode-descriptionForeground); margin-left: 4px; }
</style>
</head>
<body>
<h2>Chat Variables <button class="add-btn" id="btn-add">+ Add</button> <button class="file-btn" id="btn-file" title="Show YAML file">📄</button></h2>

<table id="var-table">
<thead><tr><th>Variable</th><th>Value</th><th></th></tr></thead>
<tbody id="var-body"></tbody>
</table>

<div class="log-section">
    <h3>Change Log (last 100)</h3>
    <div class="log-list" id="log-list"></div>
</div>

<script>
var vscode = acquireVsCodeApi();
var stateData = {};

// ── Render variable table ──
function renderTable(s) {
    stateData = s;
    var body = document.getElementById('var-body');
    var rows = '';

    // Built-in variables
    rows += varRow('quest', s.quest || '', false);
    // role: dropdown populated from available roles
    var roleOptions = '<option value="">(None)</option>' + (s.roles || []).map(function(r) {
        return '<option value="' + esc(r) + '"' + (r === (s.role || '') ? ' selected' : '') + '>' + esc(r) + '</option>';
    }).join('');
    rows += '<tr><td class="var-name">role</td>' +
        '<td class="var-value"><select data-var="role" style="width:100%;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);color:var(--vscode-dropdown-foreground);border-radius:3px;padding:3px 6px;font-size:12px;font-family:inherit;">' + roleOptions + '</select></td>' +
        '<td class="var-actions"></td></tr>';
    // activeProjects: special row with Select... button
    var apVal = JSON.stringify(s.activeProjects || []);
    rows += '<tr><td class="var-name">activeProjects</td>' +
        '<td class="var-value"><input data-var="activeProjects" value="' + esc(apVal) + '"></td>' +
        '<td class="var-actions"><button class="select-btn" id="btn-pick-projects" title="Select projects">Select…</button></td></tr>';
    rows += varRow('todo', s.todo || '', false);
    rows += varRow('todoFile', s.todoFile || '', false);

    // Custom variables
    var custom = s.custom || {};
    Object.keys(custom).sort().forEach(function(k) {
        rows += varRow('custom.' + k, custom[k] || '', true);
    });

    // New variable input row (hidden by default)
    rows += '<tr class="new-row" id="new-row"><td><input id="new-key" placeholder="key.name"></td><td><input id="new-value" placeholder="value"></td><td class="var-actions"><button class="confirm-btn" id="btn-confirm-add">✓</button></td></tr>';

    body.innerHTML = rows;
    attachInputListeners();
}

function varRow(name, value, deletable) {
    var escapedValue = esc(value);
    var deleteBtn = deletable ? '<button class="delete-btn" data-delete="' + esc(name.replace('custom.', '')) + '" title="Delete">🗑️</button>' : '';
    return '<tr>' +
        '<td class="var-name">' + esc(name) + '</td>' +
        '<td class="var-value"><input data-var="' + esc(name) + '" value="' + escapedValue + '"></td>' +
        '<td class="var-actions">' + deleteBtn + '</td></tr>';
}

function attachInputListeners() {
    document.querySelectorAll('[data-var]').forEach(function(el) {
        el.addEventListener('change', function() {
            var name = el.dataset.var;
            var val = el.value;
            if (name === 'quest') vscode.postMessage({ type: 'setQuest', value: val });
            else if (name === 'role') vscode.postMessage({ type: 'setRole', value: val });
            else if (name === 'activeProjects') {
                try { vscode.postMessage({ type: 'setActiveProjects', value: JSON.parse(val) }); } catch {}
            }
            else if (name === 'todo') vscode.postMessage({ type: 'setTodo', value: val });
            else if (name === 'todoFile') vscode.postMessage({ type: 'setTodoFile', value: val });
            else if (name.startsWith('custom.')) vscode.postMessage({ type: 'setCustom', key: name.replace('custom.', ''), value: val });
        });
    });

    document.querySelectorAll('[data-delete]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({ type: 'deleteCustom', key: el.dataset.delete });
        });
    });

    var confirmBtn = document.getElementById('btn-confirm-add');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', function() {
            var key = document.getElementById('new-key').value.trim();
            var val = document.getElementById('new-value').value;
            if (!key) return;
            key = key.replace(/[^a-z0-9._]/g, '');
            if (!key) return;
            vscode.postMessage({ type: 'setCustom', key: key, value: val });
            document.getElementById('new-row').classList.remove('visible');
        });
    }

    var pickBtn = document.getElementById('btn-pick-projects');
    if (pickBtn) {
        pickBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'pickProjects' });
        });
    }
}

// ── Render change log ──
function renderLog(entries) {
    var list = document.getElementById('log-list');
    if (!entries || !entries.length) { list.innerHTML = '<div style="color:var(--vscode-descriptionForeground)">No changes yet</div>'; return; }
    list.innerHTML = entries.slice().reverse().map(function(e) {
        var time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        return '<div class="log-entry"><span class="log-time">' + time + '</span>' +
            '<span class="log-var">' + esc(e.variable) + '</span> = "' + esc(String(e.value).substring(0, 60)) + '"' +
            '<span class="log-source"> (' + esc(e.source) + ')</span></div>';
    }).join('');
}

// ── Add button ──
document.getElementById('btn-add').addEventListener('click', function() {
    var row = document.getElementById('new-row');
    if (row) { row.classList.toggle('visible'); }
});

// ── Show file button ──
document.getElementById('btn-file').addEventListener('click', function() {
    vscode.postMessage({ type: 'showFile' });
});

// ── Message listener ──
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'state') {
        renderTable(msg);
        renderLog(msg.changeLog);
    }
});

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Initial request
vscode.postMessage({ type: 'getState' });
</script>
</body>
</html>`;
}

// ============================================================================
// Registration
// ============================================================================

export function registerChatVariablesEditorCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('dartscript.openChatVariablesEditor', () => {
            openChatVariablesEditor(context);
        }),
    );
}
