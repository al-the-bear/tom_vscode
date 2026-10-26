/**
 * One Messages API call on the direct transport, always streamed.
 *
 * The SDK refuses a non-streaming `messages.create` whose `max_tokens` could
 * make it run longer than ten minutes ("Streaming is required for operations
 * that may take longer than 10 minutes"), and the configurations of the
 * current models ask for 64k-128k output tokens. Streaming and waiting for
 * the final message returns the same `Message` a non-streaming call would,
 * so the tool loop around it does not change, and the API errors it throws
 * are the same classes, so the retry budget classifies them as before.
 */

import type Anthropic from '@anthropic-ai/sdk';

/** The part of the client this needs (a test passes a fake). */
export interface MessageStreamingClient {
    messages: {
        stream(
            params: Anthropic.MessageCreateParamsNonStreaming,
            options?: { signal?: AbortSignal },
        ): { finalMessage(): Promise<Anthropic.Message> };
    };
}

/** Send `params` as a streamed request and resolve with the final message. */
export async function createMessageStreamed(
    client: MessageStreamingClient,
    params: Anthropic.MessageCreateParamsNonStreaming,
    signal?: AbortSignal,
): Promise<Anthropic.Message> {
    return client.messages.stream(params, signal ? { signal } : undefined).finalMessage();
}

/** The part of a `vscode.CancellationToken` this needs. */
export interface CancellationLike {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): unknown;
}

/**
 * An AbortSignal that fires when `token` is cancelled (already aborted when it
 * is), so cancelling a send also aborts the HTTP stream in flight; undefined
 * without a token.
 */
export function abortSignalFor(token: CancellationLike | undefined): AbortSignal | undefined {
    if (!token) { return undefined; }
    const controller = new AbortController();
    if (token.isCancellationRequested) {
        controller.abort();
    } else {
        token.onCancellationRequested(() => controller.abort());
    }
    return controller.signal;
}
