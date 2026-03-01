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

// ============================================================================
// Constants
// ============================================================================

/** View ID registered in package.json */
const WINDOW_STATUS_VIEW_ID = 'tomAi.windowStatus';

/** File name suffix for window state files */
const WINDOW_STATE_FILE_SUFFIX = '.window-state.json';

/** How often the panel auto-refreshes (ms) */
const AUTO_REFRESH_INTERVAL_MS = 3_000;

/** Colour constants (VS Code compatible hex) */
const COLOUR_PROMPT_SENT = '#e8a317';  // orange
const COLOUR_ANSWER_RECEIVED = '#3fb950';  // green

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

        return '<!DOCTYPE html>\n'
            + '<html lang="en">\n'
            + '<head>\n'
            + '  <meta charset="UTF-8">\n'
            + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            + '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + ' \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src ' + webview.cspSource + ';">\n'
            + '  <link href="' + codiconsUri + '" rel="stylesheet" />\n'
            + '  <title>Window Status</title>\n'
            + '  <style>\n'
            + '    * { box-sizing: border-box; margin: 0; padding: 0; }\n'
            + '    body {\n'
            + '      font-family: var(--vscode-font-family);\n'
            + '      font-size: var(--vscode-font-size);\n'
            + '      color: var(--vscode-foreground);\n'
            + '      background: var(--vscode-sideBar-background);\n'
            + '      height: 100vh;\n'
            + '      overflow-y: auto;\n'
            + '    }\n'
            + '    .window-list {\n'
            + '      padding: 2px 0;\n'
            + '    }\n'
            + '    .window-card {\n'
            + '      padding: 6px 12px;\n'
            + '      border-left: 3px solid transparent;\n'
            + '      border-bottom: 1px solid var(--vscode-panel-border);\n'
            + '    }\n'
            + '    .window-card:hover {\n'
            + '      background: var(--vscode-list-hoverBackground);\n'
            + '    }\n'
            + '    .window-card-header {\n'
            + '      display: flex;\n'
            + '      align-items: center;\n'
            + '      gap: 6px;\n'
            + '    }\n'
            + '    .window-workspace {\n'
            + '      font-size: 11px;\n'
            + '      font-weight: 600;\n'
            + '      flex: 1;\n'
            + '      white-space: nowrap;\n'
            + '      overflow: hidden;\n'
            + '      text-overflow: ellipsis;\n'
            + '    }\n'
            + '    .subsystem-list {\n'
            + '      margin-top: 4px;\n'
            + '      display: flex;\n'
            + '      flex-direction: column;\n'
            + '      gap: 2px;\n'
            + '    }\n'
            + '    .subsystem-item {\n'
            + '      display: flex;\n'
            + '      align-items: center;\n'
            + '      gap: 6px;\n'
            + '      font-size: 10px;\n'
            + '    }\n'
            + '    .status-dot {\n'
            + '      width: 8px;\n'
            + '      height: 8px;\n'
            + '      border-radius: 50%;\n'
            + '      flex-shrink: 0;\n'
            + '    }\n'
            + '    .status-dot.prompt-sent {\n'
            + '      background: ' + COLOUR_PROMPT_SENT + ';\n'
            + '    }\n'
            + '    .status-dot.answer-received {\n'
            + '      background: ' + COLOUR_ANSWER_RECEIVED + ';\n'
            + '    }\n'
            + '    .subsystem-name {\n'
            + '      color: var(--vscode-foreground);\n'
            + '    }\n'
            + '    .subsystem-time {\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      margin-left: auto;\n'
            + '      white-space: nowrap;\n'
            + '    }\n'
            + '    .delete-btn {\n'
            + '      background: none;\n'
            + '      border: none;\n'
            + '      color: var(--vscode-foreground);\n'
            + '      cursor: pointer;\n'
            + '      padding: 2px;\n'
            + '      opacity: 0.5;\n'
            + '      flex-shrink: 0;\n'
            + '    }\n'
            + '    .delete-btn:hover {\n'
            + '      opacity: 1;\n'
            + '      color: var(--vscode-errorForeground);\n'
            + '    }\n'
            + '    .empty-state {\n'
            + '      display: flex;\n'
            + '      flex-direction: column;\n'
            + '      align-items: center;\n'
            + '      justify-content: center;\n'
            + '      padding: 24px 12px;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      text-align: center;\n'
            + '      font-size: 12px;\n'
            + '    }\n'
            + '    .empty-state .codicon {\n'
            + '      font-size: 32px;\n'
            + '      margin-bottom: 8px;\n'
            + '    }\n'
            + '  </style>\n'
            + '</head>\n'
            + '<body>\n'
            + '  <div class="window-list" id="windowList">\n'
            + '    <div class="empty-state">\n'
            + '      <span class="codicon codicon-loading codicon-modifier-spin"></span>\n'
            + '      <div>Loading...</div>\n'
            + '    </div>\n'
            + '  </div>\n'
            + '  <script>\n'
            + '    (function() {\n'
            + '      var vscode = acquireVsCodeApi();\n'
            + '      var states = [];\n'
            + '      var windowList = document.getElementById("windowList");\n'
            + '\n'
            + '      function escapeHtml(text) {\n'
            + '        var div = document.createElement("div");\n'
            + '        div.textContent = text;\n'
            + '        return div.innerHTML;\n'
            + '      }\n'
            + '\n'
            + '      /* Format a relative time string from ISO timestamp */\n'
            + '      function timeAgo(iso) {\n'
            + '        if (!iso) return "";\n'
            + '        var ms = Date.now() - new Date(iso).getTime();\n'
            + '        if (ms < 0) ms = 0;\n'
            + '        var sec = Math.floor(ms / 1000);\n'
            + '        if (sec < 60) return sec + "s ago";\n'
            + '        var min = Math.floor(sec / 60);\n'
            + '        if (min < 60) return min + "m ago";\n'
            + '        var hr = Math.floor(min / 60);\n'
            + '        return hr + "h ago";\n'
            + '      }\n'
            + '\n'
            + '      function renderStates() {\n'
            + '        if (states.length === 0) {\n'
            + '          windowList.innerHTML = \'<div class="empty-state">\'\n'
            + '            + \'<span class="codicon codicon-window"></span>\'\n'
            + '            + \'<div>No active windows.</div>\'\n'
            + '            + \'</div>\';\n'
            + '          return;\n'
            + '        }\n'
            + '        var html = "";\n'
            + '        for (var i = 0; i < states.length; i++) {\n'
            + '          var s = states[i];\n'
            + '          var questLabel = s.activeQuest || s.workspace || "unknown";\n'
            + '          var subsHtml = "";\n'
            + '          if (s.status && s.status.length > 0) {\n'
            + '            for (var j = 0; j < s.status.length; j++) {\n'
            + '              var sub = s.status[j];\n'
            + '              var dotClass = sub.status === "answer-received" ? "answer-received" : "prompt-sent";\n'
            + '              var statusLabel = sub.status === "answer-received" ? "Answer received" : "Prompt sent";\n'
            + '              var ts = sub.status === "answer-received" ? sub.lastAnswerAt : sub.promptStartedAt;\n'
            + '              subsHtml += \'<div class="subsystem-item">\'\n'
            + '                + \'<span class="status-dot \' + dotClass + \'" title="\' + escapeHtml(statusLabel) + \'"></span>\'\n'
            + '                + \'<span class="subsystem-name">\' + escapeHtml(sub.subsystem) + \'</span>\'\n'
            + '                + \'<span class="subsystem-time">\' + escapeHtml(timeAgo(ts)) + \'</span>\'\n'
            + '                + \'</div>\';\n'
            + '            }\n'
            + '          }\n'
            + '          html += \'<div class="window-card">\'\n'
            + '            + \'<div class="window-card-header">\'\n'
            + '            + \'<span class="window-workspace">\' + escapeHtml(questLabel) + \'</span>\'\n'
            + '            + \'<button class="delete-btn" data-windowid="\' + escapeHtml(s.windowId) + \'" title="Remove window status">\'\n'
            + '            + \'<span class="codicon codicon-trash"></span></button>\'\n'
            + '            + \'</div>\'\n'
            + '            + (subsHtml ? \'<div class="subsystem-list">\' + subsHtml + \'</div>\' : \'\')\n'
            + '            + \'</div>\';\n'
            + '        }\n'
            + '        windowList.innerHTML = html;\n'
            + '\n'
            + '        /* Wire up delete buttons */\n'
            + '        var deleteBtns = windowList.querySelectorAll(".delete-btn");\n'
            + '        for (var k = 0; k < deleteBtns.length; k++) {\n'
            + '          deleteBtns[k].addEventListener("click", function(ev) {\n'
            + '            ev.stopPropagation();\n'
            + '            var wid = this.getAttribute("data-windowid");\n'
            + '            if (wid) {\n'
            + '              vscode.postMessage({ type: "deleteWindowState", windowId: wid });\n'
            + '            }\n'
            + '          });\n'
            + '        }\n'
            + '      }\n'
            + '\n'
            + '      window.addEventListener("message", function(event) {\n'
            + '        var msg = event.data;\n'
            + '        if (msg.type === "windowStates") {\n'
            + '          states = msg.states || [];\n'
            + '          renderStates();\n'
            + '        } else if (msg.type === "refresh") {\n'
            + '          vscode.postMessage({ type: "loadWindowStates" });\n'
            + '        }\n'
            + '      });\n'
            + '\n'
            + '      /* Initial load */\n'
            + '      vscode.postMessage({ type: "loadWindowStates" });\n'
            + '    })();\n'
            + '  </script>\n'
            + '</body>\n'
            + '</html>'
            ;
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
            };
        } else {
            state = {
                windowId,
                workspace,
                activeQuest,
                status: [],
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
    const provider = new WindowStatusViewProvider(context.extensionUri, context);
    setWindowStatusProvider(provider);
    return vscode.window.registerWebviewViewProvider(WINDOW_STATUS_VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
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
