/**
 * Window Status Panel - Explorer sidebar panel showing status of all open VS Code windows.
 *
 * Displays window state files from `_ai/local/` as a flat list of cards.
 * Each card shows the workspace name (first line), active quest, and subsystem
 * statuses with colour coding:
 *   - Orange (#e8a317): prompt sent, waiting for answer
 *   - Green  (#3fb950): answer received
 *
 * Status files are written by the trail creation hooks (writePromptTrail /
 * writeAnswerTrail in chatPanel-handler.ts) and cleaned up on window
 * deactivation or stale-session detection on activation.
 *
 * Uses the same WebviewViewProvider pattern as todoLogPanel-handler.ts.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, reportException } from './handler_shared.js';
import { debugLog } from '../utils/debugLogger.js';
import { WsPaths } from '../utils/workspacePaths.js';
import { loadSendToChatConfig } from '../utils/sendToChatConfig.js';
import { loadWebviewHtml } from '../utils/webviewLoader';

// ============================================================================
// Constants
// ============================================================================

/** View ID registered in package.json */
const WINDOW_STATUS_VIEW_ID = 'tomAi.windowStatus';
const WINDOW_STATUS_TOM_VIEW_ID = 'tomAi.windowStatusTom';

/** File name suffix for window state files */
const WINDOW_STATE_FILE_SUFFIX = '.window-state.json';

/** How often the panel auto-refreshes (ms) */
const AUTO_REFRESH_INTERVAL_MS = 3_000;

// ============================================================================
// Types
// ============================================================================

/** Status of a single subsystem within a window */
export interface SubsystemStatus {
    /** Current status: 'prompt-sent' | 'answer-received' */
    status: 'prompt-sent' | 'answer-received';
    /** Subsystem identifier (e.g. 'copilot', 'localLlm', 'aiConversation') */
    subsystem: string;
    /** ISO timestamp when the prompt was sent */
    promptStartedAt: string;
    /** ISO timestamp when the last answer was received (empty if waiting) */
    lastAnswerAt: string;
}

/** Full window state persisted to disk */
export interface WindowStateFile {
    /** Unique window identifier: sessionId(8)_machineId(8) */
    windowId: string;
    /** Workspace name or folder label */
    workspace: string;
    /** Active quest ID, or empty string */
    activeQuest: string;
    /** Per-subsystem statuses */
    status: SubsystemStatus[];
    /** Whether AI conversation is currently active in this window. */
    aiConversationActive?: boolean;
}

// ============================================================================
// Singleton accessor
// ============================================================================

let windowStatusProviderInstance: WindowStatusViewProvider | undefined;

export function setWindowStatusProvider(p: WindowStatusViewProvider): void {
    windowStatusProviderInstance = p;
}

export function getWindowStatusProvider(): WindowStatusViewProvider | undefined {
    return windowStatusProviderInstance;
}

// ============================================================================
// Provider
// ============================================================================

