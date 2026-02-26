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
import { getTrailFolder, getTrailFilePrefix } from './unifiedNotepad-handler.js';

// ============================================================================
// View IDs
// ============================================================================

const TODO_LOG_VIEW_ID = 'dartscript.todoLogView';

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
                await vscode.commands.executeCommand('dartscript.openTrailViewer');
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
     * Open the trail custom editor (trailViewer.editor) for the current workspace's prompts trail file.
     */
    private async _openTrailFiles(): Promise<void> {
        const trailFolder = getTrailFolder();
        if (!trailFolder) {
            vscode.window.showWarningMessage('No trail folder found');
            return;
        }

        // Use shared trail file prefix (quest ID when quest workspace is open)
        const prefix = getTrailFilePrefix();
        const promptsPath = path.join(trailFolder, prefix + '.prompts.md');

        // Ensure directory exists
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }

        // Create file if it doesn't exist
        if (!fs.existsSync(promptsPath)) {
            fs.writeFileSync(promptsPath, '# Copilot Prompts Trail\n\n', 'utf-8');
        }

        // Open with the custom trail editor
        const uri = vscode.Uri.file(promptsPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'trailViewer.editor');
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
        this._context.workspaceState.update('trailEditor.pendingFocus', {
            requestId,
            session,
        });

        const uri = vscode.Uri.file(answersPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'trailViewer.editor');
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
        const results: TodoLogEntry[] = [];

        for (const [setName, _set] of trailSets) {
            const entries = loadTrailSet(folder, setName, trailSets);
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

        return '<!DOCTYPE html>\n'
            + '<html lang="en">\n'
            + '<head>\n'
            + '  <meta charset="UTF-8">\n'
            + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            + '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + ' \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src ' + webview.cspSource + ';">\n'
            + '  <link href="' + codiconsUri + '" rel="stylesheet" />\n'
            + '  <title>TODO Log</title>\n'
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
            + '    .header {\n'
            + '      padding: 8px 12px;\n'
            + '      border-bottom: 1px solid var(--vscode-panel-border);\n'
            + '      display: flex;\n'
            + '      align-items: center;\n'
            + '      gap: 8px;\n'
            + '    }\n'
            + '    .header h2 {\n'
            + '      font-size: 11px;\n'
            + '      font-weight: 600;\n'
            + '      flex: 1;\n'
            + '      text-transform: uppercase;\n'
            + '      letter-spacing: 0.5px;\n'
            + '    }\n'
            + '    .header button {\n'
            + '      background: none;\n'
            + '      border: none;\n'
            + '      color: var(--vscode-foreground);\n'
            + '      cursor: pointer;\n'
            + '      padding: 2px;\n'
            + '    }\n'
            + '    .header button:hover {\n'
            + '      color: var(--vscode-textLink-foreground);\n'
            + '    }\n'
            + '    .entry-list {\n'
            + '      padding: 2px 0;\n'
            + '    }\n'
            + '    .entry-item {\n'
            + '      padding: 6px 12px;\n'
            + '      border-left: 3px solid transparent;\n'
            + '      cursor: pointer;\n'
            + '    }\n'
            + '    .entry-item:hover {\n'
            + '      background: var(--vscode-list-hoverBackground);\n'
            + '    }\n'
            + '    .entry-time {\n'
            + '      font-size: 11px;\n'
            + '      font-weight: 600;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '    }\n'
            + '    .entry-session {\n'
            + '      font-size: 10px;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      margin-top: 1px;\n'
            + '      white-space: nowrap;\n'
            + '      overflow: hidden;\n'
            + '      text-overflow: ellipsis;\n'
            + '    }\n'
            + '    .entry-todo-links {\n'
            + '      display: flex;\n'
            + '      flex-wrap: wrap;\n'
            + '      gap: 2px 6px;\n'
            + '      margin-top: 3px;\n'
            + '    }\n'
            + '    .entry-todo-link {\n'
            + '      color: var(--vscode-textLink-foreground);\n'
            + '      cursor: pointer;\n'
            + '      font-size: 11px;\n'
            + '      text-decoration: none;\n'
            + '    }\n'
            + '    .entry-todo-link:hover {\n'
            + '      text-decoration: underline;\n'
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
            + '    .entry-count {\n'
            + '      font-size: 10px;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      font-weight: normal;\n'
            + '    }\n'
            + '  </style>\n'
            + '</head>\n'
            + '<body>\n'
            + '  <div class="header">\n'
            + '    <h2>TODO Log <span class="entry-count" id="entryCount"></span></h2>\n'
            + '    <button id="openTrailFilesBtn" title="Open Trail"><span class="codicon codicon-history"></span></button>\n'
            + '    <button id="openTrailViewerBtn" title="Open Trail Files Viewer"><span class="codicon codicon-list-flat"></span></button>\n'
            + '    <button id="refreshBtn" title="Refresh"><span class="codicon codicon-refresh"></span></button>\n'
            + '  </div>\n'
            + '  <div class="entry-list" id="entryList">\n'
            + '    <div class="empty-state">\n'
            + '      <span class="codicon codicon-loading codicon-modifier-spin"></span>\n'
            + '      <div>Loading...</div>\n'
            + '    </div>\n'
            + '  </div>\n'
            + '  <script>\n'
            + '    (function() {\n'
            + '      var vscode = acquireVsCodeApi();\n'
            + '      var entries = [];\n'
            + '      var entryList = document.getElementById(\'entryList\');\n'
            + '      var entryCount = document.getElementById(\'entryCount\');\n'
            + '      var refreshBtn = document.getElementById(\'refreshBtn\');\n'
            + '      var openTrailFilesBtn = document.getElementById(\'openTrailFilesBtn\');\n'
            + '      var openTrailViewerBtn = document.getElementById(\'openTrailViewerBtn\');\n'
            + '\n'
            + '      function escapeHtml(text) {\n'
            + '        var div = document.createElement(\'div\');\n'
            + '        div.textContent = text;\n'
            + '        return div.innerHTML;\n'
            + '      }\n'
            + '\n'
            + '      function renderEntries() {\n'
            + '        entryCount.textContent = entries.length > 0 ? \'(\' + entries.length + \')\' : \'\';\n'
            + '        if (entries.length === 0) {\n'
            + '          entryList.innerHTML = \'<div class="empty-state">\'  \n'
            + '            + \'<span class="codicon codicon-checklist"></span>\'\n'
            + '            + \'<div>No TODO-linked answers yet.</div>\'  \n'
            + '            + \'</div>\';\n'
            + '          return;\n'
            + '        }\n'
            + '        var html = \'\';\n'
            + '        for (var i = 0; i < entries.length; i++) {\n'
            + '          var e = entries[i];\n'
            + '          var linksHtml = \'\';\n'
            + '          if (e.todoRefs && e.todoRefs.length > 0) {\n'
            + '            var links = \'\';\n'
            + '            for (var j = 0; j < e.todoRefs.length; j++) {\n'
            + '              var ref = e.todoRefs[j];\n'
            + '              var parts = ref.split(\'/\');\n'
            + '              var todoId = parts.length >= 2 ? parts[parts.length - 1] : ref;\n'
            + '              var todoFile = parts.length >= 2 ? parts[parts.length - 2] : \'\';\n'
            + '              var display = todoFile ? todoId + \'@\' + todoFile : todoId;\n'
            + '              var encoded = encodeURIComponent(ref);\n'
            + '              links += \'<a class="entry-todo-link" data-todoref="\' + encoded + \'" title="Open TODO">\'\n'
            + '                + \'<span class="codicon codicon-tasklist" style="margin-right:3px;font-size:11px;vertical-align:middle;"></span>\'\n'
            + '                + escapeHtml(display) + \'</a>\';\n'
            + '            }\n'
            + '            linksHtml = \'<div class="entry-todo-links">\' + links + \'</div>\';\n'
            + '          }\n'
            + '          html += \'<div class="entry-item" data-id="\' + e.id + \'" data-session="\' + escapeHtml(e.session) + \'">\'\n'
            + '            + \'<div class="entry-time">\' + escapeHtml(e.displayTime) + \'</div>\'\n'
            + '            + \'<div class="entry-session">\' + escapeHtml(e.session) + \'</div>\'\n'
            + '            + linksHtml\n'
            + '            + \'</div>\';\n'
            + '        }\n'
            + '        entryList.innerHTML = html;\n'
            + '\n'
            + '        // Wire up entry-item clicks (open trail editor at that answer)\n'
            + '        var itemEls = entryList.querySelectorAll(\'.entry-item\');\n'
            + '        for (var m = 0; m < itemEls.length; m++) {\n'
            + '          itemEls[m].addEventListener(\'click\', (function(el) {\n'
            + '            return function(ev) {\n'
            + '              if (ev.target && ev.target.classList && ev.target.classList.contains(\'entry-todo-link\')) return;\n'
            + '              if (ev.target && ev.target.closest && ev.target.closest(\'.entry-todo-link\')) return;\n'
            + '              var id = el.getAttribute(\'data-id\') || \'\';\n'
            + '              var session = el.getAttribute(\'data-session\') || \'\';\n'
            + '              if (id && session) {\n'
            + '                vscode.postMessage({ type: \'openAnswerInTrailEditor\', session: session, requestId: id });\n'
            + '              }\n'
            + '            };\n'
            + '          })(itemEls[m]));\n'
            + '        }\n'
            + '\n'
            + '        // Wire up TODO link clicks\n'
            + '        var linkEls = entryList.querySelectorAll(\'.entry-todo-link\');\n'
            + '        for (var k = 0; k < linkEls.length; k++) {\n'
            + '          linkEls[k].addEventListener(\'click\', function(ev) {\n'
            + '            ev.stopPropagation();\n'
            + '            ev.preventDefault();\n'
            + '            var todoRef = decodeURIComponent(this.getAttribute(\'data-todoref\') || \'\');\n'
            + '            if (todoRef) {\n'
            + '              vscode.postMessage({ type: \'gotoTodo\', todoRef: todoRef });\n'
            + '            }\n'
            + '          });\n'
            + '        }\n'
            + '      }\n'
            + '\n'
            + '      refreshBtn.addEventListener(\'click\', function() {\n'
            + '        vscode.postMessage({ type: \'loadTodoExchanges\' });\n'
            + '      });\n'
            + '\n'
            + '      openTrailFilesBtn.addEventListener(\'click\', function() {\n'
            + '        vscode.postMessage({ type: \'openTrailFiles\' });\n'
            + '      });\n'
            + '\n'
            + '      openTrailViewerBtn.addEventListener(\'click\', function() {\n'
            + '        vscode.postMessage({ type: \'openTrailViewer\' });\n'
            + '      });\n'
            + '\n'
            + '      window.addEventListener(\'message\', function(event) {\n'
            + '        var msg = event.data;\n'
            + '        if (msg.type === \'todoExchanges\') {\n'
            + '          entries = msg.entries || [];\n'
            + '          renderEntries();\n'
            + '        } else if (msg.type === \'refresh\') {\n'
            + '          vscode.postMessage({ type: \'loadTodoExchanges\' });\n'
            + '        }\n'
            + '      });\n'
            + '\n'
            + '      // Initial load\n'
            + '      vscode.postMessage({ type: \'loadTodoExchanges\' });\n'
            + '    })();\n'
            + '  </script>\n'
            + '</body>\n'
            + '</html>'
            ;
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
    const provider = new TodoLogViewProvider(context.extensionUri, context);
    setTodoLogProvider(provider);
    return vscode.window.registerWebviewViewProvider(TODO_LOG_VIEW_ID, provider, {
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
