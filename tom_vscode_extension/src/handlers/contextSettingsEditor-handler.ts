/**
 * Context & Settings Editor — standalone webview panel.
 *
 * Opened via `tomAi.editor.contextSettings` command (or from the
 * copilot toolbar "Context & Settings" button).  Replaces the old in-webview
 * popup overlay, giving full editor-tab space.
 *
 * Reads/writes the ChatVariablesStore, scans quest folders, manages reminder
 * configuration — same data flow as the old popup but in its own panel.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';
import { PLACEHOLDER_HELP } from './promptTemplate';

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

export function registerContextSettingsEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.contextSettings', () => {
            openContextSettingsEditor(ctx);
        }),
    );
}

export function openContextSettingsEditor(context: vscode.ExtensionContext): void {
    if (_panel) {
        _panel.reveal();
        _sendContextData();
        return;
    }

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );

    _panel = vscode.window.createWebviewPanel(
        'tomAi.contextSettingsEditor',
        'Context & Settings',
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
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = _getHtml(webviewCodiconsUri.toString());

    _panel.onDidDispose(() => {
        _panel = undefined;
    });

    // Initial data push
    _sendContextData();
}

// ============================================================================
// Message handling
// ============================================================================

async function _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
        case 'getContextData':
            await _sendContextData();
            break;
        case 'applyContext':
            await _applyContext(msg);
            break;
        case 'getContextDataForQuest':
            await _sendTodoFilesForQuest(msg.quest);
            break;
        case 'getTodosForFile':
            await _sendTodosForFile(msg.file);
            break;
        case 'pickProjects':
            await _pickProjects();
            break;
        case 'addReminderTemplate':
            await _addReminderTemplate();
            break;
        case 'editReminderTemplate':
            await _editReminderTemplate(msg.id);
            break;
        case 'deleteReminderTemplate':
            await _deleteReminderTemplate(msg.id);
            break;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('tomAi.editor.chatVariables');
            break;
        case 'close':
            _panel?.dispose();
            break;
    }
}

// ============================================================================
// Data helpers (mirrored from unifiedNotepad-handler)
// ============================================================================

function _getWorkspaceRoot(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (activeWorkspaceFolder) {
            return activeWorkspaceFolder.uri.fsPath;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function _sendContextData(): Promise<void> {
    if (!_panel) return;
    const wsRoot = _getWorkspaceRoot();
    let quests: string[] = [];
    let roles: string[] = [];
    let projects: string[] = [];
    let todoFiles: string[] = [];
    let todos: { id: string; title?: string; description?: string; status?: string }[] = [];

    if (wsRoot) {
        const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
        if (fs.existsSync(questsDir)) {
            try {
                quests = fs.readdirSync(questsDir, { withFileTypes: true })
                    .filter(e => e.isDirectory()).map(e => e.name).sort();
            } catch { /* */ }
        }
        const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
        if (fs.existsSync(rolesDir)) {
            try {
                roles = fs.readdirSync(rolesDir, { withFileTypes: true })
                    .filter(e => e.isDirectory() || e.name.endsWith('.md') || e.name.endsWith('.yaml'))
                    .map(e => e.isDirectory() ? e.name : e.name.replace(/\.(md|yaml)$/, ''))
                    .sort();
            } catch { /* */ }
        }
        const masterYaml = WsPaths.metadata('tom_master.yaml') || path.join(wsRoot, '.tom_metadata', 'tom_master.yaml');
        if (fs.existsSync(masterYaml)) {
            try {
                const yaml = await import('yaml');
                const content = fs.readFileSync(masterYaml, 'utf-8');
                const parsed = yaml.parse(content);
                if (parsed?.projects) projects = Object.keys(parsed.projects).sort();
            } catch { /* */ }
        }
        // Supplement with scanned workspace projects
        try {
            const { scanWorkspaceProjects } = await import('../managers/questTodoManager.js');
            const scanned = scanWorkspaceProjects().map(p => p.name);
            const set = new Set(projects);
            for (const p of scanned) set.add(p);
            projects = [...set].sort();
        } catch { /* */ }
    }

    let currentQuest = '';
    let currentRole = '';
    let activeProjects: string[] = [];
    let currentTodoFile = '';
    let currentTodo = '';
    let reminderEnabled = false;
    let reminderTimeout = 600000;

    try {
        const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
        const store = ChatVariablesStore.instance;
        currentQuest = store.quest || '';
        currentRole = store.role || '';
        activeProjects = store.activeProjects || [];
        currentTodo = store.todo || '';
        currentTodoFile = store.todoFile || '';
    } catch { /* */ }

    // Scan ALL quests for *.todo.yaml files (same filter as questTodoManager.listTodoFiles)
    if (wsRoot) {
        // Also include workspace-level todo file
        const wsToDoFile = path.join(wsRoot, 'workspace.todo.yaml');
        if (fs.existsSync(wsToDoFile)) {
            todoFiles.push('workspace.todo.yaml');
        }
        const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
        if (fs.existsSync(questsDir)) {
            try {
                const questDirs = fs.readdirSync(questsDir, { withFileTypes: true })
                    .filter(e => e.isDirectory()).map(e => e.name);
                for (const qName of questDirs) {
                    const qDir = path.join(questsDir, qName);
                    const files = fs.readdirSync(qDir)
                        .filter(f => f.endsWith('.todo.yaml'));
                    for (const f of files) {
                        todoFiles.push(`${qName}/${f}`);
                    }
                }
                todoFiles.sort();
            } catch { /* */ }
        }
    }

    // Parse todo file path (may include quest: "questId/filename.yaml" or be a root-level file)
    if (currentTodoFile && currentTodoFile !== 'all' && wsRoot) {
        let todoPath: string;
        if (currentTodoFile === 'workspace.todo.yaml') {
            // Workspace-level todo file
            todoPath = path.join(wsRoot, 'workspace.todo.yaml');
        } else if (currentTodoFile.includes('/')) {
            // Full path with quest: questId/filename.yaml
            todoPath = WsPaths.ai('quests', ...currentTodoFile.split('/')) || path.join(wsRoot, '_ai', 'quests', ...currentTodoFile.split('/'));
        } else if (currentQuest) {
            // Legacy: just filename, use currentQuest
            todoPath = WsPaths.ai('quests', currentQuest, currentTodoFile) || path.join(wsRoot, '_ai', 'quests', currentQuest, currentTodoFile);
        } else {
            todoPath = '';
        }
        if (todoPath && fs.existsSync(todoPath)) {
            try {
                const yaml = await import('yaml');
                const content = fs.readFileSync(todoPath, 'utf-8');
                const parsed = yaml.parse(content);
                if (parsed?.todos && Array.isArray(parsed.todos)) {
                    todos = parsed.todos.map((t: any) => ({
                        id: t.id || '', title: t.title || '',
                        description: t.description || '', status: t.status || 'not-started',
                    }));
                }
            } catch { /* */ }
        }
    }

    let reminderTemplates: { id: string; name: string }[] = [];

    try {
        const { ReminderSystem } = await import('../managers/reminderSystem.js');
        const reminder = ReminderSystem.instance;
        if (reminder) {
            reminderEnabled = reminder.config.enabled;
            reminderTimeout = reminder.config.defaultTimeoutMinutes * 60000;
            reminderTemplates = reminder.templates.map(t => ({ id: t.id, name: t.name }));
        }
    } catch { /* */ }

    const autoHideDelay = _context?.workspaceState.get('copilotAutoHideDelay', 0) ?? 0;

    _panel?.webview.postMessage({
        type: 'contextData',
        quests, roles, projects, todoFiles, todos,
        currentQuest, currentRole, activeProjects,
        currentTodoFile, currentTodo,
        reminderEnabled, reminderTimeout, reminderTemplates,
        autoHideDelay,
    });
}

