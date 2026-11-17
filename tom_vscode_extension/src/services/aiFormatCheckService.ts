/**
 * The `_ai` format version at start and while the window runs
 * (src/utils/aiFormatVersion.ts, aiFormatMigrationRun.ts; vscimpb142, vscimpb142a):
 *
 *   - {@link aiFormatStartGate}, before the extension starts its normal parts:
 *     the files are older than this build (the shared stamp missing or older,
 *     or this machine's own files behind — the machine-local stamp) or NEWER
 *     than it: Tom AI does not start; every panel shows a hint, with
 *     **Upgrade the workspace…** (the migration page, which also opens by
 *     itself) or the newer build to install. When only this machine's own
 *     files are behind and the dry run finds nothing to do, the local stamp is
 *     written quietly and the window starts normally;
 *   - {@link startAiFormatCheck}, in a window that started normally: another
 *     window migrates under it (the shared stamp changes): this window pauses
 *     the auto-send of every run and shows the reload overlay
 *     (handlers/reloadOverlay-handler.ts) — the prompts still running, each
 *     with Interrupt, and Reload window; nothing new starts.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { AI_FORMAT_FILE, AI_FORMAT_VERSION, readAiFormatStamp, localDate } from '../utils/aiFormatVersion';
import {
    formatEmergencyHint,
    formatMigratedHint,
    lockHolds,
    migrationLockFile,
    migrationNeed,
    readMigrationLock,
    runAiFormatMigration,
    writeLocalStamp,
} from '../utils/aiFormatMigrationRun';
import { registerMinimalModePanels, type MinimalModePanels } from '../handlers/minimalMode-handler';
import { showReloadOverlay, type ReloadOverlayDeps } from '../handlers/reloadOverlay-handler';
import { checkAiMergeDrivers, installAiMergeDrivers, outdatedDriverUpdate, setUpAiMergeDrivers } from '../utils/aiMergeDriverSetup';
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

const UPGRADE = 'Upgrade the workspace…';
const UPDATE_DRIVERS = 'Update the merge drivers';
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

/** The overlay's dependencies: this window's queue, its chat sends, the Prompt Queue editor's column. */
export function reloadOverlayDeps(): ReloadOverlayDeps {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qm = () => (require('../managers/promptQueueManager.js') as typeof import('../managers/promptQueueManager')).PromptQueueManager.instance;
    return {
        items: () => { try { return qm().items; } catch { return []; } },
        autoSend: (run) => { try { return qm().runQueueSettings(run).autoSend; } catch { return false; } },
        windowId,
        onDidChange: (listener) => { try { return qm().onDidChange(listener); } catch { return { dispose: () => undefined }; } },
        interruptItem: (id) => { try { return qm().interruptActiveItemForContinuation(id, undefined, { hard: true }); } catch { return false; } },
        cancelChat: (id) => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            try { return (require('../handlers/sendToChatState.js') as typeof import('../handlers/sendToChatState')).cancelAnthropicSendOfChatItem(id) !== undefined; } catch { return false; }
        },
        viewColumn: () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            try { return (require('../handlers/queueEditor-handler.js') as typeof import('../handlers/queueEditor-handler')).queueEditorViewColumn(); } catch { return undefined; }
        },
    };
}

/** The page's dependencies for this window. */
function installMigrationDeps(aiRoot: string, host: string, emergency: boolean, onMigrated: (version: number) => void): void {
    setMigrationPageDeps({
        aiRoot: () => aiRoot,
        workspaceRoot: () => WsPaths.wsRoot,
        host: () => host,
        windowId,
        isAlive: (id) => id === windowId() || liveStates().some((s) => s.windowId === id),
        otherWindows: () => liveStates()
            .filter((s) => s.windowId !== windowId() && (s.workspace === path.basename(WsPaths.wsRoot ?? '') || !!s.activeQuest))
            .map((s) => ({ label: `${s.activeQuest || '(no quest)'} — ${s.workspace || s.windowId}` })),
        onMigrated,
        emergency: () => emergency,
        mergeDrivers: () => checkAiMergeDrivers(aiRoot),
        setUpMergeDrivers: (scope) => {
            const r = setUpAiMergeDrivers(aiRoot, scope);
            return `Registered the extension's ${r.drivers.length} merge drivers (${scope === 'local' ? 'this repository' : 'global'})`
                + (r.bound.length ? `; ${r.bound.length} rule(s) added to _ai/.gitattributes.` : '.');
        },
    });
}

/**
 * The merge drivers' upgrade check (vscimpb142c): drivers registered from an older install of the extension
 * (another folder, another Node) are offered for an update, a few seconds after the start.
 */
