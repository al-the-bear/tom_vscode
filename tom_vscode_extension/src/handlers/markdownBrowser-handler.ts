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
 *
 * Panel lifecycle:
 *  - `tomAi.openInMdBrowserLive` — reuses a single live-panel singleton so
 *    the live-trail always updates in the same window.
 *  - `tomAi.openInMdBrowser` (context menu) — always creates a NEW panel so
 *    the existing live-trail window (or any other open browser) is never
 *    disturbed.
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
import { resolveWorkspaceDocsDir } from '../utils/workspaceDocsDir.js';
import { debugLog } from '../utils/debugLogger.js';
import { openInExternalApplication } from './handler_shared.js';
import { resolveLink, type ResolvedLink, type LinkContext } from '../utils/linkResolver.js';
import { readMediaText } from '../utils/webviewLoader.js';

// ============================================================================
// Constants
// ============================================================================

const PANEL_VIEW_TYPE = 'tomAi.markdownBrowser';
const PANEL_TITLE = 'MD Browser';
const MAX_HISTORY_ENTRIES = 100;
const PICKER_PREFIX = 'mdBrowser';

/**
 * Polling interval (ms) for the mtime-based fallback that backs up the VS Code
 * file watcher. `createFileSystemWatcher` does not reliably fire for files whose
 * real path resolves OUTSIDE the workspace folders — and the live-trail under
 * `_ai/` is exactly that case (`_ai` is a relative symlink onto a single shared
 * clone, so its target lives outside this workspace folder). The poll guarantees
 * the live-trail keeps tailing even when the native watcher silently detaches.
 */
const FILE_POLL_INTERVAL_MS = 1000;

/** Debug logging toggle for this module. */
let MD_BROWSER_DEBUG = false;

export function setMdBrowserDebug(enabled: boolean): void {
    MD_BROWSER_DEBUG = enabled;
}

/**
 * Webview options shared by the fresh-open and reload-restore paths. Kept in one
 * place so the resource roots a restored panel needs stay identical to a freshly
 * opened one (`retainContextWhenHidden` is a panel-create option, not a webview
 * option, so it is added separately at create time).
 */
function getMdBrowserWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            // Allow reading any workspace file for markdown rendering
            ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || []),
        ],
    };
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
// Per-panel state class
// ============================================================================

/**
 * Encapsulates all mutable state for a single MD Browser WebviewPanel.
 * Multiple instances may be alive simultaneously (e.g. one live-trail panel
 * plus several static browser panels opened from the context menu).
 */
class MdBrowserPanel {
    private readonly _panel: vscode.WebviewPanel;
    private readonly _history: NavigationHistory;
    private readonly _context: vscode.ExtensionContext;
    private _liveMode: boolean;
    private _pendingInitialFile?: string;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _fileWatcherDebounce?: ReturnType<typeof setTimeout>;
    /** mtime-polling fallback for files the native watcher can't see (see FILE_POLL_INTERVAL_MS). */
    private _filePollTimer?: ReturnType<typeof setInterval>;
    /** Last observed mtime of the watched file; drives the poll's change detection. */
    private _lastMtimeMs?: number;
    private readonly _onDisposeCallback: () => void;

    constructor(
        context: vscode.ExtensionContext,
        filePath: string,
        liveMode: boolean,
        onDispose: () => void,
        restorePanel?: vscode.WebviewPanel,
    ) {
        this._context = context;
        this._liveMode = liveMode;
        this._history = new NavigationHistory();
        this._pendingInitialFile = filePath;
        this._onDisposeCallback = onDispose;

        if (restorePanel) {
            // Reload-restore path: adopt the panel VS Code re-created for us.
            // Its webview options must be re-applied (scripts/resource roots are
            // not preserved across a reload) before we paint the HTML.
            this._panel = restorePanel;
            this._panel.webview.options = getMdBrowserWebviewOptions(context);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                PANEL_VIEW_TYPE,
                PANEL_TITLE,
                vscode.ViewColumn.Active,
                {
                    ...getMdBrowserWebviewOptions(context),
                    retainContextWhenHidden: true,
                },
            );
        }

        this._panel.webview.html = buildHtml(this._panel.webview, context);