async function _applyContext(msg: any): Promise<void> {
    try {
        const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
        const store = ChatVariablesStore.instance;
        if (msg.quest !== undefined) store.set('quest', msg.quest, 'user');
        if (msg.role !== undefined) store.set('role', msg.role, 'user');
        if (msg.activeProjects !== undefined) store.setActiveProjects(msg.activeProjects || [], 'user');
        if (msg.todoFile !== undefined) store.set('todoFile', msg.todoFile, 'user');
        if (msg.todo !== undefined) store.set('todo', msg.todo, 'user');
    } catch { /* */ }

    try {
        const { ReminderSystem } = await import('../managers/reminderSystem.js');
        const reminder = ReminderSystem.instance;
        if (reminder) {
            const timeoutMinutes = Math.max(1, Math.round((msg.reminderTimeout || 600000) / 60000));
            reminder.updateConfig({ enabled: !!msg.reminderEnabled, defaultTimeoutMinutes: timeoutMinutes });
        }
    } catch { /* */ }

    // Auto-hide delay
    if (msg.autoHideDelay !== undefined && _context) {
        _context.workspaceState.update('copilotAutoHideDelay', msg.autoHideDelay);
    }

    vscode.window.showInformationMessage('Context & Settings applied.');
    // Close the panel after apply
    _panel?.dispose();
}

