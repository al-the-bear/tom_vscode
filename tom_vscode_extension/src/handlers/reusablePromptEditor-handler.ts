/**
 * Reusable Prompt Editor — full-screen webview panel.
 *
 * Unified editor for `.prompt.md` files across four scopes:
 *   1. Global    — _ai/prompt/
 *   2. Project   — {projectRoot}/prompt/
 *   3. Quest     — _ai/quests/{questId}/prompt/
 *   4. Scan      — ancestor `prompt/` dirs relative to active file
 *
 * Layout: top action bar with scope selector + sub-scope + add/delete/open btns,
 * left column *.prompt.md file list, right column markdown editor.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, escapeHtml } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { getWorkspaceName } from '../utils/panelYamlStore';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';

// ============================================================================
// Types
// ============================================================================

export type PromptScope = 'global' | 'project' | 'quest' | 'scan';

export const SCOPE_LABELS: Record<PromptScope, string> = {
    global: 'Global',
    project: 'Project',
    quest: 'Quest',
    scan: 'Scan',
};

interface ScopeItem {
    id: string;
    label: string;
    dir: string;
}

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

/**
 * Open the reusable prompt editor, optionally pre-selecting a scope and file.
 */
export function openReusablePromptEditor(
    context: vscode.ExtensionContext,
    options?: { scope?: PromptScope; subScopeId?: string; fileId?: string },
): void {
    _context = context;

    if (_panel) {
        _panel.reveal();
        if (options?.scope || options?.fileId) {
            _panel.webview.postMessage({
                type: 'selectFile',
                scope: options.scope,
                subScopeId: options.subScopeId,
                fileId: options.fileId,
            });
        }
        return;
    }

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );

    _panel = vscode.window.createWebviewPanel(
        'dartscript.reusablePromptEditor',
        'Reusable Prompt Editor',
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

    _panel.webview.onDidReceiveMessage(
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = _getHtml(webviewCodiconsUri.toString());

    _panel.onDidDispose(() => { _panel = undefined; });

    setTimeout(() => {
        _sendAllData(options?.scope, options?.subScopeId, options?.fileId);
    }, 100);
}

export function registerReusablePromptEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('dartscript.openReusablePromptEditor', (args?: any) => {
            openReusablePromptEditor(ctx, {
                scope: args?.scope,
                subScopeId: args?.subScopeId,
                fileId: args?.fileId,
            });
        }),
    );
}

// ============================================================================
// Scope resolution (adapted from unifiedNotepad-handler.ts)
// ============================================================================

function _getGlobalPromptsDir(): string | null {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return null;
    return WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
}

function _getActiveQuestId(): string {
    return _context?.workspaceState?.get<string>('chatVar_quest', '').trim() || '';
}

function _getPreferredQuestId(): string {
    const activeQuest = _getActiveQuestId();
    if (activeQuest) return activeQuest;
    const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
    if (workspaceFile && workspaceFile.endsWith('.code-workspace')) {
        const guessed = getWorkspaceName().trim();
        if (guessed && guessed !== 'default') return guessed;
    }
    return '';
}

function _getQuestPromptsDir(questId: string): string | null {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot || !questId) return null;
    return WsPaths.ai('quests', questId, 'prompt') || path.join(wsRoot, '_ai', 'quests', questId, 'prompt');
}

