/**
 * Soft interrupt for continuation (vscimpb112): the running prompt of a queue
 * item is stopped at the next possible point — the result of its next tool
 * call is held, not handed back to the model, so the turn stays open the way it
 * stays open while a tomAi_askUser question waits. No API request is in flight
 * while a result is held, so the hold needs no network. Releasing the item
 * hands the result back and the turn goes on where it stopped.
 *
 * The hold points call {@link SoftInterruptRegistry.holdAt} with the tool's
 * result once they have it:
 *   - Agent SDK: the extension's tools in their MCP handlers, Claude Code's
 *     built-ins through a PostToolUse hook, AskUserQuestion where canUseTool
 *     answers it;
 *   - direct API / local LLM: the tool loop, before the round's results go into
 *     the next request.
 * An item without a requested soft interrupt passes straight through.
 *
 * The request arms a timer (15 s) — unless it waits without a limit (the
 * button's second press, {@link SoftInterruptRegistry.waitWithoutLimit}: for
 * long tool calls the turn may hold only after many minutes) — but a turn already waiting counts as held at
 * once — in an ask* tool, in tomAi_waitFor, or for its background work (its
 * answer given, the turn waits for its background tasks). When nothing was
 * held by then, the queue decides the same way, and any other turn gets the
 * hard interrupt.
 *
 * The class is `vscode`-free; timers and the clock are injectable.
 */

/** How long a soft interrupt waits for a hold point before the hard interrupt. */
export const SOFT_INTERRUPT_TIMEOUT_MS = 15_000;

/** A held result is marked when it was held longer than this. */
export const HELD_FOR_NOTE_THRESHOLD_MS = 60_000;

/** The `tool` of a hold of kind `wait` while the turn waits for its background work (not in tomAi_waitFor). */
export const BACKGROUND_WORK_HOLD = 'background work';

/** What holds the turn. */
export type SoftHoldKind = 'tool' | 'question' | 'wait';

/** The state of one item's soft interrupt (persisted on the queue item as `softInterrupt`). */
export interface SoftInterruptState {
    /** Epoch ms of the button press. */
    requestedAt: number;
    /** Epoch ms the turn was held; unset while the request waits for a hold point. */
    heldAt?: number;
    /** What holds it: a tool result, an open question, a wait (tomAi_waitFor). */
    kind?: SoftHoldKind;
    /** The tool whose result is held (or the ask / wait tool the turn waits in). */
    tool?: string;
    /** The held result as text (for a resend after the turn was lost). */
    heldResult?: string;
    /** It waits for a hold point without a limit: no hard interrupt by the timer (the button's second press). */
    unlimited?: boolean;
    /** The press switched the run's auto-send off: cancelling the interruption switches it on again. */
    pausedAutoSend?: boolean;
}

/** What a hold point gets back on release. */
export interface HoldRelease {
    /** The held-for line to put before the result (held longer than a minute), else undefined. */
    prefix?: string;
    /** The turn is being ended (hard interrupt): nothing goes on. */
    aborted?: true;
}

/** Extra state a hold point hands over with its result (the direct API conversation). */
export interface HoldExtras {
    /** The conversation up to and including the held round's results (direct API), saved for a restart. */
    conversation?: unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface SoftInterruptRegistryOptions {
    setTimer?: (ms: number, cb: () => void) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
    now?: () => number;
}

interface Entry {
    state: SoftInterruptState;
    timer?: TimerHandle;
    onTimeout?: () => void;
    /** Resolves the hold point's promise. */
    release?: (r: HoldRelease) => void;
    extras?: HoldExtras;
}

/** `[This result was held for 2 min 5 s by the user's interrupt for continuation.]`, held longer than a minute. */
export function heldForLine(heldMs: number): string | undefined {
    if (!(heldMs > HELD_FOR_NOTE_THRESHOLD_MS)) { return undefined; }
    return `[This result was held for ${formatHeldDuration(heldMs)} by the user's interrupt for continuation.]`;
}

/** `45 s`, `2 min 5 s`, `1 h 3 min`. */
export function formatHeldDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) { return `${s} s`; }
    const m = Math.floor(s / 60);
    if (m < 60) { return s % 60 ? `${m} min ${s % 60} s` : `${m} min`; }
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A tool result as text for the held record (bounded: it rides in the queue file). */
export const HELD_RESULT_MAX_CHARS = 20_000;

