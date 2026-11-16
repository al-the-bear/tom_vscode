/**
 * The busy slots of interactive Anthropic chat sends: one per session.
 *
 * Several entry points start an Anthropic turn outside the prompt queue: the
 * @CHAT panel's Send, the Send-to-Chat command and the editor / file menus,
 * the todo panel's Send and Guide me, Telegram's `send_prompt`, the scripting
 * bridge's `sendToChatVce`, an assist prompt. Each claims the slot of the
 * session it sends in (the effective session name, `<session>@<run>` included).
 * Two sends in the same session are refused — two prompts never share a
 * conversation — while sends in different sessions run side by side.
 *
 * Each slot holds the **cancel hook** of its send, so a remote driver (the
 * Telegram `/cancel_chat` command) or an assist overlay can interrupt it the
 * way the chat panel's Stop button does. The hook is supplied by whichever
 * entry point claimed the slot (it cancels that send's
 * `CancellationTokenSource` and aborts its pending approvals) and goes with
 * the slot when it is released, so a stale hook never fires against a
 * finished turn.
 *
 * Dependency-free, so the router and the chat panel import it without an
 * import cycle, and unit-testable.
 */

interface Slot {
    onCancel?: () => void;
    /** The prompt queue entry the send is shown as, once it has one. */
    chatItemId?: string;
}

/** The sends in flight, by session. */
const _slots = new Map<string, Slot>();

/**
 * Whether an interactive Anthropic send runs in `session`; without a session,
 * whether one runs in any session.
 */
export function isAnthropicSendInFlight(session?: string): boolean {
    return session === undefined ? _slots.size > 0 : _slots.has(session);
}

/** The sessions a chat send runs in now, in the order they started. */
export function anthropicSendSessions(): string[] {
    return [..._slots.keys()];
}

/**
 * Claim the slot of `session`.
 *
 * @param onCancel Optional cancel hook for this send, run by
 *                 {@link cancelAnthropicSend} (e.g. Telegram `/cancel_chat`).
 *                 It goes with the slot on {@link endAnthropicSend}.
 * @returns `true` if the session was free and its slot is now the caller's
 *          (who must later call {@link endAnthropicSend} with the same
 *          session); `false` if a send already runs in that session.
 */
export function tryBeginAnthropicSend(session: string, onCancel?: () => void): boolean {
    if (_slots.has(session)) {
        return false;
    }
    _slots.set(session, { ...(onCancel ? { onCancel } : {}) });
    return true;
}

/**
 * Register (or replace) the cancel hook of the send in `session`. No-op when
 * nothing runs there, so a late registration never arms a cancel against a
 * finished turn. Used when the cancel target (e.g. a `CancellationTokenSource`)
 * is only created after the slot is claimed.
 */
export function setAnthropicSendCancel(session: string, onCancel: () => void): void {
    const slot = _slots.get(session);
    if (slot) { slot.onCancel = onCancel; }
}

/** Note the prompt queue entry the send in `session` is shown as (an assist cancels by it). */
export function setAnthropicSendChatItem(session: string, chatItemId: string): void {
    const slot = _slots.get(session);
    if (slot) { slot.chatItemId = chatItemId; }
}

function runCancel(slot: Slot): boolean {
    if (!slot.onCancel) { return false; }
    try {
        slot.onCancel();
    } catch {
        // best-effort — a broken cancel hook must not wedge the guard
    }
    return true;
}

/**
 * Cancel the chat send in `session`; without a session, every running chat
 * send.
 *
 * @returns the sessions whose send was cancelled (their cancel hook ran);
 *          empty when nothing ran there (or no hook was registered).
 */
export function cancelAnthropicSend(session?: string): string[] {
    const targets = session === undefined ? [..._slots.entries()] : (_slots.has(session) ? [[session, _slots.get(session)!] as [string, Slot]] : []);
    return targets.filter(([, slot]) => runCancel(slot)).map(([name]) => name);
}

/** Cancel the chat send shown as prompt queue entry `chatItemId`; answers its session, or undefined. */
export function cancelAnthropicSendOfChatItem(chatItemId: string): string | undefined {
    for (const [name, slot] of _slots) {
        if (slot.chatItemId === chatItemId) { return runCancel(slot) ? name : undefined; }
    }
    return undefined;
}

/** The warning for a send refused because its session is busy: it names the session. */
export function busySessionWarning(session: string | undefined): string {
    return `Session ${session || 'chat'} is busy — a chat send runs in it. Try again once it has finished, or pick another session.`;
}

/** Release the slot of `session`. Safe to call when not held. */
export function endAnthropicSend(session: string): void {
    _slots.delete(session);
}

/** Test seam: release every slot. */
export function __resetAnthropicSendsForTests(): void { // eslint-disable-line @typescript-eslint/naming-convention -- a test seam
    _slots.clear();
}

/**
 * The sessions of `candidates` that are free in this window: no queue item
 * sending in them (`queueBusy`) and no chat send in flight; in their order,
 * each once.
 */
export function freeChatSessions(candidates: readonly string[], queueBusy: (session: string) => boolean = () => false): string[] {
    return candidates.filter((s, i) => candidates.indexOf(s) === i && !_slots.has(s) && !queueBusy(s));
}
