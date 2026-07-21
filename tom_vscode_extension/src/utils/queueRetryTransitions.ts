/**
 * Pure state transitions for the queue-level `retry` status.
 *
 * When a `sending` item fails with a *generic* error — one that is not a
 * rate-limit "resets <time>" clause (those go to `waiting`, see
 * `queueErrorTransitions.ts`) and not a deliberate user cancellation — the
 * queue no longer hard-fails it immediately. Instead the item is parked in
 * `retry` and auto-retried on a fixed exponential-ish backoff schedule,
 * keeping its queue position so a stopped queue clearly shows what happened.
 * Only once the schedule is exhausted does the item drop to `error` and the
 * queue pause.
 *
 * The schedule (7 attempts): 30s, then +15m, +30m, +45m, +60m, +60m, +60m —
 * i.e. the last retry fires ~4h30m30s after the first failure. After the 7th
 * retry also fails, the item is `error` and the queue pauses.
 *
 * All helpers here are pure (mutate the passed item in place, no I/O, no
 * `vscode` import) so the behaviour is unit-testable without instantiating
 * `PromptQueueManager`. The manager owns persistence, the health-check timer
 * that fires due retries, and the one side effect these transitions imply
 * (deleting `default.session.json` for the `previous_message_id` error).
 */

import type { QueueItemWarningLike, QueueWarningKindLike } from './queueErrorTransitions';

/**
 * Backoff delays (ms) between successive retries, indexed by the number of
 * retries already consumed. `RETRY_BACKOFF_MS.length` is the total number of
 * retries the queue will attempt before giving up.
 *
 *   index 0 → 30s   (first retry, 30s after the initial failure)
 *   index 1 → 15m
 *   index 2 → 30m
 *   index 3 → 45m
 *   index 4 → 60m
 *   index 5 → 60m
 *   index 6 → 60m
 *
 * Cumulative wall-clock to the last retry: 30s + 15 + 30 + 45 + 60 + 60 + 60
 * minutes = 4h30m30s.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
    30_000,
    15 * 60_000,
    30 * 60_000,
    45 * 60_000,
    60 * 60_000,
    60 * 60_000,
    60 * 60_000,
];

/** Total retries before exhaustion — surfaced to the UI as the "/N" total. */
export const RETRY_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

/** Item shape needed by the retry transitions. Subset of `QueuedPrompt`. */
export interface RetryTransitionItem {
    status?: string;
    error?: string;
    warning?: QueueItemWarningLike;
    /**
     * Number of retries already consumed in the current failure cascade
     * (0-based index into `RETRY_BACKOFF_MS`). Absent/undefined means the
     * cascade hasn't started — the next failure is the first retry.
     */
    retryAttempt?: number;
    /** ISO instant at which the next retry should fire. */
    retryUntil?: string;
}

/**
 * The scheduling decision for the *next* retry, given how many retries have
 * already been consumed. `retry` carries the delay until the next attempt and
 * the attempt counter to store; `exhausted` means the schedule is spent and
 * the caller must hard-fail the item (→ `error`, pause the queue).
 */
export type RetryDecision =
    | { kind: 'retry'; delayMs: number; attempt: number; total: number }
    | { kind: 'exhausted' };

/**
 * Decide the next retry from the number of retries already consumed.
 *
 * `consumed` is the item's current `retryAttempt` (treat undefined as 0). When
 * it still points inside the schedule, return the delay at that index and the
 * attempt number to persist (`consumed + 1`, 1-based for display). When it has
 * reached the schedule length, the budget is spent → `exhausted`.
 */
export function computeRetryDecision(consumed: number | undefined): RetryDecision {
    const idx = Math.max(0, Math.floor(consumed ?? 0));
    if (idx >= RETRY_BACKOFF_MS.length) {
        return { kind: 'exhausted' };
    }
    return {
        kind: 'retry',
        delayMs: RETRY_BACKOFF_MS[idx],
        attempt: idx + 1,
        total: RETRY_BACKOFF_MS.length,
    };
}

