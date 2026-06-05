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
 */

let _inFlight = false;

/** Whether an interactive Anthropic turn is currently running. */
export function isAnthropicSendInFlight(): boolean {
    return _inFlight;
}

/**
 * Attempt to claim the in-flight slot.
 *
 * @returns `true` if the slot was free and is now claimed by the caller (which
 *          must later call {@link endAnthropicSend}); `false` if a turn is
 *          already running and the caller should reject.
 */
export function tryBeginAnthropicSend(): boolean {
    if (_inFlight) {
        return false;
    }
    _inFlight = true;
    return true;
}

/** Release the in-flight slot. Safe to call when not held. */
export function endAnthropicSend(): void {
    _inFlight = false;
}
