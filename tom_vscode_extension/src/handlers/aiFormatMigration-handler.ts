/**
 * Upgrade the workspace: the `_ai` format migration from the installed
 * extension (vscimpb142; src/utils/aiFormatMigration.ts, aiFormatMigrationRun.ts).
 * No checkout and no Node on PATH needed: the command **@T: Migrate _ai
 * Formats** (`tomAi.migrateAiFormats`) opens a page with the dry run's report,
 * the warning that it cannot be undone and that everyone sharing the workspace
 * must upgrade too, the other windows of this machine on the workspace, and
 * **Migrate now**. The page opens by itself at start while the workspace needs
 * the migration (services/aiFormatCheckService.ts).
 *
 * One migration at a time on a machine (the lock in `_ai/local/`): while
 * another window migrates, the page says so; when it is done already, it says
 * that. After a migration the other windows pause their runs and ask for a
 * reload (aiFormatCheckService.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { AI_FORMAT_VERSION } from '../utils/aiFormatVersion';
import {
    acquireMigrationLock,
    lockHolds,
    makeMigrationMerger,
    migrationNeed,
    migrationReportMarkdown,
    readMigrationLock,
    releaseMigrationLock,
    runAiFormatMigration,
    type MigrationNeed,
} from '../utils/aiFormatMigrationRun';
import type { FormatMigrationResult } from '../utils/aiFormatMigration';
import { aiMergeDriverSummary, type AiMergeDriverReport } from '../utils/aiMergeDriverSetup';
import { hostSlugOf } from '../utils/hostSlug';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { WsPaths } from '../utils/workspacePaths';

export const MIGRATE_AI_FORMATS_COMMAND = 'tomAi.migrateAiFormats';

/** What the page shows. */
export interface MigrationPageState {
    phase: 'review' | 'running' | 'done' | 'failed' | 'locked' | 'current' | 'newer';
    from?: number;
    to: number;
    reason?: 'shared' | 'local';
    reportHtml?: string;
    changes?: number;
    problems?: number;
    windows?: Array<{ label: string }>;
    holder?: string;
    message?: string;
    /** Tom AI did not start in this window (emergency mode, vscimpb142a): after the migration it needs a reload. */
    restartRequired?: boolean;
    /** The `_ai` merge drivers git uses for the workspace (vscimpb142c). */
    mergeDrivers?: MergeDriversView;
}

/** The page's merge-driver section. */
export interface MergeDriversView {
    /** One line per driver, then what is missing. */
    lines: string[];
    /** Every driver is this extension's and bound. */
    ok: boolean;
    /** `_ai` is in a git repository (registering for it alone is possible). */
    repo: boolean;
    /** Some driver points to an older extension install. */
    outdated: boolean;
    /** What the last Register did. */
    note?: string;
}

/** What the page needs from the window (a test may stand in). */
export interface MigrationPageDeps {
    aiRoot(): string | undefined;
    workspaceRoot(): string | undefined;
    host(): string;
    windowId(): string;
    /** Whether a window (by id) has a live heartbeat. */
    isAlive(windowId: string): boolean;
    /** The other live windows of this machine on this workspace, as labels. */
    otherWindows(): Array<{ label: string }>;
    /** Called once this window migrated (its own watcher then does not pause it). */
    onMigrated(version: number): void;
    /** Whether the window started in emergency mode (Tom AI not started; vscimpb142a). Default false. */
    emergency?(): boolean;
    /** The merge drivers' report (vscimpb142c); none: the page leaves the section out. */
    mergeDrivers?(): AiMergeDriverReport | undefined;
    /** Register the extension's drivers (`local`: the `_ai` repository; `global`) and bind them; answers what was done. */
    setUpMergeDrivers?(scope: 'local' | 'global'): string;
}

let panel: vscode.WebviewPanel | undefined;
let lastReport: { markdown: string; result: FormatMigrationResult } | undefined;
let deps: MigrationPageDeps | undefined;

/** Install what the page reads from the window (activation). */
export function setMigrationPageDeps(d: MigrationPageDeps): void {
    deps = d;
}

