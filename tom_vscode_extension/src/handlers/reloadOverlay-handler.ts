/**
 * The reload overlay (vscimpb142b): another window migrated the workspace's
 * `_ai` files while this one runs (services/aiFormatCheckService.ts). Every
 * run of this window is paused; this page is brought to the front — over the
 * Prompt Queue editor when it is open — saying so, and lists the prompts that
 * were still running (utils/reloadOverlayRows.ts): status and kind label, run,
 * session, title, each with **Interrupt**. Their status follows the queue, so
 * the list shows when one is done; **Reload window** says when nothing runs
 * any more. A status-bar item brings the page back after it was closed.
 *
 * Interrupt: a queue item gets the hard interrupt for continuation (its turn
 * is cancelled, the item `interrupted`; its resend after the reload goes on in
 * the conversation it ran in); a chat send is cancelled.
 */

import * as vscode from 'vscode';

import { reloadOverlayRows, reloadOverlayText, trackRunningItems, type OverlayQueueItem, type ReloadOverlayRow } from '../utils/reloadOverlayRows';
import { loadWebviewHtml } from '../utils/webviewLoader';

export const SHOW_RELOAD_OVERLAY_COMMAND = 'tomAi.showReloadOverlay';

/** What the overlay needs from the window (a test may stand in). */
export interface ReloadOverlayDeps {
    items(): readonly OverlayQueueItem[];
    autoSend(run: string): boolean;
    windowId(): string;
    /** The queue's change event. */
    onDidChange(listener: () => void): vscode.Disposable;
    /** Interrupt a queue item (hard, for continuation); answers whether something was done. */
    interruptItem(id: string): boolean;
    /** Cancel a chat send by its queue entry id; answers whether one was cancelled. */
    cancelChat(id: string): boolean;
    /** The column to open in (the Prompt Queue editor's, when open). */
    viewColumn(): vscode.ViewColumn | undefined;
}

/** What the page shows. */
export interface ReloadOverlayState {
    version: number;
    text: string;
    rows: ReloadOverlayRow[];
    /** Nothing of the list runs any more. */
    idle: boolean;
}

let panel: vscode.WebviewPanel | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let tracked: string[] = [];
let shownVersion = 0;
let activeDeps: ReloadOverlayDeps | undefined;
let queueListener: vscode.Disposable | undefined;

/** The page's state now; tracks every item running now. */
export function reloadOverlayState(deps: ReloadOverlayDeps, version: number, ids: string[]): ReloadOverlayState {
    trackRunningItems(deps.items(), ids, deps.windowId(), (run) => deps.autoSend(run));
    const rows = reloadOverlayRows(deps.items(), ids, deps.windowId(), (run) => deps.autoSend(run));
    return { version, text: reloadOverlayText(version), rows, idle: rows.every((r) => !r.running) };
}

/** The overlay's message from the page: interrupt a row, reload, ready. Answers whether it was handled. */
export function handleReloadOverlayMessage(deps: ReloadOverlayDeps, msg: { type?: string; id?: string; chat?: boolean }): boolean {
    switch (msg.type) {
        case 'interrupt':
            if (!msg.id) { return false; }
            return msg.chat ? deps.cancelChat(msg.id) : deps.interruptItem(msg.id);
        case 'reload':
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
            return true;
        default:
            return false;
    }
}

function post(): void {
    if (!panel || !activeDeps) { return; }
    const state = reloadOverlayState(activeDeps, shownVersion, tracked);
    void panel.webview.postMessage({ type: 'state', state });
    if (statusItem) {
        statusItem.text = state.idle ? '$(debug-restart) Reload: workspace migrated' : `$(warning) Reload after ${state.rows.filter((r) => r.running).length} running prompt(s)`;
    }
}

/**
 * Show the overlay for format `version` (again, when it is open: brought to the front). The items running now
 * are listed; the list follows the queue.
 */
export function showReloadOverlay(context: vscode.ExtensionContext, deps: ReloadOverlayDeps, version: number): void {
    activeDeps = deps;
    shownVersion = version;
    if (!statusItem) {
        statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
        statusItem.command = SHOW_RELOAD_OVERLAY_COMMAND;
        statusItem.tooltip = reloadOverlayText(version);
        statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusItem.show();
        context.subscriptions.push(statusItem);
        context.subscriptions.push(vscode.commands.registerCommand(SHOW_RELOAD_OVERLAY_COMMAND, () => showReloadOverlay(context, deps, shownVersion)));
    }
    if (!queueListener) {
        queueListener = deps.onDidChange(() => post());
        context.subscriptions.push(queueListener);
    }
    if (panel) {
        panel.reveal(deps.viewColumn() ?? panel.viewColumn, false);
        post();
        return;
    }
    const initial = reloadOverlayState(deps, version, tracked);
    panel = vscode.window.createWebviewPanel('tomAi.reloadOverlay', 'Reload required (Tom AI)', { viewColumn: deps.viewColumn() ?? vscode.ViewColumn.Active, preserveFocus: false }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.webview.html = loadWebviewHtml(panel.webview, 'reloadOverlay', { init: initial as unknown as Record<string, unknown> });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage((msg: { type?: string; id?: string; chat?: boolean }) => {
        if (msg.type === 'ready') { post(); return; }
        if (handleReloadOverlayMessage(deps, msg)) { post(); }
    }, undefined, context.subscriptions);
    post();
}
