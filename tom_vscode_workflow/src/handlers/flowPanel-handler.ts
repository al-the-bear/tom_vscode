/**
 * @TODO Panel Handler
 *
 * Bottom panel for the TOM Tracker extension. Uses the accordion component
 * to display two side-by-side file editing sections (todo1.md and todo2.md).
 *
 * Each section provides a textarea for editing the corresponding file.
 * Changes are auto-saved on a debounce timer and can also be saved manually.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { type AccordionSection, getAccordionHtml } from '../components/accordionPanel';
import { debug, error } from '../infrastructure';
import { reportError, wrapListener } from '../infrastructure/errorCapture';
import {
    findScanRoot,
    scanTodoFiles,
    readTodoFile,
    updateTodoInFile,
    type TodoItem,
} from 'tom-vscode-shared';

// ============================================================================
// Constants
// ============================================================================

const VIEW_ID = 'tomTracker.todoPanel';
const AUTO_SAVE_DELAY_MS = 1500;

// ============================================================================
// State
// ============================================================================

let _provider: TodoPanelProvider | undefined;

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the @TODO bottom panel with VS Code.
 */
export function registerTodoPanel(context: vscode.ExtensionContext): void {
    _provider = new TodoPanelProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, _provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    debug('@TODO panel registered');
}

// ============================================================================
// Provider
// ============================================================================