export class WindowStatusViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _watcher?: vscode.FileSystemWatcher;
    private _refreshTimer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
    ) {}

    // ──────────────────────────────────────────────────────────────────────
    // WebviewViewProvider
    // ──────────────────────────────────────────────────────────────────────

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            undefined,
            this._context.subscriptions,
        );

        // File watcher on _ai/local/ folder
        this._setupWatcher();

        // Periodic auto-refresh
        this._startAutoRefresh();

        webviewView.onDidDispose(() => {
            this._view = undefined;
            this._disposeWatcher();
            this._stopAutoRefresh();
        });
    }

    /** Trigger a refresh of the panel contents. */
    public refresh(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'refresh' });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // File watcher
    // ──────────────────────────────────────────────────────────────────────

    private _setupWatcher(): void {
        try {
            this._disposeWatcher();
            const folder = getLocalFolder();
            if (!folder || !fs.existsSync(folder)) { return; }

            const pattern = new vscode.RelativePattern(folder, `*${WINDOW_STATE_FILE_SUFFIX}`);
            this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

            const scheduleRefresh = debounce(() => this.refresh(), 500);
            this._watcher.onDidCreate(() => scheduleRefresh());
            this._watcher.onDidChange(() => scheduleRefresh());
            this._watcher.onDidDelete(() => scheduleRefresh());
        } catch (error) {
            reportException('windowStatusPanel._setupWatcher', error);
        }
    }

    private _disposeWatcher(): void {
        if (this._watcher) {
            this._watcher.dispose();
            this._watcher = undefined;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Auto-refresh timer
    // ──────────────────────────────────────────────────────────────────────

    private _startAutoRefresh(): void {
        this._stopAutoRefresh();
        this._refreshTimer = setInterval(() => this.refresh(), AUTO_REFRESH_INTERVAL_MS);
    }

    private _stopAutoRefresh(): void {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = undefined;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Message handling (from webview)
    // ──────────────────────────────────────────────────────────────────────

    private async _handleMessage(msg: any): Promise<void> {
        try {
            switch (msg.type) {
                case 'loadWindowStates': {
                    const states = loadAllWindowStates();
                    this._view?.webview.postMessage({ type: 'windowStates', states });
                    break;
                }
                case 'deleteWindowState': {
                    const windowId = String(msg.windowId || '');
                    if (windowId) {
                        deleteWindowStateFile(windowId);
                        this.refresh();
                    }
                    break;
                }
            }
        } catch (error) {
            reportException('windowStatusPanel._handleMessage', error, { msgType: msg?.type });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // HTML
    // ──────────────────────────────────────────────────────────────────────

    private _getHtml(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
        );
        return loadWebviewHtml(webview, 'windowStatusPanel', {
            init: { codiconsUri: codiconsUri.toString() },
        });
    }
}

// ============================================================================
// File I/O — window state files
// ============================================================================

/**
 * Get the local folder path for window state files.
 * Reads from config `windowStatus.localFolder` (supports ${ai} token),
 * falls back to `${ai}/local`.
 * Creates the directory if it does not exist.
 */
export function getLocalFolder(): string | undefined {
    let folder: string | undefined;

    // Check config for custom folder path
    try {
        const config = loadSendToChatConfig();
        const configuredPath = config?.windowStatus?.localFolder;
        if (configuredPath) {
            const wsRoot = getWorkspaceRoot();
            if (wsRoot) {
                // Resolve ${ai} token
                const aiFolder = WsPaths.aiFolder;
                const resolved = configuredPath.replace(/\$\{ai\}/g, path.join(wsRoot, aiFolder));
                folder = path.isAbsolute(resolved) ? resolved : path.join(wsRoot, resolved);
            }
        }
    } catch (error) {
        debugLog(`[WindowStatus] Failed to read config for localFolder: ${error}`, 'WARN', 'windowStatus');
    }

    // Fallback to WsPaths.ai('local')
    if (!folder) {
        folder = WsPaths.ai('local');
    }
    if (!folder) { return undefined; }

    try {
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }
    } catch (error) {
        reportException('windowStatusPanel.getLocalFolder', error);
    }
    return folder;
}

/**
 * Build the file path for a given window ID.
 */
function stateFilePath(windowId: string): string | undefined {
    const folder = getLocalFolder();
    if (!folder) { return undefined; }
    return path.join(folder, `${windowId}${WINDOW_STATE_FILE_SUFFIX}`);
}

/**
 * Read a single window state file. Returns undefined on any error.
 */
function readWindowStateFile(filePath: string): WindowStateFile | undefined {
    try {
        if (!fs.existsSync(filePath)) { return undefined; }
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as WindowStateFile;
    } catch (error) {
        debugLog(`[WindowStatus] Failed to read state file ${filePath}: ${error}`, 'WARN', 'windowStatus');
        return undefined;
    }
}

/**
 * Load all window state files from _ai/local/, sorted by quest name.
 */
export function loadAllWindowStates(): WindowStateFile[] {
    try {
        const folder = getLocalFolder();
        if (!folder || !fs.existsSync(folder)) { return []; }

        const files = fs.readdirSync(folder)
            .filter(f => f.endsWith(WINDOW_STATE_FILE_SUFFIX));

        const states: WindowStateFile[] = [];
        for (const file of files) {
            const state = readWindowStateFile(path.join(folder, file));
            if (state) { states.push(state); }
        }

        // Sort by quest name (ascending), then workspace name
        states.sort((a, b) => {
            const questCmp = (a.activeQuest || '').localeCompare(b.activeQuest || '');
            if (questCmp !== 0) { return questCmp; }
            return (a.workspace || '').localeCompare(b.workspace || '');
        });

        return states;
    } catch (error) {
        reportException('windowStatusPanel.loadAllWindowStates', error);
        return [];
    }
}

/**
 * Write or update the window state file for the current window.
 * Creates the file if it doesn't exist, or merges the subsystem status.
 */
export function writeWindowState(
    windowId: string,
    workspace: string,
    activeQuest: string,
    subsystem: string,
    status: 'prompt-sent' | 'answer-received',
): void {
    try {
        const filePath = stateFilePath(windowId);
        if (!filePath) {
            debugLog('[WindowStatus] Cannot write state — no local folder', 'WARN', 'windowStatus');
            return;
        }

        // Read existing state or create new
        let state: WindowStateFile;
        if (fs.existsSync(filePath)) {
            const existing = readWindowStateFile(filePath);
            state = existing || {
                windowId,
                workspace,
                activeQuest,
                status: [],
                aiConversationActive: false,
            };
        } else {
            state = {
                windowId,
                workspace,
                activeQuest,
                status: [],
                aiConversationActive: false,
            };
        }

        // Always update top-level fields to latest values
        state.workspace = workspace;
        state.activeQuest = activeQuest;

        // Find or create subsystem entry
        const now = new Date().toISOString();
        let sub = state.status.find(s => s.subsystem === subsystem);
        if (!sub) {
            sub = {
                status: status,
                subsystem: subsystem,
                promptStartedAt: '',
                lastAnswerAt: '',
            };
            state.status.push(sub);
        }

        // Update timestamps based on status
        sub.status = status;
        if (status === 'prompt-sent') {
            sub.promptStartedAt = now;
            sub.lastAnswerAt = '';
        } else if (status === 'answer-received') {
            sub.lastAnswerAt = now;
        }

        // Write atomically (write to temp, rename)
        const tempPath = filePath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tempPath, filePath);

        debugLog(`[WindowStatus] Updated state: windowId=${windowId} subsystem=${subsystem} status=${status}`, 'INFO', 'windowStatus');
    } catch (error) {
        reportException('windowStatusPanel.writeWindowState', error, { windowId, subsystem, status });
    }
}

/**
 * Delete the window state file for a given window ID.
 */
export function deleteWindowStateFile(windowId: string): void {
    try {
        const filePath = stateFilePath(windowId);
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            debugLog(`[WindowStatus] Deleted state file for windowId=${windowId}`, 'INFO', 'windowStatus');
        }
    } catch (error) {
        reportException('windowStatusPanel.deleteWindowStateFile', error, { windowId });
    }
}