        this._panel.webview.onDidReceiveMessage(
            (msg) => void this._handleMessage(msg),
            undefined,
            context.subscriptions,
        );

        this._panel.onDidDispose(() => this._onDispose());
    }

    // ---- Public API --------------------------------------------------------

    reveal(): void {
        this._panel.reveal(vscode.ViewColumn.Active);
    }

    /** Upgrade to live mode (never downgrade). */
    upgradeLiveMode(): void {
        this._liveMode = true;
    }

    navigateTo(filePath: string): void {
        this._navigateToFile(filePath, 'other');
    }

    // ---- Lifecycle ---------------------------------------------------------

    private _onDispose(): void {
        this._stopWatching();
        this._onDisposeCallback();
    }

    /** Tear down the native watcher, its debounce, and the poll fallback. */
    private _stopWatching(): void {
        if (this._fileWatcher) {
            this._fileWatcher.dispose();
            this._fileWatcher = undefined;
        }
        if (this._fileWatcherDebounce !== undefined) {
            clearTimeout(this._fileWatcherDebounce);
            this._fileWatcherDebounce = undefined;
        }
        if (this._filePollTimer !== undefined) {
            clearInterval(this._filePollTimer);
            this._filePollTimer = undefined;
        }
    }

    // ---- Navigation --------------------------------------------------------

    private _navigateToFile(filePath: string, group: string, anchor?: string): void {
        try {
            if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] navigateToFile path=${filePath} group=${group} anchor=${anchor || 'none'}`, 'INFO', 'mdBrowser');

            const absPath = resolveFilePath(filePath);
            if (!absPath || !fs.existsSync(absPath)) {
                this._panel.webview.postMessage({ type: 'mdContent', content: '', error: 'File not found: ' + filePath });
                return;
            }

            // If it's not a markdown file, open in editor instead
            if (!absPath.toLowerCase().endsWith('.md')) {
                vscode.window.showTextDocument(vscode.Uri.file(absPath), { viewColumn: vscode.ViewColumn.Beside });
                return;
            }

            this._history.push({ filePath: absPath, group });
            this._sendFileContent(absPath, anchor);
            this._watchCurrentFile(absPath);
            this._sendNavState();
        } catch (err) {
            debugLog(`[MdBrowser] navigateToFile error: ${err}`, 'ERROR', 'mdBrowser');
        }
    }

    private _sendFileContent(absPath: string, anchor?: string): void {
        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            const wsRoot = WsPaths.wsRoot || '';
            const relativePath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);

            this._panel.title = (this._liveMode ? 'MD (live): ' : 'MD: ') + path.basename(absPath);
            this._panel.webview.postMessage({
                type: 'mdContent',
                content,
                filePath: absPath,
                relativePath,
                fileName: path.basename(absPath),
                anchor,
                liveMode: this._liveMode,
            });
        } catch (err) {
            debugLog(`[MdBrowser] sendFileContent error: ${err}`, 'ERROR', 'mdBrowser');
            this._panel.webview.postMessage({ type: 'mdContent', content: '', error: String(err) });
        }
    }

    private _sendNavState(): void {
        this._panel.webview.postMessage({
            type: 'navState',
            canGoBack: this._history.canGoBack,
            canGoForward: this._history.canGoForward,
        });
    }

    private _watchCurrentFile(absPath: string): void {
        try {
            this._stopWatching();

            // Baseline mtime so the poll only fires on genuine changes.
            try { this._lastMtimeMs = fs.statSync(absPath).mtimeMs; } catch { this._lastMtimeMs = undefined; }

            const dir = path.dirname(absPath);
            const name = path.basename(absPath);
            const pattern = new vscode.RelativePattern(dir, name);
            this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
            this._fileWatcher.onDidChange(() => {
                if (this._fileWatcherDebounce !== undefined) {
                    clearTimeout(this._fileWatcherDebounce);
                }
                this._fileWatcherDebounce = setTimeout(() => {
                    this._fileWatcherDebounce = undefined;
                    if (this._history.current?.filePath === absPath) {
                        this._refreshMtimeBaseline(absPath);
                        this._sendFileContent(absPath);
                    }
                }, 200);
            });

            // Poll fallback: the native watcher does not reliably fire for the
            // symlinked `_ai/` live-trail (real path outside the workspace
            // folder), which is the long-standing "live-trail stops updating"
            // bug. A cheap per-second mtime stat guarantees the tail keeps up.
            this._filePollTimer = setInterval(() => {
                try {
                    if (this._history.current?.filePath !== absPath) { return; }
                    const m = fs.statSync(absPath).mtimeMs;
                    if (this._lastMtimeMs === undefined || m > this._lastMtimeMs) {
                        this._lastMtimeMs = m;
                        this._sendFileContent(absPath);
                    }
                } catch { /* file may be mid-write or briefly absent; ignore */ }
            }, FILE_POLL_INTERVAL_MS);
        } catch (err) {
            debugLog(`[MdBrowser] watchCurrentFile error: ${err}`, 'ERROR', 'mdBrowser');
        }
    }

    /** Re-read the watched file's mtime so the poll doesn't double-send after a watcher push. */
    private _refreshMtimeBaseline(absPath: string): void {
        try { this._lastMtimeMs = fs.statSync(absPath).mtimeMs; } catch { /* ignore */ }
    }

    // ---- Document picker helpers -------------------------------------------

    private _sendGroups(): void {
        try {
            const wsRoot = WsPaths.wsRoot;
            if (!wsRoot) return;

            const groups: DocPickerGroup[] = [];
            const projects: { id: string; label: string }[] = [];

            const guidelinesDir = WsPaths.guidelines();
            if (guidelinesDir && fs.existsSync(guidelinesDir)) {
                groups.push({ id: 'global', label: 'Guidelines' });
            }

            // Offer Workspace Docs only when the resolved dir actually holds
            // markdown, so a `doc/` folder that exists only for non-markdown
            // artifacts does not surface an empty group (prefers _doc/ — see
            // resolveWorkspaceDocsDir).
            const wsDocsDir = resolveWorkspaceDocsDir(wsRoot, workspaceDocsProbe());
            if (wsDocsDir && workspaceDocsProbe().hasMarkdown(wsDocsDir)) {
                groups.push({ id: 'workspace', label: 'Workspace Docs' });
            }

            const notesDir = WsPaths.ai('notes');
            if (notesDir && fs.existsSync(notesDir)) {
                groups.push({ id: 'notes', label: 'Notes' });
            }

            const rolesDir = WsPaths.ai('roles');
            if (rolesDir && fs.existsSync(rolesDir)) {
                groups.push({ id: 'roles', label: 'Roles' });
            }

            const questsDir = WsPaths.ai('quests');
            const quests: { id: string; label: string }[] = [];
            if (questsDir && fs.existsSync(questsDir)) {
                groups.push({ id: 'quests', label: 'Quests' });
                const entries = fs.readdirSync(questsDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        quests.push({ id: 'quest:' + entry.name, label: entry.name });
                    }
                }
                quests.sort((a, b) => a.label.localeCompare(b.label));
            }

            const copilotInstr = WsPaths.github('copilot-instructions.md');
            if (copilotInstr && fs.existsSync(copilotInstr)) {
                groups.push({ id: 'copilot-instructions', label: 'Copilot Instructions' });
            }

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

            groups.push({ id: 'other', label: 'Other file:' });

            this._panel.webview.postMessage({
                type: PICKER_PREFIX + 'Groups',
                groups,
                projects,
                quests,
            });
        } catch (err) {
            debugLog(`[MdBrowser] sendGroups error: ${err}`, 'ERROR', 'mdBrowser');
        }
    }

    private _sendFilesForGroup(group: string): void {
        try {
            const dir = resolveGroupDir(group);
            if (!dir || !fs.existsSync(dir)) {
                this._panel.webview.postMessage({ type: PICKER_PREFIX + 'Files', files: [] });
                return;
            }

            const files = listMdFiles(dir);
            this._panel.webview.postMessage({
                type: PICKER_PREFIX + 'Files',
                files,
            });
        } catch (err) {
            debugLog(`[MdBrowser] sendFilesForGroup error: ${err}`, 'ERROR', 'mdBrowser');
        }
    }

    // ---- Special link handling ---------------------------------------------

    private _handleSpecialLink(resolved: ResolvedLink): void {
        switch (resolved.type) {
            case 'issue':
                vscode.window.showInformationMessage(`Issue link: ${resolved.identifier}`);
                break;

            case 'todo':
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
                if (resolved.identifier) {
                    vscode.window.showInformationMessage(`Trail link: ${resolved.identifier}`);
                }
                break;

            case 'quest':
                // Navigate to quest overview within this panel
                if (resolved.filePath) {
                    this._navigateToFile(resolved.filePath, 'other');
                } else if (resolved.identifier) {
                    vscode.commands.executeCommand('tomAi.showQuest', resolved.identifier);
                }
                break;

            case 'test':
                if (resolved.identifier) {
                    const [filePath, testName] = resolved.identifier.split('::');
                    if (testName) {
                        vscode.window.showInformationMessage(`Test link: ${filePath} :: ${testName}`);
                    } else {
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

    // ---- Message handler ---------------------------------------------------

    private async _handleMessage(msg: any): Promise<void> {
        try {
            if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] handleMessage type=${msg?.type}`, 'INFO', 'mdBrowser');

            switch (msg?.type) {
                case 'webviewReady':
                    this._sendGroups();
                    if (this._pendingInitialFile) {
                        this._navigateToFile(this._pendingInitialFile, 'other');
                        this._pendingInitialFile = undefined;
                    }
                    break;

                case PICKER_PREFIX + 'GetGroups':
                    this._sendGroups();
                    break;

                case PICKER_PREFIX + 'GetFiles':
                    this._sendFilesForGroup(String(msg.group || ''));
                    break;

                case PICKER_PREFIX + 'LoadFile': {
                    const group = String(msg.group || '');
                    const file = String(msg.file || '');
                    if (group === 'other') {
                        this._navigateToFile(file, group);
                    } else {
                        const dir = resolveGroupDir(group);
                        if (dir) {
                            this._navigateToFile(path.join(dir, file), group);
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
                        this._panel.webview.postMessage({
                            type: PICKER_PREFIX + 'BrowsedFile',
                            file: relPath,
                        });
                        this._navigateToFile(filePath, 'other');
                    }
                    break;
                }

                case 'goBack': {
                    const back = this._history.goBack();
                    if (back) {
                        this._sendFileContent(back.filePath);
                        this._sendNavState();
                    }
                    break;
                }

                case 'goForward': {
                    const fwd = this._history.goForward();
                    if (fwd) {
                        this._sendFileContent(fwd.filePath);
                        this._sendNavState();
                    }
                    break;
                }

                case 'navigateLink': {
                    const linkHref = String(msg.href || '');
                    const currentFile = this._history.current?.filePath || '';
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
                            this._panel.webview.postMessage({
                                type: 'scrollToAnchor',
                                anchor: resolved.anchor,
                            });
                            break;

                        case 'navigate-md':
                            if (resolved.filePath) {
                                this._navigateToFile(resolved.filePath, 'other');
                            }
                            break;

                        case 'navigate-md-anchor':
                            if (resolved.filePath) {
                                this._navigateToFile(resolved.filePath, 'other', resolved.anchor);
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
                            this._handleSpecialLink(resolved);
                            break;

                        case 'error':
                            vscode.window.showWarningMessage(resolved.error || 'Link could not be resolved');
                            break;
                    }
                    break;
                }

                case 'openInEditor': {
                    const current = this._history.current;
                    if (current && fs.existsSync(current.filePath)) {
                        vscode.window.showTextDocument(
                            vscode.Uri.file(current.filePath),
                            { viewColumn: vscode.ViewColumn.Beside },
                        );
                    }
                    break;
                }

                case 'openExternal': {
                    const current = this._history.current;
                    if (current && fs.existsSync(current.filePath)) {
                        openInExternalApplication(current.filePath);
                    }
                    break;
                }

                case 'reload': {
                    const current = this._history.current;
                    if (current && fs.existsSync(current.filePath)) {
                        this._sendFileContent(current.filePath);
                    } else {
                        this._panel.webview.postMessage({
                            type: 'mdContent', content: '', error: 'No file to reload.',
                        });
                    }
                    break;
                }

                case 'reconnect': {
                    // Re-establish the file watch from scratch (native watcher +
                    // poll fallback) and force a fresh read. This is the recovery
                    // path when the live-trail viewer has detached from the file
                    // (symlinked `_ai/` watcher silently stopped firing).
                    const current = this._history.current;
                    if (current && fs.existsSync(current.filePath)) {
                        this._watchCurrentFile(current.filePath);
                        this._sendFileContent(current.filePath);
                        this._panel.webview.postMessage({
                            type: 'reconnected',
                            filePath: current.filePath,
                            liveMode: this._liveMode,
                        });
                    } else {
                        this._panel.webview.postMessage({
                            type: 'mdContent', content: '', error: 'No file to reconnect.',
                        });
                    }
                    break;
                }
            }
        } catch (err) {
            debugLog(`[MdBrowser] handleMessage error: ${err}`, 'ERROR', 'mdBrowser');
        }
    }
}

