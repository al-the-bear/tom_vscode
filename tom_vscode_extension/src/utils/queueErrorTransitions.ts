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

// ---------------------------------------------------------------------------
// Rate-limit "waiting" transitions
// ---------------------------------------------------------------------------

export interface WaitingTransitionItem {
    status?: string;
    error?: string;
    warning?: QueueItemWarningLike;
    waitingUntil?: string;
    waitingResetLabel?: string;
}

/** Minimal reset-clause shape consumed by `applyWaitingTransition`. */
export interface ResetClauseLike {
    /** Reset instant stated by the provider, UTC epoch ms. */
    resetAtMs: number;
    /** Friendly label in the source timezone (drives the header). */
    displayLabel: string;
}

export interface ApplyWaitingTransitionOptions {
    /** Grace period added to the reset instant before auto-retry. */
    retryBufferMs: number;
    /** Warning kind to stamp — defaults to `rate_limit`. */
    kind?: QueueWarningKindLike;
    /** Override for `warning.at`; production callers omit it. */
    nowIso?: string;
}

/**
 * Park a queue item in the `waiting` state after a rate-limit / quota
 * error that carried a parseable "resets …" clause. Instead of the
 * normal `error` transition (which would flip auto-send off and burn no
 * further quota until the user intervenes), the item keeps its queue
 * position and is scheduled to auto-retry `retryBufferMs` after the
 * stated reset instant.
 *
 * Clears any prior `error` marker (this is a soft wait, not a hard
 * failure) and stamps a warning chip so the reason is visible. Pure —
 * the caller persists / fires events / drives the retry timer.
 */
export function applyWaitingTransition(
    item: WaitingTransitionItem,
    clause: ResetClauseLike,
    options: ApplyWaitingTransitionOptions,
): void {
    const bufferMinutes = Math.round(options.retryBufferMs / 60_000);
    item.status = 'waiting';
    item.error = undefined;
    item.waitingUntil = new Date(clause.resetAtMs + options.retryBufferMs).toISOString();
    item.waitingResetLabel = clause.displayLabel;
    item.warning = {
        kind: options.kind ?? 'rate_limit',
        message: `Limit reached — waiting until ${clause.displayLabel}; retrying ${bufferMinutes} min after reset`,
        at: options.nowIso ?? new Date().toISOString(),
    };
}

/**
 * Return a `waiting` item to `pending` so the dispatcher picks it up.
 * Clears the waiting bookkeeping and the interruption warning. Used
 * both by the health-check auto-retry (when the wait elapses) and by a
 * manual "retry now" action. Pure — caller persists and drives sendNext.
 */
export function clearWaitingState(item: WaitingTransitionItem): void {
    item.status = 'pending';
    item.waitingUntil = undefined;
    item.waitingResetLabel = undefined;
    item.warning = undefined;
    item.error = undefined;
}

/**
 * True iff a `waiting` item's retry instant has arrived. A missing or
 * unparseable `waitingUntil` is treated as due (defensive — never strand
 * an item in `waiting` forever).
 */
export function isWaitingDue(waitingUntilIso: string | undefined, nowMs: number): boolean {
    if (!waitingUntilIso) { return true; }
    const t = new Date(waitingUntilIso).getTime();
    if (Number.isNaN(t)) { return true; }
    return nowMs >= t;
}

export interface ResetToPendingLastDispatched {
    kind: 'prePrompt' | 'main' | 'followUp';
    prePromptIndex?: number;
    followUpIndex?: number;
}

