/**
 * At start, and while the window runs, the `_ai` format version
 * (src/utils/aiFormatVersion.ts, aiFormatMigrationRun.ts; vscimpb142):
 *
 *   - the files are NEWER than this build: a warning to install the newer
 *     build (a migration never goes back);
 *   - the workspace needs the migration — the shared stamp is missing or
 *     older, or this machine's own files are behind (the machine-local stamp):
 *     the page **Upgrade the workspace** opens by itself (@T: Migrate _ai
 *     Formats), unless another window is migrating already ("Migration is
 *     already running in another window"). When only this machine's own files
 *     are behind and the dry run finds nothing to do, the local stamp is
 *     written quietly;
 *   - another window migrates while this one runs (the shared stamp changes
 *     under it): this window pauses the auto-send of every run and asks for a
 *     reload — the running prompts finish, nothing new starts.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { AI_FORMAT_FILE, AI_FORMAT_VERSION, readAiFormatStamp, localDate } from '../utils/aiFormatVersion';
import { lockHolds, migrationLockFile, migrationNeed, readMigrationLock, runAiFormatMigration, writeLocalStamp, type MigrationNeed } from '../utils/aiFormatMigrationRun';
import { WsPaths } from '../utils/workspacePaths';
import {
    migrationAiRoot,
    migrationHost,
    refreshAiFormatMigrationPage,
    registerAiFormatMigrationCommand,
    setMigrationPageDeps,
    showAiFormatMigration,
    MIGRATE_AI_FORMATS_COMMAND,
} from '../handlers/aiFormatMigration-handler';

const SHOW = 'Show migration';
const RELOAD = 'Reload window';

/** The window id the window-state files use. */
function windowId(): string {
    return `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
}

function liveStates(): Array<{ windowId: string; workspace?: string; activeQuest?: string }> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ws = require('../handlers/windowStatusPanel-handler.js') as typeof import('../handlers/windowStatusPanel-handler');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const hb = require('../utils/windowHeartbeat.js') as typeof import('../utils/windowHeartbeat');
        const now = Date.now();
        return ws.loadAllWindowStates().filter((s) => hb.isWindowAlive(s, now));
    } catch {
        return [];
    }
}

/** Pause every run's auto-send of this window: the running prompts finish, nothing new starts. */
function pauseAllRuns(): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const qm = (require('../managers/promptQueueManager.js') as typeof import('../managers/promptQueueManager')).PromptQueueManager.instance;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        const runs = store ? store.runs().map((r) => r.run) : ['default'];
        for (const run of new Set(['default', ...runs])) { qm.setRunAutoSend(run, false); }
    } catch { /* no queue */ }
}

/** The warning a window shows when another window migrated the workspace under it. */
export function reloadRequiredText(version: number): string {
    return `Tom AI: the workspace has been migrated to format version ${version}; a reload is required. All runs of this window have been paused: let the running prompts finish, then reload.`;
}

/**
 * The check at start: the migration page, the newer-build warning, or nothing; and the watchers on the
 * shared stamp and the lock. Answers what the window needs.
 */
export function startAiFormatCheck(context: vscode.ExtensionContext): MigrationNeed | undefined {
    const aiRoot = migrationAiRoot();
    registerAiFormatMigrationCommand(context);
    if (!aiRoot) { return undefined; }
    const host = migrationHost();
    let migratedHere = false;
    const startedWith = readAiFormatStamp(aiRoot)?.version;
    setMigrationPageDeps({
        aiRoot: () => aiRoot,
        workspaceRoot: () => WsPaths.wsRoot,
        host: () => host,
        windowId,
        isAlive: (id) => id === windowId() || liveStates().some((s) => s.windowId === id),
        otherWindows: () => liveStates()
            .filter((s) => s.windowId !== windowId() && (s.workspace === path.basename(WsPaths.wsRoot ?? '') || !!s.activeQuest))
            .map((s) => ({ label: `${s.activeQuest || '(no quest)'} — ${s.workspace || s.windowId}` })),
        onMigrated: () => { migratedHere = true; },
    });

    const need = migrationNeed(aiRoot, host);
    if (need.kind === 'newer' && need.check.kind === 'newer') {
        void vscode.window.showWarningMessage(`Tom AI: ${need.check.message}`);
    } else if (need.kind === 'migrate') {
        const lock = readMigrationLock(aiRoot);
        const held = lock && lock.windowId !== windowId() && lockHolds(lock, new Date(), (id) => liveStates().some((s) => s.windowId === id));
        if (held) {
            void vscode.window.showInformationMessage('Tom AI: Migration is already running in another window. Reload this window once it is done.', RELOAD)
                .then((picked) => { if (picked === RELOAD) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); } });
        } else if (need.reason === 'local' && quietLocalOnly(aiRoot, host)) {
            // This machine's own files had nothing in an older form: stamped, nothing to show.
        } else {
            showAiFormatMigration(context);
            void vscode.window.showWarningMessage(`Tom AI: this workspace needs the _ai format migration to version ${AI_FORMAT_VERSION}.`, SHOW)
                .then((picked) => { if (picked === SHOW) { void vscode.commands.executeCommand(MIGRATE_AI_FORMATS_COMMAND); } });
        }
    }

    // Another window migrates under this one: pause, ask for a reload. The page follows the lock.
    let warned = false;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(aiRoot, `{${AI_FORMAT_FILE},local/${path.basename(migrationLockFile(aiRoot))}}`));
    const onChange = (): void => {
        refreshAiFormatMigrationPage();
        const now = readAiFormatStamp(aiRoot)?.version;
        if (migratedHere || warned || now === undefined || now === startedWith) { return; }
        warned = true;
        pauseAllRuns();
        void vscode.window.showWarningMessage(reloadRequiredText(now), { modal: false }, RELOAD)
            .then((picked) => { if (picked === RELOAD) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); } });
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(() => refreshAiFormatMigrationPage());
    context.subscriptions.push(watcher);
    return need;
}

/** Only this machine's files are behind: a dry run that finds nothing writes the local stamp. Answers whether it did. */
function quietLocalOnly(aiRoot: string, host: string): boolean {
    try {
        const dry = runAiFormatMigration({ aiRoot, hostSlug: host, apply: false, merge: () => undefined });
        if (dry.changes.length || dry.problems.length) { return false; }
        writeLocalStamp(aiRoot, host, { version: AI_FORMAT_VERSION, date: localDate() });
        return true;
    } catch {
        return false;
    }
}
