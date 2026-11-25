/**
 * TODO Log Panel - Explorer sidebar panel showing trail exchanges that reference TODOs.
 *
 * Displays the answers that carry TODO response values: the turns of this
 * host's compact trail `history/trail.<host>.md` (src/services/hostTrail.ts),
 * labelled with their session, and — OLD PLACE — the answers of the summary
 * *.answers.md files of an older build (the quest's history folder and each
 * session's folder `history/sessions/<session>/`) older than the trail's
 * oldest turn (todoLogTrailSets.ts). Auto-refreshes when the host trail or an
 * .answers.md file changes there.
 *
 * Opening an entry: a host trail turn opens the trail file at its block; an
 * older pair's answer opens in the trail custom editor (trailEditor-handler.ts).
 */

import * as vscode from 'vscode';
import { registerGatedWebviewViewProvider } from './webviewViewGate';
import * as fs from 'fs';
import * as path from 'path';
import {
    discoverTrailSets,
    loadTrailSet,
} from './trailEditor-handler.js';
import { gotoWorkspaceTodo } from './trailViewer-handler.js';
import { WsPaths } from '../utils/workspacePaths';
import { questTrailFolder } from '../utils/questPaths.js';
import { readWorkspaceTodos } from '../managers/questTodoManager.js';
import { parseTodoRef, dedupeTodoRefs, extractTodoRefsFromVariables } from '../utils/todoLogRefs.js';
import { hostTrailTodoEntries, keepOlderPairAnswer, todoLogTrailSets } from '../utils/todoLogTrailSets.js';
import { hostTrailFile, readHostTrail } from '../services/hostTrail.js';
import { hostSlugOf } from '../utils/hostSlug.js';
import { loadWebviewHtml } from '../utils/webviewLoader';

/**
 * The folder the quest's summary trails are in: its `history/` subfolder
 * (questTrailFolder); '' without a workspace or a quest folder.
 */
