/**
 * @TOM INFO › USER NOTIFICATIONS (`tomAi.userNotifications`, vscimpb170):
 * everything directed at the user, from every window on this machine — asks
 * (questions, pickers, MD Browser asks, plans, tool approvals) open until
 * answered, tomAi_notifyUser messages, suggested subprocesses, process
 * decisions waiting, todos filed for the user and the queue holding for the
 * user. Read from the shared notification log (services/notificationLog.ts;
 * written by services/userNotificationEmitter.ts and the tools), one row per
 * event (utils/userNotifications.ts).
 *
 * **Dismiss** (a row, or every answered ask and notice) hides rows here only:
 * the dismissed ids are kept in one file beside the log, shared by every
 * window; the log is not changed, so NOTIFICATIONS still shows them. A click on
 * an open ask of this window opens it: the MD Browser of an MD Browser ask,
 * else the user-input panel on its run. The view's badge counts the open asks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerGatedWebviewViewProvider } from './webviewViewGate';

import { reportException } from './handler_shared.js';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { notificationLogFile, readNotificationEvents } from '../services/notificationLog';
import { addDismissed, dismissibleAnsweredIds, openAskCount, readDismissed, userNotificationRows, type UserNotificationRow } from '../utils/userNotifications';
import { userInteractions } from '../services/userInteractions';
import { SHOW_USER_INTERACTION_COMMAND } from './userInteractionPanel';

export const USER_NOTIFICATIONS_VIEW_ID = 'tomAi.userNotifications';
/** The dismissed set's file, beside the log. */
export const USER_DISMISSED_FILE = 'user-dismissed.json';

function thisWindowId(): string {
    return `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
}

/** The dismissed set's path (beside the log), when the log is configured. */
export function userDismissedFile(): string | undefined {
    const log = notificationLogFile();
    return log ? path.join(path.dirname(log), USER_DISMISSED_FILE) : undefined;
}

/** The rows the view shows now. */
export function currentUserRows(): UserNotificationRow[] {
    const log = notificationLogFile();
    if (!log) { return []; }
    const dismissedFile = userDismissedFile();
    return userNotificationRows(readNotificationEvents(log), dismissedFile ? readDismissed(dismissedFile) : new Set());
}

/**
 * Open the ask of row `row` where it is answered, when it is this window's:
 * an MD Browser ask brings its panel forward, any other the user-input panel on
 * its run. Answers whether it was opened.
 */
export async function openAskOfRow(row: Pick<UserNotificationRow, 'key' | 'windowId' | 'run' | 'kind'>, me = thisWindowId()): Promise<boolean> {
    if (!row.key || row.windowId !== me) { return false; }
    const interaction = userInteractions.get(row.key);
    if (!interaction) { return false; }
    if (interaction.kind === 'mdBrowser') {
        interaction.respond?.({});
        return true;
    }
    await vscode.commands.executeCommand(SHOW_USER_INTERACTION_COMMAND, { run: interaction.run });
    return true;
}

class UserNotificationsViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private watcher?: fs.FSWatcher;
    private debounce?: ReturnType<typeof setTimeout>;
    private stale = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const ext = this.context.extensionUri;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'node_modules', '@vscode', 'codicons', 'dist')],
        };
        const codiconsUri = view.webview.asWebviewUri(vscode.Uri.joinPath(ext, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        view.webview.html = loadWebviewHtml(view.webview, 'userNotifications', { init: { codiconsUri: codiconsUri.toString() } });
        view.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
        this.watch();
        view.onDidChangeVisibility(() => { if (view.visible && this.stale) { this.post(); } });
        view.onDidDispose(() => {
            this.view = undefined;
            this.watcher?.close();
            this.watcher = undefined;
            if (this.debounce) { clearTimeout(this.debounce); }
        });
        this.post();
    }

    /** Post the rows; the badge follows even while the view is hidden. */
    post(): void {
        if (!this.view) { return; }
        try {
            const rows = currentUserRows();
            const open = openAskCount(rows);
            this.view.badge = open ? { value: open, tooltip: `${open} waiting for your answer` } : undefined;
            if (!this.view.visible) { this.stale = true; return; }
            this.stale = false;
            void this.view.webview.postMessage({ type: 'state', rows, open, thisWindow: thisWindowId() });
        } catch (error) {
            reportException('userNotifications.post', error);
        }
    }

    private soon(): void {
        if (this.debounce) { clearTimeout(this.debounce); }
        this.debounce = setTimeout(() => { this.debounce = undefined; this.post(); }, 300);
    }

    /** Watch the log's folder: the log (replaced when cut) and the dismissed set live there. */
    private watch(): void {
        const file = notificationLogFile();
        if (!file) { return; }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const names = new Set([path.basename(file), USER_DISMISSED_FILE]);
            this.watcher = fs.watch(path.dirname(file), (_event, changed) => {
                if (!changed || names.has(String(changed))) { this.soon(); }
            });
            this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
        } catch (error) {
            reportException('userNotifications.watch', error);
        }
    }

    private dismiss(ids: string[]): void {
        const file = userDismissedFile();
        const log = notificationLogFile();
        if (!file || !log || !ids.length) { return; }
        addDismissed(file, ids, new Set(readNotificationEvents(log).map((e) => e.id)));
        this.post();
    }

    private async onMessage(msg: { type?: string; id?: unknown }): Promise<void> {
        try {
            if (msg.type === 'ready') { this.post(); return; }
            if (msg.type === 'dismiss' && typeof msg.id === 'string') { this.dismiss([msg.id]); return; }
            if (msg.type === 'dismissAnswered') { this.dismiss(dismissibleAnsweredIds(currentUserRows())); return; }
            if (msg.type === 'openAsk' && typeof msg.id === 'string') {
                const row = currentUserRows().find((r) => r.id === msg.id);
                if (row && !await openAskOfRow(row)) {
                    void vscode.window.showInformationMessage(row.windowId === thisWindowId() ? 'This ask is no longer open.' : `This ask waits in another window (${row.quest || row.windowId}).`);
                }
            }
        } catch (error) {
            reportException('userNotifications.onMessage', error, { type: msg?.type });
        }
    }
}

/** Register the USER NOTIFICATIONS view of @TOM INFO. */
export function registerUserNotificationsView(context: vscode.ExtensionContext): void {
    const provider = new UserNotificationsViewProvider(context);
    context.subscriptions.push(registerGatedWebviewViewProvider(USER_NOTIFICATIONS_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));
}
