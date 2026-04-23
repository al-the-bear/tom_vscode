/**
 * Crash-recovery helper for the prompt queue.
 *
 * Any item still marked `sending` after a full load from disk must have
 * been interrupted by a VS Code crash or window reload — nothing can
 * legitimately be mid-send at load time (no dispatcher is running yet).
 *
 * We demote such items back to `pending` and clear transient send-tracking
 * fields (requestId / expectedRequestId / reminder counters) so the item
 * looks like a fresh pending entry to the dispatcher and the answer-file
 * poll loop can't match an unrelated future answer to the stale request.
 *
 * We deliberately preserve:
 *   - `lastDispatched` — the Resend button reads this to replay the
 *     interrupted stage with identical expanded text and transport.
 *   - `warning` — the last known interruption cause remains meaningful
 *     to the user.
 *
 * Extracted as a pure function so it can be unit-tested without
 * instantiating `PromptQueueManager` (which pulls in `vscode`).
 */

export type CrashRecoveryItem = {
    id?: string;
    status?: string;
    requestId?: string | undefined;
    expectedRequestId?: string | undefined;
    reminderSentCount?: number;
    lastReminderAt?: number | string | undefined;
    // Fields intentionally *not* listed here are preserved as-is
    // (including lastDispatched and warning).
};

/**
 * Resets every item whose status is `sending` back to `pending`.
 * Mutates the provided array in place. Returns the number of items
 * that were reset.
 */
export function applyCrashRecovery(items: CrashRecoveryItem[]): number {
    let count = 0;
    for (const item of items) {
        if (item.status !== 'sending') { continue; }
        item.status = 'pending';
        item.requestId = undefined;
        item.expectedRequestId = undefined;
        item.reminderSentCount = 0;
        item.lastReminderAt = undefined;
        count++;
    }
    return count;
}