export function heldResultText(result: unknown): string {
    let text: string;
    if (typeof result === 'string') { text = result; } else {
        try { text = JSON.stringify(result); } catch { text = String(result); }
    }
    return text.length > HELD_RESULT_MAX_CHARS ? `${text.slice(0, HELD_RESULT_MAX_CHARS)}\n…(cut at ${HELD_RESULT_MAX_CHARS} characters)` : text;
}

export class SoftInterruptRegistry {
    private static _instance: SoftInterruptRegistry | undefined;

    static get instance(): SoftInterruptRegistry {
        if (!SoftInterruptRegistry._instance) { SoftInterruptRegistry._instance = new SoftInterruptRegistry(); }
        return SoftInterruptRegistry._instance;
    }

    private readonly setTimer: NonNullable<SoftInterruptRegistryOptions['setTimer']>;
    private readonly clearTimer: NonNullable<SoftInterruptRegistryOptions['clearTimer']>;
    private readonly now: NonNullable<SoftInterruptRegistryOptions['now']>;
    private readonly entries = new Map<string, Entry>();
    /** The wait before the hard interrupt (tests shorten it). */
    timeoutMs = SOFT_INTERRUPT_TIMEOUT_MS;
    private readonly listeners = new Set<(itemId: string) => void>();

    constructor(opts: SoftInterruptRegistryOptions = {}) {
        this.setTimer = opts.setTimer ?? ((ms, cb) => setTimeout(cb, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
        this.now = opts.now ?? (() => Date.now());
    }

    /** Be told when an item's state changes (requested, held, released, cleared). */
    onDidChange(listener: (itemId: string) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(itemId: string): void {
        for (const l of [...this.listeners]) {
            try { l(itemId); } catch { /* a listener must not break the hold */ }
        }
    }

    /** The state of item `itemId`'s soft interrupt, if one is requested. */
    stateOf(itemId: string): SoftInterruptState | undefined {
        const e = this.entries.get(itemId);
        return e ? { ...e.state } : undefined;
    }

    /** The extras the hold point handed over (the direct API conversation). */
    extrasOf(itemId: string): HoldExtras | undefined {
        return this.entries.get(itemId)?.extras;
    }

    /** Whether a hold point waits for the release of `itemId` (a tool result is held in a live turn). */
    hasLiveHold(itemId: string): boolean {
        return this.entries.get(itemId)?.release !== undefined;
    }

    /**
     * Request the soft interrupt of item `itemId`: the next tool result of its
     * turn is held. `onTimeout` runs after `timeoutMs` when nothing was held.
     * A second request of the same item changes nothing (answers false).
     */
    request(itemId: string, onTimeout?: () => void, timeoutMs = this.timeoutMs, opts: { pausedAutoSend?: boolean } = {}): boolean {
        if (this.entries.has(itemId)) { return false; }
        const entry: Entry = { state: { requestedAt: this.now(), ...(opts.pausedAutoSend ? { pausedAutoSend: true } : {}) }, ...(onTimeout ? { onTimeout } : {}) };
        if (onTimeout) {
            entry.timer = this.setTimer(timeoutMs, () => {
                entry.timer = undefined;
                if (this.entries.get(itemId) !== entry || entry.state.heldAt !== undefined) { return; }
                entry.onTimeout?.();
            });
        }
        this.entries.set(itemId, entry);
        this.changed(itemId);
        return true;
    }

    /**
     * Wait for a hold point without a limit (the button's second press): the
     * timer stops, so no hard interrupt comes by itself; the turn is held at its
     * next tool result however long that takes (or ends by itself). Answers
     * false when nothing waits (none requested, already held, already unlimited).
     */
    waitWithoutLimit(itemId: string): boolean {
        const e = this.entries.get(itemId);
        if (!e || e.state.heldAt !== undefined || e.state.unlimited) { return false; }
        this.stopTimer(e);
        e.state = { ...e.state, unlimited: true };
        this.changed(itemId);
        return true;
    }

    /**
     * The turn already waits where it cannot go on by itself (an open question,
     * a tomAi_waitFor wait): it counts as held. Its result, once it comes,
     * passes a hold point and is held there.
     */
    markHeld(itemId: string, kind: Exclude<SoftHoldKind, 'tool'>, tool?: string): boolean {
        const e = this.entries.get(itemId);
        if (!e || e.state.heldAt !== undefined) { return false; }
        this.stopTimer(e);
        e.state = { ...e.state, heldAt: this.now(), kind, ...(tool ? { tool } : {}) };
        this.changed(itemId);
        return true;
    }

    /**
     * A hold point: answers at once (nothing to hold) unless a soft interrupt
     * of `itemId` is requested; then the result is held until {@link release}.
     */
    async holdAt(itemId: string | undefined, tool: string, result: unknown, extras?: HoldExtras): Promise<HoldRelease> {
        if (!itemId) { return {}; }
        const e = this.entries.get(itemId);
        if (!e || e.release) { return {}; }
        this.stopTimer(e);
        const heldAt = this.now();
        e.state = {
            requestedAt: e.state.requestedAt, heldAt, kind: 'tool', tool, heldResult: heldResultText(result),
            ...(e.state.unlimited ? { unlimited: true } : {}), ...(e.state.pausedAutoSend ? { pausedAutoSend: true } : {}),
        };
        if (extras) { e.extras = extras; }
        const released = new Promise<HoldRelease>((resolve) => { e.release = resolve; });
        this.changed(itemId);
        return released;
    }

    /**
     * Release item `itemId`: a held result goes back to its turn (with the
     * held-for line when held longer than a minute), and the soft interrupt
     * ends. Answers whether a live hold point was waiting.
     */
    release(itemId: string): boolean {
        const e = this.entries.get(itemId);
        if (!e) { return false; }
        this.entries.delete(itemId);
        this.stopTimer(e);
        const wasLive = e.release !== undefined;
        if (e.release) {
            const prefix = e.state.heldAt !== undefined ? heldForLine(this.now() - e.state.heldAt) : undefined;
            e.release(prefix ? { prefix } : {});
        }
        this.changed(itemId);
        return wasLive;
    }

    /**
     * End item `itemId`'s soft interrupt without going on: the turn ends (hard
     * interrupt) or ended by itself. A waiting hold point is let go as aborted.
     * Answers the state it had.
     */
    clear(itemId: string): SoftInterruptState | undefined {
        const e = this.entries.get(itemId);
        if (!e) { return undefined; }
        this.entries.delete(itemId);
        this.stopTimer(e);
        e.release?.({ aborted: true });
        this.changed(itemId);
        return e.state;
    }

    private stopTimer(e: Entry): void {
        if (e.timer !== undefined) { this.clearTimer(e.timer); e.timer = undefined; }
    }
}

/** The result text a hold point hands back: the held-for line, a blank line, the result. */
export function withHeldForPrefix(text: string, release: HoldRelease): string {
    return release.prefix ? `${release.prefix}\n\n${text}` : text;
}

/** What a resend after a lost held turn adds: the result the agent never saw (Agent SDK, local LLM). */
export function heldResultResendLine(state: Pick<SoftInterruptState, 'tool' | 'heldResult' | 'kind'> | undefined): string | undefined {
    if (!state || state.kind !== 'tool' || state.heldResult === undefined || !state.tool) { return undefined; }
    return `The result of your last tool call ${state.tool} was: ${state.heldResult}`;
}

/** A tool_result's content as text (a string, or the text of its text blocks). */
export function toolResultText(content: unknown): string {
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
        return content.map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('');
    }
    return '';
}

/** A tool_result's content with `prefix` before it (a string stays a string; blocks get a text block first). */
export function prefixedToolResultContent<T>(content: T, prefix: string): T | string | Array<{ type: 'text'; text: string } | unknown> {
    if (typeof content === 'string') { return `${prefix}\n\n${content}`; }
    if (Array.isArray(content)) { return [{ type: 'text', text: prefix }, ...content]; }
    return prefix;
}

/* eslint-disable @typescript-eslint/naming-convention -- the queue file's kebab-case keys */
/** The state as written into a queue entry (`soft-interrupt:`). */
export function softInterruptToYaml(state: SoftInterruptState): Record<string, unknown> {
    return {
        'requested-at': new Date(state.requestedAt).toISOString(),
        ...(state.heldAt !== undefined ? { 'held-at': new Date(state.heldAt).toISOString() } : {}),
        ...(state.kind ? { kind: state.kind } : {}),
        ...(state.tool ? { tool: state.tool } : {}),
        ...(state.heldResult !== undefined ? { 'held-result': state.heldResult } : {}),
        ...(state.unlimited ? { unlimited: true } : {}),
        ...(state.pausedAutoSend ? { 'paused-auto-send': true } : {}),
    };
}

/** The state read from a queue entry; undefined when there is none or it does not read. */
export function softInterruptFromYaml(raw: unknown): SoftInterruptState | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    const requestedAt = Date.parse(String(r['requested-at'] ?? ''));
    if (!Number.isFinite(requestedAt)) { return undefined; }
    const heldAt = Date.parse(String(r['held-at'] ?? ''));
    const kind = r.kind === 'tool' || r.kind === 'question' || r.kind === 'wait' ? r.kind : undefined;
    return {
        requestedAt,
        ...(Number.isFinite(heldAt) ? { heldAt } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof r.tool === 'string' ? { tool: r.tool } : {}),
        ...(typeof r['held-result'] === 'string' ? { heldResult: r['held-result'] } : {}),
        ...(r.unlimited === true ? { unlimited: true } : {}),
        ...(r['paused-auto-send'] === true ? { pausedAutoSend: true } : {}),
    };
}

/**
 * A saved conversation with the held-for line put before its last round's
 * first tool result (a restart continues it, vscimpb112): direct API — the
 * last user message's first tool_result block; Local LLM — the first `tool`
 * message after the last assistant message.
 */
export function prefixHeldConversation(conversation: { transport: 'direct' | 'localLlm'; messages: unknown[] }, prefix: string | undefined): { transport: 'direct' | 'localLlm'; messages: unknown[] } {
    if (!prefix) { return conversation; }
    const messages = conversation.messages.map((m) => (m && typeof m === 'object' ? { ...(m as object) } : m)) as Array<Record<string, unknown>>;
    if (conversation.transport === 'direct') {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)) {
            const blocks = [...last.content as Array<Record<string, unknown>>];
            const i = blocks.findIndex((b) => b && b.type === 'tool_result');
            if (i >= 0) { blocks[i] = { ...blocks[i], content: prefixedToolResultContent(blocks[i].content, prefix) }; }
            last.content = blocks;
        }
    } else {
        let lastAssistant = -1;
        messages.forEach((m, i) => { if (m && m.role === 'assistant') { lastAssistant = i; } });
        const i = messages.findIndex((m, j) => j > lastAssistant && m && m.role === 'tool');
        if (i >= 0) { messages[i] = { ...messages[i], content: `${prefix}\n\n${String(messages[i].content ?? '')}` }; }
    }
    return { transport: conversation.transport, messages };
}
