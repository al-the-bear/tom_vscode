/**
 * SESSIONS — the @TOM sidebar view listing the active quest's named sessions
 * (above SESSION TODOS): every `<name>.session.json` of the quest's history
 * folder plus the implicit `default` (the prompt queue's) and `chat` (the
 * ANTHROPIC panel's) sessions, with base, lifetime, profile and model,
 * whether each has a conversation yet and when it was last used
 * (src/utils/sessionsViewRows.ts).
 *
 * - Add (title-bar icon, `tomAi.sessions.add`): the session picker's
 *   new-session path; the file is written at once.
 * - Reset (row): forget the conversation — its history (compacted blocks,
 *   rolling tail, accumulator) and its SDK session id — and keep base,
 *   lifetime, profile, its trails and its quest memory.
 * - Delete (row, confirmed, naming what goes): remove the session with its
 *   whole storage — `history/sessions/<name>/` (history, trail pair,
 *   live trail, raw trail, tool results) and its quest memory
 *   (`_ai/memory/<quest>/<name>/`); refused while another session is based on
 *   it. `default` and `chat` have no file: Delete removes their storage only.
 *
 * The view refreshes when
 * this store writes or removes a session file, when the folder changes on
 * disk (another window), and when it becomes visible.
 *
 * View: `tomAi.sessions`. Assets: `media/sessionsView/`.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { clearSessionId, deleteSession, listSessions, onSessionsChanged } from '../services/agentSdkSessionStore';
import { TwoTierMemoryService } from '../services/memory-service';
import { removeSessionStorage } from '../services/sessionStorage';
import { deleteSessionDetail } from '../utils/sessionSelection';
import { AnthropicHandler } from './anthropic-handler';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { sessionRows } from '../utils/sessionsViewRows';
import { WsPaths } from '../utils/workspacePaths';
import { newSessionViaPicker, sessionsFolder } from './sessionPicker';

export const SESSIONS_VIEW_ID = 'tomAi.sessions';
export const ADD_SESSION_COMMAND = 'tomAi.sessions.add';

class SessionsViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private watcher?: fs.FSWatcher;
    private watchedFolder?: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        const unsubscribe = onSessionsChanged(() => this.send());
        context.subscriptions.push({ dispose: () => { unsubscribe(); this.unwatch(); } });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sessionsView', {
            init: {
                codiconsUri: webviewView.webview.asWebviewUri(
                    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
                ).toString(),
            },
        });
        webviewView.webview.onDidReceiveMessage((msg) => void this.handle(msg), undefined, this.context.subscriptions);
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.send(); } });
        webviewView.onDidDispose(() => { this.unwatch(); this.view = undefined; });
    }

    /** Re-read the folder and post the rows; (re)watch the active quest's folder. */
    send(): void {
        if (!this.view) { return; }
        const quest = WsPaths.getWorkspaceQuestId();
        if (!quest) {
            void this.view.webview.postMessage({ type: 'state', quest: '', rows: [] });
            return;
        }
        const folder = sessionsFolder(quest);
        this.watch(folder);
        let rows: ReturnType<typeof sessionRows> = [];
        try { rows = sessionRows(listSessions(folder)); } catch { /* an unreadable folder lists nothing */ }
        void this.view.webview.postMessage({ type: 'state', quest, rows });
    }

    /** Session files written by another window: watch the folder (its files are `<name>.session.json`). */
    private watch(folder: string): void {
        if (this.watchedFolder === folder && this.watcher) { return; }
        this.unwatch();
        if (!fs.existsSync(folder)) { return; }
        try {
            const watcher = fs.watch(folder, (_event, file) => {
                if (!file || String(file).endsWith('.session.json')) { this.send(); }
            });
            // A watcher can fail after it started (EMFILE): log it and live on the store's notifications.
            watcher.on('error', () => { this.unwatch(); });
            this.watcher = watcher;
            this.watchedFolder = folder;
        } catch {
            /* the store's notifications and visibility still refresh the view */
        }
    }

    private unwatch(): void {
        try { this.watcher?.close(); } catch { /* already closed */ }
        this.watcher = undefined;
        this.watchedFolder = undefined;
    }

    private async handle(msg: { type: string; name?: string }): Promise<void> {
        const quest = WsPaths.getWorkspaceQuestId();
        const folder = quest ? sessionsFolder(quest) : '';
        switch (msg.type) {
            case 'ready':
                this.send();
                break;
            case 'reset':
                if (folder && msg.name) {
                    // The conversation goes (history and SDK id); trails and memory stay.
                    AnthropicHandler.instance.clearSession(msg.name);
                    clearSessionId(folder, msg.name);
                    this.send();
                }
                break;
            case 'delete': {
                if (!folder || !msg.name || !quest) { break; }
                const answer = await vscode.window.showWarningMessage(
                    `Delete the session "${msg.name}"?`,
                    { modal: true, detail: deleteSessionDetail(quest, msg.name) },
                    'Delete',
                );
                if (answer !== 'Delete') { break; }
                const result = deleteSession(folder, msg.name);
                if (!result.ok) { void vscode.window.showWarningMessage(result.error); this.send(); break; }
                AnthropicHandler.instance.clearSession(msg.name);
                removeSessionStorage(folder, TwoTierMemoryService.instance.memoryRoot(), quest, msg.name);
                this.send();
                break;
            }
        }
    }
}

/** Register the SESSIONS view and its add command. */
export function registerSessionsView(context: vscode.ExtensionContext): void {
    const provider = new SessionsViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SESSIONS_VIEW_ID, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand(ADD_SESSION_COMMAND, async () => {
            const quest = WsPaths.getWorkspaceQuestId();
            if (!quest) {
                void vscode.window.showWarningMessage('Sessions belong to a quest: there is no active quest.');
                return;
            }
            await newSessionViaPicker(quest);
            provider.send();
        }),
    );
}
