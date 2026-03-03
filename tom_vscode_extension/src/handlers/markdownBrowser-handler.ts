/**
 * Markdown Browser — Custom editor for browsing *.md files with rendered preview.
 *
 * Features:
 *  - Context-menu entry "@T: Open in MD Browser" for *.md files
 *  - Action bar with shared document picker (with "Other file:" support)
 *  - Back/forward navigation history (up to 100 entries)
 *  - Clickable links to other *.md documents (navigate in-browser)
 *  - Links to non-*.md files open in editor
 *  - Rendered markdown via marked.js + mermaid.js
 *
 * Opens as a WebviewPanel (not tied to a specific document) so it can
 * navigate freely between files.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    getDocumentPickerHtml,
    getDocumentPickerCss,
    getDocumentPickerScript,
    type DocPickerGroup,
} from './documentPicker.js';
import { WsPaths } from '../utils/workspacePaths.js';
import { debugLog } from '../utils/debugLogger.js';
import { openInExternalApplication } from './handler_shared.js';
import { resolveLink, type ResolvedLink, type LinkContext } from '../utils/linkResolver.js';

// ============================================================================
// Constants
// ============================================================================

const PANEL_VIEW_TYPE = 'tomAi.markdownBrowser';
const PANEL_TITLE = 'MD Browser';
const MAX_HISTORY_ENTRIES = 100;
const PICKER_PREFIX = 'mdBrowser';

/** Debug logging toggle for this module. */
let MD_BROWSER_DEBUG = false;

export function setMdBrowserDebug(enabled: boolean): void {
    MD_BROWSER_DEBUG = enabled;
}

// ============================================================================
// History
// ============================================================================

interface HistoryEntry {
    filePath: string;
    group: string;
}

/** Per-panel navigation history. */
class NavigationHistory {
    private _entries: HistoryEntry[] = [];
    private _currentIndex = -1;

    get canGoBack(): boolean { return this._currentIndex > 0; }
    get canGoForward(): boolean { return this._currentIndex < this._entries.length - 1; }
    get current(): HistoryEntry | undefined { return this._entries[this._currentIndex]; }

    /**
     * Navigate to a new document. Truncates forward history and appends.
     */
    push(entry: HistoryEntry): void {
        // If we're not at the end, truncate forward entries
        if (this._currentIndex < this._entries.length - 1) {
            this._entries = this._entries.slice(0, this._currentIndex + 1);
        }
        this._entries.push(entry);
        // Enforce max entries
        if (this._entries.length > MAX_HISTORY_ENTRIES) {
            this._entries.shift();
        }
        this._currentIndex = this._entries.length - 1;
    }

    goBack(): HistoryEntry | undefined {
        if (!this.canGoBack) return undefined;
        this._currentIndex--;
        return this._entries[this._currentIndex];
    }

    goForward(): HistoryEntry | undefined {
        if (!this.canGoForward) return undefined;
        this._currentIndex++;
        return this._entries[this._currentIndex];
    }
}

// ============================================================================
// Panel Singleton
// ============================================================================

let activePanel: vscode.WebviewPanel | undefined;
let activePanelHistory: NavigationHistory | undefined;
let activePanelContext: vscode.ExtensionContext | undefined;

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the Markdown Browser for a given file.
 * If the browser is already open, navigates to the file.
 */