/**
 * Write AI conversation active/inactive state for a window.
 */
export function writeWindowConversationState(
    windowId: string,
    workspace: string,
    activeQuest: string,
    isActive: boolean,
): void {
    try {
        const filePath = stateFilePath(windowId);
        if (!filePath) {
            debugLog('[WindowStatus] Cannot write AI conversation state — no local folder', 'WARN', 'windowStatus');
            return;
        }

        let state: WindowStateFile;
        if (fs.existsSync(filePath)) {
            const existing = readWindowStateFile(filePath);
            state = existing || {
                windowId,
                workspace,
                activeQuest,
                status: [],
                aiConversationActive: false,
            };
        } else {
            state = {
                windowId,
                workspace,
                activeQuest,
                status: [],
                aiConversationActive: false,
            };
        }

        state.workspace = workspace;
        state.activeQuest = activeQuest;
        state.aiConversationActive = isActive;

        const tempPath = filePath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tempPath, filePath);

        debugLog(`[WindowStatus] Updated AI conversation state: windowId=${windowId} active=${isActive}`, 'INFO', 'windowStatus');
    } catch (error) {
        reportException('windowStatusPanel.writeWindowConversationState', error, { windowId, isActive });
    }
}

/**
 * Delete the current window's state file. Called on deactivation.
 */
export function deleteCurrentWindowState(windowId: string): void {
    deleteWindowStateFile(windowId);
}

/**
 * Cleanup stale window state files from previous sessions.
 * Called on activation — removes files whose windowId does NOT match the current session.
 * Only deletes files older than 24 hours to avoid race conditions with other active windows.
 */
export function cleanupStaleWindowStates(currentWindowId: string): void {
    try {
        const folder = getLocalFolder();
        if (!folder || !fs.existsSync(folder)) { return; }

        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();

        const files = fs.readdirSync(folder)
            .filter(f => f.endsWith(WINDOW_STATE_FILE_SUFFIX));

        for (const file of files) {
            const filePath = path.join(folder, file);
            try {
                const stat = fs.statSync(filePath);
                const ageMs = now - stat.mtimeMs;

                // Skip the current window's file
                const fileWindowId = file.replace(WINDOW_STATE_FILE_SUFFIX, '');
                if (fileWindowId === currentWindowId) { continue; }

                // Only remove files older than 24h
                if (ageMs > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    debugLog(`[WindowStatus] Cleaned up stale state: ${file} (age=${Math.round(ageMs / 3600000)}h)`, 'INFO', 'windowStatus');
                }
            } catch (innerError) {
                debugLog(`[WindowStatus] Failed to check/cleanup ${file}: ${innerError}`, 'WARN', 'windowStatus');
            }
        }
    } catch (error) {
        reportException('windowStatusPanel.cleanupStaleWindowStates', error);
    }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the Window Status sidebar panel view.
 *
 * @returns Disposable to unregister the view
 */
export function registerWindowStatusView(context: vscode.ExtensionContext): vscode.Disposable {
    const explorerProvider = new WindowStatusViewProvider(context.extensionUri, context);
    const tomProvider = new WindowStatusViewProvider(context.extensionUri, context);
    setWindowStatusProvider(explorerProvider);
    const explorerRegistration = vscode.window.registerWebviewViewProvider(WINDOW_STATUS_VIEW_ID, explorerProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
    const tomRegistration = vscode.window.registerWebviewViewProvider(WINDOW_STATUS_TOM_VIEW_ID, tomProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
    return vscode.Disposable.from(explorerRegistration, tomRegistration);
}

// ============================================================================
// Helpers
// ============================================================================

function debounce(fn: () => void, delayMs: number): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(() => { timer = undefined; fn(); }, delayMs);
    };
}
