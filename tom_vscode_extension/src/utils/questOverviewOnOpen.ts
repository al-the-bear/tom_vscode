/**
 * When a quest window opens, its overview is shown once per quest and machine
 * (handlers/questOverviewOnOpen-handler.ts). The decision, without vscode.
 */

import * as path from 'path';

/** globalState key: the quest ids whose overview was shown on this machine (and VS Code profile). */
export const QUEST_OVERVIEW_SHOWN_KEY = 'tomAi.questOverview.shown';

export interface QuestOverviewSituation {
    /** The window's quest (`default` for none). */
    questId: string;
    /** The overview file exists. */
    overviewExists: boolean;
    /** The quest ids whose overview was shown already. */
    shown: readonly string[];
    /** The overview is open already, in a restored or a running MD Browser tab. */
    alreadyOpen: boolean;
}

export interface QuestOverviewPlan {
    /** Open the overview in the MD Browser. */
    open: boolean;
    /** The shown list to store, when it changes. */
    remember?: string[];
}

export function planQuestOverview(s: QuestOverviewSituation): QuestOverviewPlan {
    if (s.questId === 'default' || !s.questId || !s.overviewExists || s.shown.includes(s.questId)) {
        return { open: false };
    }
    // Open already (a restored tab) still counts as shown.
    return { open: !s.alreadyOpen, remember: [...s.shown, s.questId] };
}

/** The overview file of a quest. */
export function questOverviewFile(questsDir: string, questId: string): string {
    return path.join(questsDir, questId, `overview.${questId}.md`);
}

/**
 * Whether an MD Browser tab shows `file`: by its path, or — a restored tab
 * whose file was not remembered — by its title (`MD: <name>`, `MD (live): <name>`).
 */
export function isOpenInMdBrowser(
    file: string,
    entries: ReadonlyArray<{ filePath: string; label?: string }>,
): boolean {
    const target = path.resolve(file);
    const name = path.basename(file);
    return entries.some((e) => (e.filePath !== '' && path.resolve(e.filePath) === target)
        || (e.filePath === '' && !!e.label && (e.label === `MD: ${name}` || e.label === `MD (live): ${name}`)));
}
