/**
 * questRefreshDispatch — the prompt queue's Quest Refresh pre-step.
 *
 * Background (qr1). Quest Refresh used to fire from inside
 * `AnthropicHandler.sendMessage` as a re-entrant hook: when the shared counter
 * reached the interval, the queued turn's `sendMessage` called
 * `this.sendMessage(refreshText)` **inside itself**. The queue state machine
 * never models that nested send, and — worse — a failing refresh dispatch
 * propagated out of the nested call, out of the queued turn, and the user's
 * prompt was never sent.
 *
 * This helper moves the trigger OUT of the re-entrant hook and into the queue
 * dispatch loop as an explicit, sequential step: run the refresh (if due) as its
 * own dispatch, then send the main prompt. Two invariants matter and are what
 * the tests pin down:
 *
 *   1. **No re-entrancy** — `sendMain` is invoked exactly once, after the
 *      refresh, never nested inside it.
 *   2. **Failure isolation** — a broken refresh (or a throwing `shouldRefresh`)
 *      must not stop the queued prompt from being sent. The main prompt still
 *      counts toward the interval even when the refresh throws.
 *
 * The interactive send path keeps its own hook in `sendMessage` (that path works
 * — it is not a queued, state-machine-tracked turn), so this helper is queue-only.
 */

/** Injected collaborators for one main-stage dispatch. */
export interface MainStageRefreshHooks<T> {
    /** Whether a Quest Refresh is due before this prompt. */
    shouldRefresh: () => boolean;
    /** Run one refresh cycle as its own dispatch (awaited). */
    runRefresh: () => Promise<void>;
    /** Count this main prompt toward the refresh interval. Always called. */
    incrementCount: () => void;
    /** Send the queued main prompt and resolve with its dispatch result. */
    sendMain: () => Promise<T>;
    /** Optional observer for a swallowed refresh failure (logging). */
    onRefreshError?: (err: unknown) => void;
}

/**
 * Run the Quest Refresh (if due) as an explicit sequential step, then send the
 * main queue prompt. A refresh failure is caught and reported via
 * {@link MainStageRefreshHooks.onRefreshError} but never rethrown, so the queued
 * prompt is always dispatched. The counter is incremented once regardless of
 * whether the refresh ran or failed (matching the original interactive hook).
 */
export async function runMainStageWithRefresh<T>(hooks: MainStageRefreshHooks<T>): Promise<T> {
    try {
        if (hooks.shouldRefresh()) {
            await hooks.runRefresh();
        }
    } catch (err) {
        hooks.onRefreshError?.(err);
    } finally {
        hooks.incrementCount();
    }
    return hooks.sendMain();
}
