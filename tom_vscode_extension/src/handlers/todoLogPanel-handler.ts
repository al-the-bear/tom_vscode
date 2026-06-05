/**
 * TODO Log Panel - Explorer sidebar panel showing trail exchanges that reference TODOs.
 * 
 * Displays a list of Copilot answer entries from the combined *.answers.md trail
 * files that contain TODO variable references. Auto-refreshes when .answers.md
 * files change via a file system watcher on the quest/trail folder.
 * 
 * Uses the same *.prompts.md / *.answers.md files as the trail custom editor
 * (trailEditor-handler.ts).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    discoverTrailSets,
    loadTrailSet,
    type TrailEntry,
    type TrailSet,
} from './trailEditor-handler.js';
import { gotoWorkspaceTodo } from './trailViewer-handler.js';
import { getTrailFolder, getCopilotSummaryTrailPaths } from './chatPanel-handler.js';
import { loadWebviewHtml } from '../utils/webviewLoader';

// ============================================================================
// View IDs
// ============================================================================

const TODO_LOG_VIEW_ID = 'tomAi.todoLog';
const TODO_LOG_TOM_VIEW_ID = 'tomAi.todoLogTom';

// ============================================================================
// Provider
// ============================================================================

let todoLogProviderInstance: TodoLogViewProvider | undefined;

export function setTodoLogProvider(p: TodoLogViewProvider): void {
    todoLogProviderInstance = p;
}

export function getTodoLogProvider(): TodoLogViewProvider | undefined {
    return todoLogProviderInstance;
}

export class TodoLogViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _watcher?: vscode.FileSystemWatcher;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
    ) {
    }

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

        // File watcher on trail folder — auto-refresh when new answer files arrive
        this._setupWatcher();

        webviewView.onDidDispose(() => {
            this._view = undefined;
            this._disposeWatcher();
        });
    }

    /** Refresh the panel (called externally when new trail files arrive). */
    public refresh(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'refresh' });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // File watcher
    // ──────────────────────────────────────────────────────────────────────

    private _setupWatcher(): void {
        this._disposeWatcher();
        const folder = getTrailFolder();
        if (!folder || !fs.existsSync(folder)) { return; }

        // Watch for changes to combined *.answers.md trail files
        const pattern = new vscode.RelativePattern(folder, '*.answers.md');
        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

        const scheduleRefresh = debounce(() => this.refresh(), 800);
        this._watcher.onDidCreate(() => scheduleRefresh());
        this._watcher.onDidChange(() => scheduleRefresh());
        this._watcher.onDidDelete(() => scheduleRefresh());
    }

    private _disposeWatcher(): void {
        if (this._watcher) {
            this._watcher.dispose();
            this._watcher = undefined;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Message handling (from webview)
    // ──────────────────────────────────────────────────────────────────────

    private async _handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'loadTodoExchanges': {
                const entries = this._loadTodoExchanges();
                this._view?.webview.postMessage({ type: 'todoExchanges', entries });
                break;
            }
            case 'gotoTodo': {
                await gotoWorkspaceTodo(String(msg.todoRef || ''), this._context);
                break;
            }
            case 'openTrailViewer': {
                await vscode.commands.executeCommand('tomAi.editor.rawTrailViewer');
                break;
            }
            case 'openTrailFiles': {
                await this._openTrailFiles();
                break;
            }
            case 'openAnswerInTrailEditor': {
                await this._openAnswerInTrailEditor(String(msg.session || ''), String(msg.requestId || ''));
                break;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Data — reads combined *.prompts.md / *.answers.md trail files
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Open the trail custom editor (tomAi.trailViewer) for the current workspace's prompts trail file.
     */
    private async _openTrailFiles(): Promise<void> {
        const summaryPaths = getCopilotSummaryTrailPaths();
        if (!summaryPaths) {
            vscode.window.showWarningMessage('No trail folder found');
            return;
        }

        if (!fs.existsSync(summaryPaths.promptsPath)) {
            vscode.window.showInformationMessage('No summary trail exists yet. Send a prompt first.');
            return;
        }

        // Open with the custom trail editor
        const uri = vscode.Uri.file(summaryPaths.promptsPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
    }

    /**
     * Open the trail editor for the answers file and focus on a specific entry.
     */
    private async _openAnswerInTrailEditor(session: string, requestId: string): Promise<void> {
        const trailFolder = getTrailFolder();
        if (!trailFolder) {
            vscode.window.showWarningMessage('No trail folder found');
            return;
        }

        const trailSets = discoverTrailSets(trailFolder);
        const set = trailSets.get(session);
        const answersFile = set?.answers;
        if (!answersFile) {
            vscode.window.showWarningMessage('No answers file found for session: ' + session);
            return;
        }

        const answersPath = path.join(trailFolder, answersFile);
        if (!fs.existsSync(answersPath)) {
            vscode.window.showWarningMessage('Answers file not found: ' + answersFile);
            return;
        }

        // Store pending focus so the trail editor can auto-select this entry
        this._context.workspaceState.update('tomAi.trailEditor.pendingFocus', {
            requestId,
            session,
        });

        const uri = vscode.Uri.file(answersPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
    }

    /**
     * Load TODO-linked answer entries from combined *.answers.md files.
     * Parses the `variables:` metadata block of each ANSWER entry,
     * extracting keys that contain "TODO" (same logic as the trail editor).
     */
    private _loadTodoExchanges(): TodoLogEntry[] {
        const folder = getTrailFolder();
        if (!folder || !fs.existsSync(folder)) { return []; }

        const trailSets = discoverTrailSets(folder);
        for (const set of trailSets.values()) {
            set.directory = folder;
        }
        const results: TodoLogEntry[] = [];

        for (const [setName, _set] of trailSets) {
            const entries = loadTrailSet(setName, trailSets);
            for (const entry of entries) {
                if (entry.type !== 'ANSWER') continue;
                const todoRefs = extractTodoRefsFromVariables(entry.variables);
                if (todoRefs.length > 0) {
                    results.push({
                        id: entry.requestId,
                        timestamp: entry.timestamp,
                        displayTime: entry.rawTimestamp,
                        session: setName,
                        todoRefs,
                    });
                }
            }
        }

        // Sort by timestamp descending (newest first)
        results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return results;
    }

    // ──────────────────────────────────────────────────────────────────────
    // HTML
    // ──────────────────────────────────────────────────────────────────────

    private _getHtml(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
        );
        return loadWebviewHtml(webview, 'todoLogPanel', {
            init: { codiconsUri: codiconsUri.toString() },
        });
    }
}

// ============================================================================
// Types
// ============================================================================

/** A TODO-linked answer entry for display in the TODO Log panel. */
interface TodoLogEntry {
    id: string;           // requestId
    timestamp: string;    // ISO or raw timestamp for sorting
    displayTime: string;  // formatted for display
    session: string;      // trail set name (quest ID)
    todoRefs: string[];   // extracted TODO paths
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract TODO references from an answer entry's `variables` metadata.
 * Variables format (from *.answers.md):
 *   - TODO = _ai/quests/<quest>/<file>.todo.yaml/<todoId>
 *   - TODO2 = ...
 * Keys must contain uppercase "TODO".
 */
function extractTodoRefsFromVariables(variables: string | undefined): string[] {
    if (!variables) return [];
    const refs: string[] = [];
    const lines = variables.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.replace(/^\s*-\s*/, '').trim();
        const eqIdx = line.indexOf('=');
        if (eqIdx < 1) continue;
        const key = line.substring(0, eqIdx).trim();
        if (key.indexOf('TODO') === -1) continue;
        const val = line.substring(eqIdx + 1).trim();
        if (val) refs.push(val);
    }
    return refs;
}

// ============================================================================
// Registration
// ============================================================================

export function registerTodoLogView(context: vscode.ExtensionContext): vscode.Disposable {
    const explorerProvider = new TodoLogViewProvider(context.extensionUri, context);
    const tomProvider = new TodoLogViewProvider(context.extensionUri, context);
    setTodoLogProvider(explorerProvider);
    const explorerRegistration = vscode.window.registerWebviewViewProvider(TODO_LOG_VIEW_ID, explorerProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
    const tomRegistration = vscode.window.registerWebviewViewProvider(TODO_LOG_TOM_VIEW_ID, tomProvider, {
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
