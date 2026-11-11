/**
 * The Provider SDKs page (`tomAi.providerSdks`, linked from the Status Page):
 * every provider the extension can use, whether its SDK is installed and at
 * which version, and the actions — a checkbox per provider with
 * **Install / Uninstall** applying what was checked or unchecked, **Check
 * for updates** (the registry's latest releases; nothing updates by itself),
 * an **update to …** tag per provider that installs that update (marked when
 * it is a new major version), **Update all**, and **install this build's
 * versions** for a provider installed at other versions. The work is services/providerInstaller.ts; the SDKs go to
 * `<global storage>/providers/`, outside the VSIX.
 *
 * When no provider is installed, the page opens when the extension starts.
 *
 * Assets: `media/providerSdks/`.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { loadWebviewHtml } from '../utils/webviewLoader';
import {
    currentHost,
    packagesForHost,
    providerVersionLabel,
    readProviderManifest,
    readProviderState,
    type HostPlatform,
    type ProviderManifest,
    type ProviderState,
} from '../utils/providerSdks';
import { ProviderInstaller, type ProviderUpdateInfo } from '../services/providerInstaller';
import { childProcessDownloader } from '../services/providerChildDownload';
import { installedProviders, PROVIDER_SDKS_COMMAND, setProviderRoot, getProviderRoot } from '../services/providerRuntime';
import { resetAgentSdkCache } from './agent-sdk-transport';
import { AnthropicHandler } from './anthropic-handler';

/** One provider row of the page. */
export interface ProviderRow {
    id: string;
    name: string;
    description: string;
    installed: boolean;
    /** The installed roots' versions, or empty. */
    installedLabel: string;
    /** The versions an install takes (this build's). */
    pinnedLabel: string;
    /** "update to …" when Check for updates found a newer release. */
    updateLabel?: string;
    /** The update is a new major version: it may change the API this build uses. */
    updateMajor?: boolean;
    /** The number of packages an install downloads for this host. */
    packageCount: number;
    /** Installed from the registry's newer releases rather than this build's versions. */
    updated: boolean;
}

/** The rows the page shows: the manifest's providers with what is installed and what the last check found. */
export function providerRows(manifest: ProviderManifest, state: ProviderState, updates: readonly ProviderUpdateInfo[], host: HostPlatform): ProviderRow[] {
    return manifest.providers.map((def) => {
        const rec = state.providers[def.id];
        const pinnedRoots = Object.fromEntries(def.roots.map((r) => [r, def.packages.find((p) => p.name === r)?.version ?? '?']));
        const upd = updates.find((u) => u.id === def.id);
        return {
            id: def.id,
            name: def.name,
            description: def.description,
            installed: !!rec,
            installedLabel: rec ? providerVersionLabel(rec.roots) : '',
            pinnedLabel: providerVersionLabel(pinnedRoots),
            ...(rec && upd?.updateAvailable ? { updateLabel: upd.latestLabel, ...(upd.majorChange ? { updateMajor: true } : {}) } : {}),
            packageCount: packagesForHost(def.packages, host).length,
            updated: rec?.source === 'update',
        };
    });
}

let panel: vscode.WebviewPanel | undefined;
let extensionRoot = '';
let busy = false;
let lastUpdates: ProviderUpdateInfo[] = [];
let lastCheckedAt: string | undefined;
let logLines: string[] = [];
let message: { kind: 'info' | 'error'; text: string } | undefined;

function installer(): ProviderInstaller {
    const root = getProviderRoot();
    if (!root) { throw new Error('The provider folder is not set (the extension has not started).'); }
    return new ProviderInstaller({
        root,
        manifest: readProviderManifest(extensionRoot),
        log: (line) => { logLines.push(line); post({ type: 'log', line }); },
        // Tarballs are downloaded by VS Code's binary run as Node in a process of its own:
        // the extension host's `fetch` never finished the 110 MB Claude CLI package on Windows.
        downloadFile: childProcessDownloader(process.execPath, path.join(extensionRoot, 'out', 'services', 'providerDownloadWorker.js')),
    });
}

