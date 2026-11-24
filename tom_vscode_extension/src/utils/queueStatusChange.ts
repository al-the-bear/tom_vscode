/**
 * A queue item's status set by hand (the queue editor's status label) and the
 * place an item goes in a run's lane (the run / session flow of its run chip).
 *
 * - **Status.** An item in `error`, `waiting` (a usage limit, an out-of-budget
 *   stop) or `retry` goes back to `pending` or `staged`, or is marked `sent`
 *   when its work was in fact done. A running or held item (`sending`,
 *   `interrupted`, `todo-blocked`, `decision-needed`) is stopped first and then
 *   takes the status chosen. `staged`, `pending` and `sent` change among
 *   themselves. A chat send (`chat`, `chat-sent`) is never the queue's to change.
 * - **Place.** In the lane of a run (its items in queue order): at the end; at
 *   the top (before its first item that is not being sent); or *next* — right
 *   after the run's sending item, sent between its iterations — when that item
 *   iterates.
 *
 * vscode-free and pure.
 */

/** The statuses a person may set. */
export type ManualQueueStatus = 'staged' | 'pending' | 'sent';

/** A status a person may set on an item of `status`, with what it means. */
export interface QueueStatusChoice {
    status: ManualQueueStatus;
    label: string;
    detail: string;
}

/** Statuses in which a turn may still run or hold: changing them stops it first. */
export const ACTIVE_QUEUE_STATUSES: readonly string[] = ['sending', 'interrupted', 'todo-blocked', 'decision-needed'];
/** Statuses an item is parked in after a failure: error, a usage-limit wait, a retry countdown. */
export const PARKED_QUEUE_STATUSES: readonly string[] = ['error', 'waiting', 'retry'];

const CHOICE: Record<ManualQueueStatus, Omit<QueueStatusChoice, 'status'>> = {
    pending: { label: 'Pending', detail: 'the queue sends it when it gets there' },
    staged: { label: 'Staged', detail: 'it waits in the queue until you set it to pending' },
    sent: { label: 'Sent', detail: 'its work was done: the queue does not send it again' },
};

/** The statuses an item of `status` may be set to by hand, in the order they are offered; [] for none. */
export function queueStatusChoices(status: string | undefined): QueueStatusChoice[] {
    const s = status || 'staged';
    let targets: ManualQueueStatus[];
    if (PARKED_QUEUE_STATUSES.includes(s) || ACTIVE_QUEUE_STATUSES.includes(s)) { targets = ['pending', 'staged', 'sent']; }
    else if (s === 'staged') { targets = ['pending', 'sent']; }
    else if (s === 'pending') { targets = ['staged', 'sent']; }
    else if (s === 'sent') { targets = ['staged', 'pending']; }
    else { targets = []; }
    return targets.map((t) => ({ status: t, ...CHOICE[t] }));
}

/** Whether an item of `status` may move to another run or session by hand: anything not sent and no chat send. */
export function canRelocateQueueItem(status: string | undefined): boolean {
    const s = status || 'staged';
    return s === 'staged' || s === 'pending' || PARKED_QUEUE_STATUSES.includes(s) || ACTIVE_QUEUE_STATUSES.includes(s);
}

/** Where an item goes in its run's lane. */
export type LanePlace = 'end' | 'top' | 'next';

/** An item as the lane needs it. */
export interface LaneItem {
    id: string;
    status: string;
    run: string;
    /** The item iterates (a repeat count or a todo walk): a *next* item goes between its iterations. */
    iterates: boolean;
}

/** The sending item of run `run` that iterates, when there is one: a *next* item goes right after it. */
export function iteratingSendingItem(items: readonly LaneItem[], run: string): LaneItem | undefined {
    return items.find((i) => i.run === run && i.status === 'sending' && i.iterates);
}

/**
 * The index in `items` (the whole queue, without the item being placed) an
 * item of run `run` goes to: `end` after everything; `top` before the run's
 * first item that is not being sent (else at the end); `next` right after the
 * run's iterating sending item (else as `top`).
 */
export function laneInsertIndex(items: readonly LaneItem[], run: string, place: LanePlace): number {
    if (place === 'next') {
        const loop = iteratingSendingItem(items, run);
        if (loop) { return items.indexOf(loop) + 1; }
    }
    if (place === 'top' || place === 'next') {
        const first = items.findIndex((i) => i.run === run && i.status !== 'sending');
        return first >= 0 ? first : items.length;
    }
    return items.length;
}