export function openMarkdownBrowser(
    context: vscode.ExtensionContext,
    filePath: string,
): void {
    try {
        if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] openMarkdownBrowser file=${filePath}`, 'INFO', 'mdBrowser');

        if (activePanel) {
            // Reuse existing panel — navigate to new file
            activePanel.reveal(vscode.ViewColumn.Active);
            navigateToFile(filePath, 'other');
            return;
        }

        activePanelContext = context;
        activePanelHistory = new NavigationHistory();

        activePanel = vscode.window.createWebviewPanel(
            PANEL_VIEW_TYPE,
            PANEL_TITLE,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib'),
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist'),
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                    // Allow reading any workspace file for markdown rendering
                    ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || []),
                ],
            },
        );

        activePanel.webview.html = buildHtml(activePanel.webview, context);

        activePanel.webview.onDidReceiveMessage(
            (msg) => handleMessage(msg),
            undefined,
            context.subscriptions,
        );

        activePanel.onDidDispose(() => {
            activePanel = undefined;
            activePanelHistory = undefined;
            activePanelContext = undefined;
        });

        // Navigate to the initial file after a short delay for webview init
        setTimeout(() => {
            navigateToFile(filePath, 'other');
            sendGroups();
        }, 100);

    } catch (err) {
        debugLog(`[MdBrowser] openMarkdownBrowser error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

/**
 * Register the "@T: Open in MD Browser" command.
 */
export function registerMarkdownBrowser(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.openInMdBrowser', (uri?: vscode.Uri) => {
            try {
                let filePath: string | undefined;
                if (uri) {
                    filePath = uri.fsPath;
                } else {
                    filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
                }
                if (!filePath || !filePath.endsWith('.md')) {
                    vscode.window.showWarningMessage('Please select a markdown (.md) file.');
                    return;
                }
                openMarkdownBrowser(context, filePath);
            } catch (err) {
                debugLog(`[MdBrowser] command error: ${err}`, 'ERROR', 'mdBrowser');
            }
        }),
    );
}

// ============================================================================
// Navigation
// ============================================================================

function navigateToFile(filePath: string, group: string, anchor?: string): void {
    try {
        if (!activePanel || !activePanelHistory) return;
        if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] navigateToFile path=${filePath} group=${group} anchor=${anchor || 'none'}`, 'INFO', 'mdBrowser');

        const absPath = resolveFilePath(filePath);
        if (!absPath || !fs.existsSync(absPath)) {
            activePanel.webview.postMessage({ type: 'mdContent', content: '', error: 'File not found: ' + filePath });
            return;
        }

        // If it's not a markdown file, open in editor instead
        if (!absPath.toLowerCase().endsWith('.md')) {
            vscode.window.showTextDocument(vscode.Uri.file(absPath), { viewColumn: vscode.ViewColumn.Beside });
            return;
        }

        activePanelHistory.push({ filePath: absPath, group });
        sendFileContent(absPath, anchor);
        sendNavState();
    } catch (err) {
        debugLog(`[MdBrowser] navigateToFile error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

function sendFileContent(absPath: string, anchor?: string): void {
    try {
        if (!activePanel) return;
        const content = fs.readFileSync(absPath, 'utf-8');
        const wsRoot = WsPaths.wsRoot || '';
        const relativePath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);

        activePanel.title = 'MD: ' + path.basename(absPath);
        activePanel.webview.postMessage({
            type: 'mdContent',
            content,
            filePath: absPath,
            relativePath,
            fileName: path.basename(absPath),
            anchor,  // Pass anchor for scrolling after render
        });
    } catch (err) {
        debugLog(`[MdBrowser] sendFileContent error: ${err}`, 'ERROR', 'mdBrowser');
        activePanel?.webview.postMessage({ type: 'mdContent', content: '', error: String(err) });
    }
}

function sendNavState(): void {
    if (!activePanel || !activePanelHistory) return;
    activePanel.webview.postMessage({
        type: 'navState',
        canGoBack: activePanelHistory.canGoBack,
        canGoForward: activePanelHistory.canGoForward,
    });
}

function resolveFilePath(filePath: string): string | undefined {
    try {
        const wsRoot = WsPaths.wsRoot;
        if (!wsRoot) return undefined;

        // Absolute path
        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        // Relative to workspace root
        return path.join(wsRoot, filePath);
    } catch {
        return undefined;
    }
}

// ============================================================================
// Document Picker Groups (reuses same categories as @WS Documentation)
// ============================================================================

