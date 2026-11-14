/**
 * Removing a deleted run's queue (vscimpb86): the Prompt Queue editor keeps a
 * tab for a run that was deleted while it still had items, and that tab gets
 * a remove button. Removing it deletes the run's items in the extension host
 * and its queue settings (`runs.<run>` of queue-settings.yaml).
 *
 * When some of its items are not finished (staged, pending, sending,
 * interrupted …), the user chooses: delete all of them (a sending one is
 * stopped, as removing it does), or delete only the finished ones — sent and
 * failed — and keep the tab with the others.
 *
 * vscode-free: the plan and the dialog's words; the queue manager removes.
 */

import { itemRun, type LaneItem } from './queueLanes';

/** The statuses a removal of only the finished items deletes. */
export const FINISHED_RUN_ITEM_STATUSES: readonly string[] = ['sent', 'chat-sent', 'error'];

export type RunQueueRemovalMode = 'all' | 'finished';

export interface RunQueueRemovalPlan {
    run: string;
    /** Every item of the run. */
    total: number;
    /** The ids of its finished items (sent, failed). */
    finished: string[];
    /** The ids of its other items, and their count per status. */
    open: string[];
    openByStatus: Record<string, number>;
    /** Whether one of them is sending now (removing it stops it). */
    sending: boolean;
}

/** What removing `run`'s queue would delete. */
export function runQueueRemovalPlan(items: ReadonlyArray<LaneItem & { id: string; status: string }>, run: string): RunQueueRemovalPlan {
    const own = items.filter((i) => itemRun(i) === run);
    const finished = own.filter((i) => FINISHED_RUN_ITEM_STATUSES.includes(i.status));
    const open = own.filter((i) => !FINISHED_RUN_ITEM_STATUSES.includes(i.status));
    const openByStatus: Record<string, number> = {};
    for (const i of open) { openByStatus[i.status] = (openByStatus[i.status] ?? 0) + 1; }
    return {
        run,
        total: own.length,
        finished: finished.map((i) => i.id),
        open: open.map((i) => i.id),
        openByStatus,
        sending: open.some((i) => i.status === 'sending'),
    };
}

/** Why `run`'s queue cannot be removed (undefined: it can): `default` and the quest's live runs keep theirs. */
export function runQueueRemovalRefused(run: string, liveRuns: readonly string[]): string | undefined {
    if (!run || run === 'default') { return 'the default run\'s queue cannot be removed'; }
    if (liveRuns.includes(run)) { return `run ${run} is one of the quest's runs (only a deleted run's queue can be removed)`; }
    return undefined;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The confirmation: its message, detail and buttons, each button the mode it removes with. */
export function runQueueRemovalDialog(plan: RunQueueRemovalPlan): { message: string; detail: string; choices: Array<{ label: string; mode: RunQueueRemovalMode }> } {
    const message = `Remove the queue of the deleted run ${plan.run}?`;
    if (plan.open.length === 0) {
        return {
            message,
            detail: `Its ${plural(plan.total, 'item')} (sent or failed) are deleted, and its queue settings with them; the tab goes away.`,
            choices: [{ label: `Delete ${plural(plan.total, 'item')}`, mode: 'all' }],
        };
    }
    const open = Object.entries(plan.openByStatus).map(([status, n]) => `${n} ${status}`).join(', ');
    return {
        message,
        detail: [
            `It has ${plural(plan.total, 'item')}: ${plan.finished.length} sent or failed, and ${plan.open.length} not finished (${open}).`,
            `Delete all: every item goes${plan.sending ? ' — the sending one is stopped, as deleting it does' : ''}, with the run's queue settings, and the tab goes away.`,
            `Delete only the finished ones: the sent and failed items go; the ${plural(plan.open.length, 'other')} and the tab stay.`,
        ].join('\n'),
        choices: [
            { label: `Delete all ${plural(plan.total, 'item')}`, mode: 'all' },
            ...(plan.finished.length ? [{ label: `Delete only the ${plural(plan.finished.length, 'finished item')}`, mode: 'finished' as const }] : []),
        ],
    };
}
