/**
 * Custom Editor Provider for *.todo.yaml files.
 *
 * Opens the Quest TODO editor UI when a *.todo.yaml file is opened,
 * pre-selecting the quest and file based on the document path.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import {
    getQuestTodoCss,
    getQuestTodoHtmlFragment,
    getQuestTodoScript,
    handleQuestTodoMessage,
    setupQuestTodoWatcher,
    sendQuestTodoRefresh,
} from './questTodoPanel-handler.js';

const QT_PENDING_SELECT_KEY = 'qt.pendingSelect';

/**
 * Register the custom editor for *.todo.yaml files.
 */
export function registerQuestTodoCustomEditor(context: vscode.ExtensionContext): void {
    const provider = new QuestTodoEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'questTodo.editor',
            provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );
}

class QuestTodoEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const codiconsUri = vscode.Uri.joinPath(
            this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
        );

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };

        const webviewCodiconsUri = webviewPanel.webview.asWebviewUri(codiconsUri);

        // Resolve quest ID and file name from document path
        const { questId, fileName } = _resolveQuestContext(document);
        const pending = this.context.workspaceState.get<{ file?: string; todoId?: string }>(QT_PENDING_SELECT_KEY);
        let initialTodoId = '';
        if (pending?.todoId && pending?.file) {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const rel = wsRoot ? path.relative(wsRoot, document.uri.fsPath).replace(/\\/g, '/') : document.uri.fsPath.replace(/\\/g, '/');
            const target = pending.file.replace(/\\/g, '/').replace(/^\.\//, '');
            if (rel === target) {
                initialTodoId = pending.todoId;
            }
        }

        webviewPanel.webview.html = _buildHtml(
            webviewCodiconsUri.toString(),
            questId,
            fileName,
            initialTodoId,
        );

        // Route messages through the existing handler
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                await handleQuestTodoMessage(message, webviewPanel.webview);
            },
            undefined,
            this.context.subscriptions,
        );

        // File watcher for auto-refresh
        const watcher = setupQuestTodoWatcher(() => {
            sendQuestTodoRefresh(webviewPanel.webview);
        });

        webviewPanel.onDidDispose(() => {
            watcher?.dispose();
        });
    }
}

/**
 * Determine quest ID and file name from a document path.
 *
 * Paths inside `_ai/quests/{questId}/` resolve to that quest + file.
 * Workspace-level files resolve to `__all_workspace__`.
 */
function _resolveQuestContext(document: vscode.TextDocument): { questId: string; fileName: string } {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const rel = wsRoot ? path.relative(wsRoot, document.uri.fsPath) : document.uri.fsPath;

    // Check if it's inside {aiFolder}/quests/{questId}/
    const questRe = new RegExp(`^${WsPaths.aiFolder}[/\\\\]quests[/\\\\]([^/\\\\]+)[/\\\\](.+)$`);
    const questMatch = rel.match(questRe);
    if (questMatch) {
        return { questId: questMatch[1], fileName: questMatch[2] };
    }

    // Workspace-level file
    return { questId: '__all_workspace__', fileName: rel };
}

function _buildHtml(codiconsUri: string, initialQuestId: string, initialFile: string, initialTodoId: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
${getQuestTodoCss()}
</style>
</head>
<body>
${getQuestTodoHtmlFragment()}
<script>
const vscode = acquireVsCodeApi();

// Pre-configured initial state from file path
var _initialQuestId = ${JSON.stringify(initialQuestId)};
var _initialFile = ${JSON.stringify(initialFile)};
var _initialTodoId = ${JSON.stringify(initialTodoId)};

window.addEventListener('message', function(event) { qtHandleMessage(event.data); });

${getQuestTodoScript()}

// After init, override the quest/file selection if initial values are set
(function applyInitialSelection() {
    if (!_initialQuestId) return;
    // Wait for the qtQuests message to populate the dropdown, then override
    var origHandler = qtHandleMessage;
    var patched = false;
    qtHandleMessage = function(msg) {
        origHandler(msg);
        if (!patched && msg.type === 'qtQuests') {
            patched = true;
            qtHandleMessage = origHandler; // restore
            var sel = document.getElementById('qt-quest-select');
            if (sel) {
                // Ensure the option exists
                var found = false;
                for (var i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === _initialQuestId) { found = true; break; }
                }
                if (found) {
                    sel.value = _initialQuestId;
                    qtCurrentQuestId = _initialQuestId;
                }
            }
            // If specific file, wait for file list then select it
            if (_initialFile && _initialQuestId !== '__all_workspace__') {
                var origHandler2 = qtHandleMessage;
                qtHandleMessage = function(msg2) {
                    origHandler2(msg2);
                    if (msg2.type === 'qtFiles') {
                        qtHandleMessage = origHandler2;
                        var fsel = document.getElementById('qt-file-select');
                        if (fsel) {
                            for (var j = 0; j < fsel.options.length; j++) {
                                if (fsel.options[j].value === _initialFile) {
                                    fsel.value = _initialFile;
                                    qtCurrentFile = _initialFile;
                                    vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                                    if (_initialTodoId) {
                                        qtPendingSelectTodoId = _initialTodoId;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                };
            } else if (_initialTodoId) {
                qtPendingSelectTodoId = _initialTodoId;
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile || 'all' });
            }
        }
    };
})();
</script>
</body>
</html>`;
}