/** The page's state for `need`, with the dry run when it needs a migration. */
export function migrationPageState(d: MigrationPageDeps, need: MigrationNeed, now = new Date()): MigrationPageState {
    const aiRoot = d.aiRoot();
    if (!aiRoot) { return { phase: 'current', to: AI_FORMAT_VERSION, message: 'No _ai folder in this workspace.' }; }
    if (need.kind === 'newer') { return { phase: 'newer', to: AI_FORMAT_VERSION, message: need.check.kind === 'newer' ? need.check.message : undefined }; }
    if (need.kind === 'current') {
        return { phase: 'current', to: AI_FORMAT_VERSION, message: 'The migration has been done already.', ...(d.emergency?.() ? { restartRequired: true } : {}) };
    }
    const lock = readMigrationLock(aiRoot);
    if (lock && lock.windowId !== d.windowId() && lockHolds(lock, now, (id) => d.isAlive(id))) {
        return { phase: 'locked', to: need.to, from: need.from, reason: need.reason, holder: `window ${lock.windowId}, since ${lock.startedAt}`, message: 'Migration is already running in another window.' };
    }
    const result = runAiFormatMigration({ aiRoot, hostSlug: d.host(), apply: false, merge: () => undefined, ...configPaths(d) });
    const markdown = migrationReportMarkdown(result, false, now);
    lastReport = { markdown, result };
    return {
        phase: 'review', from: need.from, to: need.to, reason: need.reason,
        reportHtml: renderQuestLogMarkdown(markdown), changes: result.changes.length, problems: result.problems.length,
        windows: d.otherWindows(),
    };
}

function configPaths(d: MigrationPageDeps): { workspaceConfigPath?: string; userConfigPath?: string } {
    const ws = d.workspaceRoot();
    return {
        ...(ws ? { workspaceConfigPath: path.join(ws, '.tom', 'tom_vscode_extension.json') } : {}),
        userConfigPath: path.join(require('os').homedir(), '.tom', 'vscode', 'tom_vscode_extension.user.yaml'),
    };
}

/**
 * Migrate now: take the lock (refused while another window holds it, or when the migration has been done
 * already), apply with the extension's `_ai` merge drivers, release the lock. Answers the page's next state.
 */
export function applyMigration(d: MigrationPageDeps, now = new Date()): MigrationPageState {
    const aiRoot = d.aiRoot();
    if (!aiRoot) { return { phase: 'failed', to: AI_FORMAT_VERSION, message: 'No _ai folder in this workspace.' }; }
    const need = migrationNeed(aiRoot, d.host());
    if (need.kind !== 'migrate') { return migrationPageState(d, need, now); }
    const lock = acquireMigrationLock(aiRoot, { windowId: d.windowId(), host: d.host(), pid: process.pid }, now, (id) => d.isAlive(id));
    if (!lock.ok) {
        return { phase: 'locked', to: need.to, from: need.from, holder: `window ${lock.holder.windowId}, since ${lock.holder.startedAt}`, message: 'Migration is already running in another window.' };
    }
    let result: FormatMigrationResult;
    try {
        // The extension's own merge drivers: no git and no registered driver needed (vscimpb142c).
        result = runAiFormatMigration({ aiRoot, hostSlug: d.host(), apply: true, merge: makeMigrationMerger(), ...configPaths(d) });
    } catch (e) {
        releaseMigrationLock(aiRoot, d.windowId());
        return { phase: 'failed', to: need.to, from: need.from, message: `The migration stopped: ${(e as Error).message}` };
    }
    releaseMigrationLock(aiRoot, d.windowId());
    const markdown = migrationReportMarkdown(result, true, now);
    lastReport = { markdown, result };
    if (result.problems.length) {
        return { phase: 'failed', to: need.to, from: need.from, reportHtml: renderQuestLogMarkdown(markdown), changes: result.changes.length, problems: result.problems.length };
    }
    d.onMigrated(need.to);
    return {
        phase: 'done', to: need.to, from: need.from, reportHtml: renderQuestLogMarkdown(markdown), changes: result.changes.length, problems: 0, windows: d.otherWindows(),
        ...(d.emergency?.() ? { restartRequired: true } : {}),
    };
}

