/**
 * Forwards this window's live Anthropic/Local-LLM conversation to a Telegram
 * chat so the user can "listen in" on whatever prompt is currently running —
 * whether it was launched from Telegram (`send_prompt`) or typed into VS Code.
 *
 * Unlike the old per-`send_prompt` forwarder, a single
 * {@link TelegramLiveConversationForwarder} is created when Telegram polling
 * starts and lives for the whole polling session, subscribing to **every**
 * live-trail event for this window's quest. Two listening modes (toggled from
 * Telegram) decide how much of the conversation is forwarded:
 *
 *   - **listening** (default) — every coalesced update is streamed: prompt
 *     restatement, tool calls, assistant text, and the terminal footer.
 *   - **silent** — intermediate updates (tool calls, streamed assistant text)
 *     are suppressed; only the **final answer** plus the terminal footer are
 *     sent when the turn ends.
 *
 * The **prompt restatement** and the **final answer** are "main" messages that
 * are *always* delivered in both modes (the user's hard requirement): the
 * follower always sees which prompt started — restating the prompt text just
 * sent — and how it ended, even while muted to the intermediate noise.
 *
 * The forwarder also tracks whether a prompt is currently running (and for how
 * long) so the `/chat_status` command and the "already running" rejection can
 * report it.
 *
 * Sends are serialized through a promise chain so messages keep their emission
 * order; send failures are swallowed — trail forwarding is best-effort
 * observability and must never affect the turn's result.
 */

import { LiveTrailWriter, type LiveTrailEvent } from '../services/live-trail';
import {
    TelegramTrailCoalescer,
    formatTrailTerminalLine,
    splitTelegramMessage,
} from '../services/telegramTrailCoalescer';
import { questMatches } from '../utils/telegramSendPrompt';

/** Minimal channel surface the forwarder needs — satisfied by `TelegramChannel`. */
export interface TrailSendChannel {
    sendMessage(
        text: string,
        chatId?: number | string,
        options?: { plain?: boolean },
    ): Promise<unknown>;
}

/** Snapshot of the currently-running prompt (if any) for `/chat_status`. */
export interface LiveConversationStatus {
    /** Whether a prompt is currently being processed in this window's quest. */
    running: boolean;
    /** Milliseconds since the running prompt started (0 when idle). */
    elapsedMs: number;
    /** Transport of the running prompt (e.g. `anthropic`), when running. */
    transport?: string;
    /** Configuration name of the running prompt, when running. */
    config?: string;
    /** Whether live updates are currently being streamed (vs. silent mode). */
    listening: boolean;
}

export class TelegramLiveConversationForwarder {
    private readonly coalescer = new TelegramTrailCoalescer();
    private disposable: { dispose(): void } | undefined;
    /** Serializes outbound sends so messages keep their emission order. */
    private sendChain: Promise<void> = Promise.resolve();
    /** When true, intermediate updates are streamed; when false, only the final answer. */
    private listening = true;
    /** Accumulated assistant text since the last prompt/tool call — the final answer. */
    private finalAnswer = '';
    /** Epoch ms when the current prompt started; `undefined` when idle. */
    private runningSince: number | undefined;
    private runningTransport: string | undefined;
    private runningConfig: string | undefined;

    /**
     * @param channel  Channel used to send progress messages (the polling
     *                 channel). `null` disables forwarding (still safe to use).
     * @param chatId   Telegram chat to forward the conversation to.
     * @param questId  Quest whose trail events to forward (this window's quest).
     */
    constructor(
        private readonly channel: TrailSendChannel | null,
        private readonly chatId: number | string,
        private readonly questId: string,
    ) {}

    /** Subscribe to live-trail events. Call once when polling starts. */
    start(): void {
        if (this.disposable) { return; }
        this.disposable = LiveTrailWriter.addObserver((event) => this.onEvent(event));
    }

    /** Unsubscribe from live-trail events. Call when polling stops. */
    stop(): void {
        this.disposable?.dispose();
        this.disposable = undefined;
    }

    /** Switch between streaming live updates (`true`) and silent mode (`false`). */
    setListening(on: boolean): void {
        this.listening = on;
    }

    /** Whether live updates are currently streamed. */
    isListening(): boolean {
        return this.listening;
    }

    /** Snapshot of the running prompt + listening mode for `/chat_status`. */
    getStatus(): LiveConversationStatus {
        const running = this.runningSince !== undefined;
        return {
            running,
            elapsedMs: running ? Date.now() - (this.runningSince as number) : 0,
            ...(running && this.runningTransport ? { transport: this.runningTransport } : {}),
            ...(running && this.runningConfig ? { config: this.runningConfig } : {}),
            listening: this.listening,
        };
    }

    /** Resolve once every queued send has settled (used by tests / shutdown). */
    async drain(): Promise<void> {
        await this.sendChain;
    }

    // ------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------

    private onEvent(event: LiveTrailEvent): void {
        if (!questMatches(event.questId, this.questId)) { return; }

        // --- Running-state + final-answer bookkeeping (independent of mode) ---
        switch (event.kind) {
            case 'prompt':
                this.runningSince = Date.now();
                this.runningTransport = event.transport;
                this.runningConfig = event.config;
                this.finalAnswer = '';
                break;
            case 'toolCall':
                // Anything before the last tool call isn't the final answer.
                this.finalAnswer = '';
                break;
            case 'assistant':
                this.finalAnswer += event.text;
                break;
            default:
                break;
        }

        const terminal =
            event.kind === 'done' || event.kind === 'error' || event.kind === 'interruption';

        // Always feed the coalescer so its buffer stays coherent for streaming.
        const coalesced = this.coalescer.push(event);

        // The prompt restatement is a main message — always forward it, even in
        // silent mode, so the follower always sees which prompt just started
        // (whether typed in VS Code or queued), mirroring the always-delivered
        // final answer. Only the intermediate updates honour silent mode.
        if (event.kind === 'prompt') {
            this.enqueue(coalesced);
            return;
        }

        if (terminal) {
            if (this.listening) {
                // Streaming already delivered the answer progressively; the
                // coalescer's terminal output is the tail + footer.
                this.enqueue(coalesced);
            } else {
                // Silent: deliver the complete final answer + footer now.
                const messages = splitTelegramMessage(this.finalAnswer.trim());
                messages.push(formatTrailTerminalLine(event));
                this.enqueue(messages);
            }
            this.runningSince = undefined;
            this.runningTransport = undefined;
            this.runningConfig = undefined;
            return;
        }

        // Non-terminal: stream only while listening.
        if (this.listening) {
            this.enqueue(coalesced);
        }
    }

    /** Append messages to the serialized send chain. */
    private enqueue(messages: string[]): void {
        if (messages.length === 0 || !this.channel) { return; }
        const channel = this.channel;
        for (const message of messages) {
            if (!message) { continue; }
            this.sendChain = this.sendChain.then(async () => {
                try {
                    await channel.sendMessage(message, this.chatId, { plain: true });
                } catch {
                    // best-effort — forwarding must never affect the turn
                }
            });
        }
    }
}
