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

// ---------------------------------------------------------------------------
// Interactive send path (chat panel Send, Send-to-Chat, Telegram, localLlm).
//
// Interactive sends still run Quest Refresh from inside their own send path —
// that path is not a queued, state-machine-tracked turn, so the re-entrancy
// problem qr1 fixed for the queue does not apply. These two pure helpers pin
// the boundary ("which sends run the interactive hook") and the hook's own
// order (refresh-then-count) so both can be unit-tested without the handlers'
// vscode / SDK dependencies.
// ---------------------------------------------------------------------------

/** Inputs deciding whether a send runs the INTERACTIVE Quest Refresh hook. */
export interface InteractiveRefreshGate {
    /** Isolated sub-agent runs never refresh. Absent ⇒ not isolated. */
    isolated?: boolean;
    /** The refresh prompt itself + programmatic / queue sends opt out. */
    skipQuestRefresh?: boolean;
}

/**
 * Whether an interactive send should run the Quest Refresh hook inside its own
 * send path. `false` for isolated sub-agent runs, for the refresh prompt itself,
 * and for prompt-queue / programmatic sends — those pass `skipQuestRefresh` and
 * (for the queue) run the refresh as a separate dispatch step via
 * {@link runMainStageWithRefresh} (qr1). Because the queue send passes
 * `skipQuestRefresh:true`, this predicate returns `false` for it, which is what
 * guarantees the queue never *also* triggers/counts through the interactive
 * hook (no double count / double trigger).
 */
export function shouldRunInteractiveRefreshHook(gate: InteractiveRefreshGate): boolean {
    return !gate.isolated && !gate.skipQuestRefresh;
}

/** Collaborators for one interactive Quest Refresh hook run. */
export interface InteractiveRefreshHooks {
    /** Whether a refresh is due before this prompt. */
    shouldRefresh: () => boolean;
    /** Run one refresh cycle through this panel's own send path (awaited). */
    runRefresh: () => Promise<void>;
    /** Count this prompt toward the interval. */
    incrementCount: () => void;
}

/**
 * Run the interactive Quest Refresh hook: refresh (if due), then count.
 *
 * Unlike the queue path ({@link runMainStageWithRefresh}) a refresh failure is
 * NOT isolated here — it propagates so the user sees it, and the counter is not
 * incremented for a send whose refresh threw (matching the pre-extraction inline
 * behaviour). Callers must gate this with {@link shouldRunInteractiveRefreshHook}.
 */
export async function runInteractiveRefreshHook(hooks: InteractiveRefreshHooks): Promise<void> {
    if (hooks.shouldRefresh()) {
        await hooks.runRefresh();
    }
    hooks.incrementCount();
}