// ============================================================================
// Panel singletons
// ============================================================================

/**
 * Live-panel instances keyed by **absolute file path**.
 *
 * The previous implementation was a single module-level instance, which
 * meant the second `openInMdBrowserLive` call (e.g. opening the LocalLLM
 * live trail while the Anthropic live trail was already open) reused
 * the same panel and navigated it away from the first file. With this
 * map, each distinct file gets its own panel — so the user can watch
 * both trails side by side — and reopening the same file just reveals
 * the panel that's already showing it. The dispose callback (passed to
 * the panel constructor) deletes the map entry so a fresh open after a
 * close creates a new panel.
 */
const livePanelInstances = new Map<string, MdBrowserPanel>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the Markdown Browser for a given file.
 *
 * - liveMode: true  → reuses the live-panel singleton (auto-scroll).
 * - liveMode: false (default) → always creates a NEW panel so the caller
 *   never disturbs any existing browser window.
 */
export function openMarkdownBrowser(
    context: vscode.ExtensionContext,
    filePath: string,
    options?: { liveMode?: boolean },
): void {
    try {
        if (MD_BROWSER_DEBUG) debugLog(`[MdBrowser] openMarkdownBrowser file=${filePath} liveMode=${options?.liveMode === true}`, 'INFO', 'mdBrowser');

        if (options?.liveMode === true) {
            // --- Live panel: one panel per file path ---
            // Normalise the key so e.g. trailing-slash quirks or
            // case-insensitive filesystems can't accidentally produce
            // two map entries for the same file.
            const key = path.resolve(filePath);
            const existing = livePanelInstances.get(key);
            if (existing) {
                existing.reveal();
                existing.upgradeLiveMode();
                // Same file already showing — re-issue navigateTo
                // defensively so the panel rebinds its watcher in case
                // the file was deleted + recreated between opens.
                existing.navigateTo(filePath);
                return;
            }
            const fresh = new MdBrowserPanel(context, filePath, true, () => {
                // Only clear the entry if it still points at this
                // panel — guards against a race where the user closes
                // panel A while panel B for the same file was being
                // created (shouldn't happen with our flow, but
                // defensive against a future refactor).
                if (livePanelInstances.get(key) === fresh) {
                    livePanelInstances.delete(key);
                }
            });
            livePanelInstances.set(key, fresh);
        } else {
            // --- Static panel: always open a fresh window ---
            new MdBrowserPanel(context, filePath, false, () => {
                // No singleton to clear — the panel is self-contained.
            });
        }
    } catch (err) {
        debugLog(`[MdBrowser] openMarkdownBrowser error: ${err}`, 'ERROR', 'mdBrowser');
    }
}

