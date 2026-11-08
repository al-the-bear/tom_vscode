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
 * - Remove unused sessions (title-bar icon, `tomAi.sessions.removeUnused`):
 *   a multi-picker of the named sessions nothing uses any more
 *   (src/utils/unusedSessions.ts: no queue item still to run, no process
 *   definition and no other session names them), those without a
 *   conversation ticked; the ticked ones are deleted like Delete does, after
 *   one confirmation.
 *
 * The view refreshes when
 * this store writes or removes a session file, when the folder changes on
 * disk (another window), and when it becomes visible.
 *
 * View: `tomAi.sessions`. Assets: `media/sessionsView/`.
 */

import { wireQuestHintMessages } from './questHint-handler';
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
import { PromptQueueManager } from '../managers/promptQueueManager';
import { ProcessStateStore } from '../managers/processStateStore';
import { planUnusedSessions } from '../utils/unusedSessions';

export const SESSIONS_VIEW_ID = 'tomAi.sessions';
export const ADD_SESSION_COMMAND = 'tomAi.sessions.add';
export const REMOVE_UNUSED_SESSIONS_COMMAND = 'tomAi.sessions.removeUnused';

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
        // The "no quest is open" banner (media/shared/questHint.js).
        this.context.subscriptions.push(wireQuestHintMessages(webviewView.webview));
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
        vscode.commands.registerCommand(REMOVE_UNUSED_SESSIONS_COMMAND, async () => {
            await removeUnusedSessions();
            provider.send();
        }),
    );
}

/**
 * Offer the quest's unused sessions in a multi-picker and delete the ticked
 * ones with their storage. Refuses when the queue or the process definitions
 * cannot be read: without them a session in use could look unused.
 */
async function removeUnusedSessions(): Promise<void> {
    const quest = WsPaths.getWorkspaceQuestId();
    if (!quest) {
        void vscode.window.showWarningMessage('Sessions belong to a quest: there is no active quest.');
        return;
    }
    let queue: PromptQueueManager;
    try { queue = PromptQueueManager.instance; } catch {
        void vscode.window.showWarningMessage('The prompt queue is not loaded yet, so it is unknown which sessions it still uses. Try again in a moment.');
        return;
    }
    const processes = ProcessStateStore.instance;
    if (!processes) {
        void vscode.window.showWarningMessage('The process definitions are not loaded yet, so it is unknown which sessions they name. Try again in a moment.');
        return;
    }
    const folder = sessionsFolder(quest);
    const plan = planUnusedSessions({
        rows: sessionRows(listSessions(folder)),
        queueItems: queue.items,
        queueDefaultSession: queue.defaultAgentSdkSession,
        processes: [...processes.definitions().values()],
    });
    const namedKept = plan.kept.filter((k) => k.name !== 'default' && k.name !== 'chat');
    if (plan.offered.length === 0) {
        void vscode.window.showInformationMessage(`No unused sessions in ${quest}.` +
            (namedKept.length ? ` In use: ${namedKept.map((k) => `${k.name} (${k.reason})`).join('; ')}.` : ''));
        return;
    }
    const picked = await vscode.window.showQuickPick(
        plan.offered.map((o) => ({ label: o.name, description: o.detail, picked: o.preselected })),
        {
            canPickMany: true,
            title: `Remove unused sessions — ${quest}`,
            placeHolder: 'Tick the sessions to delete (those without a conversation are ticked)' +
                (namedKept.length ? `; kept because in use: ${namedKept.map((k) => k.name).join(', ')}` : ''),
            ignoreFocusOut: true,
        },
    );
    if (!picked || picked.length === 0) { return; }
    const names = picked.map((p) => p.label);
    const answer = await vscode.window.showWarningMessage(
        `Delete ${names.length} session${names.length === 1 ? '' : 's'}?`,
        {
            modal: true,
            detail: `${names.join(', ')}\n\nEach goes with its whole storage: history, trails, tool results and quest memory.`,
        },
        'Delete',
    );
    if (answer !== 'Delete') { return; }
    const failed: string[] = [];
    for (const name of names) {
        const result = deleteSession(folder, name);
        if (!result.ok) { failed.push(result.error); continue; }
        AnthropicHandler.instance.clearSession(name);
        removeSessionStorage(folder, TwoTierMemoryService.instance.memoryRoot(), quest, name);
    }
    const deleted = names.length - failed.length;
    if (failed.length > 0) {
        void vscode.window.showWarningMessage(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}; not deleted: ${failed.join(' ')}`);
    } else {
        void vscode.window.showInformationMessage(`Deleted ${deleted} session${deleted === 1 ? '' : 's'} of ${quest}.`);
    }
}
