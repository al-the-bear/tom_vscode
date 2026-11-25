/**
 * Wires the notice after a reconcile (src/services/historyRebuildNotice.ts)
 * into the window: a watcher on the quest's `history/` folder, a check at
 * window start, and a non-modal information message whose action runs
 * "Rebuild history and memory" (AnthropicHandler.rebuildQuestHistoryAndMemory).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createHistoryRebuildNotifier } from '../services/historyRebuildNotice';
import { hostSlugOf } from '../utils/hostSlug';
import { WsPaths } from '../utils/workspacePaths';

/** The action of the notice. */
export const REBUILD_HISTORY_ACTION = 'Rebuild history and memory';

/** The notice's text, naming the hosts whose newer turns the history does not cover. */
export function historyRebuildNoticeText(hosts: readonly string[]): string {
    return `The trail of ${hosts.join(', ')} holds turns the quest history does not cover yet (brought by a reconcile).`;
}

/** Start the notice for this window's quest (nothing without a quest). */
export function registerHistoryRebuildNotice(context: vscode.ExtensionContext): void {
    const quest = WsPaths.getWorkspaceQuestId();
    const questFolder = quest ? WsPaths.ai('quests', quest) : undefined;
    if (!quest || !questFolder || !fs.existsSync(questFolder)) { return; }
    const notifier = createHistoryRebuildNotifier({
        questFolder,
        ownHost: hostSlugOf(),
        show: (hosts) => {
            void vscode.window.showInformationMessage(historyRebuildNoticeText(hosts), REBUILD_HISTORY_ACTION).then(async (choice) => {
                if (choice !== REBUILD_HISTORY_ACTION) { return; }
                const handler = (await import('./anthropic-handler.js')).AnthropicHandler.instance;
                await handler.rebuildQuestHistoryAndMemory(quest);
            });
        },
    });
    // Several events for one pull: checked once they settle.
    const timers = new Map<string, NodeJS.Timeout>();
    const onChange = (uri: vscode.Uri): void => {
        const name = path.basename(uri.fsPath);
        clearTimeout(timers.get(name));
        timers.set(name, setTimeout(() => { timers.delete(name); notifier.onHistoryFileChanged(name); }, 2000));
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(questFolder, 'history')), 'trail.*.md'));
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    const start = setTimeout(() => notifier.check(), 5000);
    context.subscriptions.push(watcher, { dispose: () => { clearTimeout(start); for (const t of timers.values()) { clearTimeout(t); } } });
}