/**
 * Register the "@T: Open in MD Browser" command and the live variant.
 */
export function registerMarkdownBrowser(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // Context-menu / palette: always opens a NEW browser window.
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
        // Live variant — opens the panel with liveMode=true so the webview
        // auto-scrolls to the bottom on re-render (unless the user has
        // scrolled up). Intended for the chat panel's "Open Live Trail"
        // button; regular document viewing should use the non-live command.
        vscode.commands.registerCommand('tomAi.openInMdBrowserLive', (uri?: vscode.Uri) => {
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
                openMarkdownBrowser(context, filePath, { liveMode: true });
            } catch (err) {
                debugLog(`[MdBrowser] command error: ${err}`, 'ERROR', 'mdBrowser');
            }
        }),
        // Restore MD Browser panels after a window reload. The webview persists
        // its current file path + live mode via setState (media/markdownBrowser/
        // main.js); we re-adopt the panel here and replay openMarkdownBrowser's
        // wiring so the same file (and, for live trails, the same singleton-map
        // entry + follow-tail behaviour) comes back instead of a blank tab.
        vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
                try {
                    const restoreState = (state || {}) as { filePath?: string; liveMode?: boolean };
                    const filePath = restoreState.filePath;
                    if (!filePath || !fs.existsSync(filePath)) {
                        // Nothing meaningful to restore (panel was empty or the
                        // file is gone) — drop the recreated tab rather than show
                        // a dead browser.
                        panel.dispose();
                        return;
                    }
                    const liveMode = restoreState.liveMode === true;
                    if (liveMode) {
                        const key = path.resolve(filePath);
                        const existing = livePanelInstances.get(key);
                        if (existing) {
                            // A live panel for this file already exists (e.g. the
                            // command re-opened it first) — don't create a second.
                            panel.dispose();
                            return;
                        }
                        const restored = new MdBrowserPanel(context, filePath, true, () => {
                            if (livePanelInstances.get(key) === restored) {
                                livePanelInstances.delete(key);
                            }
                        }, panel);
                        livePanelInstances.set(key, restored);
                    } else {
                        new MdBrowserPanel(context, filePath, false, () => { /* self-contained */ }, panel);
                    }
                } catch (err) {
                    debugLog(`[MdBrowser] deserialize error: ${err}`, 'ERROR', 'mdBrowser');
                    panel.dispose();
                }
            },
        }),
    );
}

