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
}

/**
 * The quests to pick from: this quest first (the default), then the quests
 * with a window running on this machine (as tomAi_getQuestWindowStatus lists
 * them), then every other quest — a notification for those waits in their
 * inbox until a window starts.
 */
export function questPicks(ownQuest: string, allQuests: readonly string[], liveQuests: ReadonlySet<string>): TargetPick[] {
    const others = allQuests.filter((q) => q !== ownQuest);
    const live = others.filter((q) => liveQuests.has(q)).sort();
    const idle = others.filter((q) => !liveQuests.has(q)).sort();
    return [
        { label: ownQuest, value: '', description: 'this quest (default)' },
        ...live.map((q) => ({ label: q, value: q, description: 'a window is running' })),
        ...idle.map((q) => ({ label: q, value: q, description: 'no window running: waits in its inbox until one starts' })),
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
