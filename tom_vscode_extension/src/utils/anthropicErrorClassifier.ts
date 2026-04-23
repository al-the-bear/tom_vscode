/**
 * Classify thrown errors from the Anthropic SDK (and its look-alike leaves:
 * Agent SDK, VS Code LM, Local LLM) into a small set of user-facing
 * "interruption" categories. The prompt queue uses this to (a) decorate the
 * live-trail end-of-turn marker with a yellow banner explaining what
 * happened, and (b) surface a coloured chip on the queue item so the user
 * can see at a glance that a send was rate-limited / quota-capped / merely
 * cancelled, rather than a hard protocol bug.
 *
 * Keep this file boundary-layer: no `import 'vscode'`, no SDK types — we
 * duck-type off `status` / `error.type` / `message` / `name` because the
 * thrown value could be an `Anthropic.APIError`, a plain `Error` wrapped
 * by one of our leaves, or an `AbortError` from cancellation.
 */

/** Human-facing cause of an interruption. */
export type InterruptionKind =
    /** HTTP 429 or body `error.type === 'rate_limit_error'`. Retry after cool-down. */
    | 'rate_limit'
    /** Session / monthly / weekly quota exhausted (body type `credit_balance_too_low`, plan-cap messages). */
    | 'quota_exceeded'
    /** HTTP 529 / body `overloaded_error`. Anthropic server pressure — usually transient. */
    | 'overloaded'
    /** The user cancelled (Stop button, AbortError) or the token token tripped. */
    | 'cancelled'
    /** Stream closed early with no clear reason — "interrupted" responses the model produces. */
    | 'interrupted';

export interface Interruption {
    kind: InterruptionKind;
    /** Short one-line message suitable for surfacing to the user. */
    message: string;
}

/**
 * Inspect an error thrown from a send path and classify it. Returns
 * `null` when the error doesn't match any of the known interruption
 * kinds — callers treat that as a generic failure (status: 'error' with
 * no warning chip).
 */
export function classifyAnthropicError(err: unknown): Interruption | null {
    if (!err) { return null; }

    // Pull fields defensively — Anthropic.APIError has `.status` and `.error.type`;
    // AbortError has `.name === 'AbortError'`; raw Error only has `.message`.
    const errObj = err as {
        status?: unknown;
        name?: unknown;
        message?: unknown;
        error?: { type?: unknown; message?: unknown } | unknown;
    };
    const status = typeof errObj.status === 'number' ? errObj.status : undefined;
    const name = typeof errObj.name === 'string' ? errObj.name : '';
    const message = typeof errObj.message === 'string' ? errObj.message : String(err);
    const errorBody = (errObj.error && typeof errObj.error === 'object')
        ? errObj.error as { type?: unknown; message?: unknown }
        : undefined;
    const bodyType = typeof errorBody?.type === 'string' ? errorBody.type : '';
    const bodyMsg = typeof errorBody?.message === 'string' ? errorBody.message : '';
    const combined = `${message}\n${bodyMsg}`.toLowerCase();

    // ---- cancellation --------------------------------------------------
    if (name === 'AbortError' || name === 'CanceledError' || name === 'CancelledError') {
        return { kind: 'cancelled', message: 'Send was cancelled before completing.' };
    }
    if (/\b(aborted|cancell?ed|canceled by user)\b/.test(combined)) {
        return { kind: 'cancelled', message: shortOne(message) || 'Send was cancelled.' };
    }

    // ---- quota (session / weekly / monthly) ----------------------------
    // Anthropic returns `credit_balance_too_low` for hard quota exhaustion;
    // Claude.ai-backed routes surface "session limit" / "weekly limit" /
    // "usage limit" in the message body.
    if (bodyType === 'credit_balance_too_low') {
        return {
            kind: 'quota_exceeded',
            message: `Quota / credit balance exhausted: ${shortOne(bodyMsg || message)}`,
        };
    }
    if (/\b(quota|credit balance|weekly limit|monthly limit|session limit|usage limit|plan limit|billing)\b/.test(combined)) {
        return {
            kind: 'quota_exceeded',
            message: `Quota reached: ${shortOne(message)}`,
        };
    }

    // ---- overloaded (transient server pressure) ------------------------
    if (status === 529 || bodyType === 'overloaded_error' || /\boverloaded\b/.test(combined)) {
        return {
            kind: 'overloaded',
            message: 'Anthropic API is temporarily overloaded. Retry in a moment.',
        };
    }

    // ---- rate limit ----------------------------------------------------
    if (status === 429 || bodyType === 'rate_limit_error' || /\brate[_ ]?limit(ed)?\b/.test(combined)) {
        return {
            kind: 'rate_limit',
            message: `Rate limit hit: ${shortOne(bodyMsg || message)}`,
        };
    }

    // ---- interrupted ("stream ended early" / stop_reason indicators) ---
    // Leaves sometimes synthesise "request errored before any assistant text"
    // messages; keep the kind distinct from a plain error so the user knows
    // the model DID start producing something and can just resend.
    if (/\b(interrupt(ed|ion)?|stream (closed|ended) early|partial (output|response)|stop_reason: pause_turn|stop_reason: refusal)\b/.test(combined)) {
        return {
            kind: 'interrupted',
            message: `Response was interrupted: ${shortOne(message)}`,
        };
    }

    return null;
}

/**
 * Return a short, one-line, user-facing label for a kind. Used by the
 * webview chip and the live-trail block heading when no richer message
 * is available.
 */
export function interruptionLabel(kind: InterruptionKind): string {
    switch (kind) {
        case 'rate_limit': return 'Rate limit';
        case 'quota_exceeded': return 'Quota exceeded';
        case 'overloaded': return 'Overloaded';
        case 'cancelled': return 'Cancelled';
        case 'interrupted': return 'Interrupted';
    }
}

/** First line, collapsed whitespace, capped at 240 chars. */
function shortOne(s: string): string {
    const firstLine = s.split(/\r?\n/, 1)[0] ?? '';
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    return collapsed.length > 240 ? collapsed.slice(0, 237) + '…' : collapsed;
}
