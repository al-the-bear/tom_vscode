/**
 * Pure, dependency-free classification of "transient backend-busy" errors that
 * are worth retrying. Kept free of `vscode` and SDK imports so it can be shared
 * by both retry paths and unit-tested under `node --test`:
 *
 *   - the **time-budget** retry loop (`retryWithBudget.ts`, used by the Anthropic
 *     *direct* SDK transport and the Local LLM transport), and
 *   - the **Agent SDK** transport retry loop (`agent-sdk-transport.ts`, driven by
 *     `agent-sdk-retry.ts`).
 *
 * Different backends signal "busy" differently — Anthropic uses 429/500/529, the
 * Claude Agent SDK surfaces the same as `API Error: <code> { ... }` strings,
 * vLLM uses 429/503, Ollama tends to use 500/503 with a textual hint. This
 * normalises across them by inspecting both a numeric `.status` (the raw
 * Anthropic SDK error carries it) and the error text (the Agent SDK embeds the
 * status code in the message instead).
 */

/** HTTP status codes treated as transient backend pressure worth retrying. */
const RETRYABLE_STATUS = new Set([429, 500, 503, 529]);

/**
 * Returns true when an error looks like a transient "backend busy / overloaded /
 * rate-limited / internal server error" signal worth retrying. Other errors
 * (auth, model-not-found, malformed request) return false so they escape
 * immediately and the user can fix them.
 *
 * `500` is included because Anthropic's `api_error` ("Internal server error")
 * and Ollama's 500s are server-side transients — the SDK itself retries them by
 * default; our outer loops must agree so a 500 isn't treated as fatal.
 */
export function isRetryableBusyError(err: unknown): boolean {
    if (err === null || err === undefined) { return false; }
    const anyErr = err as { status?: number; message?: string };
    if (typeof anyErr.status === 'number' && RETRYABLE_STATUS.has(anyErr.status)) {
        return true;
    }
    const msg = typeof anyErr.message === 'string' ? anyErr.message : String(err);
    // Both `HTTP 529` (our leaf-wrapped text) and `API Error: 529` (Claude Agent
    // SDK) embed the code in the message — match either prefix.
    if (/(?:HTTP|API Error:)\s*(?:429|500|503|529)\b/i.test(msg)) { return true; }
    if (/\brate[\s_-]?limit/i.test(msg)) { return true; }
    if (/\boverload(ed)?/i.test(msg)) { return true; }
    if (/\binternal\s+server\s+error/i.test(msg)) { return true; }
    if (/\bservice\s+unavailable/i.test(msg)) { return true; }
    if (/\bserver\s+busy/i.test(msg)) { return true; }
    if (/\btoo\s+many\s+requests/i.test(msg)) { return true; }
    return false;
}
