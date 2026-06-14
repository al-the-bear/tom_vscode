/**
 * Reload-merge helper for the prompt queue.
 *
 * The file watcher reloads the queue from disk whenever entry files change
 * (a prompt added from another window, via Telegram, via the MCP server, or a
 * `persist()` triggered by this window). The naive reload rebuilds `_items`
 * wholesale from disk — but that swaps out the *live* object references that an
 * in-flight `sendItem()` chain holds. When the send finally resolves it would
 * set `status = 'sent'` on a discarded object, so the queue would stall.
 *
 * The previous guard avoided that by **dropping the reload entirely** whenever
 * any item was `sending`. That is the bug behind "the queue no longer updates
 * reliably": during active auto-send there is almost always a `sending` item,
 * so externally-added prompts never surface and completed prompts don't refresh
 * until some unrelated future watcher event happens to fire with no item
 * sending. A *stuck* `sending` item blocks reloads permanently.
 *
 * The fix is a targeted merge instead of an all-or-nothing bail: take the disk
 * state for every item, but preserve the **exact** in-memory object reference
 * for items that are currently `sending` (matched by id), so the async send
 * chain keeps mutating the object the queue actually holds. In-memory `sending`
 * items not yet present on disk are retained too (an item is normally persisted
 * the moment it goes `sending`, but we don't rely on that timing).
 *
 * Extracted as a pure function so it can be unit-tested without instantiating
 * `PromptQueueManager` (which pulls in `vscode`).
 */

export interface ReloadMergeItem {
    id: string;
    status: string;
}

export interface MergeQueueReloadResult<T extends ReloadMergeItem> {
    /** The merged list in disk order, with live `sending` references preserved. */
    merged: T[];
    /** Ids whose live in-memory reference was kept (currently `sending`). */
    preservedIds: Set<string>;
}

/**
 * Merge a fresh disk load (`disk`, already ordered) onto the current in-memory
 * list (`inMemory`), keeping the live object reference for any item that is
 * currently `sending`.
 *
 * Ordering follows `disk`. Any in-memory `sending` item absent from `disk` is
 * appended at the end (an edge case — sending items are persisted on transition,
 * and their relative order is cosmetic because the dispatcher never picks a
 * `sending` item).
 */
export function mergeQueueReload<T extends ReloadMergeItem>(
    inMemory: readonly T[],
    disk: readonly T[],
): MergeQueueReloadResult<T> {
    const liveSending = new Map<string, T>();
    for (const item of inMemory) {
        if (item.status === 'sending') {
            liveSending.set(item.id, item);
        }
    }

    const merged: T[] = [];
    const preservedIds = new Set<string>();
    const usedLive = new Set<string>();

    for (const diskItem of disk) {
        const live = liveSending.get(diskItem.id);
        if (live) {
            merged.push(live);
            preservedIds.add(live.id);
            usedLive.add(live.id);
        } else {
            merged.push(diskItem);
        }
    }

    // Retain any live sending item not represented on disk yet.
    for (const item of inMemory) {
        if (item.status === 'sending' && !usedLive.has(item.id)) {
            merged.push(item);
            preservedIds.add(item.id);
        }
    }

    return { merged, preservedIds };
}
