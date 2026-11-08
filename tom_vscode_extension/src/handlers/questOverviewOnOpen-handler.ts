/**
 * At activation of a quest window, open the quest's overview in the MD Browser
 * once per quest and machine (vsc_setup-6). Remembered in globalState
 * (`tomAi.questOverview.shown`), which is per machine and VS Code profile. The
 * focus stays where it is, an editor restored in the window stays visible
 * (the overview opens beside it), and an overview already open in a restored
 * tab is not opened again (it still counts as shown). Afterwards the overview
 * is in @WS › Documentation › Quest Overview.
 *
 * Runs after registerMarkdownBrowser, which registers the restored MD Browser
 * tabs this checks.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { mdBrowserRegistry } from '../utils/mdBrowserRegistry';
import { openMarkdownBrowser } from './markdownBrowser-handler';
import { QUEST_OVERVIEW_SHOWN_KEY, isOpenInMdBrowser, planQuestOverview, questOverviewFile } from '../utils/questOverviewOnOpen';
import { debugLog } from '../utils/debugLogger';

/** What it did: the plan's outcome for the window's quest. */
export type QuestOverviewOutcome = 'opened' | 'alreadyOpen' | 'skipped';

export async function openQuestOverviewOnce(context: vscode.ExtensionContext): Promise<QuestOverviewOutcome> {
    const questId = WsPaths.getWorkspaceQuestId();
    const questsDir = WsPaths.ai('quests');
    if (!questsDir) { return 'skipped'; }
    const file = questOverviewFile(questsDir, questId);
    const shown = context.globalState.get<string[]>(QUEST_OVERVIEW_SHOWN_KEY, []);
    const alreadyOpen = isOpenInMdBrowser(file, mdBrowserRegistry.entries());
    const plan = planQuestOverview({ questId, overviewExists: fs.existsSync(file), shown, alreadyOpen });
    if (plan.remember) { await context.globalState.update(QUEST_OVERVIEW_SHOWN_KEY, plan.remember); }
    if (!plan.open) { return plan.remember ? 'alreadyOpen' : 'skipped'; }
    // Beside a restored editor, so it stays in view; in the active group when there is none.
    const viewColumn = vscode.window.visibleTextEditors.length > 0 ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    openMarkdownBrowser(context, file, { show: { viewColumn, preserveFocus: true } });
    debugLog(`[QuestOverview] opened ${path.basename(file)} once for quest ${questId}`, 'INFO', 'extension.activate');
    return 'opened';
}
