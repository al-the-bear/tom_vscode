/**
 * Agent SDK query input — decides when the CLI's stdin may close.
 *
 * The Claude Code CLI reaches the extension's in-process MCP server (every
 * `tomAi_*` tool) through control requests, and the responses travel back on
 * the CLI's stdin. Given a STRING prompt, the SDK closes stdin at the query's
 * first `result` message. The CLI does not always stop there:
 *
 *   - when a background agent finishes after the model has ended its turn, the
 *     CLI runs a continuation turn in the same process;
 *   - on resume, the CLI first runs an orphan-summary notification about the
 *     previous process's background tasks as a turn of its own, and that
 *     turn's result arrives before the prompt has started.
 *
 * Every in-process MCP call made after stdin closed fails within milliseconds
 * with "The tool call was interrupted before a result was received", and the
 * handler never runs. So the transport passes the prompt as a stream instead,
 * and this channel keeps that stream open until the CLI says the work is over:
 * a `session_state_changed: idle` after a result that answers THIS message
 * (matched by the uuid the message carries). `idle` is the CLI's own turn-over
 * signal; it comes after held-back results and background-agent continuations.
 * The CLI emits it only when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set,
 * which the transport does.
 *
 * Two fallbacks keep a query from hanging on a CLI that behaves differently:
 * a CLI that emits no session-state events closes at the answering result
 * (the old behaviour), and an `idle` while our message is still unanswered
 * closes after a grace period unless the CLI starts running again.
 *
 * Pure: imports neither `vscode` nor the SDK.
 */

// The SDK's message fields are its snake_case wire format and cannot be renamed.
/* eslint-disable @typescript-eslint/naming-convention */
import { randomUUID } from 'node:crypto';

/** The user message the SDK's streaming-input mode expects. */
export interface SdkPromptMessage {
    type: 'user';
    uuid: string;
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
}

export type InputCloseReason =
    | 'idle-after-answer'
    | 'idle-unanswered-timeout'
    | 'result-without-session-state'
    | (string & {});

export interface QueryInputChannelOptions {
    /** Uuid stamped on the prompt; defaults to a fresh v4 uuid. */
    uuid?: string;
    /** Wait after an unanswered `idle` before closing anyway. Default 10 s. */
    graceMs?: number;
    /** Called once, when the channel closes. */
    onClose?: (reason: InputCloseReason) => void;
}

const DEFAULT_GRACE_MS = 10_000;

export class QueryInputChannel {
    readonly uuid: string;
    private readonly text: string;
    private readonly graceMs: number;
    private readonly onClose?: (reason: InputCloseReason) => void;
    private answered = false;
    private sawSessionState = false;
    private graceTimer: ReturnType<typeof setTimeout> | undefined;
    private reason: InputCloseReason | undefined;
    private resolveClosed!: () => void;
    private readonly closedPromise: Promise<void>;

    constructor(text: string, options: QueryInputChannelOptions = {}) {
        this.text = text;
        this.uuid = options.uuid ?? randomUUID();
        this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
        this.onClose = options.onClose;
        this.closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
    }

    get closed(): boolean { return this.reason !== undefined; }
    get closeReason(): InputCloseReason | undefined { return this.reason; }

    /** The prompt stream: our one message, then open until {@link close}. */
    async *messages(): AsyncGenerator<SdkPromptMessage, void, unknown> {
        yield {
            type: 'user',
            uuid: this.uuid,
            message: { role: 'user', content: this.text },
            parent_tool_use_id: null,
            session_id: '',
        };
        await this.closedPromise;
    }

    /** Feed every message of the query's output stream through here. */
    observe(msg: unknown): void {
        if (this.closed || !msg || typeof msg !== 'object') { return; }
        const m = msg as { type?: unknown; subtype?: unknown; state?: unknown };
        if (m.type === 'system' && m.subtype === 'session_state_changed') {
            this.sawSessionState = true;
            if (m.state === 'running') {
                this.clearGrace();
            } else if (m.state === 'idle') {
                if (this.answered) {
                    this.close('idle-after-answer');
                } else {
                    this.startGrace();
                }
            }
            return;
        }
        if (m.type === 'result' && this.answers(msg)) {
            this.answered = true;
            if (!this.sawSessionState) {
                this.close('result-without-session-state');
            }
        }
    }

    /** Close the stream (idempotent; the first reason is kept). */
    close(reason: InputCloseReason): void {
        if (this.closed) { return; }
        this.reason = reason;
        this.clearGrace();
        this.resolveClosed();
        try { this.onClose?.(reason); } catch { /* diagnostics only */ }
    }

    private answers(msg: object): boolean {
        const r = msg as { user_message_uuid?: unknown; user_message_uuids?: unknown };
        if (Array.isArray(r.user_message_uuids) && r.user_message_uuids.includes(this.uuid)) { return true; }
        return r.user_message_uuid === this.uuid;
    }

    private startGrace(): void {
        this.clearGrace();
        this.graceTimer = setTimeout(() => this.close('idle-unanswered-timeout'), this.graceMs);
    }

    private clearGrace(): void {
        if (this.graceTimer !== undefined) {
            clearTimeout(this.graceTimer);
            this.graceTimer = undefined;
        }
    }
}

/**
 * The text the SDK puts in a tool result when the call never got an answer
 * from its MCP server. Matched on short results only, so a result that merely
 * quotes the sentence (a log excerpt) is not mistaken for one.
 */
const CHANNEL_DEAD_TEXT = 'interrupted before a result was received';
const CHANNEL_DEAD_MAX_LENGTH = 400;

export function isChannelDeadToolResult(text: string): boolean {
    return text.length <= CHANNEL_DEAD_MAX_LENGTH && text.includes(CHANNEL_DEAD_TEXT);
}
