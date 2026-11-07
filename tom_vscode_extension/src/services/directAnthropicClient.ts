/**
 * The direct transport's Anthropic client.
 *
 * Built with `maxRetries: 0`: the SDK's own retries (two by default, for
 * 408 / 409 / 429 / 5xx and connection errors, with a short backoff that
 * honours `retry-after` only up to 60 s) would run before the time-budget
 * loop (`withRetryBudget`) sees an error — a 429 costing three requests
 * before the reset headers are read, the attempts the queue and live trail
 * count off by the hidden ones, and the budget not the only bound. Our loop
 * is the one retry layer; `isRetryableBusyError` covers what the SDK did.
 *
 * vscode-free.
 */

import Anthropic from '@anthropic-ai/sdk';

/** The SDK's retries on the direct client: none — the budget loop retries. */
export const DIRECT_CLIENT_MAX_RETRIES = 0;

/** The client the direct transport sends with; `fetch` is for tests. */
export function createDirectAnthropicClient(apiKey: string, fetch?: typeof globalThis.fetch): Anthropic {
    return new Anthropic({ apiKey, maxRetries: DIRECT_CLIENT_MAX_RETRIES, ...(fetch ? { fetch } : {}) });
}
