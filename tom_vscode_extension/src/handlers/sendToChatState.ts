/**
 * Mutual-exclusion guard for interactive Anthropic sends.
 *
 * Three entry points can start an Anthropic turn that the user perceives as
 * "the chat panel is working":
 *
 *   1. The chat panel's own Send button (`_handleSendAnthropic`).
 *   2. The Send-to-Chat command / context + file menus (when the target is
 *      Anthropic).
 *   3. The scripting-API bridge op `sendToChatVce` (when the target is
 *      Anthropic).
 *
 * The spec requires that while one of these is executing, a second one is
 * **rejected** rather than queued (the prompt-queue owns queuing). This module
 * is the single source of truth for that "is a turn in flight" flag. It is
 * deliberately dependency-free so both the router and the chat panel can import
 * it without risking an import cycle, and so it is trivially unit-testable.
 *
 * It also owns the **cancel callback** for the in-flight direct send so a
 * remote driver (the Telegram `/cancel_chat` command) can interrupt the running
 * turn the same way the chat panel's Stop button does. The callback is supplied
 * by whichever entry point claimed the slot (it cancels that send's
 * `CancellationTokenSource` and aborts any pending approvals) and is cleared
 * automatically when the slot is released, so a stale callback can never fire
 * against a finished turn.
 */

let _inFlight = false;
/**
 * Cancel hook for the currently-running direct Anthropic send, registered by
 * the entry point that holds the slot. `undefined` when nothing is in flight or
 * the holder did not register one.
 */
let _onCancel: (() => void) | undefined;

/** Whether an interactive Anthropic turn is currently running. */
export function isAnthropicSendInFlight(): boolean {
    return _inFlight;
}

/**
 * Attempt to claim the in-flight slot.
 *
 * @param onCancel Optional cancel hook for this send. Invoked by
 *                 {@link cancelAnthropicSend} (e.g. Telegram `/cancel_chat`) to
 *                 interrupt the turn. Cleared automatically on
 *                 {@link endAnthropicSend}.
 * @returns `true` if the slot was free and is now claimed by the caller (which
 *          must later call {@link endAnthropicSend}); `false` if a turn is
 *          already running and the caller should reject.
 */
export function tryBeginAnthropicSend(onCancel?: () => void): boolean {
    if (_inFlight) {
        return false;
    }
    _inFlight = true;
    _onCancel = onCancel;
    return true;
}

/**
 * Register (or replace) the cancel hook for the send that currently holds the
 * slot. No-op when nothing is in flight, so a late registration can never arm a
 * cancel against a finished turn. Used when the cancel target (e.g. a
 * `CancellationTokenSource`) is only created after the slot is claimed.
 */
export function setAnthropicSendCancel(onCancel: () => void): void {
    if (!_inFlight) {
        return;
    }
    _onCancel = onCancel;
}

/**
 * Cancel the in-flight direct Anthropic send, if any.
 *
 * @returns `true` if a turn was in flight and its cancel hook ran; `false` if
 *          nothing was running (or no hook was registered).
 */
export function cancelAnthropicSend(): boolean {
    if (!_inFlight || !_onCancel) {
        return false;
    }
    const cb = _onCancel;
    try {
        cb();
    } catch {
        // best-effort — a broken cancel hook must not wedge the guard
    }
    return true;
}

/** Release the in-flight slot. Safe to call when not held. */
export function endAnthropicSend(): void {
    _inFlight = false;
    _onCancel = undefined;
}
