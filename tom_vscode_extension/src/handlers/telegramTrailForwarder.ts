/**
 * Forwards a single Anthropic turn's live-trail to a Telegram chat so a user who
 * launched a prompt with `send_prompt` can follow the model's progress (tool
 * calls, assistant text, final outcome) from their phone.
 *
 * Lifecycle, owned by the `send_prompt` command handler:
 *
 *   const fwd = new TelegramSendPromptForwarder(channel, chatId, questId);
 *   fwd.start();                       // subscribe before the turn begins
 *   const outcome = await runAnthropicSend(ctx, prompt);
 *   fwd.flush();                       // emit any buffered assistant tail
 *   await fwd.drain();                 // wait for the send chain to settle
 *   fwd.stop();                        // unsubscribe
 *
 * Only events for the matching quest are forwarded (multiple windows may share
 * one bot). Sends are serialized through a promise chain so messages arrive in
 * order and don't interleave; send failures are swallowed — trail forwarding is
 * best-effort observability and must never affect the turn's result.
 */

import { LiveTrailWriter } from '../services/live-trail';
import { TelegramTrailCoalescer } from '../services/telegramTrailCoalescer';
import { questMatches } from '../utils/telegramSendPrompt';

/** Minimal channel surface the forwarder needs — satisfied by `TelegramChannel`. */
export interface TrailSendChannel {
    sendMessage(
        text: string,
        chatId?: number | string,
        options?: { plain?: boolean },
    ): Promise<unknown>;
}

export class TelegramSendPromptForwarder {
    private readonly coalescer = new TelegramTrailCoalescer();
    private disposable: { dispose(): void } | undefined;
    /** Serializes outbound sends so messages keep their emission order. */
    private sendChain: Promise<void> = Promise.resolve();
    private terminalSeen = false;

    /**
     * @param channel  Channel used to send progress messages (the polling
     *                 channel). `null` disables forwarding (still safe to use).
     * @param chatId   Telegram chat the prompt came from.
     * @param questId  Quest whose trail events to forward.
     */
    constructor(
        private readonly channel: TrailSendChannel | null,
        private readonly chatId: number | string,
        private readonly questId: string,
    ) {}

    /**
     * Whether a terminal event (`done` / `error` / `interruption`) was already
     * forwarded. The command handler uses this to avoid sending a redundant
     * final reply when the trail already announced the outcome.
     */
    get sawTerminal(): boolean {
        return this.terminalSeen;
    }

    /** Subscribe to live-trail events. Call before the turn starts. */
    start(): void {
        if (this.disposable) { return; }
        this.disposable = LiveTrailWriter.addObserver((event) => {
            if (!questMatches(event.questId, this.questId)) { return; }
            if (event.kind === 'done' || event.kind === 'error' || event.kind === 'interruption') {
                this.terminalSeen = true;
            }
            this.enqueue(this.coalescer.push(event));
        });
    }

    /** Emit any assistant text still buffered in the coalescer. */
    flush(): void {
        this.enqueue(this.coalescer.flush());
    }

    /** Resolve once every queued send has settled. */
    async drain(): Promise<void> {
        await this.sendChain;
    }

    /** Unsubscribe from live-trail events. */
    stop(): void {
        this.disposable?.dispose();
        this.disposable = undefined;
    }

    /** Append messages to the serialized send chain. */
    private enqueue(messages: string[]): void {
        if (messages.length === 0 || !this.channel) { return; }
        const channel = this.channel;
        for (const message of messages) {
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