function _getProjectPromptScopes(): ScopeItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];

    const projects = scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
    const scopes = projects
        .map(p => ({
            id: encodeURIComponent(p.absolutePath),
            label: p.name,
            dir: path.join(p.absolutePath, 'prompt'),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    if (scopes.length > 0) return scopes;

    // Fallback: walk for prompt/ directories
    const fallback: ScopeItem[] = [];
    const seen = new Set<string>();
    const maxDepth = 6;

    const shouldSkip = (name: string) =>
        name.startsWith('.') || ['node_modules', 'build', 'dist', 'out', '.dart_tool'].includes(name);

    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        if (entries.some(e => e.isDirectory() && e.name === 'prompt')) {
            const relative = path.relative(wsRoot, dir) || '.';
            if (
                relative !== '.' &&
                !relative.startsWith('_ai') &&
                !relative.includes(`${path.sep}_ai${path.sep}`) &&
                !relative.includes(`${path.sep}prompt${path.sep}`)
            ) {
                const key = path.resolve(dir);
                if (!seen.has(key)) {
                    seen.add(key);
                    fallback.push({
                        id: encodeURIComponent(dir),
                        label: _truncatePath(relative),
                        dir: path.join(dir, 'prompt'),
                    });
                }
            }
        }
        for (const e of entries) {
            if (!e.isDirectory() || shouldSkip(e.name)) continue;
            walk(path.join(dir, e.name), depth + 1);
        }
    };
    walk(wsRoot, 0);
    return fallback.sort((a, b) => a.label.localeCompare(b.label));
}

function _getQuestPromptScopes(): ScopeItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];

    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir) || !fs.statSync(questsDir).isDirectory()) return [];

    return fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
            const qid = e.name;
            return {
                id: qid,
                label: qid,
                dir: _getQuestPromptsDir(qid) || path.join(questsDir, qid, 'prompt'),
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
}

function _getScanPromptScopes(): ScopeItem[] {
    const wsRoot = getWorkspaceRoot();
    return _collectAncestorPromptDirs().map(promptDir => {
        const relative = wsRoot ? path.relative(wsRoot, promptDir) : promptDir;
        return { id: encodeURIComponent(promptDir), label: _truncatePath(relative), dir: promptDir };
    });
}

function _collectAncestorPromptDirs(): string[] {
    const wsRoot = getWorkspaceRoot();
    const activeFile = vscode.window.activeTextEditor?.document?.uri.fsPath;
    if (!wsRoot || !activeFile || !activeFile.startsWith(wsRoot)) return [];

    const unique = new Set<string>();
    const result: string[] = [];
    let current = path.dirname(activeFile);
    while (current && current.startsWith(wsRoot)) {
        const promptDir = path.join(current, 'prompt');
        if (fs.existsSync(promptDir) && fs.statSync(promptDir).isDirectory()) {
            const key = path.resolve(promptDir);
            if (!unique.has(key)) { unique.add(key); result.push(promptDir); }
        }
        if (current === wsRoot) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return result;
}

function _truncatePath(fullPath: string, maxLength = 60): string {
    if (fullPath.length <= maxLength) return fullPath;
    const tail = fullPath.slice(fullPath.length - maxLength);
    const sepIdx = tail.indexOf(path.sep);
    return sepIdx > -1 && sepIdx < tail.length - 1 ? `...${tail.slice(sepIdx)}` : `...${tail}`;
}

// ============================================================================
// File listing
// ============================================================================

function _listPromptFiles(dir: string): { id: string; label: string }[] {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.prompt.md'))
        .sort()
        .map(f => ({ id: f, label: f }));
}

function _resolveDir(scope: PromptScope, subScopeId: string): string | null {
    switch (scope) {
        case 'global':
            return _getGlobalPromptsDir();
        case 'project': {
            const scopes = _getProjectPromptScopes();
            const item = scopes.find(s => s.id === subScopeId);
            return item?.dir || null;
        }
        case 'quest': {
            return _getQuestPromptsDir(subScopeId);
        }
        case 'scan': {
            const scopes = _getScanPromptScopes();
            const item = scopes.find(s => s.id === subScopeId);
            return item?.dir || null;
        }
    }
}

// ============================================================================
// Message handling
// ============================================================================

async function _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
        case 'ready':
            _sendAllData();
            break;
        case 'requestData':
            _sendAllData(msg.scope, msg.subScopeId, msg.fileId);
            break;
        case 'selectScope':
            _sendScopeFiles(msg.scope, msg.subScopeId);
            break;
        case 'loadFile':
            _sendFileContent(msg.scope, msg.subScopeId, msg.fileId);
            break;
        case 'save':
            await _saveFile(msg.scope, msg.subScopeId, msg.fileId, msg.content);
            break;
        case 'add':
            await _addFile(msg.scope, msg.subScopeId);
            break;
        case 'delete':
            await _deleteFile(msg.scope, msg.subScopeId, msg.fileId);
            break;
        case 'openInVsCode':
            await _openInVsCode(msg.scope, msg.subScopeId, msg.fileId);
            break;
        case 'openInPreview':
            await _openInPreview(msg.scope, msg.subScopeId, msg.fileId);
            break;
    }
}