async function _sendTodoFilesForQuest(quest: string): Promise<void> {
    if (!_panel) return;
    const wsRoot = _getWorkspaceRoot();
    let todoFiles: string[] = [];
    if (quest && wsRoot) {
        const questDir = WsPaths.ai('quests', quest) || path.join(wsRoot, '_ai', 'quests', quest);
        if (fs.existsSync(questDir)) {
            try {
                const files = fs.readdirSync(questDir);
                todoFiles = files.filter(f => f.endsWith('.todo.yaml')).sort();
            } catch { /* */ }
        }
    }
    _panel.webview.postMessage({ type: 'contextTodoFiles', todoFiles });
}

async function _sendTodosForFile(file: string): Promise<void> {
    if (!_panel) return;
    const wsRoot = _getWorkspaceRoot();

    if (!file || !wsRoot) {
        _panel.webview.postMessage({ type: 'contextTodosUpdate', todos: [] });
        return;
    }

    // Parse file path - may be "questId/filename.yaml", "workspace.todo.yaml", or just "filename.yaml" (legacy)
    let todoPath: string;
    if (file === 'workspace.todo.yaml') {
        todoPath = path.join(wsRoot, 'workspace.todo.yaml');
    } else if (file.includes('/')) {
        // New format: questId/filename.yaml
        const parts = file.split('/');
        todoPath = WsPaths.ai('quests', ...parts) || path.join(wsRoot, '_ai', 'quests', ...parts);
    } else {
        // Legacy: try to use current quest
        let currentQuest = '';
        try {
            const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
            currentQuest = ChatVariablesStore.instance.quest || '';
        } catch { /* */ }
        if (!currentQuest) {
            _panel.webview.postMessage({ type: 'contextTodosUpdate', todos: [] });
            return;
        }
        todoPath = WsPaths.ai('quests', currentQuest, file) || path.join(wsRoot, '_ai', 'quests', currentQuest, file);
    }
    let todos: any[] = [];
    if (fs.existsSync(todoPath)) {
        try {
            const yaml = await import('yaml');
            const content = fs.readFileSync(todoPath, 'utf-8');
            const parsed = yaml.parse(content);
            if (parsed?.todos && Array.isArray(parsed.todos)) {
                todos = parsed.todos.map((t: any) => ({
                    id: t.id || '', title: t.title || '',
                    description: t.description || '', status: t.status || 'not-started',
                }));
            }
        } catch { /* */ }
    }
    _panel.webview.postMessage({ type: 'contextTodosUpdate', todos });
}

async function _pickProjects(): Promise<void> {
    if (!_panel) return;

    // Use the workspace project scanner instead of tom_master.yaml
    let projects: string[] = [];
    try {
        const { scanWorkspaceProjects } = await import('../managers/questTodoManager.js');
        projects = scanWorkspaceProjects().map(p => p.name);
    } catch { /* scanner not available */ }

    // Get current selection
    let currentProjects: string[] = [];
    try {
        const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
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
        _panel.webview.postMessage({ type: 'projectsPicked', projects: selected });
    }
}

async function _addReminderTemplate(): Promise<void> {
    if (_context) {
        openGlobalTemplateEditor(_context, { category: 'reminder' });
    }
}

async function _editReminderTemplate(id: string): Promise<void> {
    if (!id || !_context) return;
    openGlobalTemplateEditor(_context, { category: 'reminder', itemId: id });
}

async function _deleteReminderTemplate(id: string): Promise<void> {
    if (!id) return;
    try {
        const { ReminderSystem } = await import('../managers/reminderSystem.js');
        const rs = ReminderSystem.instance;
        const existing = rs.templates.find(t => t.id === id);
        if (!existing) return;
        const answer = await vscode.window.showWarningMessage(
            `Delete reminder template "${existing.name}"?`, { modal: true }, 'Delete');
        if (answer !== 'Delete') return;
        rs.removeTemplate(id);
        await _sendContextData();
    } catch { /* */ }
}

