/**
 * Custom Editor Provider for *.todo.yaml files.
 *
 * Opens the Quest TODO editor UI when a *.todo.yaml file is opened,
 * pre-selecting the quest and file based on the document path.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { readMediaText } from '../utils/webviewLoader';
import {
    getQuestTodoCss,
    getQuestTodoHtmlFragment,
    getQuestTodoScript,
    handleQuestTodoMessage,
    setupQuestTodoWatcher,
    sendQuestTodoRefresh,
} from './questTodoPanel-handler.js';

const QT_PENDING_SELECT_KEY = 'tomAi.questTodo.pendingSelect';

/**
 * Register the custom editor for *.todo.yaml files.
 */
export function registerQuestTodoCustomEditor(context: vscode.ExtensionContext): void {
    const provider = new QuestTodoEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'tomAi.todoEditor',
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
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
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
            webviewPanel.webview,
            this.context,
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

/**
 * Compose the custom-editor HTML.
 *
 * This editor COMPOSES the shared Quest TODO panel fragment (CSS / HTML /
 * client script, owned by `media/questTodoPanel/` and consumed by four hosts),
 * so it uses the `readMediaText` escape hatch (raw media text, no loader
 * rewriting) and substitutes its own `{{tokens}}` here — the same pattern as
 * the markdownBrowser (B.21) and issuesPanel (B.19) migrations, not
 * `loadWebviewHtml`. The per-document initial selection is first-paint data and
 * flows via `window.__INIT__` (seeded by `media/questTodoEditor/main.js`).
 */
function _buildHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    codiconsUri: string,
    initialQuestId: string,
    initialFile: string,
    initialTodoId: string,
): string {
    const baseUri = webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'questTodoEditor'))
        .toString()
        .replace(/\/$/, '');

    // First-paint seed for window.__INIT__. Escape `<` so the JSON cannot break
    // out of the inline <script> (mirrors the loader's init handling).
    const initJson = JSON.stringify({ initialQuestId, initialFile, initialTodoId })
        .replace(/</g, '\\u003c');

    const tokens: Record<string, string> = {
        '{{cspSource}}': webview.cspSource,
        '{{codiconsUri}}': codiconsUri,
        '{{baseUri}}': baseUri,
        '{{initJson}}': initJson,
        '{{questTodoCss}}': getQuestTodoCss(),
        '{{questTodoFragment}}': getQuestTodoHtmlFragment(),
        '{{questTodoScript}}': getQuestTodoScript(),
    };

    let html = readMediaText('questTodoEditor', 'index.html');
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    return html;
}
