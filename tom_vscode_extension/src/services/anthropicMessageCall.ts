/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (context_management, clear_at_least, ...) */
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
    /** The beta surface, for a request that names betas (context editing). */
    beta?: {
        messages: {
            stream(
                params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
                options?: { signal?: AbortSignal },
            ): { finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage> };
        };
    };
}

/** Beta-only request fields: `betas` and `context_management` (server-side context editing). */
export interface BetaRequestFields {
    betas?: string[];
    context_management?: Anthropic.Beta.Messages.BetaContextManagementConfig;
}

/** A final message, with what the server's context editing did when the request asked for it. */
export type StreamedMessage = Anthropic.Message & { context_management?: Anthropic.Beta.Messages.BetaContextManagementResponse | null };

/**
 * Send `params` as a streamed request and resolve with the final message. A
 * request with betas goes through the beta surface (`client.beta.messages`),
 * every other one through `client.messages` as before.
 */
export async function createMessageStreamed(
    client: MessageStreamingClient,
    params: Anthropic.MessageCreateParamsNonStreaming & BetaRequestFields,
    signal?: AbortSignal,
): Promise<StreamedMessage> {
    const options = signal ? { signal } : undefined;
    if (params.betas && params.betas.length > 0) {
        if (!client.beta) { throw new Error('createMessageStreamed: this client has no beta surface for betas ' + params.betas.join(', ')); }
        const message = await client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, options).finalMessage();
        return message as unknown as StreamedMessage;
    }
    const { betas: _b, context_management: _c, ...plain } = params;
    return client.messages.stream(plain, options).finalMessage();
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
