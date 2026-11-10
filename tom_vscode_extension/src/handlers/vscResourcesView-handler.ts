/**
 * @TOM VSC — the side bar container for taming resource-hungry extensions
 * (vscimpb30), with its view RESOURCES and a status-bar item.
 *
 * - **Processes**: the helper processes of this window's extension host
 *   (language servers, analysers, …) grouped by the extension that started them,
 *   with memory, CPU and age; Pause / Resume / Kill per process and per
 *   extension (src/services/extensionProcessService.ts). A paused language
 *   server's editor features (completion, diagnostics, go to definition) wait
 *   until it is resumed. Windows: Kill only.
 * - **Profiles**: switching to a lean VS Code profile (its own set of enabled
 *   extensions) is the supported way to turn extensions off; the view opens the
 *   profile picker and creates a profile from the current one.
 * - **Settings**: workspace toggles of the biggest consumers (src/utils/heavySettings.ts).
 *
 * Refreshes every 5 s while visible, nothing while hidden. The status-bar item
 * (`$(server-process) 9.2 GB in 7 processes`) opens the view; it is refreshed
 * every 30 s (one `ps`) and with every refresh of the view.
 */

import * as vscode from 'vscode';

import { ExtensionProcessService, liveProcessSystem, type ProcessAction, type ProcessSnapshot } from '../services/extensionProcessService';
import { formatMemory, totalsText } from '../utils/extensionProcesses';
import { HEAVY_SETTINGS, heavySettingRow, heavySettingWrite, type HeavySettingRow } from '../utils/heavySettings';
import { loadWebviewHtml } from '../utils/webviewLoader';

export const VSC_RESOURCES_VIEW_ID = 'tomAi.vscResources';
/** VS Code's own command that reveals a view: `<view id>.focus`. */
const FOCUS_VIEW_COMMAND = `${VSC_RESOURCES_VIEW_ID}.focus`;
const VIEW_REFRESH_MS = 5000;
const STATUS_REFRESH_MS = 30000;

/** The profile commands the view offers, when this VS Code has them. */
export const PROFILE_COMMANDS = [
    { id: 'workbench.profiles.actions.switchProfile', label: 'Switch profile…', hint: 'A lean profile has its own, smaller set of enabled extensions; switching restarts the extension host, not the window.' },
    { id: 'workbench.profiles.actions.createFromCurrentProfile', label: 'Create a profile from the current one…', hint: 'Make the lean profile: a copy of this one, then disable the heavy extensions in it.' },
    { id: 'workbench.profiles.actions.manageProfiles', label: 'Manage profiles…', hint: 'The profiles editor.' },
] as const;

/** The rows of the settings section from the live configuration. */
function settingRows(): Array<HeavySettingRow & { available: boolean }> {
    const cfg = vscode.workspace.getConfiguration();
    return HEAVY_SETTINGS.map((def) => {
        const inspect = cfg.inspect(def.key);
        const row = heavySettingRow(def, cfg.get(def.key), inspect?.workspaceValue);
        // A setting of an extension that is not installed has no default: offered, but writing it fails.
        return { ...row, available: inspect?.defaultValue !== undefined };
    });
}

/** Write a toggle into the workspace settings; answers an error text or ''. */
async function writeSetting(id: string, value: unknown): Promise<string> {
    const def = HEAVY_SETTINGS.find((d) => d.id === id);
    if (!def) { return `no setting ${id}`; }
    const cfg = vscode.workspace.getConfiguration();
    const inspect = cfg.inspect(def.key);
    const inherited = mergeObjects(inspect?.defaultValue, inspect?.globalValue);
    const next = heavySettingWrite(def, inspect?.workspaceValue, value, inherited);
    if (next === undefined) { return `"${String(value)}" is no value of ${def.key}`; }
    try {
        await cfg.update(def.key, next, vscode.ConfigurationTarget.Workspace);
        return '';
    } catch (e) {
        return `${def.key} could not be written: ${(e as Error).message}`;
    }
}

/** An object setting's value below the workspace: the default with the user's entries over it. */
function mergeObjects(base: unknown, over: unknown): unknown {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (isObj(base) || isObj(over)) { return { ...(isObj(base) ? base : {}), ...(isObj(over) ? over : {}) }; }
    return over ?? base;
}

class VscResourcesViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private timer?: ReturnType<typeof setInterval>;
    private profileCommands: Array<{ id: string; label: string; hint: string; available: boolean }> | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly service: ExtensionProcessService,
        private readonly onSnapshot: (snap: ProcessSnapshot) => void,
    ) {
        context.subscriptions.push({ dispose: () => this.stop() });
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (this.view?.visible && HEAVY_SETTINGS.some((d) => e.affectsConfiguration(d.key))) { void this.send(); }
        }));
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'vscResources', {
            init: {
                codiconsUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')).toString(),
            },
        });
        webviewView.webview.onDidReceiveMessage((msg) => void this.handle(msg), undefined, this.context.subscriptions);
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.start(); } else { this.stop(); } });
        webviewView.onDidDispose(() => { this.stop(); this.view = undefined; });
        if (webviewView.visible) { this.start(); }
    }

    /** Refresh now and every VIEW_REFRESH_MS while visible. */
    private start(): void {
        void this.send();
        if (!this.timer) {
            this.timer = setInterval(() => { void this.send(); }, VIEW_REFRESH_MS);
            this.timer.unref?.();
        }
    }

    private stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    }

    async send(note?: { text: string; error?: boolean }): Promise<void> {
        if (!this.view) { return; }
        const snap = await this.service.snapshot();
        this.onSnapshot(snap);
        if (!this.profileCommands) {
            const all = new Set(await vscode.commands.getCommands(true));
            this.profileCommands = PROFILE_COMMANDS.map((c) => ({ ...c, available: all.has(c.id) }));
        }
        void this.view.webview.postMessage({
            type: 'state',
            snapshot: { ...snap, totalText: formatMemory(snap.totalKb) },
            settings: settingRows(),
            profiles: this.profileCommands,
            ...(note ? { note } : {}),
        });
    }

    private async handle(msg: { type: string; action?: ProcessAction; pids?: number[]; extensionId?: string; label?: string; id?: string; value?: unknown; command?: string }): Promise<void> {
        switch (msg.type) {
            case 'ready':
            case 'refresh':
                await this.send();
                return;
            case 'act': {
                const action = msg.action;
                if (action !== 'pause' && action !== 'resume' && action !== 'kill') { return; }
                const what = msg.extensionId !== undefined ? `every process of ${msg.label || msg.extensionId || 'this group'}` : `process ${(msg.pids ?? []).join(', ')}`;
                if (action === 'kill') {
                    const ok = await vscode.window.showWarningMessage(`Kill ${what}?`, {
                        modal: true,
                        detail: 'SIGTERM. The extension that started it may start it again — Pause stops it without the extension noticing.',
                    }, 'Kill');
                    if (ok !== 'Kill') { return; }
                }
                const result = await this.service.act(action, msg.extensionId !== undefined ? { extensionId: msg.extensionId } : { pids: msg.pids ?? [] });
                const verb = { pause: 'Paused', resume: 'Resumed', kill: 'Killed' }[action];
                const text = `${verb} ${result.done.length} process${result.done.length === 1 ? '' : 'es'}`
                    + (result.refused.length ? `; not: ${result.refused.map((r) => `${r.pid} (${r.why})`).join(', ')}` : '')
                    + (action === 'pause' && result.done.length ? '. Their editor features wait until you resume them.' : '.');
                await this.send({ text, error: result.done.length === 0 && result.refused.length > 0 });
                return;
            }
            case 'setting': {
                const error = await writeSetting(String(msg.id ?? ''), msg.value);
                await this.send(error ? { text: error, error: true } : undefined);
                return;
            }
            case 'profile': {
                if (!PROFILE_COMMANDS.some((c) => c.id === msg.command)) { return; }
                try {
                    await vscode.commands.executeCommand(msg.command!);
                } catch (e) {
                    await this.send({ text: `${msg.command} failed: ${(e as Error).message}`, error: true });
                }
                return;
            }
        }
    }
}

/** Register @TOM VSC's view and the status-bar item. */
export function registerVscResourcesView(context: vscode.ExtensionContext, service = new ExtensionProcessService(liveProcessSystem())): void {
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    status.command = FOCUS_VIEW_COMMAND;
    context.subscriptions.push(status);
    const show = (snap: ProcessSnapshot): void => {
        if (snap.error) { status.hide(); return; }
        status.text = `$(server-process) ${totalsText(snap.processes)}`;
        const top = snap.groups.slice(0, 5).map((g) => `${g.label}: ${formatMemory(g.rssKb)}${g.paused ? ' (paused)' : ''}`);
        status.tooltip = `Helper processes of this window's extensions${snap.host ? ` (the extension host itself: ${formatMemory(snap.host.rssKb)})` : ''}`
            + (top.length ? `\n${top.join('\n')}` : '') + '\nClick: @TOM VSC';
        status.show();
    };
    const provider = new VscResourcesViewProvider(context, service, show);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VSC_RESOURCES_VIEW_ID, provider));
    const tick = (): void => { void service.snapshot().then(show, () => status.hide()); };
    tick();
    const timer = setInterval(tick, STATUS_REFRESH_MS);
    // The status refresh never keeps a process alive on its own (tests, a shutting-down host).
    timer.unref?.();
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