function _sendAllData(scope?: string, subScopeId?: string, fileId?: string): void {
    const projectScopes = _getProjectPromptScopes();
    const questScopes = _getQuestPromptScopes();
    const scanScopes = _getScanPromptScopes();
    const preferredQuestId = _getPreferredQuestId();

    // Determine preferred project scope
    let preferredProjectId = projectScopes[0]?.id || '';
    const activeFile = vscode.window.activeTextEditor?.document?.uri.fsPath;
    if (activeFile && projectScopes.length > 0) {
        let best: { id: string; depth: number } | undefined;
        for (const s of projectScopes) {
            const projectDir = decodeURIComponent(s.id);
            if (activeFile.startsWith(projectDir + path.sep) || activeFile === projectDir) {
                const depth = projectDir.split(path.sep).length;
                if (!best || depth > best.depth) best = { id: s.id, depth };
            }
        }
        if (best) preferredProjectId = best.id;
    }

    const globalDir = _getGlobalPromptsDir();

    _panel?.webview.postMessage({
        type: 'allData',
        scopes: {
            global: [{ id: 'global', label: 'Global', dir: globalDir || '' }],
            project: projectScopes.map(s => ({ id: s.id, label: s.label })),
            quest: questScopes.map(s => ({ id: s.id, label: s.label })),
            scan: scanScopes.map(s => ({ id: s.id, label: s.label })),
        },
        files: {
            global: globalDir ? _listPromptFiles(globalDir) : [],
        },
        preferred: {
            scope: scope || 'global',
            project: subScopeId || preferredProjectId,
            quest: subScopeId || preferredQuestId,
            scan: subScopeId || scanScopes[0]?.id || '',
        },
        initialFileId: fileId || '',
    });
}

function _sendScopeFiles(scope: PromptScope, subScopeId: string): void {
    const dir = _resolveDir(scope, subScopeId);
    const files = dir ? _listPromptFiles(dir) : [];
    _panel?.webview.postMessage({ type: 'scopeFiles', scope, subScopeId, files });
}

function _sendFileContent(scope: PromptScope, subScopeId: string, fileId: string): void {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir) {
        _panel?.webview.postMessage({ type: 'fileContent', fileId, content: '' });
        return;
    }
    const filePath = path.join(dir, fileId);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* empty */ }
    _panel?.webview.postMessage({ type: 'fileContent', fileId, content });
}

async function _saveFile(scope: PromptScope, subScopeId: string, fileId: string, content: string): Promise<void> {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir) {
        vscode.window.showWarningMessage('Cannot determine prompt directory for this scope.');
        return;
    }
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, fileId);
    fs.writeFileSync(filePath, content, 'utf-8');
    vscode.window.showInformationMessage(`Saved ${fileId}`);
}

async function _addFile(scope: PromptScope, subScopeId: string): Promise<void> {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir) {
        vscode.window.showWarningMessage('Cannot determine prompt directory for this scope.');
        return;
    }

    let name = await vscode.window.showInputBox({
        prompt: 'New reusable prompt filename',
        placeHolder: 'my_prompt.prompt.md',
        validateInput: (v) => {
            if (!v.trim()) return 'Name is required';
            if (!v.endsWith('.prompt.md')) return 'Must end with .prompt.md';
            return null;
        },
    });
    if (!name) return;
    if (!name.endsWith('.prompt.md')) name += '.prompt.md';

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`File "${name}" already exists.`);
        return;
    }
    fs.writeFileSync(filePath, `# ${name.replace('.prompt.md', '')}\n\n`, 'utf-8');

    // Refresh list with new file selected
    _sendScopeFiles(scope, subScopeId);
    setTimeout(() => {
        _panel?.webview.postMessage({ type: 'selectNewFile', fileId: name });
    }, 100);
}

