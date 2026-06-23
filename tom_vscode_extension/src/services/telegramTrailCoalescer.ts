/**
 * Coalesces a stream of {@link LiveTrailEvent}s into a small number of plain-text
 * messages suitable for Telegram, so a remotely-driven Anthropic turn can be
 * followed in chat without hitting the Bot API rate limit.
 *
 * Why this exists: the live-trail emits one event per thinking chunk, tool call,
 * tool result, and assistant-text chunk. Forwarding each verbatim would be both
 * spammy and rate-limited. This coalescer applies a fixed policy:
 *
 *   - **thinking** and **toolResult** events are dropped — noise for a follower.
 *   - **assistant** text chunks are buffered and concatenated; the buffer is
 *     flushed as one message when a structural event (tool call / done / error /
 *     interruption / explicit {@link flush}) arrives, or when it would exceed
 *     {@link maxMessageChars}.
 *   - **toolCall**, **done**, **error**, and **interruption** each produce a
 *     single concise line, after first flushing any pending assistant text so
 *     ordering is preserved.
 *
 * The class is **pure** (no I/O, no timers) so it is unit-testable in isolation;
 * the forwarder owns the async send chain.
 */

import type { LiveTrailEvent } from './live-trail.js';

/** Telegram hard limit is 4096 chars; stay well under to leave room for escaping. */
const DEFAULT_MAX_MESSAGE_CHARS = 3500;

/** A terminal live-trail event (the turn ended cleanly, failed, or was interrupted). */
export type TerminalTrailEvent = Extract<
    LiveTrailEvent,
    { kind: 'done' | 'error' | 'interruption' }
>;

/**
 * One-line summary for a terminal event, shared by the coalescer's streaming
 * path and the live-conversation forwarder's silent path so both render the
 * outcome footer identically.
 */
export function formatTrailTerminalLine(event: TerminalTrailEvent): string {
    switch (event.kind) {
        case 'done':
            return `✅ done (rounds=${event.rounds}, tools=${event.toolCalls}, ${event.durationMs}ms)`;
        case 'error':
            return `⚠️ error: ${event.message}`;
        case 'interruption':
            return `🟡 ${event.label}: ${event.message}`;
    }
}

/**
 * Split a single block of text into Telegram-sized messages (hard slices at
 * `maxChars`). Returns `[]` for empty input. Used by the forwarder to deliver a
 * long final answer in silent mode without exceeding the Bot API message cap.
 */
export function splitTelegramMessage(
    text: string,
    maxChars: number = DEFAULT_MAX_MESSAGE_CHARS,
): string[] {
    const t = text ?? '';
    if (t.length === 0) { return []; }
    const out: string[] = [];
    let rest = t;
    while (rest.length > maxChars) {
        out.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
    }
    if (rest.length > 0) { out.push(rest); }
    return out;
}

export class TelegramTrailCoalescer {
    private readonly maxMessageChars: number;
    /** Accumulated assistant text not yet emitted as a message. */
    private buffer = '';

    constructor(opts: { maxMessageChars?: number } = {}) {
        const n = opts.maxMessageChars;
        this.maxMessageChars = Number.isFinite(n) && (n as number) > 0
            ? Math.floor(n as number)
            : DEFAULT_MAX_MESSAGE_CHARS;
    }

    /**
     * Feed one event. Returns zero or more messages to send **now**, in order.
     * Assistant text is buffered and may not produce output until a later event
     * (or {@link flush}) forces it out.
     */
    push(event: LiveTrailEvent): string[] {
        switch (event.kind) {
            case 'prompt': {
                // A fresh prompt block — flush anything stale, then restate the
                // prompt itself so a Telegram follower sees exactly what was
                // sent. The prompt is a "main" message the forwarder always
                // delivers (in both listening and silent modes), mirroring the
                // always-delivered final answer. The body is split so a long
                // prompt is delivered in full without exceeding the message cap.
                const header = `🚀 prompt [${event.transport}/${event.config}]`;
                const body = (event.userText ?? '').trim();
                const message = body ? `${header}\n\n${body}` : header;
                return [...this.flush(), ...splitTelegramMessage(message, this.maxMessageChars)];
            }
            case 'thinking':
            case 'toolResult':
                return [];
            case 'assistant':
                return this.appendAssistant(event.text);
            case 'toolCall':
                return [...this.flush(), `🔧 ${event.toolName}`];
            case 'retry':
                // A mid-turn transient-failure retry — flush buffered text and
                // surface it so a Telegram follower sees the error + retry too,
                // mirroring the live-trail's `🔁 retry` entry.
                return [...this.flush(), `🔁 retry — ${event.message}`];
            case 'done':
            case 'error':
            case 'interruption':
                return [...this.flush(), formatTrailTerminalLine(event)];
            default: {
                // Exhaustiveness guard: a new event kind must be handled above.
                const _never: never = event;
                void _never;
                return [];
            }
        }
    }

    /**
     * Emit any buffered assistant text as a message and clear the buffer.
     * Called by `push` before structural events and by the forwarder when the
     * turn ends. Returns 0 or 1 messages — {@link appendAssistant} already keeps
     * the buffer below {@link maxMessageChars}, so a single message always fits.
     */
    flush(): string[] {
        const text = this.buffer.trim();
        this.buffer = '';
        return text ? [text] : [];
    }

    /**
     * Buffer an assistant chunk. If the buffer grows past the size limit, emit
     * the full chunks that fit now and keep the remainder buffered so streamed
     * output is delivered progressively rather than all at the end. The retained
     * remainder is always below the limit, so {@link flush} never has to split.
     */
    private appendAssistant(text: string): string[] {
        if (!text) { return []; }
        this.buffer += text;
        if (this.buffer.length < this.maxMessageChars) { return []; }
        // Emit complete max-sized chunks, retaining the trailing partial.
        const out: string[] = [];
        while (this.buffer.length >= this.maxMessageChars) {
            out.push(this.buffer.slice(0, this.maxMessageChars));
            this.buffer = this.buffer.slice(this.maxMessageChars);
        }
        return out;
    }
}