function sendGroups(): void {
    if (!activePanel) return;
    try {
        const wsRoot = WsPaths.wsRoot;
        if (!wsRoot) return;

        const groups: DocPickerGroup[] = [];
        const projects: { id: string; label: string }[] = [];

        // Guidelines groups
        const guidelinesDir = WsPaths.guidelines();
        if (guidelinesDir && fs.existsSync(guidelinesDir)) {
            groups.push({ id: 'global', label: 'Guidelines' });
        }

        // Documentation groups
        const wsDocDir = path.join(wsRoot, 'doc');
        const wsDocDir2 = path.join(wsRoot, '_doc');
        if (fs.existsSync(wsDocDir) || fs.existsSync(wsDocDir2)) {
            groups.push({ id: 'workspace', label: 'Workspace Docs' });
        }

        // Notes
        const notesDir = WsPaths.ai('notes');
        if (notesDir && fs.existsSync(notesDir)) {
            groups.push({ id: 'notes', label: 'Notes' });
        }

        // Roles
        const rolesDir = WsPaths.ai('roles');
        if (rolesDir && fs.existsSync(rolesDir)) {
            groups.push({ id: 'roles', label: 'Roles' });
        }

        // Quests
        const questsDir = WsPaths.ai('quests');
        if (questsDir && fs.existsSync(questsDir)) {
            groups.push({ id: 'quests', label: 'Quests' });
        }

        // Copilot instructions
        const copilotInstr = WsPaths.github('copilot-instructions.md');
        if (copilotInstr && fs.existsSync(copilotInstr)) {
            groups.push({ id: 'copilot-instructions', label: 'Copilot Instructions' });
        }

        // Detect projects with guidelines or docs
        detectProjects(wsRoot).forEach(proj => {
            const projGuidelinesDir = path.join(wsRoot, proj.relPath, '_copilot_guidelines');
            const projDocDir = path.join(wsRoot, proj.relPath, 'doc');
            if (fs.existsSync(projGuidelinesDir)) {
                projects.push({ id: 'project:' + proj.relPath, label: proj.name + ' (guidelines)' });
            }
            if (fs.existsSync(projDocDir)) {
                projects.push({ id: 'docproject:' + proj.relPath, label: proj.name + ' (docs)' });
            }
        });

        if (projects.length > 0) {
            groups.push({ id: 'project', label: 'Projects' });
        }

        // Other file
        groups.push({ id: 'other', label: 'Other file:' });

        activePanel.webview.postMessage({
            type: PICKER_PREFIX + 'Groups',
            groups,
            projects,
        });
    } catch (err) {
        debugLog(`[MdBrowser] sendGroups error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

function sendFilesForGroup(group: string): void {
    if (!activePanel) return;
    try {
        const dir = resolveGroupDir(group);
        if (!dir || !fs.existsSync(dir)) {
            activePanel.webview.postMessage({ type: PICKER_PREFIX + 'Files', files: [] });
            return;
        }

        const files = listMdFiles(dir);
        activePanel.webview.postMessage({
            type: PICKER_PREFIX + 'Files',
            files,
        });
    } catch (err) {
        debugLog(`[MdBrowser] sendFilesForGroup error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

function resolveGroupDir(group: string): string | undefined {
    const wsRoot = WsPaths.wsRoot;
    if (!wsRoot) return undefined;

    if (group === 'global') return WsPaths.guidelines();
    if (group === 'roles') return WsPaths.ai('roles');
    if (group === 'quests') return WsPaths.ai('quests');
    if (group === 'copilot-instructions') return WsPaths.github();
    if (group === 'notes') return WsPaths.ai('notes');
    if (group === 'workspace') {
        const docDir = path.join(wsRoot, 'doc');
        return fs.existsSync(docDir) ? docDir : path.join(wsRoot, '_doc');
    }
    if (group.startsWith('project:')) {
        return path.join(wsRoot, group.substring('project:'.length), '_copilot_guidelines');
    }
    if (group.startsWith('docproject:')) {
        return path.join(wsRoot, group.substring('docproject:'.length), 'doc');
    }
    return undefined;
}

function listMdFiles(dir: string, prefix = ''): string[] {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
            const relPath = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) {
                results.push(...listMdFiles(path.join(dir, entry.name), relPath));
            } else if (entry.name.endsWith('.md')) {
                results.push(relPath);
            }
        }
        return results.sort();
    } catch {
        return [];
    }
}