async function _deleteFile(scope: PromptScope, subScopeId: string, fileId: string): Promise<void> {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir) return;
    const filePath = path.join(dir, fileId);

    const confirm = await vscode.window.showWarningMessage(
        `Delete "${fileId}"?`, { modal: true }, 'Delete',
    );
    if (confirm !== 'Delete') return;

    try { fs.unlinkSync(filePath); } catch { /* ok */ }
    _sendScopeFiles(scope, subScopeId);
    _panel?.webview.postMessage({ type: 'fileDeleted', fileId });
}

async function _openInVsCode(scope: PromptScope, subScopeId: string, fileId: string): Promise<void> {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir) return;
    const filePath = path.join(dir, fileId);
    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage('File not found.');
        return;
    }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function _openInPreview(scope: PromptScope, subScopeId: string, fileId: string): Promise<void> {
    const dir = _resolveDir(scope, subScopeId);
    if (!dir || !_context) return;
    const filePath = path.join(dir, fileId);
    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage('File not found.');
        return;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    await showMarkdownHtmlPreview(_context, {
        title: fileId,
        markdown: content,
        meta: filePath,
    });
}

// ============================================================================
// HTML
// ============================================================================

function _getHtml(codiconsUri: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${codiconsUri}">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    overflow: hidden;
}

/* ── Action bar ── */
.action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.action-bar select {
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    font-size: 13px;
}
.action-bar .spacer { flex: 1; }
.icon-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn .codicon { font-size: 16px; }
.sep { width: 1px; height: 20px; background: var(--vscode-panel-border); margin: 0 4px; }

/* ── Main layout ── */
.main {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ── Vertical splitter ── */
.v-splitter {
    width: 4px;
    cursor: col-resize;
    background: var(--vscode-panel-border);
    flex-shrink: 0;
}
.v-splitter:hover, .v-splitter.dragging { background: var(--vscode-focusBorder); }

/* ── Left list ── */
.file-list {
    width: 260px;
    min-width: 180px;
    border-right: 1px solid var(--vscode-panel-border);
    overflow-y: auto;
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.file-list .item {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-left: 3px solid transparent;
}
.file-list .item:hover { background: var(--vscode-list-hoverBackground); }
.file-list .item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
}
.file-list .empty {
    padding: 16px 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 12px;
}

/* ── Right editor ── */
.editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.editor-area .no-selection {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding-top: 40px;
    text-align: center;
}
.editor-area textarea {
    flex: 1;
    width: 100%;
    border: none;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    padding: 12px 16px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    resize: none;
    outline: none;
    tab-size: 4;
}
.editor-area textarea:focus { border-color: var(--vscode-focusBorder); }
.file-header {
    padding: 6px 16px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBarSectionHeader-background);
    border-bottom: 1px solid var(--vscode-panel-border);
}

