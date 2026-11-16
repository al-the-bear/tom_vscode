/**
 * @TOM INFO › RUNS (`tomAi.runsOverview`, vscimpb123): every process run of
 * every window on this machine, grouped by window — run name, subject,
 * process › position and a state badge with what it waits for.
 *
 * The runs come from the window-state files (`_ai/local/<window>.window-state.json`),
 * where every window writes its runs with its heartbeat and soon after a
 * change (handlers/windowActivity-handler.ts; the states:
 * src/utils/runActivity.ts). The view refreshes when a state file changes and,
 * while shown, once per heartbeat interval so a gone window ages out — never
 * faster than the heartbeat. A window without a heartbeat for 90 s is shown
 * as gone, and left out 10 minutes after its last one.
 *
 * A click on a run of this window selects it (the window works on it from
 * then on); a click on another window's run shows its details in place.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { reportException } from './handler_shared.js';
import { getLocalFolder, loadAllWindowStates } from './windowStatusPanel-handler';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '../utils/windowHeartbeat';
import { runsOverviewWindows, type RunsOverviewWindow } from '../utils/runActivity';

export const RUNS_OVERVIEW_VIEW_ID = 'tomAi.runsOverview';

/** This window's id, as the window-state file names it (extension.ts). */
function thisWindowId(): string {
    return `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
}

/** What the view shows now. */
export function currentRunsOverview(nowMs = Date.now()): RunsOverviewWindow[] {
    return runsOverviewWindows(loadAllWindowStates(), {
        nowMs,
        thisWindowId: thisWindowId(),
        thisHost: os.hostname(),
        thisMachine: vscode.env.machineId.substring(0, 8),
        staleMs: HEARTBEAT_STALE_MS,
    });
}

class RunsOverviewViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private watcher?: vscode.FileSystemWatcher;
    private timer?: ReturnType<typeof setInterval>;
    private debounce?: ReturnType<typeof setTimeout>;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };
        const codiconsUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        view.webview.html = loadWebviewHtml(view.webview, 'runsOverview', { init: { codiconsUri: codiconsUri.toString() } });
        view.webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); });
        this.watch();
        if (view.visible) { this.startTimer(); }
        view.onDidChangeVisibility(() => {
            if (view.visible) { this.post(); this.startTimer(); } else { this.stopTimer(); }
        });
        view.onDidDispose(() => {
            this.view = undefined;
            this.watcher?.dispose();
            this.watcher = undefined;
            this.stopTimer();
            if (this.debounce) { clearTimeout(this.debounce); }
        });
    }

    /** Post the windows and their runs (only while shown: a hidden view is posted to when shown again). */
    post(): void {
        if (!this.view?.visible) { return; }
        try {
            void this.view.webview.postMessage({ type: 'runs', windows: currentRunsOverview() });
        } catch (error) {
            reportException('runsOverview.post', error);
        }
    }

    private soon(): void {
        if (this.debounce) { clearTimeout(this.debounce); }
        this.debounce = setTimeout(() => { this.debounce = undefined; this.post(); }, 500);
    }

    private watch(): void {
        try {
            const folder = getLocalFolder();
            if (!folder || !fs.existsSync(folder)) { return; }
            this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*.window-state.json'));
            this.watcher.onDidCreate(() => this.soon());
            this.watcher.onDidChange(() => this.soon());
            this.watcher.onDidDelete(() => this.soon());
        } catch (error) {
            reportException('runsOverview.watch', error);
        }
    }

    /** Once per heartbeat interval while shown: windows age into gone and out of the view. */
    private startTimer(): void {
        this.stopTimer();
        this.timer = setInterval(() => this.post(), HEARTBEAT_INTERVAL_MS);
    }

    private stopTimer(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    }

    private async onMessage(msg: { type?: string; windowId?: string; run?: string }): Promise<void> {
        try {
            if (msg.type === 'ready') { this.post(); return; }
            if (msg.type === 'selectRun' && msg.windowId === thisWindowId() && typeof msg.run === 'string') {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ProcessStateStore } = require('../managers/processStateStore') as typeof import('../managers/processStateStore');
                const result = ProcessStateStore.instance?.selectRun(msg.run);
                if (result && !result.ok) { void vscode.window.showWarningMessage(`RUNS: ${result.error}`); }
                // The heartbeat rewrites the state file on the change; the watcher posts then.
                this.soon();
            }
        } catch (error) {
            reportException('runsOverview.onMessage', error, { type: msg?.type });
        }
    }
}

/** Register the RUNS view of @TOM INFO. */
export function registerRunsOverviewView(context: vscode.ExtensionContext): void {
    const provider = new RunsOverviewViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RUNS_OVERVIEW_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));
}