/** The last report, written for the MD Browser (scratch, regenerable). */
function writeReport(d: MigrationPageDeps): string | undefined {
    if (!lastReport) { return undefined; }
    const ws = d.workspaceRoot();
    if (!ws) { return undefined; }
    const day = new Date();
    const stamp = `${String(day.getFullYear()).slice(2)}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    const file = path.join(ws, 'ztmp', `${stamp}_ai_format_migration_report.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lastReport.markdown + '\n', 'utf8');
    return file;
}

/** The page's merge-driver section, when the window can check the drivers. */
export function mergeDriversView(d: MigrationPageDeps, note?: string): MergeDriversView | undefined {
    let report: AiMergeDriverReport | undefined;
    try { report = d.mergeDrivers?.(); } catch { report = undefined; }
    if (!report) { return undefined; }
    return {
        lines: aiMergeDriverSummary(report), ok: report.ok, repo: !!report.repoRoot,
        outdated: report.drivers.some((x) => x.state === 'outdated'), ...(note ? { note } : {}),
    };
}

/** The state with the merge-driver section. */
function withDrivers(d: MigrationPageDeps, state: MigrationPageState, note?: string): MigrationPageState {
    const view = mergeDriversView(d, note);
    return view ? { ...state, mergeDrivers: view } : state;
}

/** Register: the page's merge-driver buttons. */
export function setUpMergeDriversFromPage(d: MigrationPageDeps, scope: 'local' | 'global'): string {
    if (!d.setUpMergeDrivers) { return 'This window cannot register merge drivers.'; }
    try { return d.setUpMergeDrivers(scope); } catch (e) { return `Not registered: ${(e as Error).message}`; }
}

/** Open (or bring up) the page. */
export function showAiFormatMigration(context: vscode.ExtensionContext): void {
    const d = deps;
    if (!d) { return; }
    const aiRoot = d.aiRoot();
    const state = withDrivers(d, migrationPageState(d, aiRoot ? migrationNeed(aiRoot, d.host()) : { kind: 'current' }));
    if (panel) {
        panel.reveal();
        void panel.webview.postMessage({ type: 'state', state });
        return;
    }
    panel = vscode.window.createWebviewPanel('tomAi.aiFormatMigration', 'Upgrade the workspace (Tom AI)', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.webview.html = loadWebviewHtml(panel.webview, 'aiFormatMigration', { init: state as unknown as Record<string, unknown> });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
        const view = panel?.webview;
        if (!view) { return; }
        switch (msg.type) {
            case 'apply':
                await view.postMessage({ type: 'state', state: withDrivers(d, applyMigration(d)) });
                return;
            case 'mergeDrivers': {
                const scope = (msg as { scope?: string }).scope === 'global' ? 'global' : 'local';
                const note = setUpMergeDriversFromPage(d, scope);
                const root = d.aiRoot();
                await view.postMessage({ type: 'state', state: withDrivers(d, migrationPageState(d, root ? migrationNeed(root, d.host()) : { kind: 'current' }), note) });
                return;
            }
            case 'openReport': {
                const file = writeReport(d);
                if (file) {
                    const { openMarkdownBrowser } = await import('./markdownBrowser-handler.js');
                    openMarkdownBrowser(context, file);
                }
                return;
            }
            case 'reload':
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return;
            case 'close':
                panel?.dispose();
                return;
        }
    }, undefined, context.subscriptions);
}

/** Tell an open page that another window holds the lock, or that the migration was done meanwhile. */
export function refreshAiFormatMigrationPage(): void {
    const d = deps;
    const aiRoot = d?.aiRoot();
    if (!panel || !d || !aiRoot) { return; }
    void panel.webview.postMessage({ type: 'state', state: withDrivers(d, migrationPageState(d, migrationNeed(aiRoot, d.host()))) });
}

/** The page's command (activation). */
export function registerAiFormatMigrationCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(MIGRATE_AI_FORMATS_COMMAND, () => showAiFormatMigration(context)));
}

/** The machine's host slug (the stamp's `<host>`). */
export function migrationHost(): string {
    return hostSlugOf();
}

/** The workspace's `_ai` folder, when it has one. */
export function migrationAiRoot(): string | undefined {
    const ai = WsPaths.aiRoot;
    return ai && fs.existsSync(ai) ? ai : undefined;
}
