/**
 * @TOM VSC › PREREQUISITES: the workspace's `prerequisites.yaml` files — the
 * secrets each project needs and how to provide them, and the software it
 * expects — as a tree repository → project → section → secret / tool → option,
 * with what VS Code can check (presence only, never a value).
 *
 * - **Discovery** (services/prerequisitesService.ts): the projects of the
 *   workspace listing and their repositories; re-read when a
 *   `prerequisites.yaml` changes. Projects without a file are listed in their
 *   own group (collapsed at first), each with **Create**.
 * - **Checks** run only on **Check now** / **Refresh**: there are many
 *   projects and some checks run programs. The results and the time of the
 *   check are kept in VS Code's global storage (one per installation), so
 *   another window shows them at once without checking again.
 * - **Collapse state** and the filter are kept in global storage too, per
 *   node (`<file>#<node id>`), never in `_ai`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { registerGatedWebviewViewProvider } from './webviewViewGate';
import { listWorkspaceProjects, type ProjectListing } from '../services/workspaceProjects';
import {
    discoverPrerequisites, liveCheckDeps, pendingChecks, probeLoginShell, runChecks, shellQuestions,
} from '../services/prerequisitesService';
import { PREREQUISITES_FILE, prerequisitesLineOf, prerequisitesSkeleton, type CheckResult, type PrerequisiteCheckDeps } from '../utils/prerequisites';
import { buildPrerequisitesTree, type DiscoveredFile, type DiscoveredProject } from '../utils/prerequisitesTree';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { WsPaths } from '../utils/workspacePaths';

export const PREREQUISITES_VIEW_ID = 'tomAi.prerequisites';
/** `{checkedAt, durationMs, results}`: the last check, for every window of this installation. */
export const PREREQUISITES_RESULTS_KEY = 'tomAi.prerequisites.results';
/** `{[nodeKey]: boolean}`: which nodes are open. */
export const PREREQUISITES_EXPANDED_KEY = 'tomAi.prerequisites.expanded';
/** `{missingOnly, requiredOnly}`. */
export const PREREQUISITES_FILTER_KEY = 'tomAi.prerequisites.filter';

/** What the view lists projects and checks with; tests give their own. */
export interface PrerequisitesViewDeps {
    listProjects(root: string, fresh: boolean): Promise<ProjectListing>;
    /** The check effects for one run (the login shell asked once for these names). */
    checkDeps(envNames: string[], commands: string[], vscodeSecretHas: (key: string) => Promise<boolean>): Promise<PrerequisiteCheckDeps>;
}

export const LIVE_PREREQUISITES_VIEW_DEPS: PrerequisitesViewDeps = {
    listProjects: (root, fresh) => listWorkspaceProjects(root, { fresh }),
    checkDeps: async (envNames, commands, vscodeSecretHas) => liveCheckDeps(await probeLoginShell(envNames, commands), vscodeSecretHas),
};

export interface StoredResults {
    checkedAt: string;
    durationMs: number;
    results: Record<string, CheckResult>;
}