.save-bar {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.save-bar button {
    padding: 6px 16px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 13px;
}
.save-bar button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.save-bar button:hover { opacity: 0.9; }
</style>
</head>
<body>

<h2 id="panelHeadline" style="margin:12px 16px 0;font-weight:600;font-size:1.1em;color:var(--vscode-foreground);">Reusable Prompt Editor</h2>

<div class="action-bar">
    <select id="scopeSelect">
        <option value="global">Global</option>
        <option value="project">Project</option>
        <option value="quest">Quest</option>
        <option value="scan">Scan</option>
    </select>
    <select id="subScopeSelect" style="display:none"></select>
    <div class="sep"></div>
    <button class="icon-btn" id="btnAdd" title="Add new prompt file">
        <span class="codicon codicon-new-file"></span>
    </button>
    <button class="icon-btn" id="btnDelete" title="Delete selected file">
        <span class="codicon codicon-trash"></span>
    </button>
    <div class="spacer"></div>
    <button class="icon-btn" id="btnPreview" title="Preview in Markdown viewer">
        <span class="codicon codicon-preview"></span> Preview
    </button>
    <button class="icon-btn" id="btnOpen" title="Open in VS Code editor">
        <span class="codicon codicon-go-to-file"></span> Open
    </button>
</div>

<div class="main">
    <div class="file-list" id="fileList"></div>
    <div class="v-splitter" id="vSplitter"></div>
    <div class="editor-area" id="editorArea">
        <div class="no-selection">Select a prompt file from the left to edit</div>
    </div>
</div>

<div class="save-bar" id="saveBar" style="display:none">
    <button class="primary" id="btnSave">Save</button>
</div>

<script>
const vscode = acquireVsCodeApi();

let scopeData = {};
let currentScope = 'global';
let currentSubScope = 'global';
let currentFileId = '';
let currentFiles = [];
let preferred = {};
let dirty = false;

const scopeSelect = document.getElementById('scopeSelect');
const subScopeSelect = document.getElementById('subScopeSelect');
const fileList = document.getElementById('fileList');
const editorArea = document.getElementById('editorArea');
const saveBar = document.getElementById('saveBar');
const panelHeadline = document.getElementById('panelHeadline');

function updateHeadline() {
    const scopeLabels = { global: 'Global', project: 'Project', quest: 'Quest', scan: 'Scan' };
    const label = scopeLabels[currentScope] || currentScope;
    panelHeadline.textContent = label + ' — Reusable Prompt Editor';
}

scopeSelect.addEventListener('change', () => {
    if (dirty && !confirmDiscard()) { scopeSelect.value = currentScope; return; }
    currentScope = scopeSelect.value;
    dirty = false;
    updateSubScopeSelect();
    updateHeadline();
    requestFiles();
    editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
    saveBar.style.display = 'none';
    currentFileId = '';
});

subScopeSelect.addEventListener('change', () => {
    if (dirty && !confirmDiscard()) { subScopeSelect.value = currentSubScope; return; }
    currentSubScope = subScopeSelect.value;
    dirty = false;
    updateHeadline();
    requestFiles();
    editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
    saveBar.style.display = 'none';
    currentFileId = '';
});

document.getElementById('btnAdd').addEventListener('click', () => {
    vscode.postMessage({ type: 'add', scope: currentScope, subScopeId: getSubScopeId() });
});
document.getElementById('btnDelete').addEventListener('click', () => {
    if (!currentFileId) return;
    vscode.postMessage({ type: 'delete', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
});
document.getElementById('btnSave').addEventListener('click', saveFile);
document.getElementById('btnPreview').addEventListener('click', () => {
    if (!currentFileId) return;
    vscode.postMessage({ type: 'openInPreview', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
});
document.getElementById('btnOpen').addEventListener('click', () => {
    if (!currentFileId) return;
    vscode.postMessage({ type: 'openInVsCode', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
});

// Ctrl/Cmd+S to save
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
    }
});

function getSubScopeId() {
    if (currentScope === 'global') return 'global';
    return currentSubScope;
}

function updateSubScopeSelect() {
    if (currentScope === 'global') {
        subScopeSelect.style.display = 'none';
        currentSubScope = 'global';
        return;
    }
    const items = scopeData[currentScope] || [];
    if (items.length === 0) {
        subScopeSelect.style.display = 'none';
        subScopeSelect.innerHTML = '';
        currentSubScope = '';
        return;
    }
    subScopeSelect.style.display = '';
    const prevId = preferred[currentScope] || items[0]?.id || '';
    subScopeSelect.innerHTML = items.map(s =>
        '<option value="' + escapeAttr(s.id) + '"' + (s.id === prevId ? ' selected' : '') + '>' +
        escapeText(s.label) + '</option>'
    ).join('');
    currentSubScope = prevId || items[0]?.id || '';
}

function requestFiles() {
    vscode.postMessage({ type: 'selectScope', scope: currentScope, subScopeId: getSubScopeId() });
}

function renderFileList(files, selectId) {
    currentFiles = files || [];
    if (currentFiles.length === 0) {
        fileList.innerHTML = '<div class="empty">No .prompt.md files in this scope</div>';
        return;
    }
    fileList.innerHTML = currentFiles.map(f =>
        '<div class="item' + (f.id === (selectId || currentFileId) ? ' selected' : '') +
        '" data-id="' + escapeAttr(f.id) + '">' + escapeText(f.label) + '</div>'
    ).join('');

    fileList.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', () => {
            if (dirty && !confirmDiscard()) return;
            dirty = false;
            currentFileId = el.dataset.id;
            fileList.querySelectorAll('.item').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
        });
    });
}