/** Detect workspace projects by looking for pubspec.yaml or package.json files. */
function detectProjects(wsRoot: string): Array<{ name: string; relPath: string }> {
    try {
        const results: Array<{ name: string; relPath: string }> = [];
        const seen = new Set<string>();

        const scanDir = (dir: string, depth: number): void => {
            if (depth > 4) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
                    const subDir = path.join(dir, entry.name);
                    const relPath = path.relative(wsRoot, subDir);
                    if (seen.has(relPath)) continue;

                    const hasPubspec = fs.existsSync(path.join(subDir, 'pubspec.yaml'));
                    const hasPackageJson = fs.existsSync(path.join(subDir, 'package.json'));
                    if (hasPubspec || hasPackageJson) {
                        seen.add(relPath);
                        results.push({ name: entry.name, relPath });
                    }
                    scanDir(subDir, depth + 1);
                }
            } catch { /* ignore permission errors */ }
        };

        scanDir(wsRoot, 0);
        return results.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

// ============================================================================
// Special Link Handling
// ============================================================================

/**
 * Handle special link types (issue, todo, trail, quest, test).
 * These are extensible — new types can be added via registerLinkHandler().
 */
function handleSpecialLink(resolved: ResolvedLink): void {
    switch (resolved.type) {
        case 'issue':
            // TODO: Integrate with GitHub/GitLab issue viewer
            vscode.window.showInformationMessage(`Issue link: ${resolved.identifier}`);
            break;

        case 'todo':
            // TODO: Open todo in todo editor
            if (resolved.identifier) {
                const parts = resolved.identifier.split('/');
                if (parts.length >= 2) {
                    const questId = parts[0];
                    const todoId = parts.slice(1).join('/');
                    vscode.commands.executeCommand('tomAi.showTodo', questId, todoId);
                }
            }
            break;

        case 'trail':
            // TODO: Open trail entry in trail viewer
            if (resolved.identifier) {
                vscode.window.showInformationMessage(`Trail link: ${resolved.identifier}`);
            }
            break;

        case 'quest':
            // Navigate to quest overview if resolved, otherwise show quest picker
            if (resolved.filePath) {
                navigateToFile(resolved.filePath, 'other');
            } else if (resolved.identifier) {
                vscode.commands.executeCommand('tomAi.showQuest', resolved.identifier);
            }
            break;

        case 'test':
            // TODO: Run or navigate to test
            if (resolved.identifier) {
                const [filePath, testName] = resolved.identifier.split('::');
                if (testName) {
                    vscode.window.showInformationMessage(`Test link: ${filePath} :: ${testName}`);
                } else {
                    // Just open the test file
                    const wsRoot = WsPaths.wsRoot;
                    if (wsRoot) {
                        const fullPath = path.join(wsRoot, filePath);
                        if (fs.existsSync(fullPath)) {
                            vscode.window.showTextDocument(vscode.Uri.file(fullPath), { viewColumn: vscode.ViewColumn.Beside });
                        }
                    }
                }
            }
            break;

        default:
            if (resolved.identifier) {
                vscode.window.showInformationMessage(`Special link: ${resolved.type}:${resolved.identifier}`);
            }
    }
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    try {
        if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] handleMessage type=${msg?.type}`, 'INFO', 'mdBrowser');

        switch (msg?.type) {
            case PICKER_PREFIX + 'GetGroups':
                sendGroups();
                break;

            case PICKER_PREFIX + 'GetFiles':
                sendFilesForGroup(String(msg.group || ''));
                break;

            case PICKER_PREFIX + 'LoadFile': {
                const group = String(msg.group || '');
                const file = String(msg.file || '');
                if (group === 'other') {
                    navigateToFile(file, group);
                } else {
                    const dir = resolveGroupDir(group);
                    if (dir) {
                        navigateToFile(path.join(dir, file), group);
                    }
                }
                break;
            }

            case PICKER_PREFIX + 'BrowseFile': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'Markdown': ['md'], 'All Files': ['*'] },
                    defaultUri: WsPaths.wsRoot ? vscode.Uri.file(WsPaths.wsRoot) : undefined,
                });
                if (uris && uris.length > 0) {
                    const filePath = uris[0].fsPath;
                    const wsRoot = WsPaths.wsRoot || '';
                    const relPath = wsRoot ? path.relative(wsRoot, filePath) : filePath;
                    activePanel?.webview.postMessage({
                        type: PICKER_PREFIX + 'BrowsedFile',
                        file: relPath,
                    });
                    navigateToFile(filePath, 'other');
                }
                break;
            }

            case 'goBack': {
                if (!activePanelHistory) break;
                const back = activePanelHistory.goBack();
                if (back) {
                    sendFileContent(back.filePath);
                    sendNavState();
                }
                break;
            }

            case 'goForward': {
                if (!activePanelHistory) break;
                const fwd = activePanelHistory.goForward();
                if (fwd) {
                    sendFileContent(fwd.filePath);
                    sendNavState();
                }
                break;
            }

            case 'navigateLink': {
                const linkHref = String(msg.href || '');
                const currentFile = activePanelHistory?.current?.filePath || '';
                if (!linkHref) break;

                const context: LinkContext = {
                    currentFilePath: currentFile,
                    workspaceRoot: WsPaths.wsRoot,
                };

                const resolved = resolveLink(linkHref, context);
                if (MD_BROWSER_DEBUG) {
                    debugLog(`[MdBrowser] resolveLink href=${linkHref} => type=${resolved.type} action=${resolved.action}`, 'INFO', 'mdBrowser');
                }

                switch (resolved.action) {
                    case 'scroll-to-anchor':
                        // Tell webview to scroll to anchor
                        activePanel?.webview.postMessage({
                            type: 'scrollToAnchor',
                            anchor: resolved.anchor,
                        });
                        break;

                    case 'navigate-md':
                        if (resolved.filePath) {
                            navigateToFile(resolved.filePath, 'other');
                        }
                        break;

                    case 'navigate-md-anchor':
                        if (resolved.filePath) {
                            navigateToFile(resolved.filePath, 'other', resolved.anchor);
                        }
                        break;

                    case 'open-in-editor':
                        if (resolved.filePath) {
                            vscode.window.showTextDocument(
                                vscode.Uri.file(resolved.filePath),
                                { viewColumn: vscode.ViewColumn.Beside },
                            );
                        }
                        break;

                    case 'open-in-editor-line':
                        if (resolved.filePath) {
                            const lineNumber = resolved.lineNumber || 1;
                            vscode.window.showTextDocument(
                                vscode.Uri.file(resolved.filePath),
                                {
                                    viewColumn: vscode.ViewColumn.Beside,
                                    selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0),
                                },
                            );
                        }
                        break;

                    case 'open-external':
                        if (resolved.identifier) {
                            vscode.env.openExternal(vscode.Uri.parse(resolved.identifier));
                        }
                        break;

                    case 'run-command':
                        // Handle special link types (issue, todo, trail, quest, test)
                        handleSpecialLink(resolved);
                        break;

                    case 'error':
                        vscode.window.showWarningMessage(resolved.error || 'Link could not be resolved');
                        break;
                }
                break;
            }

            case 'openInEditor': {
                const current = activePanelHistory?.current;
                if (current && fs.existsSync(current.filePath)) {
                    vscode.window.showTextDocument(
                        vscode.Uri.file(current.filePath),
                        { viewColumn: vscode.ViewColumn.Beside },
                    );
                }
                break;
            }

            case 'openExternal': {
                const current = activePanelHistory?.current;
                if (current && fs.existsSync(current.filePath)) {
                    openInExternalApplication(current.filePath);
                }
                break;
            }
        }
    } catch (err) {
        debugLog(`[MdBrowser] handleMessage error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

// ============================================================================
// HTML generation
// ============================================================================

function buildHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const markedUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
    );
    const mermaidUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    );
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
    );

    const pickerHtml = getDocumentPickerHtml({
        idPrefix: PICKER_PREFIX,
        allowOtherFile: true,
        showGroupSelector: true,
        groupLabel: 'Type:',
        fileLabel: 'File:',
    });

    const pickerCss = getDocumentPickerCss();
    const pickerScript = getDocumentPickerScript({
        idPrefix: PICKER_PREFIX,
        allowOtherFile: true,
        showGroupSelector: true,
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:;">
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* ---- Action Bar ---- */
        .action-bar {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            gap: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
            flex-shrink: 0;
        }
        .action-bar .picker-area {
            flex: 1;
            display: flex;
            align-items: center;
        }
        .action-bar .nav-area {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .icon-btn {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 3px 5px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .icon-btn:disabled {
            opacity: 0.3;
            cursor: default;
        }
        .icon-btn:disabled:hover {
            background: none;
        }

        /* ---- File Info Bar ---- */
        .file-info-bar {
            padding: 4px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        .file-info-bar .file-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* ---- Markdown Content Area ---- */
        .content-area {
            flex: 1;
            overflow: auto;
            padding: 14px 18px;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 16px 0 8px; }
        .markdown-body h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
        .markdown-body p { margin: 8px 0; line-height: 1.6; }
        .markdown-body pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow-x: auto; }
        .markdown-body code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
        .markdown-body :not(pre) > code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
        .markdown-body blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 8px 0; padding: 4px 10px; color: var(--vscode-descriptionForeground); }
        .markdown-body table { border-collapse: collapse; width: 100%; margin: 10px 0; }
        .markdown-body th, .markdown-body td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
        .markdown-body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 14px 0; }
        .markdown-body a { color: var(--vscode-textLink-foreground); cursor: pointer; }
        .markdown-body a:hover { text-decoration: underline; }
        .markdown-body img { max-width: 100%; }
        .markdown-body ul, .markdown-body ol { margin: 8px 0; padding-left: 24px; }
        .markdown-body li { margin: 2px 0; line-height: 1.5; }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            gap: 12px;
        }
        .empty-state .codicon { font-size: 48px; }
        .error-state { color: var(--vscode-errorForeground); }

        ${pickerCss}
    </style>
</head>
<body>
    <!-- Action Bar -->
    <div class="action-bar">
        <div class="picker-area">
            ${pickerHtml}
        </div>
        <div class="nav-area">
            <button class="icon-btn" id="openInEditorBtn" title="Open in Editor">
                <span class="codicon codicon-go-to-file"></span>
            </button>
            <button class="icon-btn" id="openExternalBtn" title="Open in External Viewer">
                <span class="codicon codicon-link-external"></span>
            </button>
            <span style="width:1px; height:16px; background:var(--vscode-panel-border); margin:0 2px;"></span>
            <button class="icon-btn" id="backBtn" disabled title="Go Back">
                <span class="codicon codicon-arrow-left"></span>
            </button>
            <button class="icon-btn" id="forwardBtn" disabled title="Go Forward">
                <span class="codicon codicon-arrow-right"></span>
            </button>
        </div>
    </div>

    <!-- File info -->
    <div class="file-info-bar">
        <span class="file-path" id="filePath">No file selected</span>
    </div>

    <!-- Content -->
    <div class="content-area markdown-body" id="contentArea">
        <div class="empty-state">
            <span class="codicon codicon-markdown"></span>
            <div>Select a document to preview</div>
        </div>
    </div>

    <script src="${markedUri}"></script>
    <script src="${mermaidUri}"></script>
    <script>
        var vscode = acquireVsCodeApi();
        var __mdBrowserBooted = false;

        try {
            var backBtn = document.getElementById('backBtn');
            var forwardBtn = document.getElementById('forwardBtn');
            var openInEditorBtn = document.getElementById('openInEditorBtn');
            var openExternalBtn = document.getElementById('openExternalBtn');
            var contentArea = document.getElementById('contentArea');
            var filePathEl = document.getElementById('filePath');

            var currentFilePath = '';

            // ---- Document Picker Script ----
            ${pickerScript}

            // ---- Request groups after picker script init ----
            setTimeout(function() {
                vscode.postMessage({ type: '${PICKER_PREFIX}GetGroups' });
            }, 10);

            // ---- Navigation Buttons ----
            backBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'goBack' });
            });
            forwardBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'goForward' });
            });
            openInEditorBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'openInEditor' });
            });
            openExternalBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'openExternal' });
            });

            // ---- Render Markdown ----
            function renderMarkdown(text) {
                if (typeof marked !== 'undefined' && marked.parse) {
                    return marked.parse(text || '');
                }
                return '<pre>' + escapeHtml(text || '') + '</pre>';
            }

            function escapeHtml(text) {
                var div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            // ---- Anchor Scrolling ----
            function scrollToAnchor(anchor) {
                if (!anchor || !contentArea) return false;
                
                // Try finding element by ID first (standard anchor)
                var target = document.getElementById(anchor);
                
                // If not found, try common heading ID patterns generated by marked.js
                if (!target) {
                    // marked.js generates IDs by lowercasing and replacing spaces/special chars
                    var normalizedAnchor = anchor.toLowerCase().replace(/[^\\w\\s-]/g, '').replace(/\\s+/g, '-');
                    target = document.getElementById(normalizedAnchor);
                }
                
                // Try finding by heading text content
                if (!target) {
                    var headings = contentArea.querySelectorAll('h1, h2, h3, h4, h5, h6');
                    for (var i = 0; i < headings.length; i++) {
                        var h = headings[i];
                        var headingId = h.id || '';
                        var headingText = (h.textContent || '').toLowerCase().replace(/[^\\w\\s-]/g, '').replace(/\\s+/g, '-');
                        if (headingId === anchor || headingText === anchor || headingText === anchor.toLowerCase()) {
                            target = h;
                            break;
                        }
                    }
                }
                
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Add a brief highlight effect
                    target.style.transition = 'background-color 0.3s';
                    target.style.backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground)';
                    setTimeout(function() {
                        target.style.backgroundColor = '';
                    }, 1500);
                    return true;
                }
                return false;
            }

            function initMermaid() {
                if (typeof mermaid === 'undefined' || !contentArea) return;
                try {
                    contentArea.querySelectorAll('pre > code.language-mermaid').forEach(function(codeEl) {
                        var pre = codeEl.parentElement;
                        if (!pre || !pre.parentElement) return;
                        var mermaidDiv = document.createElement('div');
                        mermaidDiv.className = 'mermaid';
                        mermaidDiv.textContent = codeEl.textContent || '';
                        pre.parentElement.replaceChild(mermaidDiv, pre);
                    });
                    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
                    mermaid.run({ nodes: contentArea.querySelectorAll('.mermaid') });
                } catch (err) {
                    console.error('Mermaid render failed', err);
                }
            }

            // ---- Link Click Handling ----
            function interceptLinks() {
                if (!contentArea) return;
                contentArea.querySelectorAll('a[href]').forEach(function(link) {
                    link.addEventListener('click', function(e) {
                        e.preventDefault();
                        var href = link.getAttribute('href') || '';
                        if (!href) return;

                        // Skip external URLs
                        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                            return;
                        }

                        vscode.postMessage({ type: 'navigateLink', href: href });
                    });
                });
            }

            // ---- Message Handling ----
            window.addEventListener('message', function(e) {
                var msg = e.data;
                if (!msg || !msg.type) return;

                if (msg.type === 'mdContent') {
                    if (msg.error) {
                        contentArea.innerHTML = '<div class="empty-state error-state">'
                            + '<span class="codicon codicon-error"></span>'
                            + '<div>' + escapeHtml(msg.error) + '</div>'
                            + '</div>';
                        filePathEl.textContent = 'Error';
                    } else {
                        currentFilePath = msg.filePath || '';
                        filePathEl.textContent = msg.relativePath || msg.fileName || '';
                        contentArea.innerHTML = renderMarkdown(msg.content);
                        initMermaid();
                        interceptLinks();
                        
                        // Handle anchor scrolling after content loads
                        if (msg.anchor) {
                            // Small delay to ensure DOM is ready
                            setTimeout(function() {
                                scrollToAnchor(msg.anchor);
                            }, 50);
                        } else {
                            contentArea.scrollTop = 0;
                        }
                    }
                } else if (msg.type === 'navState') {
                    backBtn.disabled = !msg.canGoBack;
                    forwardBtn.disabled = !msg.canGoForward;
                } else if (msg.type === 'scrollToAnchor') {
                    // Scroll to anchor within current document
                    if (msg.anchor) {
                        scrollToAnchor(msg.anchor);
                    }
                }
            });

            __mdBrowserBooted = true;
        } catch (err) {
            console.error('[MdBrowser] Boot error:', err);
            document.body.innerHTML = '<div style="padding:20px;color:red;">MD Browser failed to initialize: ' + err + '</div>';
        }
    </script>
</body>
</html>`;
}