function checkMergeDriverUpgrade(context: vscode.ExtensionContext, aiRoot: string): void {
    const timer = setTimeout(() => {
        let update: ReturnType<typeof outdatedDriverUpdate>;
        try { update = outdatedDriverUpdate(checkAiMergeDrivers(aiRoot)); } catch { return; }
        if (!update) { return; }
        const u = update;
        void vscode.window.showInformationMessage(`Tom AI: the _ai merge drivers git uses (${u.drivers.join(', ')}) point to an older Tom AI install.`, UPDATE_DRIVERS)
            .then((picked) => {
                if (picked !== UPDATE_DRIVERS) { return; }
                try {
                    installAiMergeDrivers(aiRoot, u.scope, { only: u.drivers });
                    void vscode.window.showInformationMessage(`Tom AI: ${u.drivers.length} merge driver(s) updated (${u.scope}).`);
                } catch (e) {
                    void vscode.window.showWarningMessage(`Tom AI: the merge drivers were not updated: ${(e as Error).message}`);
                }
            });
    }, 5000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

/** A watcher on the shared stamp and the migration lock. */
function watchStampAndLock(context: vscode.ExtensionContext, aiRoot: string, onChange: () => void): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(aiRoot, `{${AI_FORMAT_FILE},local/${path.basename(migrationLockFile(aiRoot))}}`));
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(() => refreshAiFormatMigrationPage());
    context.subscriptions.push(watcher);
}

function reloadWindow(): void {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * Before the extension starts its normal parts (vscimpb142a): when the workspace's `_ai` files are not in
 * this build's format, Tom AI does not start. Every panel shows the hint of {@link formatEmergencyHint} —
 * **Upgrade the workspace…** for an older workspace (the page also opens by itself), the build to install for
 * newer files — and the command @T: Migrate _ai Formats is the only one registered. Once the workspace is
 * migrated (here or in another window) the panels and the page ask for a reload. When only this machine's
 * own files are behind and the dry run finds nothing to do, the local stamp is written quietly and the
 * window starts normally. Answers whether the window is in emergency mode (the caller stops activating).
 */
export function aiFormatStartGate(context: vscode.ExtensionContext): boolean {
    const aiRoot = migrationAiRoot();
    if (!aiRoot) { return false; }
    const host = migrationHost();
    const need = migrationNeed(aiRoot, host);
    if (need.kind === 'current') { return false; }
    if (need.kind === 'migrate' && need.reason === 'local' && quietLocalOnly(aiRoot, host)) { return false; }
    const hint = formatEmergencyHint(need);
    if (!hint) { return false; }

    registerAiFormatMigrationCommand(context);
    let panels: MinimalModePanels | undefined;
    let migrated = false;
    const showMigrated = (version: number): void => {
        if (migrated) { return; }
        migrated = true;
        panels?.update({ mode: 'format', hint: formatMigratedHint(version) });
    };
    installMigrationDeps(aiRoot, host, true, showMigrated);
    panels = registerMinimalModePanels(context, { mode: 'format', hint });

    if (need.kind === 'newer') {
        void vscode.window.showWarningMessage(`Tom AI does not start: ${hint.text}`, RELOAD)
            .then((picked) => { if (picked === RELOAD) { reloadWindow(); } });
    } else {
        const lock = readMigrationLock(aiRoot);
        const held = lock && lock.windowId !== windowId() && lockHolds(lock, new Date(), (id) => liveStates().some((s) => s.windowId === id));
        if (held) {
            void vscode.window.showInformationMessage('Tom AI does not start: Migration is already running in another window. Reload this window once it is done.', RELOAD)
                .then((picked) => { if (picked === RELOAD) { reloadWindow(); } });
        } else {
            void vscode.window.showWarningMessage(`Tom AI does not start: ${hint.text}`, UPGRADE)
                .then((picked) => { if (picked === UPGRADE) { void vscode.commands.executeCommand(MIGRATE_AI_FORMATS_COMMAND); } });
        }
        showAiFormatMigration(context);
    }

    // Migrated meanwhile (this window or another): the panels ask for a reload.
    watchStampAndLock(context, aiRoot, () => {
        refreshAiFormatMigrationPage();
        if (migrationNeed(aiRoot, host).kind === 'current') { showMigrated(readAiFormatStamp(aiRoot)?.version ?? AI_FORMAT_VERSION); }
    });
    return true;
}

/**
 * The check of a window that started normally (the workspace in this build's format): the migration
 * command, and the watchers — another window migrating under this one (the shared stamp changes) pauses
 * the auto-send of every run and shows the reload overlay; an open page follows the lock.
 */
export function startAiFormatCheck(context: vscode.ExtensionContext): void {
    registerAiFormatMigrationCommand(context);
    const aiRoot = migrationAiRoot();
    if (!aiRoot) { return; }
    const host = migrationHost();
    let migratedHere = false;
    const startedWith = readAiFormatStamp(aiRoot)?.version;
    installMigrationDeps(aiRoot, host, false, () => { migratedHere = true; });
    checkMergeDriverUpgrade(context, aiRoot);

    let warned = false;
    watchStampAndLock(context, aiRoot, () => {
        refreshAiFormatMigrationPage();
        const now = readAiFormatStamp(aiRoot)?.version;
        if (migratedHere || warned || now === undefined || now === startedWith) { return; }
        warned = true;
        pauseAllRuns();
        // The reload overlay (vscimpb142b): the prompts still running, each with Interrupt, and Reload window.
        showReloadOverlay(context, reloadOverlayDeps(), now);
    });
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
