/**
 * The iteration a queue prompt belongs to, for per-iteration sessions.
 *
 * An item's main prompt runs once per iteration — each round of a repeat
 * count, each todo of a `<prefix>*` walk. A per-iteration session
 * (src/utils/agentSdkSessions.ts) keeps one conversation per iteration, so
 * every prompt the queue sends names its iteration with a key:
 *
 *   `<item id>/<run id>/<n>`
 *
 * `n` counts the main prompts of this run (`iterationSeq`, the number already
 * sent). The main prompt starts iteration `n + 1`; a pre-prompt runs in the
 * iteration it precedes (the next one, `n + 1`); a follow-up in the one it
 * follows (the last, `n`, at least 1). The run id changes when the item is
 * started again from the beginning (Send Now on a sent item resets it), so a
 * second run never continues the first run's conversations.
 *
 * Pure.
 */

export type IterationStage = 'prePrompt' | 'main' | 'followUp';

export interface IterationItem {
    id: string;
    /** This run of the item; set on its first dispatch, cleared by a reset. */
    runId?: string;
    /** Main prompts sent in this run. */
    iterationSeq?: number;
}

/** The key of the iteration a prompt of `stage` belongs to. */
export function iterationKeyFor(item: IterationItem, stage: IterationStage): string {
    const sent = item.iterationSeq ?? 0;
    const n = stage === 'followUp' ? Math.max(sent, 1) : sent + 1;
    return `${item.id}/${item.runId ?? 'run'}/${n}`;
}

/** Give the item a run id when it has none (its first dispatch, or the first after a reset). */
export function ensureRunId(item: IterationItem, makeId: () => string): string {
    if (!item.runId) { item.runId = makeId(); }
    return item.runId;
}
