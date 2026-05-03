/**
 * Pure state transitions for queue items entering or leaving the
 * `error` status. Extracted as plain functions so the behaviour can
 * be unit-tested without instantiating `PromptQueueManager` (which
 * pulls in `vscode`).
 *
 * Two transitions live here:
 *
 *  - `applyErrorTransition` — called from every `catch` site that
 *    promotes a `sending` item to `error`. Beyond stamping the
 *    `error` string and optional `warning`, the queue must also
 *    flip auto-send off so a cascade of failing prompts cannot burn
 *    quota: when one prompt fails, subsequent ones are very likely
 *    to fail for the same underlying cause (rate-limit, quota,
 *    overload, network outage). The user reviews the failure and
 *    explicitly opts back in.
 *
 *  - `applyResetToPending` — called by the per-item "Set to
 *    Pending" button on error items. The user signalled that they
 *    want the prompt to wait its turn again, **not** to be resent
 *    immediately. Auto-send is left untouched (still off after the
 *    error transition); the user has a separate auto-send toggle to
 *    re-arm the queue when they're ready.
 *
 * Neither helper persists or fires events — the caller owns that, so
 * the helpers stay free of side effects and trivial to test.
 */

export type QueueWarningKindLike =
    | 'rate_limit'
    | 'quota_exceeded'
    | 'overloaded'
    | 'cancelled'
    | 'interrupted';

export interface QueueItemWarningLike {
    kind: QueueWarningKindLike;
    message: string;
    at: string;
}

export interface ErrorTransitionItem {
    status?: string;
    error?: string;
    warning?: QueueItemWarningLike;
}

export interface ApplyErrorTransitionOptions {
    /**
     * Classified interruption (rate-limit / quota / overload /
     * cancelled / interrupted) extracted from the thrown error by
     * the dispatch layer. When provided, it overwrites any prior
     * warning so the latest cause is what the user sees.
     */
    interruption?: { kind: QueueWarningKindLike; message: string } | null;
    /**
     * Override for `warning.at`. Only here so tests can pin the
     * timestamp; production callers omit it and get `Date.now()`.
     */
    nowIso?: string;
}

/**
 * Result of an error transition. The caller inspects
 * `shouldDisableAutoSend` and, if true, disables auto-send and
 * persists settings exactly once per call site — keeping the side
 * effect at the manager boundary instead of inside this helper.
 */
export interface ErrorTransitionResult {
    /**
     * True iff the item was actually transitioned to `error` (i.e.
     * it wasn't already in `error`). Callers use this to decide
     * whether to log / persist / fire change events; an idempotent
     * second call is a no-op.
     */
    transitioned: boolean;
    /**
     * True iff auto-send must be disabled as a consequence of this
     * transition. Currently equal to `transitioned` — every fresh
     * error trips the auto-send safety brake — but kept as a
     * separate flag so future tweaks (e.g. ignore cancellations)
     * have a clear hook.
     */
    shouldDisableAutoSend: boolean;
}

/**
 * Promote a queue item to `error`. Stamps `error` + optional
 * `warning` and returns whether the caller should also flip
 * auto-send off.
 *
 * Idempotent: a second call on an already-errored item updates the
 * error/warning markers but reports `transitioned: false` so the
 * caller can skip the auto-send brake (it was already pulled the
 * first time round).
 */
export function applyErrorTransition(
    item: ErrorTransitionItem,
    err: unknown,
    options: ApplyErrorTransitionOptions = {},
): ErrorTransitionResult {
    const wasNotErrored = item.status !== 'error';
    item.status = 'error';
    item.error = stringifyError(err);

    if (options.interruption) {
        item.warning = {
            kind: options.interruption.kind,
            message: options.interruption.message,
            at: options.nowIso ?? new Date().toISOString(),
        };
    }

    return {
        transitioned: wasNotErrored,
        shouldDisableAutoSend: wasNotErrored,
    };
}

export interface ResetToPendingItem {
    status?: string;
    error?: string;
    warning?: QueueItemWarningLike;
    requestId?: string;
    expectedRequestId?: string;
    reminderSentCount?: number;
    lastReminderAt?: string | undefined;
    sentAt?: string;
    // `lastDispatched` is intentionally not listed here so callers
    // can pass through the full QueuedPrompt without us erasing it —
    // the user may still want to use the Resend button after they
    // re-enable auto-send and the item gets picked up again.
}

/**
 * Reset a queue item to `pending`. Only allowed on items that are
 * currently in `error`; for any other status the call is a no-op
 * (returns `false`) so accidental routes can't downgrade in-flight
 * items.
 *
 * Clears the failure markers and the transient send-tracking fields
 * so the dispatcher treats the item like a fresh pending entry.
 * Deliberately preserves `lastDispatched` — the Resend button still
 * works on the reset item once the queue is sending again.
 *
 * Auto-send is **not** touched. The error transition already turned
 * it off; pressing Reset is the user signalling "queue this for
 * later", not "send now".
 */
export function applyResetToPending(item: ResetToPendingItem): boolean {
    if (item.status !== 'error') {
        return false;
    }
    item.status = 'pending';
    item.error = undefined;
    item.warning = undefined;
    item.requestId = undefined;
    item.expectedRequestId = undefined;
    item.reminderSentCount = 0;
    item.lastReminderAt = undefined;
    item.sentAt = undefined;
    return true;
}

function stringifyError(err: unknown): string {
    // Matches the historical `String(err)` behaviour at the four
    // catch sites — for `Error` instances this yields "Error: <msg>"
    // not the bare `.message`. Preserved verbatim so the change to
    // a centralised helper is byte-identical to the inlined code.
    try {
        return String(err);
    } catch {
        return 'unknown error';
    }
}
