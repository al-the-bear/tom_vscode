/**
 * "Send between iterations": a pending item sent between two iterations of a
 * running loop.
 *
 * A queue item that repeats its main prompt (a counter `repeatCount` above 1,
 * a `<prefix>*` todo walk or a GROUP item's walk over a group's members) holds
 * its run's lane until the loop ends. The queue editor's Send next button, on
 * the pending item that comes next in the same run after such a running loop
 * (the second item of the run's queue; sent items and chat sends between them
 * do not count), marks it instead (`sendBetween`). When the loop has finished an
 * iteration and would dispatch the next, it steps aside: the marked item moves
 * in front of it and is sent, and the loop item (back to pending, its counters
 * kept) resumes with its next iteration after it. At most one item is marked.
 *
 * The rules, over a minimal item shape; the queue manager applies them.
 * vscode-free.
 */

import { parseTodoWalk } from './queueStep3Utils';
import { itemRun } from './queueLanes';

/** What the rules need of a queue item. */
export interface BetweenQueueItem {
    id: string;
    status: string;
    run?: string;
    processRun?: { run?: string };
    repeatCount?: number | string;
    resolvedRepeatCount?: number;
    sendBetween?: boolean;
}

/** The item repeats its main prompt: a `<prefix>*` walk, a GROUP item's walk, or a counter above 1 (a TODO item runs one todo). */
export function isLoopItem(item: BetweenQueueItem): boolean {
    const walk = parseTodoWalk(item.repeatCount);
    if (walk) { return walk.kind !== 'todo'; }
    const n = typeof item.resolvedRepeatCount === 'number' ? item.resolvedRepeatCount : Number(item.repeatCount);
    return Number.isFinite(n) && n > 1;
}

/** Statuses that are over: they are not part of a run's queue order any more. */
const FINISHED = ['sent', 'chat', 'chat-sent'];

/**
 * The running loop item `id` comes next after in its run, or undefined: Send
 * next means "send between iterations" only for a pending item that directly
 * follows a sending loop of the same run (finished items and other runs' items
 * between them do not count).
 */
export function runningLoopAbove(items: readonly BetweenQueueItem[], id: string): BetweenQueueItem | undefined {
    const target = items.find((i) => i.id === id);
    if (!target || target.status !== 'pending') { return undefined; }
    const run = itemRun(target);
    const lane = items.filter((i) => i === target || (itemRun(i) === run && !FINISHED.includes(i.status)));
    const at = lane.indexOf(target);
    if (at <= 0) { return undefined; }
    const above = lane[at - 1];
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