// ============================================================================
// HTML
// ============================================================================

function _getHtml(codiconsUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${codiconsUri}">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    max-width: 600px;
    margin: 0;
}
h1 { font-size: 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
h1 .codicon { font-size: 20px; }

fieldset {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
}
legend {
    font-size: 14px;
    font-weight: 600;
    padding: 0 6px;
}
.form-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}
.form-row label {
    font-size: 13px;
    font-weight: 600;
    min-width: 90px;
    color: var(--vscode-descriptionForeground);
}
.form-row select, .form-row input[type="text"] {
    flex: 1;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    color: var(--vscode-dropdown-foreground);
    border-radius: 4px;
    font-size: 13px;
    padding: 4px 8px;
}
.form-row select[multiple] {
    min-height: 72px;
}
.actions {
    display: flex;
    gap: 10px;
    margin-top: 20px;
    justify-content: flex-end;
}
.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 6px 20px;
    font-size: 13px;
    font-weight: 600;
}
.primary:hover { background: var(--vscode-button-hoverBackground); }
.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 6px 20px;
    font-size: 13px;
}
.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
}
.checkbox-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
}
.icon-btn {
    background: none;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn.danger { color: var(--vscode-errorForeground); }
.link-btn {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 13px;
    text-decoration: underline;
    padding: 4px 0;
}
.link-btn:hover { color: var(--vscode-textLink-activeForeground); }
</style>
</head>
<body>
<h1><span class="codicon codicon-tools"></span> Context & Settings</h1>

<fieldset>
    <legend>Context</legend>
    <div class="form-row"><label>Quest:</label><select id="ctx-quest"></select></div>
    <div class="form-row"><label>Role:</label><select id="ctx-role"></select></div>
    <div class="form-row"><label>Projects:</label><input type="text" id="ctx-projects" placeholder="Comma-separated or use Select…"><button class="secondary" id="btn-pick-projects" style="padding:4px 12px;flex:none;">Select…</button></div>
    <div class="form-row"><label>Todo File:</label><select id="ctx-todoFile"></select></div>
    <div class="form-row"><label>Todo:</label><select id="ctx-todo"></select></div>
</fieldset>

<fieldset>
    <legend>Reminder Templates</legend>
    <div class="form-row">
        <label>Template:</label>
        <select id="ctx-reminder-template" style="flex:1;"></select>
        <button class="icon-btn" id="btn-add-template" title="Add Template"><span class="codicon codicon-add"></span> Add</button>
        <button class="icon-btn" id="btn-edit-template" title="Edit Template"><span class="codicon codicon-edit"></span> Edit</button>
        <button class="icon-btn danger" id="btn-delete-template" title="Delete Template"><span class="codicon codicon-trash"></span> Del</button>
    </div>
</fieldset>

<fieldset>
    <legend>Reminder</legend>
    <div class="form-row">
        <div class="checkbox-row">
            <input type="checkbox" id="ctx-reminder-enabled">
            <label style="min-width:auto;">Alive check</label>
        </div>
        <select id="ctx-reminder-timeout" style="max-width:120px;">
            <option value="300000">5 min</option>
            <option value="600000">10 min</option>
            <option value="900000">15 min</option>
            <option value="1800000">30 min</option>
            <option value="3600000">60 min</option>
            <option value="7200000">120 min</option>
            <option value="14400000">240 min</option>
            <option value="21600000">360 min</option>
            <option value="28800000">480 min</option>
        </select>
    </div>
</fieldset>

<fieldset>
    <legend>Sidebar Auto-hide</legend>
    <div class="form-row">
        <label>After sending prompt:</label>
        <select id="ctx-autohide" style="max-width:160px;">
            <option value="0">Keep open</option>
            <option value="1000">1 second</option>
            <option value="5000">5 seconds</option>
            <option value="10000">10 seconds</option>
        </select>
    </div>
</fieldset>

<div style="margin-top:8px; margin-bottom:12px;">
    <button class="link-btn" id="btn-open-chat-variables">Open Chat Variables Editor…</button>
</div>

<div class="actions">
    <button class="secondary" id="btn-cancel">Cancel</button>
    <button class="primary" id="btn-apply"><span class="codicon codicon-check"></span> Apply</button>
</div>

<script>
var vscode = acquireVsCodeApi();

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
</script>
</body>
</html>`;
}