export class PrerequisitesViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private files: DiscoveredFile[] = [];
    private without: DiscoveredProject[] = [];
    private root = '';
    private note: { text: string; error?: boolean } | undefined;
    private scanned = false;
    private checking: { done: number; total: number } | null = null;
    private live: Record<string, CheckResult> = {};
    private lastPost = 0;

    constructor(private readonly context: vscode.ExtensionContext, private readonly deps: PrerequisitesViewDeps = LIVE_PREREQUISITES_VIEW_DEPS) {
        const watcher = vscode.workspace.createFileSystemWatcher(`**/${PREREQUISITES_FILE}`);
        const changed = (): void => { if (this.scanned) { void this.rescan(); } };
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
        watcher.onDidDelete(changed);
        context.subscriptions.push(watcher);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'prerequisites', {
            init: {
                codiconsUri: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')).toString(),
            },
        });
        webviewView.webview.onDidReceiveMessage((msg) => void this.handle(msg), undefined, this.context.subscriptions);
        // Another window may have checked meanwhile: its results are in global storage.
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.send(); } });
        webviewView.onDidDispose(() => { this.view = undefined; });
    }

    private stored(): StoredResults | undefined {
        return this.context.globalState.get<StoredResults>(PREREQUISITES_RESULTS_KEY);
    }

    /** Find the files again (the listing is cached for 30 s; `fresh` asks buildkit again). */
    private async rescan(fresh = false): Promise<void> {
        const root = WsPaths.wsRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { this.note = { text: 'No workspace folder is open.', error: true }; this.send(); return; }
        this.root = root;
        const listing = await this.deps.listProjects(root, fresh);
        if (!listing.ok) {
            this.note = { text: `The projects could not be listed: ${listing.error}`, error: true };
            this.files = [];
            this.without = [];
        } else {
            this.note = listing.source === 'javascript' ? { text: listing.fallback.reason } : undefined;
            const found = discoverPrerequisites(root, listing.projects);
            this.files = found.files;
            this.without = found.without;
        }
        this.scanned = true;
        this.send();
    }

    private send(): void {
        if (!this.view) { return; }
        const stored = this.stored();
        const results = { ...(stored?.results ?? {}), ...this.live };
        const tree = buildPrerequisitesTree(this.files, this.without, results, this.root || '/');
        void this.view.webview.postMessage({
            type: 'state',
            scanned: this.scanned,
            tree,
            checkedAt: stored?.checkedAt ?? null,
            durationMs: stored?.durationMs ?? null,
            checking: this.checking,
            expanded: this.context.globalState.get<Record<string, boolean>>(PREREQUISITES_EXPANDED_KEY, {}),
            filter: this.context.globalState.get(PREREQUISITES_FILTER_KEY, { missingOnly: false, requiredOnly: false }),
            note: this.note ?? null,
        });
    }

    /** Run every check; one at a time per program, the results kept for every window. */
    private async check(): Promise<void> {
        if (this.checking) { return; }
        await this.rescan(true);
        const checks = pendingChecks(this.files, process.platform, process.env.PATH);
        this.checking = { done: 0, total: checks.length };
        this.live = {};
        this.send();
        const started = Date.now();
        try {
            const q = shellQuestions(this.files);
            const deps = await this.deps.checkDeps(q.env, q.cmd, async (key) => (await this.context.secrets.get(key)) !== undefined);
            const results = await runChecks(checks, deps, (key, result, done) => {
                this.live[key] = result;
                this.checking = { done, total: checks.length };
                // At most a few posts a second while checking.
                if (Date.now() - this.lastPost > 300) { this.lastPost = Date.now(); this.send(); }
            });
            const stored: StoredResults = { checkedAt: new Date().toISOString(), durationMs: Date.now() - started, results };
            await this.context.globalState.update(PREREQUISITES_RESULTS_KEY, stored);
        } catch (e) {
            this.note = { text: `The check failed: ${(e as Error).message}`, error: true };
        } finally {
            this.checking = null;
            this.live = {};
            this.send();
        }
    }

    /** A message from the webview (public for tests). */
    async handle(msg: { type: string; node?: string; expanded?: boolean; file?: string; nodeId?: string; dir?: string; name?: string; filter?: unknown }): Promise<void> {
        switch (msg.type) {
            case 'ready':
                if (!this.scanned) { await this.rescan(); } else { this.send(); }
                return;
            case 'check':
                await this.check();
                return;
            case 'toggle': {
                if (!msg.node) { return; }
                const expanded = { ...this.context.globalState.get<Record<string, boolean>>(PREREQUISITES_EXPANDED_KEY, {}) };
                expanded[msg.node] = !!msg.expanded;
                await this.context.globalState.update(PREREQUISITES_EXPANDED_KEY, expanded);
                return;
            }
            case 'filter':
                await this.context.globalState.update(PREREQUISITES_FILTER_KEY, msg.filter);
                this.send();
                return;
            case 'open': {
                if (!msg.file || !this.isKnownFile(msg.file)) { return; }
                await openAt(msg.file, msg.nodeId);
                return;
            }
            case 'create': {
                const project = this.without.find((p) => p.dir === msg.dir);
                if (!project) { return; }
                const file = path.join(project.dir, PREREQUISITES_FILE);
                if (fs.existsSync(file)) { await openAt(file); return; }
                fs.writeFileSync(file, prerequisitesSkeleton(project.name), 'utf8');
                await this.rescan();
                await openAt(file);
                return;
            }
        }
    }

    private isKnownFile(file: string): boolean {
        return this.files.some((f) => f.file === file);
    }
}

/** Open the file at a node's line (its section or item), else at the top. */
async function openAt(file: string, nodeId?: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const line = nodeId ? Math.max(0, prerequisitesLineOf(doc.getText(), nodeId)) : 0;
    const pos = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(pos, pos) });
}

/** Register @TOM VSC's PREREQUISITES view. */
export function registerPrerequisitesView(context: vscode.ExtensionContext, deps: PrerequisitesViewDeps = LIVE_PREREQUISITES_VIEW_DEPS): PrerequisitesViewProvider {
    const provider = new PrerequisitesViewProvider(context, deps);
    context.subscriptions.push(registerGatedWebviewViewProvider(PREREQUISITES_VIEW_ID, provider));
    return provider;
}