// ============================================================================
// Utility / pure functions (no per-panel state)
// ============================================================================

function resolveFilePath(filePath: string): string | undefined {
    try {
        const wsRoot = WsPaths.wsRoot;
        if (!wsRoot) return undefined;

        if (path.isAbsolute(filePath)) {
            return filePath;
        }

        return path.join(wsRoot, filePath);
    } catch {
        return undefined;
    }
}

/**
 * fs-backed probe for {@link resolveWorkspaceDocsDir}. "hasMarkdown" is
 * recursive here because the Markdown Browser lists markdown recursively
 * (see {@link listMdFiles}), so the group's "has docs" test matches its listing.
 */
function workspaceDocsProbe(): { exists(dir: string): boolean; hasMarkdown(dir: string): boolean } {
    return {
        exists: (dir: string) => fs.existsSync(dir),
        hasMarkdown: (dir: string) => fs.existsSync(dir) && listMdFiles(dir).length > 0,
    };
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
        return resolveWorkspaceDocsDir(wsRoot, workspaceDocsProbe()) ?? undefined;
    }
    if (group.startsWith('project:')) {
        return path.join(wsRoot, group.substring('project:'.length), '_copilot_guidelines');
    }
    if (group.startsWith('docproject:')) {
        return path.join(wsRoot, group.substring('docproject:'.length), 'doc');
    }
    if (group.startsWith('quest:')) {
        const questId = group.substring('quest:'.length);
        return WsPaths.ai(`quests/${questId}`) || path.join(wsRoot, '_ai', 'quests', questId);
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

    // This panel COMPOSES the shared documentPicker fragment (HTML/CSS/JS),
    // which is owned elsewhere and consumed by other panels too — so it uses
    // the readMediaText escape hatch (raw media text, no loader rewriting) and
    // substitutes its own {{tokens}} here, rather than loadWebviewHtml.
    const baseUri = webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'markdownBrowser'))
        .toString()
        .replace(/\/$/, '');

    const tokens: Record<string, string> = {
        '{{cspSource}}': webview.cspSource,
        '{{codiconsUri}}': codiconsUri.toString(),
        '{{markedUri}}': markedUri.toString(),
        '{{mermaidUri}}': mermaidUri.toString(),
        '{{baseUri}}': baseUri,
        '{{pickerHtml}}': pickerHtml,
        '{{pickerCss}}': pickerCss,
        '{{pickerScript}}': pickerScript,
    };

    let html = readMediaText('markdownBrowser', 'index.html');
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    return html;
}