function getTrailFolder(): string {
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return ''; }
    const questId = WsPaths.getWorkspaceQuestId();
    const questFolder = WsPaths.ai('quests', questId) || path.join(aiRoot, 'quests', questId);
    return fs.existsSync(questFolder) ? questTrailFolder(questFolder) : '';
}

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

        // Watch the host trails and (OLD PLACE) the summary *.answers.md files, the sessions' included
        const pattern = new vscode.RelativePattern(folder, '{trail.*.md,**/*.answers.md}');
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
            case 'openAnswerInTrailEditor': {
                await this._openAnswerInTrailEditor(String(msg.session || ''), String(msg.requestId || ''));
                break;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Data — the host trail and (OLD PLACE) the summary *.answers.md files
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Open the trail editor for the answers file and focus on a specific entry.
     */
    private async _openAnswerInTrailEditor(session: string, requestId: string): Promise<void> {
        const trailFolder = getTrailFolder();
        if (!trailFolder) {
            vscode.window.showWarningMessage('No trail folder found');
            return;
        }

        // A turn of this host's trail: the trail file at the turn's block.
        const trailFile = hostTrailFile(path.dirname(trailFolder), hostSlugOf());
        if (requestId && fs.existsSync(trailFile)) {
            const lines = fs.readFileSync(trailFile, 'utf-8').split('\n');
            const at = lines.findIndex((l) => l.startsWith('<!--tom-trail-turn ') && l.includes(`"id":${JSON.stringify(requestId)}`));
            if (at >= 0) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(trailFile));
                const position = new vscode.Position(at, 0);
                await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
                return;
            }
        }

        const set = todoLogTrailSets(trailFolder, discoverTrailSets).get(session);
        const answersFile = set?.answers;
        if (!answersFile) {
            vscode.window.showWarningMessage('No answers file found for session: ' + session);
            return;
        }

        const answersPath = path.join(set.directory || trailFolder, answersFile);
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
     * Load the TODO-linked answers: this host's trail turns whose answers carry
     * `TODO*` response values, and (OLD PLACE) the `variables:` blocks of the
     * older *.answers.md files' answers the trail does not have.
     *
     * Each ref is deduplicated (a single answer often carries the same TODO
     * twice) and resolved to its todo title so the view can show what the TODO
     * actually was, not just its id.
     */
    private _loadTodoExchanges(): TodoLogEntry[] {
        const folder = getTrailFolder();
        if (!folder || !fs.existsSync(folder)) { return []; }

        const staged: { entry: TodoLogEntry; refs: string[] }[] = [];
        const turns = readHostTrail(path.dirname(folder), hostSlugOf());
        for (const t of hostTrailTodoEntries(turns)) {
            staged.push({
                entry: { id: t.requestId, timestamp: t.timestamp, displayTime: t.timestamp, session: t.session, todoLinks: [] },
                refs: dedupeTodoRefs(t.refs),
            });
        }

        // OLD PLACE: the summary pairs of an older build, for the answers before the host trail's.
        const trailSets = todoLogTrailSets(folder, discoverTrailSets);
        for (const [setName, _set] of trailSets) {
            const entries = loadTrailSet(setName, trailSets);
            for (const entry of entries) {
                if (entry.type !== 'ANSWER') { continue; }
                if (!keepOlderPairAnswer(entry.requestId, entry.timestamp, turns)) { continue; }
                const refs = dedupeTodoRefs(extractTodoRefsFromVariables(entry.variables));
                if (refs.length === 0) { continue; }
                staged.push({
                    entry: {
                        id: entry.requestId,
                        timestamp: entry.timestamp,
                        displayTime: entry.rawTimestamp,
                        session: setName,
                        todoLinks: [],
                    },
                    refs,
                });
            }
        }

        // Resolve titles once (walking the workspace is only worthwhile when
        // there is at least one TODO-linked answer to annotate).
        const titles = staged.length > 0 ? this._buildTodoTitleLookup() : new Map<string, string>();
        const results = staged.map(({ entry, refs }) => {
            entry.todoLinks = refs.map((ref) => {
                const { fileName, id } = parseTodoRef(ref);
                const title = titles.get(ref);
                return { ref, id, fileName, title };
            });
            return entry;
        });

        // Sort by timestamp descending (newest first)
        results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return results;
    }

    /**
     * Build a `${_sourceFile}/${id}` → title lookup over every `*.todo.yaml`
     * file in the workspace. The key matches the qualified TODO ref shape, so a
     * ref resolves to its title with a single map lookup.
     */
    private _buildTodoTitleLookup(): Map<string, string> {
        const lookup = new Map<string, string>();
        try {
            for (const todo of readWorkspaceTodos()) {
                if (todo._sourceFile && todo.id && todo.title) {
                    lookup.set(`${todo._sourceFile}/${todo.id}`, todo.title);
                }
            }
        } catch { /* best-effort: fall back to id-only labels */ }
        return lookup;
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

/** A single TODO reference resolved for display (deduped, title-annotated). */
interface TodoLogLink {
    ref: string;        // full qualified ref <path>/<file>.todo.yaml/<id>
    id: string;         // todo id (final segment)
    fileName: string;   // base name of the .todo.yaml file
    title?: string;     // resolved todo title, when the todo still exists
}

/** A TODO-linked answer entry for display in the TODO Log panel. */
interface TodoLogEntry {
    id: string;             // requestId
    timestamp: string;      // ISO or raw timestamp for sorting
    displayTime: string;    // formatted for display
    session: string;        // the host trail turn's session, or an older pair's trail set name
    todoLinks: TodoLogLink[]; // resolved TODO references (deduped)
}

// ============================================================================
// Helpers
// ============================================================================


// ============================================================================
// Registration
// ============================================================================

export function registerTodoLogView(context: vscode.ExtensionContext): vscode.Disposable {
    const explorerProvider = new TodoLogViewProvider(context.extensionUri, context);
    const tomProvider = new TodoLogViewProvider(context.extensionUri, context);
    setTodoLogProvider(explorerProvider);
    const explorerRegistration = registerGatedWebviewViewProvider(TODO_LOG_VIEW_ID, explorerProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    });
    const tomRegistration = registerGatedWebviewViewProvider(TODO_LOG_TOM_VIEW_ID, tomProvider, {
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
