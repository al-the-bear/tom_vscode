/**
 * The user-input panel (vscimpb81): every interaction that waits for the user
 * (services/userInteractions.ts) in one webview panel, one tab per process run
 * with open interactions (a badge with the count on each), so asks of
 * different runs stand side by side and the user answers them in any order.
 * Questions, tool approvals, plan proposals and pickers are answered here; an
 * ask in the MD Browser is listed with a button that brings its panel to the
 * front.
 *
 * The panel opens when a question, a picker or a plan opens (an approval also
 * shows in the @CHAT panel, which comes forward for it); closing it leaves
 * every interaction open — `@T: Show Pending Question`, the status-bar entry
 * and a waiting queue item's indicator bring it back on the right tab.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionPath, bridgeLog, reportException } from './handler_shared';
import { debugLog } from '../utils/debugLogger';
import { instrumentWebviewMessages } from '../utils/webviewMessageInstrumentation';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { userInteractions, type OpenInteraction } from '../services/userInteractions';

let panel: vscode.WebviewPanel | undefined;
/** The tab and interaction to show next (set by show, sent with the next state). */
let pendingSelection: { run?: string; focusId?: string } | undefined;

/** Whether the panel is open (tests, diagnostics). */
export function userInteractionPanelOpen(): boolean {
    return panel !== undefined;
}

function postState(): void {
    if (!panel) { return; }
    const selection = pendingSelection;
    pendingSelection = undefined;
    void panel.webview.postMessage({ type: 'state', interactions: userInteractions.views(), ...(selection ?? {}) });
}

/** The webview's messages: a question's (by request id) or another interaction's (by id). */
function onMessage(msg: Record<string, unknown>): void {
    const type = String(msg?.type ?? '');
    const id = type === 'submit' || type === 'answers' || type === 'choice' ? String(msg.requestId ?? '') : String(msg.id ?? '');
    if (!id || !['submit', 'answers', 'choice', 'approval', 'plan', 'picker', 'reveal'].includes(type)) { return; }
    const interaction = userInteractions.get(id);
    if (!interaction?.respond) {
        void vscode.window.showInformationMessage('That question was already closed; your answer was not sent.');
        postState();
        return;
    }
    try {
        interaction.respond(msg);
    } catch (e) {
        reportException('userInteractionPanel.respond', e, { id, type });
    }
}

/**
 * Show the panel: on run `run`'s tab, with interaction `focusId` in view
 * (default: the newest interaction's run).
 */
export function showUserInteractions(opts: { run?: string; focusId?: string; preserveFocus?: boolean } = {}): void {
    const focus = opts.focusId ? userInteractions.get(opts.focusId) : undefined;
    const newest = userInteractions.list().slice(-1)[0];
    pendingSelection = { run: opts.run ?? focus?.run ?? newest?.run, ...(opts.focusId ? { focusId: opts.focusId } : {}) };
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active, opts.preserveFocus ?? false);
        postState();
        return;
    }
    const extPath = getExtensionPath();
    const created = vscode.window.createWebviewPanel(
        'tomAiAskUser',
        'Tom AI — Waiting for you',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus ?? false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: extPath ? [vscode.Uri.file(path.join(extPath, 'media'))] : undefined },
    );
    panel = created;
    instrumentWebviewMessages(created.webview, {
        source: 'tomAiAskUser',
        log: (line) => debugLog(`webview message: ${line}`, 'INFO', 'webview.message'),
        report: (where, error, details) => reportException(`webview:${where}`, error, details),
    });
    created.webview.onDidReceiveMessage((msg: Record<string, unknown>) => onMessage(msg));
    created.onDidDispose(() => {
        if (panel === created) { panel = undefined; }
        debugLog(`user-input panel closed (${userInteractions.list().length} interaction(s) stay open)`, 'INFO', 'askUser');
    });
    try {
        const selection = pendingSelection;
        pendingSelection = undefined;
        created.webview.html = loadWebviewHtml(created.webview, 'askUser', {
            init: { interactions: userInteractions.views(), ...(selection ?? {}) },
        });
    } catch (err) {
        bridgeLog(`[userInput] Failed to render panel: ${(err as Error).message}`, 'ERROR');
    }
}

/** The command that shows the panel (on the newest question's run). */
export const SHOW_PENDING_QUESTION_COMMAND = 'tomAi.showPendingQuestion';
/** The command a waiting queue item's indicator runs: `{ itemId }` or `{ run }`. */
export const SHOW_USER_INTERACTION_COMMAND = 'tomAi.showUserInteraction';

/**
 * Show what queue item `itemId` waits for: an ask in the MD Browser brings that
 * panel to the front, anything else opens the user-input panel on its tab.
 * Answers false when the item waits for nothing.
 */
export function showInteractionOfItem(itemId: string): boolean {
    const open = userInteractions.forQueueItem(itemId);
    const first = open.find((i) => i.kind !== 'mdBrowser') ?? open[0];
    if (!first) {
        void vscode.window.showInformationMessage('This item does not wait for you any more.');
        return false;
    }
    if (first.kind === 'mdBrowser') {
        first.respond?.({ type: 'reveal', id: first.id });
        return true;
    }
    showUserInteractions({ run: first.run, focusId: first.id });
    return true;
}

/** Whether an interaction opening brings the panel forward by itself. */
function opensPanel(i: OpenInteraction): boolean {
    return i.kind === 'question' || i.kind === 'picker' || i.kind === 'plan';
}

/**
 * At activation: the commands, a status-bar entry while anything waits for the
 * user (it opens the panel), and the panel kept in step with the interactions.
 */
export function initUserInteractionPanel(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_PENDING_QUESTION_COMMAND, () => {
            if (!userInteractions.list().length) {
                void vscode.window.showInformationMessage('Nothing is waiting for your answer.');
                return false;
            }
            showUserInteractions();
            return true;
        }),
        vscode.commands.registerCommand(SHOW_USER_INTERACTION_COMMAND, (arg?: { itemId?: string; run?: string }) => {
            if (arg?.itemId) { return showInteractionOfItem(arg.itemId); }
            showUserInteractions({ run: arg?.run });
            return true;
        }),
    );
    const item = vscode.window.createStatusBarItem('tomAi.pendingQuestion', vscode.StatusBarAlignment.Left, 51);
    item.name = 'Tom AI: waiting for your answer';
    item.command = SHOW_PENDING_QUESTION_COMMAND;
    context.subscriptions.push(item);
    const update = (): void => {
        const open = userInteractions.list();
        if (!open.length) { item.hide(); return; }
        const runs = userInteractions.runs();
        item.text = `$(comment-discussion) ${open.length === 1 ? 'Waiting for you' : `${open.length} waiting for you`}`;
        item.tooltip = `${runs.map((r) => `run ${r.run}: ${r.count}`).join(', ')}. Click to open.`;
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        item.show();
    };
    const unsubscribe = userInteractions.onChange((added) => {
        update();
        // A new interaction opens the panel on its run; an open panel only updates its tabs and badges, so a
        // question of another run never takes the user away from the one they are answering.
        if (added && opensPanel(added) && !panel) {
            showUserInteractions({ run: added.run, focusId: added.id });
        } else {
            postState();
        }
    });
    context.subscriptions.push({ dispose: () => { unsubscribe(); panel?.dispose(); } });
    update();
}
