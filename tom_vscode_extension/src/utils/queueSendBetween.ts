/**
 * "Send between iterations": a pending item sent between two iterations of a
 * running loop.
 *
 * A queue item that repeats its main prompt (a counter `repeatCount` above 1,
 * or a `<prefix>*` todo walk) holds the queue until the loop ends. The queue
 * editor's Send next button, on the pending item directly under such a running
 * loop, marks it instead (`sendBetween`). When the loop has finished an
 * iteration and would dispatch the next, it steps aside: the marked item moves
 * in front of it and is sent, and the loop item (back to pending, its counters
 * kept) resumes with its next iteration after it. At most one item is marked.
 *
 * The rules, over a minimal item shape; the queue manager applies them.
 * vscode-free.
 */

/** What the rules need of a queue item. */
export interface BetweenQueueItem {
    id: string;
    status: string;
    repeatCount?: number | string;
    resolvedRepeatCount?: number;
    sendBetween?: boolean;
}

/** A `<prefix>*` repeat count (a todo walk). */
function isTodoWalk(repeatCount: unknown): boolean {
    return typeof repeatCount === 'string' && /\*\s*$/.test(repeatCount.trim());
}

/** The item repeats its main prompt: a todo walk, or a counter above 1. */
export function isLoopItem(item: BetweenQueueItem): boolean {
    if (isTodoWalk(item.repeatCount)) { return true; }
    const n = typeof item.resolvedRepeatCount === 'number' ? item.resolvedRepeatCount : Number(item.repeatCount);
    return Number.isFinite(n) && n > 1;
}

/**
 * The running loop item `id` sits directly under, or undefined: Send next
 * means "send between iterations" only for a pending item right below a
 * sending loop.
 */
export function runningLoopAbove(items: readonly BetweenQueueItem[], id: string): BetweenQueueItem | undefined {
    const at = items.findIndex((i) => i.id === id);
    if (at <= 0 || items[at].status !== 'pending') { return undefined; }
    const above = items[at - 1];
    return above.status === 'sending' && isLoopItem(above) ? above : undefined;
}

/**
 * Mark (or, when it is marked, unmark) `id` to be sent between iterations.
 * Answers the ids whose mark changed; [] when `id` is not under a running
 * loop. Marking one clears any other mark.
 */
export function toggleSendBetween(items: BetweenQueueItem[], id: string): string[] {
    const target = items.find((i) => i.id === id);
    if (!target) { return []; }
    if (target.sendBetween) {
        target.sendBetween = undefined;
        return [id];
    }
    if (!runningLoopAbove(items, id)) { return []; }
    const changed: string[] = [];
    for (const i of items) {
        if (i.sendBetween && i.id !== id) { i.sendBetween = undefined; changed.push(i.id); }
    }
    target.sendBetween = true;
    changed.push(id);
    return changed;
}

/**
 * At a loop's iteration boundary: the marked item to send now, or undefined.
 * Only when at least one iteration went out (`sentIterations`) and more are
 * left (`moreLeft`); the loop item itself never counts.
 */
export function itemToSendBetween<T extends BetweenQueueItem>(
    items: readonly T[],
    loop: T,
    sentIterations: number,
    moreLeft: boolean,
): T | undefined {
    if (sentIterations < 1 || !moreLeft) { return undefined; }
    return items.find((i) => i.sendBetween === true && i.status === 'pending' && i.id !== loop.id);
}

/** The queue order with `between` moved directly in front of `loop`. */
export function orderForBetween<T extends BetweenQueueItem>(items: readonly T[], loop: T, between: T): T[] {
    const rest = items.filter((i) => i !== between);
    const at = rest.indexOf(loop);
    return at < 0 ? [...items] : [...rest.slice(0, at), between, ...rest.slice(at)];
}

/**
 * Where "Queue next" puts a new item so it is the next one sent: directly
 * under the item sending (where Send next would move it, and where "send
 * between iterations" applies when that item is a loop), or in front of the
 * first pending item when that comes earlier or nothing is sending; at the
 * end when there is neither.
 */
export function nextQueuePosition(items: readonly BetweenQueueItem[]): number {
    const sending = items.findIndex((i) => i.status === 'sending');
    const firstPending = items.findIndex((i) => i.status === 'pending');
    if (sending >= 0 && (firstPending < 0 || firstPending > sending)) { return sending + 1; }
    if (firstPending >= 0) { return firstPending; }
    return items.length;
}
