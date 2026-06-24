/**
 * Pure decision logic for the Agent SDK transport retry loop
 * (spec: anthropic_sdk_integration.md §18, "Anthropic Transport Retry").
 *
 * Kept free of `vscode` / SDK imports so it can be unit-tested under
 * `node --test` without the extension host. `agent-sdk-transport.ts`
 * re-exports these symbols and drives the actual retry loop with them.
 */

/**
 * Classify an Agent SDK error message as a "session unusable" failure —
 * the resumed session id is not recognised by the SDK ("no session" /
 * "unknown session id"). On such an error the only sane retry is a fresh
 * session (no `resume`), so {@link planAgentSdkRetry} routes to
 * `retry-fresh` regardless of whether a session id was captured.
 */
export function isUnknownSessionError(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes('no session') || m.includes('unknown session');
}

/** Outcome of {@link planAgentSdkRetry}. */
export type AgentSdkRetryPlan =
    | { kind: 'give-up' }
    | { kind: 'retry-fresh' }
    | { kind: 'retry-resume'; sessionId: string };

/** Inputs describing the just-failed attempt. */
export interface AgentSdkRetryInput {
    /** Attempts already completed (>= 1). */
    attemptsMade: number;
    /** Total attempts allowed including the first. */
    maxAttempts: number;
    /** Error message from the failed attempt. */
    errorMessage: string;
    /** Session id we tried to resume on the failed attempt, if any. */
    resumeSessionId?: string;
    /** Session id captured from the stream during the failed attempt, if any. */
    capturedSessionId?: string;
    /** Whether cancellation was requested. */
    cancelled?: boolean;
    /**
     * Whether the failed attempt's error is a transient backend-busy signal
     * (HTTP 429 / 500 / 503 / 529 / overloaded). The caller classifies the raw
     * error with the shared `isRetryableBusyError` and passes the result here so
     * this module stays free of `vscode` / SDK imports. When true AND a positive
     * `maxTotalWaitMs` is supplied, the retry is bounded by the **time budget**
     * instead of `maxAttempts` — a sustained overload needs many spaced-out
     * retries over minutes/hours, not the small instant `maxAttempts` cap.
     */
    errorIsBusy?: boolean;
    /** Elapsed time (ms) since the first failure in this retry sequence. */
    elapsedMs?: number;
    /**
     * Time budget (ms) for retrying *busy* errors. Maps from the Anthropic
     * profile's `retryMaxTotalWaitMinutes`. Undefined / <= 0 falls back to the
     * `maxAttempts` count bound (legacy behavior).
     */
    maxTotalWaitMs?: number;
}

/**
 * Decide whether (and how) to retry an Agent SDK attempt.
 *
 * Rules:
 *  - Never retry once cancellation was requested.
 *  - **Busy errors with a time budget** (`errorIsBusy && maxTotalWaitMs > 0`)
 *    retry until `elapsedMs >= maxTotalWaitMs`, ignoring `maxAttempts` — this is
 *    how a 529/500 overload is ridden out for the profile's full retry window.
 *  - **Other errors** (the "resume interrupted work" case) keep the legacy
 *    count bound: give up once `attemptsMade >= maxAttempts`.
 *  - **Fresh session** (`retry-fresh`, replay original prompt) when no
 *    session id is known yet OR the error is an unknown/no-session error.
 *  - Otherwise **resume** (`retry-resume`) the most recent session id and
 *    send a continuation prompt built from the error text.
 */
export function planAgentSdkRetry(input: AgentSdkRetryInput): AgentSdkRetryPlan {
    if (input.cancelled === true) {
        return { kind: 'give-up' };
    }
    const budgetBounded =
        input.errorIsBusy === true &&
        typeof input.maxTotalWaitMs === 'number' &&
        input.maxTotalWaitMs > 0;
    if (budgetBounded) {
        if ((input.elapsedMs ?? 0) >= (input.maxTotalWaitMs as number)) {
            return { kind: 'give-up' };
        }
    } else if (input.attemptsMade >= input.maxAttempts) {
        return { kind: 'give-up' };
    }
    // Prefer the id captured during the failed attempt (the live session)
    // over the one we asked to resume.
    const sessionId = input.capturedSessionId || input.resumeSessionId;
    if (!sessionId || isUnknownSessionError(input.errorMessage)) {
        return { kind: 'retry-fresh' };
    }
    return { kind: 'retry-resume', sessionId };
}

/** Tunables for {@link computeBackoffMs}. */
export interface BackoffOptions {
    /** Delay before the first retry (ms). Default 1000. */
    initialDelayMs?: number;
    /** Cap on a single backoff step (ms). Default 5 minutes. */
    maxDelayMs?: number;
}

/**
 * Exponential backoff delay for the `retryIndex`-th busy retry (0 = the wait
 * before the first retry). Pure so the transport loop's spacing is testable
 * without timers: `initialDelayMs * 2^retryIndex`, capped at `maxDelayMs`.
 */
export function computeBackoffMs(retryIndex: number, opts?: BackoffOptions): number {
    const initial = opts?.initialDelayMs ?? 1000;
    const max = opts?.maxDelayMs ?? 5 * 60 * 1000;
    const idx = Math.max(0, Math.floor(retryIndex));
    return Math.min(initial * Math.pow(2, idx), max);
}

/**
 * Error-case fallback continuation prompt. Used **only** when no transport
 * retry template can be resolved from the config — i.e. there is no config on
 * disk, or it carries no template marked `isDefault`. In normal operation the
 * body comes from the on-disk "Default Retry" template (seeded by
 * `ensureDefaultTransportRetryTemplate`). References `${errorText}`; the handler
 * expands it with the placeholder engine before passing it as
 * `buildContinuationPrompt`.
 */
export const DEFAULT_TRANSPORT_RETRY_TEMPLATE =
    'The previous attempt failed with the following error:\n\n${errorText}\n\n' +
    'Please continue from where you left off and complete the original request. ' +
    'Do not repeat work that already succeeded.';

/** Minimal shape of a single transport-retry template (config subset). */
export interface TransportRetryTemplateLike {
    id: string;
    template: string;
    isDefault?: boolean;
}

/** Minimal shape of the `anthropic.transportRetry` config section. */
export interface TransportRetrySectionLike {
    templateId?: string;
    templates?: TransportRetryTemplateLike[];
}

/**
 * Resolve the continuation-prompt body for a transport-retry attempt:
 *  - an explicit `templateId` selects that template by id;
 *  - an empty/missing `templateId` ("use default") selects the template
 *    marked `isDefault`;
 *  - if neither resolves, fall back to {@link DEFAULT_TRANSPORT_RETRY_TEMPLATE}.
 *
 * The returned body still contains placeholders (e.g. `${errorText}`); the
 * caller expands them.
 */
export function selectTransportRetryTemplateBody(
    section: TransportRetrySectionLike | undefined,
): string {
    const templates = section?.templates;
    const selected = section?.templateId
        ? templates?.find((t) => t.id === section.templateId)
        : templates?.find((t) => t.isDefault === true);
    return selected?.template ?? DEFAULT_TRANSPORT_RETRY_TEMPLATE;
}
