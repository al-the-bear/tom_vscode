/**
 * The error a Local LLM leaf (Ollama, vLLM / OpenAI-compatible) rejects with
 * for an HTTP error response: the server's message, its status as `status`
 * (what `isRetryableBusyError` and `providerRetryDelayMs` read, as on the
 * Anthropic SDK's `APIError`) and `statusCode` (what the leaf's own log and
 * older callers read), and the response headers, so a `retry-after` /
 * `retry-after-ms` the server sends is honoured by the retry loop.
 *
 * vscode-free.
 */

import type { IncomingHttpHeaders } from 'http';

export type HttpStatusError = Error & { status: number; statusCode: number; headers: IncomingHttpHeaders };

export function httpStatusError(message: string, status: number, headers: IncomingHttpHeaders): HttpStatusError {
    return Object.assign(new Error(message), { status, statusCode: status, headers });
}