function renderEditor(fileId, content) {
    editorArea.innerHTML = '<div class="file-header">' + escapeText(fileId) + '</div>' +
        '<textarea id="contentEditor" spellcheck="false">' + escapeText(content) + '</textarea>';
    saveBar.style.display = 'flex';
    dirty = false;
    const ta = document.getElementById('contentEditor');
    ta.addEventListener('input', () => { dirty = true; });
    // Tab support in textarea
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
            ta.selectionStart = ta.selectionEnd = start + 4;
            dirty = true;
        }
    });
}

function saveFile() {
    const ta = document.getElementById('contentEditor');
    if (!ta || !currentFileId) return;
    vscode.postMessage({
        type: 'save',
        scope: currentScope,
        subScopeId: getSubScopeId(),
        fileId: currentFileId,
        content: ta.value,
    });
    dirty = false;
}

function confirmDiscard() { return confirm('Discard unsaved changes?'); }
function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Messages from extension ──
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
        case 'allData': {
            scopeData = msg.scopes;
            preferred = msg.preferred || {};
            const initScope = preferred.scope || 'global';
            scopeSelect.value = initScope;
            currentScope = initScope;
            updateSubScopeSelect();

            // If globalFiles were provided, render them immediately
            if (initScope === 'global' && msg.files?.global) {
                renderFileList(msg.files.global, msg.initialFileId);
                if (msg.initialFileId) {
                    currentFileId = msg.initialFileId;
                    vscode.postMessage({ type: 'loadFile', scope: 'global', subScopeId: 'global', fileId: msg.initialFileId });
                }
            } else {
                requestFiles();
                if (msg.initialFileId) {
                    // Will be selected when scopeFiles arrives
                    currentFileId = msg.initialFileId;
                }
            }
            break;
        }
        case 'scopeFiles':
            renderFileList(msg.files, currentFileId);
            if (currentFileId && msg.files.some(f => f.id === currentFileId)) {
                vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
            }
            break;
        case 'fileContent':
            renderEditor(msg.fileId, msg.content);
            break;
        case 'selectNewFile':
            currentFileId = msg.fileId;
            renderFileList(currentFiles.concat([{ id: msg.fileId, label: msg.fileId }]), msg.fileId);
            vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: msg.fileId });
            break;
        case 'fileDeleted':
            currentFileId = '';
            editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
            saveBar.style.display = 'none';
            dirty = false;
            break;
        case 'selectFile':
            if (msg.scope) { currentScope = msg.scope; scopeSelect.value = msg.scope; updateSubScopeSelect(); }
            if (msg.subScopeId) { currentSubScope = msg.subScopeId; subScopeSelect.value = msg.subScopeId; }
            if (msg.fileId) { currentFileId = msg.fileId; }
            requestFiles();
            break;
    }
});

vscode.postMessage({ type: 'ready' });

// ── Splitter logic ──
(function() {
    const fileListEl = document.getElementById('fileList');
    const vSplitter = document.getElementById('vSplitter');
    let vDragging = false;
    vSplitter.addEventListener('mousedown', function(e) {
        vDragging = true;
        vSplitter.classList.add('dragging');
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (vDragging) {
            const newWidth = Math.max(150, Math.min(e.clientX, window.innerWidth - 300));
            fileListEl.style.width = newWidth + 'px';
        }
    });
    document.addEventListener('mouseup', function() {
        if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
    });
})();
</script>
</body></html>`;
}
