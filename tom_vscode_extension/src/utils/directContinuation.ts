/**
 * The direct transport's continuation after a dropped connection (CC-8).
 *
 * The Agent SDK resumes its session with a continuation prompt when a send
 * breaks off. The direct transport keeps the turn's conversation itself — the
 * prompt and every finished tool round in `messages` — so after a dropped
 * connection it sends the round again over that history, with the
 * continuation prompt (the same `anthropic.transportRetry` template the Agent
 * SDK uses) added to the last user message, instead of failing the turn and
 * starting the prompt again. A busy backend (429 / 529 / 5xx) is not a dropped
 * connection: the retry budget inside `send` rides that out unchanged.
 *
 * vscode-free.
 */

import { isDroppedConnectionError } from './retryableError';

/** A message of the turn, as far as this step writes it. */
export interface ContinuationMessage {
    role: string;
    content: unknown;
}

/** The text block a continuation adds to the last user message. */
export interface ContinuationBlock {
    type: 'text';
    text: string;
}

export interface SendWithContinuationOptions<T> {
    /** The turn's messages; the continuation prompt is added to the last one (a user message). */
    messages: ContinuationMessage[];
    /** Sends the round over `messages` as they are now. */
    send: () => Promise<T>;
    /** Attempts in all, the first included (`anthropic.transportRetry.maxAttempts`); 1 = no continuation. */
    maxAttempts: number;
    /** The continuation prompt for a dropped connection's error text. */
    continuationPrompt: (errorText: string) => string;
    /** True once the user stopped the send: nothing is continued then. */
    isCancelled?: () => boolean;
    /** Told before each continuation: the attempt it starts (2, 3, …) and the error. */
    onContinue?: (attempt: number, maxAttempts: number, errorText: string) => void;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Put `text` into the last message, a user message: as a text block after
 * its content, or into `previous` when that block is already there (a second
 * continuation of the same round replaces the first's prompt, not adds one).
 * Answers the block.
 */
export function addContinuationPrompt(
    messages: ContinuationMessage[],
    text: string,
    previous?: ContinuationBlock,
): ContinuationBlock {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') {
        throw new Error('A continuation follows a user message (the prompt or a round\'s tool results).');
    }
    if (typeof last.content === 'string') {
        last.content = [{ type: 'text', text: last.content }];
    }
    const blocks = last.content as unknown[];
    if (previous && blocks.includes(previous)) {
        previous.text = text;
        return previous;
    }
    const block: ContinuationBlock = { type: 'text', text };
    blocks.push(block);
    return block;
}

/**
 * Send the round; after a dropped connection, add the continuation prompt and
 * send it again over the same history, up to `maxAttempts` in all. Any other
 * error, a cancellation, or the last attempt's failure is thrown.
 */
export async function sendWithContinuation<T>(opts: SendWithContinuationOptions<T>): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
    let block: ContinuationBlock | undefined;
    for (let attempt = 1; ; attempt++) {
        try {
            return await opts.send();
        } catch (err) {
            if (opts.isCancelled?.() || !isDroppedConnectionError(err) || attempt >= maxAttempts) { throw err; }
            const text = errorText(err);
            block = addContinuationPrompt(opts.messages, opts.continuationPrompt(text), block);
            opts.onContinue?.(attempt + 1, maxAttempts, text);
        }
    }
}