export interface ResetToPendingStage {
    repeatIndex?: number;
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
    /**
     * Snapshot of the last dispatch — preserved across the reset so
     * the Resend button still works. Read here only so we can
     * decrement the matching counter (see below).
     */
    lastDispatched?: ResetToPendingLastDispatched;
    /** Per-stage `repeatIndex` counters mutated to roll back the errored rep. */
    repeatIndex?: number;
    prePrompts?: ResetToPendingStage[];
    followUps?: ResetToPendingStage[];
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
 * **Rolls back the errored repetition counter.** The dispatch loop
 * bumps `repeatIndex` *before* awaiting the actual send — that's so
 * the rep number is visible to `lastDispatched` / status formatters
 * during the dispatch. When the dispatch then throws, the counter
 * still says "rep N+1 was sent" even though the send failed. If we
 * left it that way, a reset-then-auto-send (the natural user flow
 * for "queue this for later, then drain") would skip rep N+1 and
 * jump to N+2 — silently dropping the rep the user wanted to retry.
 * Decrementing here brings the counter back in line with what was
 * actually delivered. `resendLastPrompt` deliberately replays
 * `lastDispatched.expandedText` (the errored rep's frozen text)
 * *without* touching counters, so that path stays correct: re-fire
 * rep N+1, then the loop advances naturally to N+2.
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

    // Roll back the counter for the stage that was in flight when
    // the error fired — see the doc comment for the rationale.
    const last = item.lastDispatched;
    if (last) {
        if (last.kind === 'main') {
            item.repeatIndex = Math.max(0, (item.repeatIndex ?? 0) - 1);
        } else if (last.kind === 'prePrompt' && typeof last.prePromptIndex === 'number' && Array.isArray(item.prePrompts)) {
            const pp = item.prePrompts[last.prePromptIndex];
            if (pp) { pp.repeatIndex = Math.max(0, (pp.repeatIndex ?? 0) - 1); }
        } else if (last.kind === 'followUp' && typeof last.followUpIndex === 'number' && Array.isArray(item.followUps)) {
            const fu = item.followUps[last.followUpIndex];
            if (fu) { fu.repeatIndex = Math.max(0, (fu.repeatIndex ?? 0) - 1); }
        }
    }
    return true;
}

/**
 * Truthy iff a queue item has at least one stage / repetition
 * dispatched on file. Drives two related decisions:
 *
 *   - The **pause gate** in `dispatchNextStageForSendingItem`: when
 *     auto-send is OFF and an in-flight item has progress, refuse to
 *     start the next repetition (the current rep finishes naturally).
 *     The first dispatch is allowed even with auto-send off so the
 *     user's explicit `sendNow` action isn't blocked.
 *   - The **fresh-vs-resume gate** in `sendItem`: items with prior
 *     progress (paused mid-flight, error-reset, or post-crash-recovery)
 *     keep their cursors; truly-fresh items get the full counter
 *     reset.
 *
 * Mirrors the per-stage counter scheme:
 *
 *   - any pre-prompt `repeatIndex > 0`,
 *   - main `repeatIndex > 0`,
 *   - any follow-up `repeatIndex > 0`,
 *   - or `followUpIndex > 0` (advanced past a fully-replayed follow-up).
 *
 * Extracted as a pure function so the gate / resume logic can be
 * unit-tested without instantiating PromptQueueManager.
 */
export interface InFlightProgressItem {
    repeatIndex?: number;
    followUpIndex?: number;
    prePrompts?: Array<{ repeatIndex?: number }>;
    followUps?: Array<{ repeatIndex?: number }>;
}

export function itemHasInFlightProgress(item: InFlightProgressItem): boolean {
    if ((item.repeatIndex ?? 0) > 0) { return true; }
    if ((item.followUpIndex ?? 0) > 0) { return true; }
    if (Array.isArray(item.prePrompts)) {
        for (const pp of item.prePrompts) {
            if ((pp?.repeatIndex ?? 0) > 0) { return true; }
        }
    }
    if (Array.isArray(item.followUps)) {
        for (const fu of item.followUps) {
            if ((fu?.repeatIndex ?? 0) > 0) { return true; }
        }
    }
    return false;
}

/** Minimal container shape that can absorb a captured answer text. */
export interface AnswerContainerLike {
    answerText?: string;
}

/**
 * Item shape needed to route a captured answer back to the stage that
 * was last dispatched. Mirrors the per-stage container scheme: the
 * main prompt's container is the item itself; pre-prompts and
 * follow-ups have their own container objects addressed by index.
 */
export interface AnswerContainerItem extends AnswerContainerLike {
    prePrompts?: AnswerContainerLike[];
    followUps?: AnswerContainerLike[];
    lastDispatched?: {
        kind: 'prePrompt' | 'main' | 'followUp';
        prePromptIndex?: number;
        followUpIndex?: number;
    };
}

/**
 * Resolve the stage container that should absorb the answer text for
 * the **last-dispatched** stage of an item, using the same contract as
 * the dispatch loop's `stageForAnswer` argument.
 *
 * Returns `undefined` when there is no `lastDispatched` snapshot or the
 * referenced stage no longer exists (defensive — indices come off a
 * persisted snapshot). Used by both `resendLastPrompt` (route the
 * resend's returned text) and the manual-continue capture (record the
 * most-recent LLM answer onto the stage being completed).
 *
 * Pure so it can be unit-tested without instantiating
 * `PromptQueueManager`.
 */
export function resolveAnswerContainer(item: AnswerContainerItem): AnswerContainerLike | undefined {
    const last = item.lastDispatched;
    if (!last) {
        return undefined;
    }
    if (last.kind === 'prePrompt' && typeof last.prePromptIndex === 'number') {
        return item.prePrompts?.[last.prePromptIndex];
    }
    if (last.kind === 'followUp' && typeof last.followUpIndex === 'number') {
        return item.followUps?.[last.followUpIndex];
    }
    if (last.kind === 'main') {
        return item;
    }
    return undefined;
}

/**
 * Decide whether a dispatch frame that has just finished (returned
 * normally *or* threw) is still the authoritative owner of its queue
 * item, or whether an explicit user action superseded it while the
 * dispatch was in flight.
 *
 * The queue keeps a monotonic "dispatch epoch" counter that is bumped
 * every time an in-flight dispatch is **intentionally** cancelled —
 * i.e. from `_cancelActiveDispatch`, which is only ever reached via the
 * user-facing Continue / Stop / set-to-staged actions. A send-owning
 * frame (`sendItem`, `_resumePausedSendingItem`, `resendLastPrompt`,
 * `continueSending`) captures the epoch immediately before awaiting its
 * dispatch. If the epoch has advanced by the time the await settles, the
 * cancel was deliberate and this frame must become a **no-op**:
 *
 *   - it must NOT promote the item to `error` (the cancel was wanted,
 *     not a failure) and must NOT disable auto-send (no quota cascade to
 *     guard against), and
 *   - it must NOT advance the queue (mark `sent`, enqueue the next
 *     template iteration, or call `sendNext`) — the action that issued
 *     the cancel already owns the item's next state.
 *
 * Without this guard, cancelling an in-flight Anthropic send (e.g. by
 * pressing Continue) makes the original send's awaited call throw a
 * cancellation error, which the owning frame's catch would otherwise
 * turn into `error` + auto-send-off (the reported "Continue → error +
 * queue pauses" bug); and in the non-throw path it would double-advance.
 */
export function dispatchWasSuperseded(capturedEpoch: number, currentEpoch: number): boolean {
    return currentEpoch !== capturedEpoch;
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
