/**
 * Memory Panel — webview that exposes the two-tier memory store
 * (`_ai/memory/shared/` + `_ai/memory/{quest}/`) for inline editing.
 *
 * Spec: anthropic_sdk_integration.md §11.2. The panel is opened via the
 * `tomAi.panel.memory` command, which the ANTHROPIC section's Memory
 * button invokes when the webview posts `{ type: 'openAnthropicMemory' }`.
 *
 * Layout (two-pane):
 *   ├── Scope tabs          [Shared memory] [Quest: {quest}]
 *   ├── File list (left)    one entry per file in the selected scope
 *   ├── Content view (right) editable markdown textarea
 *   └── Toolbar             [+ New file] [Save] [Delete] [Open in editor]
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { TwoTierMemoryService, MemoryScope } from '../services/memory-service';

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

export function registerMemoryPanelCommand(context: vscode.ExtensionContext): void {
    _context = context;
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.panel.memory', () => {
            openMemoryPanel(context);
        }),
    );
}

export function openMemoryPanel(context: vscode.ExtensionContext): void {
    _context = context;
    if (_panel) {
        _panel.reveal();
        _sendSnapshot();
        return;
    }
    _panel = vscode.window.createWebviewPanel(
        'tomAi.memoryPanel',
        'Memory',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    _panel.webview.html = _getHtml();
    _panel.webview.onDidReceiveMessage(
        (msg: WebviewMessage) => { void _handleMessage(msg); },
        undefined,
        context.subscriptions,
    );
    _panel.onDidDispose(() => { _panel = undefined; });
    // Initial data push once the webview has loaded.
    setTimeout(() => _sendSnapshot(), 50);
}

async function _handleMessage(msg: WebviewMessage): Promise<void> {
    try {
        switch (msg.type) {
            case 'ready':
                _sendSnapshot();
                return;
            case 'readFile':
                _sendFile(msg.scope as MemoryScope, String(msg.file ?? ''));
                return;
            case 'saveFile':
                _saveFile(msg.scope as MemoryScope, String(msg.file ?? ''), String(msg.content ?? ''));
                return;
            case 'deleteFile':
                _deleteFile(msg.scope as MemoryScope, String(msg.file ?? ''));
                return;
            case 'newFile':
                await _newFile(msg.scope as MemoryScope);
                return;
            case 'openInEditor':
                _openInEditor(msg.scope as MemoryScope, String(msg.file ?? ''));
                return;
        }
    } catch (e) {
        _panel?.webview.postMessage({
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

function _sendSnapshot(): void {
    const svc = TwoTierMemoryService.instance;
    const quest = svc.currentQuest();
    const shared = svc.listWithMeta('shared').sort((a, b) => a.file.localeCompare(b.file));
    const questFiles = quest
        ? svc.listWithMeta('quest').sort((a, b) => a.file.localeCompare(b.file))
        : [];
    _panel?.webview.postMessage({
        type: 'snapshot',
        quest,
        shared: shared.map((e) => ({ file: e.file, bytes: e.bytes })),
        questFiles: questFiles.map((e) => ({ file: e.file, bytes: e.bytes })),
    });
}

function _sendFile(scope: MemoryScope, file: string): void {
    if (!file) return;
    const content = TwoTierMemoryService.instance.read(scope, file);
    _panel?.webview.postMessage({ type: 'fileContent', scope, file, content });
}

function _saveFile(scope: MemoryScope, file: string, content: string): void {
    if (!file) return;
    TwoTierMemoryService.instance.write(scope, file, content);
    vscode.window.setStatusBarMessage(`Memory: saved ${scope}/${file}`, 2000);
    _sendSnapshot();
    _sendFile(scope, file);
}

function _deleteFile(scope: MemoryScope, file: string): void {
    if (!file) return;
    TwoTierMemoryService.instance.delete(scope, file);
    vscode.window.setStatusBarMessage(`Memory: deleted ${scope}/${file}`, 2000);
    _sendSnapshot();
}

async function _newFile(scope: MemoryScope): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: `New memory file (${scope})`,
        placeHolder: 'e.g. decisions.md',
        validateInput: (v) => (v && v.trim() && !v.includes('..') ? null : 'Invalid file name'),
    });
    if (!name) return;
    const file = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
    const svc = TwoTierMemoryService.instance;
    if (svc.read(scope, file)) {
        vscode.window.showWarningMessage(`Memory file already exists: ${scope}/${file}`);
        return;
    }
    svc.write(scope, file, '');
    _sendSnapshot();
    _sendFile(scope, file);
}

function _openInEditor(scope: MemoryScope, file: string): void {
    if (!file) return;
    const abs = TwoTierMemoryService.instance.filePath(scope, file);
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
}

// ----- HTML --------------------------------------------------------------

function _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
}
.tabs {
    display: flex;
    gap: 2px;
    padding: 8px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
}
.tab {
    padding: 6px 14px;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 3px;
    user-select: none;
}
.tab.active {
    background: var(--vscode-tab-activeBackground);
    border-color: var(--vscode-focusBorder);
}
.toolbar {
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
}
button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 2px;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.split {
    flex: 1;
    display: flex;
    min-height: 0;
}
.file-list {
    width: 240px;
    overflow-y: auto;
    border-right: 1px solid var(--vscode-panel-border);
    padding: 4px 0;
}
.file-item {
    padding: 4px 10px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.file-item:hover { background: var(--vscode-list-hoverBackground); }
.file-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
.file-item .bytes { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
.editor {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
}
textarea {
    flex: 1;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: none;
    padding: 10px;
    resize: none;
    outline: none;
}
.empty {
    padding: 20px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}
</style>
</head>
<body>
    <div class="tabs">
        <div class="tab active" data-scope="shared">Shared memory</div>
        <div class="tab" data-scope="quest" id="quest-tab">Quest</div>
    </div>
    <div class="toolbar">
        <button id="btn-new">+ New file</button>
        <button id="btn-save" disabled>Save</button>
        <button id="btn-delete" disabled>Delete file</button>
        <button id="btn-open" disabled>Open in editor</button>
        <span style="flex:1"></span>
        <span id="status" style="padding-top:6px;color:var(--vscode-descriptionForeground);font-size:12px"></span>
    </div>
    <div class="split">
        <div class="file-list" id="file-list"></div>
        <div class="editor">
            <textarea id="content" spellcheck="false" placeholder="Select a file — or click '+ New file' to create one."></textarea>
        </div>
    </div>
<script>
(() => {
    const vscode = acquireVsCodeApi();
    let currentScope = 'shared';
    let currentFile = '';
    let dirty = false;
    let snapshot = { quest: '', shared: [], questFiles: [] };

    const questTab = document.getElementById('quest-tab');
    const fileList = document.getElementById('file-list');
    const content = document.getElementById('content');
    const status = document.getElementById('status');
    const btnNew = document.getElementById('btn-new');
    const btnSave = document.getElementById('btn-save');
    const btnDelete = document.getElementById('btn-delete');
    const btnOpen = document.getElementById('btn-open');

    document.querySelectorAll('.tab').forEach((el) => {
        el.addEventListener('click', () => switchScope(el.getAttribute('data-scope')));
    });

    content.addEventListener('input', () => {
        dirty = true;
        btnSave.disabled = !currentFile;
        status.textContent = currentFile ? 'unsaved' : '';
    });

    btnNew.addEventListener('click', () => {
        vscode.postMessage({ type: 'newFile', scope: currentScope });
    });
    btnSave.addEventListener('click', () => {
        if (!currentFile) return;
        vscode.postMessage({ type: 'saveFile', scope: currentScope, file: currentFile, content: content.value });
        dirty = false;
        status.textContent = 'saved';
    });
    btnDelete.addEventListener('click', () => {
        if (!currentFile) return;
        if (!confirm('Delete ' + currentScope + '/' + currentFile + '?')) return;
        vscode.postMessage({ type: 'deleteFile', scope: currentScope, file: currentFile });
        currentFile = '';
        content.value = '';
        dirty = false;
        btnSave.disabled = true;
        btnDelete.disabled = true;
        btnOpen.disabled = true;
    });
    btnOpen.addEventListener('click', () => {
        if (!currentFile) return;
        vscode.postMessage({ type: 'openInEditor', scope: currentScope, file: currentFile });
    });

    function switchScope(scope) {
        if (dirty && !confirm('Discard unsaved changes?')) return;
        currentScope = scope;
        currentFile = '';
        content.value = '';
        dirty = false;
        btnSave.disabled = true;
        btnDelete.disabled = true;
        btnOpen.disabled = true;
        status.textContent = '';
        document.querySelectorAll('.tab').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-scope') === scope);
        });
        renderList();
    }

    function renderList() {
        const files = currentScope === 'shared' ? snapshot.shared : snapshot.questFiles;
        fileList.innerHTML = '';
        if (!files.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            if (currentScope === 'quest' && !snapshot.quest) {
                empty.textContent = 'No active quest. Set one in the Chat Variables Editor.';
            } else {
                empty.textContent = '(no files)';
            }
            fileList.appendChild(empty);
            return;
        }
        for (const f of files) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = '<span>' + f.file + '</span><span class="bytes">' + f.bytes + 'b</span>';
            if (f.file === currentFile) item.classList.add('active');
            item.addEventListener('click', () => {
                if (dirty && !confirm('Discard unsaved changes?')) return;
                currentFile = f.file;
                document.querySelectorAll('.file-item').forEach((el) => el.classList.remove('active'));
                item.classList.add('active');
                vscode.postMessage({ type: 'readFile', scope: currentScope, file: f.file });
            });
            fileList.appendChild(item);
        }
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'snapshot') {
            snapshot = msg;
            questTab.textContent = msg.quest ? 'Quest: ' + msg.quest : 'Quest';
            renderList();
        } else if (msg.type === 'fileContent') {
            if (msg.scope === currentScope && msg.file === currentFile) {
                content.value = msg.content;
                dirty = false;
                btnSave.disabled = false;
                btnDelete.disabled = false;
                btnOpen.disabled = false;
                status.textContent = '';
            }
        } else if (msg.type === 'error') {
            status.textContent = 'error: ' + msg.message;
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

// Appease strict unused-import linting when the module-level `_context`
// is only read from within closures — retained for future API hooks.
void _context;
void path;
