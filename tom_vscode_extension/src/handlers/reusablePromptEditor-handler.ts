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
import { getWorkspaceRoot } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { getWorkspaceName } from '../utils/panelYamlStore';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

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

    const panel = vscode.window.createWebviewPanel(
        'tomAi.reusablePromptEditor',
        'Reusable Prompt Editor',
        vscode.ViewColumn.Active,
        {
            ...getReusablePromptEditorWebviewOptions(context),
            retainContextWhenHidden: true,
        },
    );
    bindReusablePromptEditorPanel(context, panel, options);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getReusablePromptEditorWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

/**
 * Wire a (freshly-created or reload-restored) Reusable Prompt editor panel:
 * install the message handler, paint the HTML, and push scope/file data. Both
 * `openReusablePromptEditor` and the reload serializer call this so the wiring
 * lives in one place. `options` carries the scope/sub-scope/file to pre-select —
 * on restore it comes from the webview's persisted `setState`, so the editor
 * re-opens the same prompt the user was last editing.
 */
function bindReusablePromptEditorPanel(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    options?: { scope?: PromptScope; subScopeId?: string; fileId?: string },
): void {
    _context = context;
    _panel = panel;

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );
    const webviewCodiconsUri = panel.webview.asWebviewUri(codiconsUri);

    panel.webview.onDidReceiveMessage(
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );
    wireCompletionMessages(panel.webview);

    panel.webview.html = _getHtml(panel.webview, webviewCodiconsUri.toString());

    panel.onDidDispose(() => { _panel = undefined; });

    setTimeout(() => {
        _sendAllData(options?.scope, options?.subScopeId, options?.fileId);
    }, 100);
}

export function registerReusablePromptEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.reusablePrompts', (args?: any) => {
            openReusablePromptEditor(ctx, {
                scope: args?.scope,
                subScopeId: args?.subScopeId,
                fileId: args?.fileId,
            });
        }),
    );
    // Restore the panel after a window reload. Singleton; the webview persists
    // its selected {scope, subScopeId, fileId} via setState, so the deserialize
    // path re-opens the same prompt the user was editing. Without the serializer
    // the tab silently vanishes on reload.
    ctx.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('tomAi.reusablePromptEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                const context = _context ?? ctx;
                panel.webview.options = getReusablePromptEditorWebviewOptions(context);
                bindReusablePromptEditorPanel(context, panel, {
                    scope: state?.scope,
                    subScopeId: state?.subScopeId,
                    fileId: state?.fileId,
                });
            },
        }),
    );
}

// ============================================================================
// Scope resolution (adapted from chatPanel-handler.ts)
// ============================================================================

function _getGlobalPromptsDir(): string | null {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return null;
    return WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
}

function _getActiveQuestId(): string {
    try {
        return ChatVariablesStore.instance.quest.trim();
    } catch {
        return '';
    }
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
    return _collectAllPromptDirs().map(promptDir => {
        const relative = wsRoot ? path.relative(wsRoot, promptDir) : promptDir;
        return { id: encodeURIComponent(promptDir), label: _truncatePath(relative), dir: promptDir };
    });
}

/**
 * Walk the entire workspace tree (up to depth 6) and collect every
 * `prompt/` directory. Unlike the former ancestor-walk approach this
 * does not depend on the active text editor, so it works from webview
 * panels and custom editors too.
 */
function _collectAllPromptDirs(): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const maxDepth = 6;
    const shouldSkip = (name: string) =>
        name.startsWith('.') || ['node_modules', 'build', 'dist', 'out', '.dart_tool'].includes(name);

    const unique = new Set<string>();
    const result: string[] = [];

    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            if (!entry.isDirectory() || shouldSkip(entry.name)) continue;
            const childDir = path.join(dir, entry.name);
            if (entry.name === 'prompt') {
                const key = path.resolve(childDir);
                if (!unique.has(key)) { unique.add(key); result.push(childDir); }
                // Don't recurse into prompt/ itself
            } else {
                walk(childDir, depth + 1);
            }
        }
    };
    walk(wsRoot, 0);
    return result.sort();
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

function _getHtml(webview: vscode.Webview, codiconsUri: string): string {
    return loadWebviewHtml(webview, 'reusablePromptEditor', {
        init: { codiconsUri },
    });
}