function state(): Record<string, unknown> {
    const root = getProviderRoot() ?? '';
    const manifest = readProviderManifest(extensionRoot);
    const host = currentHost();
    return {
        type: 'state',
        rows: providerRows(manifest, root ? readProviderState(root) : { formatVersion: 1, providers: {} }, lastUpdates, host),
        busy,
        folder: root,
        platform: `${host.os}-${host.cpu}${host.libc === 'musl' ? '-musl' : ''}`,
        lastCheckedAt,
        log: logLines.slice(-200),
        message,
        noneInstalled: installedProviders().length === 0,
    };
}

function post(msg: Record<string, unknown>): void {
    void panel?.webview.postMessage(msg);
}

/** Run one operation at a time; the page shows its log and the outcome. */
async function run(label: string, work: (inst: ProviderInstaller) => Promise<void>): Promise<void> {
    if (busy) { return; }
    busy = true;
    logLines = [`— ${label} —`];
    message = undefined;
    post(state());
    try {
        await work(installer());
        message = { kind: 'info', text: `${label}: done.` };
    } catch (e) {
        message = { kind: 'error', text: `${label} failed: ${(e as Error).message}` };
        logLines.push(`✖ ${(e as Error).message}`);
    } finally {
        busy = false;
        // The next query loads the SDKs again from what is installed now.
        resetAgentSdkCache();
        AnthropicHandler.resetClientIfStarted();
        // The panel's 🤖 dot asks again and the panel re-sends its states
        // (loaded lazily: the chat panel is a large module).
        void import('./chatPanel-handler.js').then((m) => m.notifyAnthropicConfigChanged()).catch(() => undefined);
        post(state());
    }
}

/** What the page asks for. */
export async function handleProviderSdksMessage(msg: { type?: string; install?: unknown; remove?: unknown; id?: unknown }): Promise<void> {
    switch (msg.type) {
        case 'ready':
            post(state());
            return;
        case 'checkUpdates':
            await run('Check for updates', async (inst) => {
                const ids = Object.keys(inst.state().providers);
                lastUpdates = ids.length ? await inst.checkUpdates(ids) : [];
                lastCheckedAt = new Date().toISOString();
                const n = lastUpdates.filter((u) => u.updateAvailable).length;
                logLines.push(n ? `${n} provider(s) can be updated` : 'Every installed provider is at the latest release');
            });
            return;
        case 'apply': {
            const install = Array.isArray(msg.install) ? msg.install.map(String) : [];
            const remove = Array.isArray(msg.remove) ? msg.remove.map(String) : [];
            await run('Install / uninstall', async (inst) => {
                for (const id of remove) { inst.remove(id); lastUpdates = lastUpdates.filter((u) => u.id !== id); }
                for (const id of install) { await inst.install(id); }
            });
            return;
        }
        case 'update': {
            const id = String(msg.id ?? '');
            await run(`Update ${id}`, async (inst) => {
                await inst.update(id);
                lastUpdates = lastUpdates.filter((u) => u.id !== id);
            });
            return;
        }
        case 'reinstall': {
            // Back to this build's versions (after an update, or to repair the folder).
            const id = String(msg.id ?? '');
            await run(`Install ${id} at this build's versions`, async (inst) => { await inst.install(id); });
            return;
        }
        case 'updateAll':
            await run('Update all', async (inst) => {
                for (const u of lastUpdates.filter((x) => x.updateAvailable)) { await inst.update(u.id); }
                lastUpdates = [];
            });
            return;
    }
}

/** Open (or reveal) the Provider SDKs page. */
export function showProviderSdks(): void {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel(
        'tomAi.providerSdks',
        'Provider SDKs',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(extensionRoot, 'media'))] },
    );
    panel.webview.onDidReceiveMessage((m) => { void handleProviderSdksMessage(m); });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.html = loadWebviewHtml(panel.webview, 'providerSdks', { init: state() });
}

/**
 * Activation: the provider folder (`<global storage>/providers`), the
 * command, and — when no provider is installed — the page.
 */
export function initProviderSdks(context: vscode.ExtensionContext): void {
    extensionRoot = context.extensionPath;
    setProviderRoot(path.join(context.globalStorageUri.fsPath, 'providers'));
    context.subscriptions.push(vscode.commands.registerCommand(PROVIDER_SDKS_COMMAND, showProviderSdks));
    if (installedProviders().length === 0) { showProviderSdks(); }
}

/** Test seam: the extension root the manifest and the assets are read from. */
export function __setProviderSdksExtensionRootForTests(root: string): void { // eslint-disable-line @typescript-eslint/naming-convention -- a test seam
    extensionRoot = root;
}