class TodoPanelProvider implements vscode.WebviewViewProvider {
    private _view: vscode.WebviewView | undefined;
    private readonly _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;
        debug('@TODO resolveWebviewView start');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };

        // Build HTML
        try {
            const codiconsUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
            );

            webviewView.webview.html = this._getHtmlContent(codiconsUri.toString());
            debug('@TODO webview HTML assigned');
        } catch (err) {
            reportError('todoPanel.resolveWebviewView.assignHtml', err, undefined, true);
            webviewView.webview.html = `<html><body><pre style="color:red;white-space:pre-wrap;padding:20px;">@TODO panel error: ${escapeHtml(String(err))}</pre></body></html>`;
            return;
        }

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            wrapListener('todoPanel.onMessage', async (message: any) => {
                await this._handleMessage(message, webviewView.webview);
            }),
            undefined,
            this._context.subscriptions,
        );
    }

    // ========================================================================
    // HTML Generation
    // ========================================================================

    private _getHtmlContent(codiconsUri: string): string {
        // Load initial content for each todo file
        const file1Content = this._readNoteFile('todo1.md');
        const file2Content = this._readNoteFile('todo2.md');

        const sections: AccordionSection[] = [
            {
                id: 'tracker',
                title: 'TRACKER',
                icon: 'graph',
                content: this._getTrackerSectionHtml(),
            },
            {
                id: 'todos',
                title: 'TODOS',
                icon: 'tasklist',
                content: this._getTodosSectionHtml(),
            },
            {
                id: 'file1',
                title: 'FILE1',
                icon: 'file',
                content: this._getNoteEditorHtml('file1', 'todo1.md', file1Content),
            },
            {
                id: 'file2',
                title: 'FILE2',
                icon: 'file',
                content: this._getNoteEditorHtml('file2', 'todo2.md', file2Content),
            },
        ];

        const additionalCss = this._getAdditionalCss();
        const additionalScript = this._getAdditionalScript();

        return getAccordionHtml({
            codiconsUri,
            sections,
            initialExpanded: 'tracker',
            additionalCss,
            additionalScript,
        });
    }

    private _getTrackerSectionHtml(): string {
        return `
<div class="toolbar">
    <button class="primary" data-action="openMindmap" data-id="tracker">
        <span class="codicon codicon-graph"></span> Open Mindmap
    </button>
    <button data-action="scanInfo" data-id="tracker">
        <span class="codicon codicon-search"></span> Scan
    </button>
</div>
<div class="tracker-info" id="tracker-info">
    Click <b>Open Mindmap</b> to scan for *.todo.yaml files and visualize as a flowchart diagram.
</div>`;
    }

    private _getTodosSectionHtml(): string {
        return `
<div class="toolbar">
    <button data-action="pickTodosDir" data-id="todos">
        <span class="codicon codicon-folder-opened"></span> Pick Directory
    </button>
    <button data-action="refreshTodos" data-id="todos">
        <span class="codicon codicon-refresh"></span>
    </button>
    <span class="toolbar-filename" id="todos-dir-label">No directory</span>
</div>
<div id="todos-list" class="todos-container">
    <div class="sample-content"><p>Pick a directory to browse *.todo.yaml files.</p></div>
</div>`;
    }

    private _getNoteEditorHtml(id: string, filename: string, content: string): string {
        const escapedContent = escapeHtml(content);
        return `
<div class="toolbar">
    <span class="toolbar-filename"><span class="codicon codicon-file"></span> ${filename}</span>
    <span class="toolbar-spacer"></span>
    <button class="icon-btn" title="Save" data-action="save" data-id="${id}">
        <span class="codicon codicon-save"></span>
    </button>
    <button class="icon-btn" title="Reload from disk" data-action="reload" data-id="${id}">
        <span class="codicon codicon-refresh"></span>
    </button>
</div>
<textarea id="editor-${id}" data-file-id="${id}" placeholder="Start typing...">${escapedContent}</textarea>
<div class="status-bar" id="status-${id}">Ready</div>`;
    }

    private _getAdditionalCss(): string {
        return `
.toolbar-filename { font-size: 12px; display: flex; align-items: center; gap: 4px; opacity: 0.8; }
.toolbar-spacer { flex: 1; }
.status-bar { padding: 2px 8px; font-size: 11px; border-top: 1px solid var(--vscode-panel-border); }
.status-bar.saved { color: var(--vscode-testing-iconPassed); }
.status-bar.error { color: var(--vscode-errorForeground); }
.status-bar.modified { color: var(--vscode-editorWarning-foreground); }
.tracker-info { padding: 8px; font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.tracker-info b { color: var(--vscode-foreground); }
.todos-container { overflow-y: auto; flex: 1; font-size: 12px; }
.todos-file-header { padding: 4px 8px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--vscode-sideBarSectionHeader-foreground); background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; display: flex; align-items: center; gap: 4px; }
.todos-file-header:hover { background: var(--vscode-list-hoverBackground); }
.todos-item { padding: 3px 8px 3px 16px; display: flex; align-items: center; gap: 6px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.todos-item:hover { background: var(--vscode-list-hoverBackground); }
.todos-item .status-icon { flex-shrink: 0; }
.todos-item .todo-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todos-item .todo-priority { font-size: 10px; opacity: 0.6; }
.todos-item select { padding: 0 2px; height: 18px; font-size: 11px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
.todos-empty { padding: 8px; color: var(--vscode-descriptionForeground); font-style: italic; }
`;
    }

    private _getAdditionalScript(): string {
        return `
// --- TODO Editor Script ---

var autoSaveTimers = {};
var AUTO_SAVE_DELAY = ${AUTO_SAVE_DELAY_MS};

function onRenderComplete() {
    // Attach input listeners to textareas after accordion renders
    document.querySelectorAll('textarea[data-file-id]').forEach(function(ta) {
        ta.addEventListener('input', function() {
            var fileId = ta.dataset.fileId;
            setStatus(fileId, 'Modified', 'modified');
            scheduleAutoSave(fileId, ta.value);
        });
    });
}

function scheduleAutoSave(fileId, content) {
    if (autoSaveTimers[fileId]) clearTimeout(autoSaveTimers[fileId]);
    autoSaveTimers[fileId] = setTimeout(function() {
        saveFile(fileId, content);
    }, AUTO_SAVE_DELAY);
}

function saveFile(fileId, content) {
    if (content === undefined) {
        var ta = document.getElementById('editor-' + fileId);
        if (ta) content = ta.value;
    }
    vscode.postMessage({ type: 'saveFile', fileId: fileId, content: content });
}

function setStatus(fileId, text, className) {
    var el = document.getElementById('status-' + fileId);
    if (el) {
        el.textContent = text;
        el.className = 'status-bar' + (className ? ' ' + className : '');
    }
}

function handleAction(action, id) {
    if (action === 'save') {
        var ta = document.getElementById('editor-' + id);
        if (ta) saveFile(id, ta.value);
    } else if (action === 'reload') {
        vscode.postMessage({ type: 'reloadFile', fileId: id });
    } else if (action === 'openMindmap') {
        vscode.postMessage({ type: 'openMindmap' });
    } else if (action === 'scanInfo') {
        vscode.postMessage({ type: 'scanInfo' });
    } else if (action === 'pickTodosDir') {
        vscode.postMessage({ type: 'pickTodosDir' });
    } else if (action === 'refreshTodos') {
        vscode.postMessage({ type: 'refreshTodos' });
    } else {
        vscode.postMessage({ type: 'action', action: action, sectionId: id });
    }
}

// --- TODOS Section Rendering ---

var todosStatusIcons = {
    'not-started': '⬜',
    'in-progress': '🔄',
    'completed': '✅',
    'cancelled': '⛔',
    'blocked': '🚫'
};

function todosRenderList(data) {
    var container = document.getElementById('todos-list');
    if (!container) return;
    if (!data || !data.files || data.files.length === 0) {
        container.innerHTML = '<div class="todos-empty">No *.todo.yaml files found</div>';
        return;
    }
    var html = '';
    data.files.forEach(function(file) {
        html += '<div class="todos-file-header" data-action="todosOpenFile" data-id="' + escapeAttr(file.path) + '">';
        html += '<span class="codicon codicon-file"></span> ' + escapeText(file.name);
        html += ' <span style="opacity:0.5">(' + (file.todos ? file.todos.length : 0) + ')</span>';
        html += '</div>';
        if (file.todos) {
            file.todos.forEach(function(todo) {
                var icon = todosStatusIcons[todo.status] || '⬜';
                var pri = todo.priority ? ' [' + todo.priority + ']' : '';
                html += '<div class="todos-item" data-action="todosSelectTodo" data-id="' + escapeAttr(todo.id) + '" data-file="' + escapeAttr(file.path) + '">';
                html += '<span class="status-icon">' + icon + '</span>';
                html += '<span class="todo-title">' + escapeText(todo.id) + ': ' + escapeText(todo.title || '') + '</span>';
                html += '<span class="todo-priority">' + escapeText(pri) + '</span>';
                html += '<select class="todos-status-select" data-todo-id="' + escapeAttr(todo.id) + '" data-file="' + escapeAttr(file.path) + '">';
                ['not-started','in-progress','completed','cancelled','blocked'].forEach(function(s) {
                    html += '<option value="' + s + '"' + (s === todo.status ? ' selected' : '') + '>' + (todosStatusIcons[s] || '') + ' ' + s + '</option>';
                });
                html += '</select>';
                html += '</div>';
            });
        }
    });
    container.innerHTML = html;
    // Attach status change listeners
    container.querySelectorAll('.todos-status-select').forEach(function(sel) {
        sel.addEventListener('change', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'todosStatusChange', todoId: sel.dataset.todoId, filePath: sel.dataset.file, newStatus: sel.value });
        });
    });
    // Attach click listeners for file and todo items
    container.querySelectorAll('[data-action="todosOpenFile"]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({ type: 'todosOpenFile', filePath: el.dataset.id });
        });
    });
    container.querySelectorAll('[data-action="todosSelectTodo"]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
            vscode.postMessage({ type: 'todosOpenFile', filePath: el.dataset.file });
        });
    });
}

function escapeText(str) { return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
function escapeAttr(str) { return str ? str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

// Listen for messages from the extension
window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'fileSaved') {
        setStatus(msg.fileId, 'Saved', 'saved');
    } else if (msg.type === 'fileReloaded') {
        var ta = document.getElementById('editor-' + msg.fileId);
        if (ta) ta.value = msg.content || '';
        setStatus(msg.fileId, 'Reloaded', 'saved');
    } else if (msg.type === 'saveError') {
        setStatus(msg.fileId, 'Save error: ' + (msg.error || 'unknown'), 'error');
    } else if (msg.type === 'todosDirectory') {
        var label = document.getElementById('todos-dir-label');
        if (label) label.textContent = msg.truncatedPath || msg.dirPath || '';
    } else if (msg.type === 'todosList') {
        todosRenderList(msg);
    } else if (msg.type === 'todosStatusChanged') {
        // Refresh after status change
        vscode.postMessage({ type: 'refreshTodos' });
    } else if (msg.type === 'scanInfoResult') {
        var info = document.getElementById('tracker-info');
        if (info) info.innerHTML = msg.html || '';
    }
});
`;
    }

    // ========================================================================
    // Message Handling
    // ========================================================================

    private async _handleMessage(message: any, webview: vscode.Webview): Promise<void> {
        switch (message.type) {
            case 'saveFile':
                await this._saveFile(message.fileId, message.content, webview);
                break;

            case 'reloadFile':
                this._reloadFile(message.fileId, webview);
                break;

            case 'openMindmap':
                await vscode.commands.executeCommand('tomTracker.showTodoMindmap');
                break;

            case 'scanInfo':
                this._sendScanInfo(webview);
                break;

            case 'pickTodosDir':
                await this._pickTodosDirectory(webview);
                break;

            case 'refreshTodos':
                this._refreshTodos(webview);
                break;

            case 'todosStatusChange':
                this._changeTodoStatus(message.todoId, message.filePath, message.newStatus, webview);
                break;

            case 'todosOpenFile':
                if (message.filePath) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(message.filePath);
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
                    } catch (err) {
                        error(`Failed to open file: ${err}`);
                    }
                }
                break;

            case 'action':
                debug(`@TODO action: ${message.action} section=${message.sectionId}`);
                break;

            default:
                debug(`@TODO unknown message: ${JSON.stringify(message)}`);
        }
    }

    // ========================================================================
    // TRACKER / TODOS Section Operations
    // ========================================================================

    /** Currently selected TODOS directory path. */
    private _todosDir: string | undefined;

    private _sendScanInfo(webview: vscode.Webview): void {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            webview.postMessage({ type: 'scanInfoResult', html: '<p>No workspace folder open.</p>' });
            return;
        }
        try {
            const scanRoot = findScanRoot(wsFolder.uri.fsPath);
            const files = scanTodoFiles(scanRoot);
            const truncRoot = scanRoot.length > 60 ? '...' + scanRoot.slice(-57) : scanRoot;
            webview.postMessage({
                type: 'scanInfoResult',
                html: `<b>Root:</b> ${escapeHtml(truncRoot)}<br/><b>Files:</b> ${files.length} *.todo.yaml files found`,
            });
        } catch (err) {
            webview.postMessage({ type: 'scanInfoResult', html: `<span style="color:var(--vscode-errorForeground)">Scan error: ${escapeHtml(String(err))}</span>` });
        }
    }

    private async _pickTodosDirectory(webview: vscode.Webview): Promise<void> {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: wsFolder?.uri,
            openLabel: 'Select TODO Directory',
        });
        if (!uris || uris.length === 0) { return; }

        this._todosDir = uris[0].fsPath;
        const truncPath = this._todosDir.length > 60 ? '...' + this._todosDir.slice(-57) : this._todosDir;
        webview.postMessage({ type: 'todosDirectory', dirPath: this._todosDir, truncatedPath: truncPath });
        this._refreshTodos(webview);
    }

    private _refreshTodos(webview: vscode.Webview): void {
        if (!this._todosDir) { return; }
        try {
            const files = scanTodoFiles(this._todosDir);
            const fileData = files.map(rel => {
                const fullPath = path.join(this._todosDir!, rel);
                const todos = readTodoFile(fullPath).map((t: TodoItem) => ({
                    id: t.id,
                    title: t.title || '',
                    status: t.status,
                    priority: t.priority || '',
                }));
                return { name: rel, path: fullPath, todos };
            });
            webview.postMessage({ type: 'todosList', files: fileData });
        } catch (err) {
            error(`TODOS refresh failed: ${err}`);
        }
    }

    private _changeTodoStatus(todoId: string, filePath: string, newStatus: string, webview: vscode.Webview): void {
        try {
            const updated = updateTodoInFile(filePath, todoId, { status: newStatus });
            webview.postMessage({ type: 'todosStatusChanged', todoId, success: !!updated });
        } catch (err) {
            error(`TODOS status change failed: ${err}`);
        }
    }

    // ========================================================================
    // File Operations
    // ========================================================================

    private _getNotePath(filename: string): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        // Use the first workspace folder as the root
        return path.join(workspaceFolders[0].uri.fsPath, filename);
    }

    private _readNoteFile(filename: string): string {
        const filePath = this._getNotePath(filename);
        if (!filePath) {
            return '';
        }
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf-8');
            }
        } catch (err) {
            error(`Failed to read ${filename}: ${err}`);
        }
        return '';
    }

    private async _saveFile(fileId: string, content: string, webview: vscode.Webview): Promise<void> {
        const filename = this._fileIdToFilename(fileId);
        if (!filename) {
            webview.postMessage({ type: 'saveError', fileId, error: 'Unknown file ID' });
            return;
        }

        const filePath = this._getNotePath(filename);
        if (!filePath) {
            webview.postMessage({ type: 'saveError', fileId, error: 'No workspace folder' });
            return;
        }

        try {
            fs.writeFileSync(filePath, content, 'utf-8');
            debug(`@TODO saved ${filename} (${content.length} chars)`);
            webview.postMessage({ type: 'fileSaved', fileId });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`@TODO save failed for ${filename}: ${msg}`);
            webview.postMessage({ type: 'saveError', fileId, error: msg });
        }
    }

    private _reloadFile(fileId: string, webview: vscode.Webview): void {
        const filename = this._fileIdToFilename(fileId);
        if (!filename) { return; }

        const content = this._readNoteFile(filename);
        webview.postMessage({ type: 'fileReloaded', fileId, content });
        debug(`@TODO reloaded ${filename}`);
    }

    private _fileIdToFilename(fileId: string): string | null {
        switch (fileId) {
            case 'file1': return 'todo1.md';
            case 'file2': return 'todo2.md';
            default: return null;
        }
    }
}

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