export interface ApplyRetrySchedulingOptions {
    /** Now, epoch ms — used to compute `retryUntil`. */
    nowMs: number;
    /** Classified interruption to stamp as the warning chip, if any. */
    interruption?: { kind: QueueWarningKindLike; message: string } | null;
    /** Raw error text, used for the warning message when no interruption. */
    errorText?: string;
    /** Override for `warning.at`; production callers omit it. */
    nowIso?: string;
}

/**
 * Park an item in `retry` for the given (non-exhausted) decision. Sets the
 * countdown instant, bumps `retryAttempt` to the decision's attempt number,
 * clears any hard-`error` marker (this is a soft retry, not a failure yet),
 * and stamps a warning chip explaining the cause + next-attempt count.
 *
 * Pure — the caller persists, fires change events, and drives the retry timer.
 */
export function applyRetryScheduling(
    item: RetryTransitionItem,
    decision: Extract<RetryDecision, { kind: 'retry' }>,
    options: ApplyRetrySchedulingOptions,
): void {
    item.status = 'retry';
    item.error = undefined;
    item.retryAttempt = decision.attempt;
    item.retryUntil = new Date(options.nowMs + decision.delayMs).toISOString();

    const kind: QueueWarningKindLike = options.interruption?.kind ?? 'interrupted';
    const cause = options.interruption?.message
        ?? firstLine(options.errorText)
        ?? 'Send failed';
    item.warning = {
        kind,
        message: `${cause} — retry ${decision.attempt}/${decision.total} scheduled`,
        at: options.nowIso ?? new Date(options.nowMs).toISOString(),
    };
}

/**
 * Fire a parked `retry` item: flip it back to `pending` so the dispatcher
 * picks it up, and clear the countdown. **Preserves `retryAttempt`** — a fired
 * retry that fails again must continue the backoff from where it left off, not
 * restart at 30s. Used by both the health-check auto-fire (countdown elapsed)
 * and the manual "retry now" button. The warning chip is kept so the cause
 * stays visible while the retry is in flight.
 */
export function fireRetry(item: RetryTransitionItem): void {
    item.status = 'pending';
    item.retryUntil = undefined;
    item.error = undefined;
}

/**
 * True iff a `retry` item's countdown has arrived. A missing/unparseable
 * `retryUntil` is treated as due (defensive — never strand an item forever).
 */
export function isRetryDue(retryUntilIso: string | undefined, nowMs: number): boolean {
    if (!retryUntilIso) { return true; }
    const t = new Date(retryUntilIso).getTime();
    if (Number.isNaN(t)) { return true; }
    return nowMs >= t;
}

/**
 * Clear all retry bookkeeping. Called when a dispatch **succeeds** so the next
 * failure (e.g. a later repetition) starts a fresh backoff cascade at 30s.
 * Only touches the retry fields — leaves status / answer / counters alone.
 */
export function clearRetryBookkeeping(item: RetryTransitionItem): void {
    item.retryAttempt = undefined;
    item.retryUntil = undefined;
}

/**
 * Give up on a `retry` item now (user pressed "Stop retrying"): promote it to
 * `error` and stop the countdown. Keeps `retryAttempt` and the warning chip so
 * the user can still see how far the cascade got. The caller pauses the queue
 * (mirrors the exhausted-schedule path). No-op (returns false) unless the item
 * is currently in `retry`.
 */
export function applyStopRetrying(item: RetryTransitionItem): boolean {
    if (item.status !== 'retry') { return false; }
    item.status = 'error';
    item.retryUntil = undefined;
    if (!item.error) {
        item.error = 'Retrying stopped by user';
    }
    return true;
}

/**
 * Classify the Claude Agent SDK "stale previous_message_id" 400. This error
 * means the persisted `default.session.json` carries a `previous_message_id`
 * that is no longer valid, and it survives an ordinary session reset — so the
 * session file must be deleted before the item is retried. Matches the
 * diagnostic substring the SDK surfaces:
 *
 *   "400 diagnostics.previous_message_id: must be the `id` from a prior
 *    /v1/messages response (starts with `msg_`)"
 *
 * Pure text match so the manager can decide whether to unlink the session file
 * before scheduling the retry.
 */
