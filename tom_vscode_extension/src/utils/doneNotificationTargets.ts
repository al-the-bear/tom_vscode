/**
 * Where a queue item's done notification goes, as the queue editor offers it
 * (vscimpb71): the quest picker and the run picker. vscode-free; the handler
 * shows the picks.
 */

const DEFAULT_RUN = 'default';

export interface TargetPick {
    label: string;
    /** The value stored: '' resets to the default. */
    value: string;
    description?: string;
    /** A second line: the quest's short description (vscimpb145). */
    detail?: string;
}

/**
 * The quests to pick from: this quest first (the default), then the quests
 * with a window running on this machine (as tomAi_getQuestWindowStatus lists
 * them), then every other quest — a notification for those waits in their
 * inbox until a window starts.
 */
/** The pick that opens the choice among every quest (the workspace's quests come first, vscimpb144). */
export const ALL_QUESTS_PICK = '__all_quests__';

export function questPicks(ownQuest: string, allQuests: readonly string[], liveQuests: ReadonlySet<string>, workspaceQuests?: readonly string[], describe?: (quest: string) => string | undefined): TargetPick[] {
    if (workspaceQuests) {
        const inWorkspace = new Set(workspaceQuests);
        const shown = allQuests.filter((q) => q === ownQuest || inWorkspace.has(q));
        if (shown.length < allQuests.length) {
            return [
                ...questPicks(ownQuest, shown, liveQuests, undefined, describe),
                { label: '$(list-flat) All quests…', value: ALL_QUESTS_PICK, description: `every quest (${allQuests.length})` },
            ];
        }
    }
    const others = allQuests.filter((q) => q !== ownQuest);
    const live = others.filter((q) => liveQuests.has(q)).sort();
    const idle = others.filter((q) => !liveQuests.has(q)).sort();
    // Each quest's short description (vscimpb145) as the pick's detail line, when there is one.
    const withDetail = (p: TargetPick, quest: string): TargetPick => {
        const detail = describe?.(quest);
        return detail ? { ...p, detail } : p;
    };
    return [
        withDetail({ label: ownQuest, value: '', description: 'this quest (default)' }, ownQuest),
        ...live.map((q) => withDetail({ label: q, value: q, description: 'a window is running' }, q)),
        ...idle.map((q) => withDetail({ label: q, value: q, description: 'no window running: waits in its inbox until one starts' }, q)),
    ];
}

/**
 * The runs to pick from in `quest`: its default first (the item's run in this
 * quest, `default` in another), then the others.
 */
export function runPicks(runs: readonly string[], ownQuestTarget: boolean, itemRun: string): TargetPick[] {
    const defaultRun = ownQuestTarget ? (itemRun || DEFAULT_RUN) : DEFAULT_RUN;
    const all = Array.from(new Set([DEFAULT_RUN, ...runs, ...(ownQuestTarget ? [defaultRun] : [])]));
    const rest = all.filter((r) => r !== defaultRun).sort((a, b) => (a === DEFAULT_RUN ? -1 : b === DEFAULT_RUN ? 1 : a.localeCompare(b)));
    return [
        { label: defaultRun, value: '', description: ownQuestTarget ? 'the item\'s run (default)' : 'default' },
        ...rest.map((r) => ({ label: r, value: r })),
    ];
}
