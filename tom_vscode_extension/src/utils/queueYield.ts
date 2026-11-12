/**
 * "Let the next item go first" (vscimpb60e): a repeating item (a `<prefix>*`
 * todo walk, or a repeat count above 1) holds its lane until its last
 * iteration. The action lets the lane go on with the next item instead,
 * without losing the walk:
 *
 * - on a pending iteration item: it moves at once behind the next pending
 *   item of its lane;
 * - on a sending one: it is armed (`yieldAfterIteration`); its running
 *   iteration finishes normally — its waits, its answer, its continuation
 *   check — and then, instead of the next iteration, the item steps back to
 *   pending with its counters kept and moves behind the next pending item of
 *   its lane, which is sent; when that one ends, the walk resumes with its
 *   next iteration. Pressing again before the iteration ends cancels it.
 *
 * Without a following pending item in its lane there is nothing to yield to.
 *
 * Pure: the rules over a minimal item shape; the queue manager applies them.
 */

import { isLoopItem, type BetweenQueueItem } from './queueSendBetween';

/** What the rules need of a queue item. */
export interface YieldQueueItem extends BetweenQueueItem {
    yieldAfterIteration?: boolean;
}

/** The item `item` would let go first: the first pending item of its lane after it, in queue order. */
export function yieldTarget<T extends YieldQueueItem>(laneItems: readonly T[], item: T): T | undefined {
    const at = laneItems.indexOf(item);
    if (at < 0) { return undefined; }
    return laneItems.slice(at + 1).find((i) => i.status === 'pending');
}

/** The queue order with `item` moved directly behind `target`. */
export function orderForYield<T>(items: readonly T[], item: T, target: T): T[] {
    const rest = items.filter((i) => i !== item);
    const at = rest.indexOf(target);
    return at < 0 ? [...items] : [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)];
}

/** Why the action is not offered on `item` now, or undefined when it is. */
export function yieldUnavailableReason<T extends YieldQueueItem>(laneItems: readonly T[], item: T): string | undefined {
    if (item.status !== 'pending' && item.status !== 'sending') { return 'only a pending or sending item can let the next one go first'; }
    if (!isLoopItem(item)) { return 'not an iteration item (a todo walk or a repeat count above 1)'; }
    if (!yieldTarget(laneItems, item)) { return 'no pending item follows it in its lane: nothing to let go first'; }
    return undefined;
}