export function isPreviousMessageIdError(text: string | undefined): boolean {
    if (!text) { return false; }
    return /previous_message_id/i.test(text);
}

// ============================================================================
// In-flight repetition rollback
// ============================================================================
//
// The dispatcher advances a stage's repetition counter *optimistically* — the
// moment it starts a send, before it knows whether the send will succeed. On a
// genuine failure the item is parked (in `retry` or `waiting`) and later
// re-dispatched; without a rollback the re-dispatch would send the *next*
// repetition, so a 7-attempt retry cascade would walk the loop index forward
// by 7 and continue at the wrong iteration. To keep a retry re-sending the
// *same* failed prompt, the dispatcher records exactly which counter it bumped
// (an `InFlightRepetition` snapshot) and this helper restores it when the send
// fails.

/** Which stage's counter the in-flight dispatch advanced. */
export type InFlightStage = 'prePrompt' | 'main' | 'followUp';

/**
 * Snapshot of the single counter advance an in-flight dispatch made, captured
 * so a failed send can be rolled back to re-send the same repetition. Set by
 * the dispatcher immediately after it bumps a stage counter; consumed (and
 * cleared) by `rollbackInFlightRepetition` when the send fails.
 */
export interface InFlightRepetition {
    stage: InFlightStage;
    /** For `prePrompt`/`followUp`: index into the respective array. */
    stageIndex?: number;
    /** The stage's repeat counter value *before* the dispatch advanced it. */
    prevRepeatIndex: number;
    /**
     * For `followUp` only: `item.followUpIndex` before the dispatch's
     * conditional advance (a follow-up whose last repeat just went out also
     * advances the item to the next follow-up). Restored alongside the
     * follow-up's own repeat counter.
     */
    prevFollowUpIndex?: number;
}

/** Item shape mutated by `rollbackInFlightRepetition`. Subset of `QueuedPrompt`. */
export interface RollbackTargetItem {
    repeatIndex?: number;
    followUpIndex?: number;
    prePrompts?: { repeatIndex?: number }[];
    followUps?: { repeatIndex?: number }[];
    inFlightRepetition?: InFlightRepetition;
}

/**
 * Undo the counter advance recorded by the in-flight dispatch so a parked
 * (retry / waiting) item re-sends the *same* repetition rather than skipping to
 * the next one. No-op (returns false) when there is no snapshot — e.g. the send
 * failed during prompt expansion, before any counter was bumped, so nothing
 * needs restoring. Clears the snapshot after applying it.
 *
 * Pure — mutates the passed item in place, no I/O.
 */
export function rollbackInFlightRepetition(item: RollbackTargetItem): boolean {
    const snap = item.inFlightRepetition;
    if (!snap) { return false; }
    switch (snap.stage) {
        case 'main':
            item.repeatIndex = snap.prevRepeatIndex;
            break;
        case 'prePrompt': {
            const pp = snap.stageIndex !== undefined ? item.prePrompts?.[snap.stageIndex] : undefined;
            if (pp) { pp.repeatIndex = snap.prevRepeatIndex; }
            break;
        }
        case 'followUp': {
            const fu = snap.stageIndex !== undefined ? item.followUps?.[snap.stageIndex] : undefined;
            if (fu) { fu.repeatIndex = snap.prevRepeatIndex; }
            if (snap.prevFollowUpIndex !== undefined) {
                item.followUpIndex = snap.prevFollowUpIndex;
            }
            break;
        }
    }
    item.inFlightRepetition = undefined;
    return true;
}

/** First non-empty line of a string, trimmed and capped — for warning chips. */
function firstLine(s: string | undefined): string | undefined {
    if (!s) { return undefined; }
    const line = s.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
    if (!line) { return undefined; }
    return line.length > 200 ? line.slice(0, 197) + '…' : line;
}
