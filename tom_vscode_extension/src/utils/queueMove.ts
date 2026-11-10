/**
 * Moving a queue item one place up or down, as the queue editor shows it.
 *
 * The editor groups the items by status (media/shared/queueEntryUtils.js
 * statusSortRank: the held states first, then sending, pending, staged, the
 * sent history) and keeps the queue's own order inside a group. One step up or
 * down therefore means: past the nearest item *of the same status* in that
 * direction — not past its neighbour in the queue's array, which is often an
 * item of another group (a sent item between pending ones), so swapping with
 * it changed nothing the user could see.
 */

/**
 * The index of the item `items[index]` changes places with when it moves one
 * step `direction`: the nearest item with the same status that way; -1 when
 * there is none (it is first / last of its group already).
 */
export function queueMoveTarget(items: ReadonlyArray<{ status: string }>, index: number, direction: 'up' | 'down'): number {
    const status = items[index]?.status;
    if (status === undefined) { return -1; }
    const step = direction === 'up' ? -1 : 1;
    for (let i = index + step; i >= 0 && i < items.length; i += step) {
        if (items[i].status === status) { return i; }
    }
    return -1;
}
