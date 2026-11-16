/**
 * @TOM INFO › NOTIFICATIONS (`tomAi.notifications`, vscimpb124): what agents,
 * the user and the extension do to queues and todos across the windows of
 * this machine, from the shared event log (services/notificationLog.ts).
 *
 * One line per event, events of one type from one source in one quest within
 * 60 s merged (utils/notificationEvents.ts); a click opens the details. A
 * window filter (one or several windows, none ticked: all), the five type
 * toggles and Clear (hides what is there now, in this window only) are kept
 * per window in workspaceState. The view reads the log when it changes
 * (`fs.watch` on its folder), never by polling; a change while it is hidden is
 * shown when it is shown again.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { reportException } from './handler_shared.js';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { notificationLogFile, readNotificationEvents } from '../services/notificationLog';
import {
    NOTIFICATION_TYPES, NOTIFICATION_TYPE_INFO, filterNotifications, groupDetails, groupLine, groupNotifications, notificationWindows,
    type NotificationFilters, type NotificationType,
} from '../utils/notificationEvents';

export const NOTIFICATIONS_VIEW_ID = 'tomAi.notifications';
const FILTERS_KEY = 'tomAi.notifications.filters';
/** The most groups the view lists (the log holds up to 1000 events). */
const MAX_LINES = 300;

function thisWindowId(): string {
    return `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
}

/** The filters as stored, made valid. */
export function storedFilters(raw: unknown): NotificationFilters {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationFilters>;
    const types = Array.isArray(r.types) ? r.types.filter((t): t is NotificationType => NOTIFICATION_TYPES.includes(t as NotificationType)) : undefined;
    return {
        windows: Array.isArray(r.windows) ? r.windows.filter((w): w is string => typeof w === 'string') : [],
        ...(types ? { types } : {}),
        ...(typeof r.clearedAt === 'string' ? { clearedAt: r.clearedAt } : {}),
    };
}

class NotificationsViewProvider implements vscode.WebviewViewProvider {
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
        view.webview.html = loadWebviewHtml(view.webview, 'notifications', { init: { codiconsUri: codiconsUri.toString() } });
        view.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
        this.watch();
        view.onDidChangeVisibility(() => { if (view.visible && this.stale) { this.post(); } });
        view.onDidDispose(() => {
            this.view = undefined;
            this.watcher?.close();
            this.watcher = undefined;
            if (this.debounce) { clearTimeout(this.debounce); }
        });
    }

    private get filters(): NotificationFilters {
        return storedFilters(this.context.workspaceState.get(FILTERS_KEY));
    }

    private async saveFilters(f: NotificationFilters): Promise<void> {
        await this.context.workspaceState.update(FILTERS_KEY, f);
    }

    /** Post the lines, the window choices and the filters (a hidden view is posted to when shown). */
    post(): void {
        if (!this.view) { return; }
        if (!this.view.visible) { this.stale = true; return; }
        this.stale = false;
        try {
            const file = notificationLogFile();
            const events = file ? readNotificationEvents(file) : [];
            const filters = this.filters;
            const me = thisWindowId();
            const groups = groupNotifications(filterNotifications(events, filters)).slice(0, MAX_LINES).map((g) => ({
                id: g.id,
                type: g.type,
                icon: NOTIFICATION_TYPE_INFO[g.type].icon,
                count: g.members.length,
                last: g.last,
                line: groupLine(g),
                details: groupDetails(g),
            }));
            const windows = notificationWindows(events).map((w) => ({ ...w, isThisWindow: w.windowId === me }));
            if (!windows.some((w) => w.isThisWindow)) { windows.unshift({ windowId: me, quest: '', isThisWindow: true }); }
            void this.view.webview.postMessage({
                type: 'state',
                groups,
                windows,
                filters: { windows: filters.windows, types: filters.types ?? [...NOTIFICATION_TYPES], cleared: !!filters.clearedAt },
                typeInfo: NOTIFICATION_TYPES.map((t) => ({ type: t, ...NOTIFICATION_TYPE_INFO[t] })),
                total: events.length,
            });
        } catch (error) {
            reportException('notifications.post', error);
        }
    }

    private soon(): void {
        if (this.debounce) { clearTimeout(this.debounce); }
        this.debounce = setTimeout(() => { this.debounce = undefined; this.post(); }, 300);
    }

    /** Watch the log's folder (the file is replaced when the log is cut, so the folder, not the file). */
    private watch(): void {
        const file = notificationLogFile();
        if (!file) { return; }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const name = path.basename(file);
            this.watcher = fs.watch(path.dirname(file), (_event, changed) => {
                if (!changed || String(changed) === name) { this.soon(); }
            });
            // Without a listener a watch error (EMFILE with many windows) is an uncaught exception.
            this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
        } catch (error) {
            reportException('notifications.watch', error);
        }
    }

    private async onMessage(msg: { type?: string; windows?: unknown; types?: unknown }): Promise<void> {
        try {
            if (msg.type === 'ready') { this.post(); return; }
            if (msg.type === 'setFilters') {
                const next = storedFilters({ ...this.filters, windows: msg.windows, types: msg.types });
                // Every type ticked is the default: stored as absent, so a type added later shows.
                if (next.types && next.types.length === NOTIFICATION_TYPES.length) { delete next.types; }
                await this.saveFilters(next);
                this.post();
                return;
            }
            if (msg.type === 'clear') {
                await this.saveFilters({ ...this.filters, clearedAt: new Date().toISOString() });
                this.post();
                return;
            }
            if (msg.type === 'unclear') {
                const { clearedAt: _gone, ...rest } = this.filters;
                await this.saveFilters(rest);
                this.post();
            }
        } catch (error) {
            reportException('notifications.onMessage', error, { type: msg?.type });
        }
    }
}

/** Register the NOTIFICATIONS view of @TOM INFO. */
export function registerNotificationsView(context: vscode.ExtensionContext): void {
    const provider = new NotificationsViewProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(NOTIFICATIONS_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));
}
