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
    /**
     * Exact wait (ms) before a retry *can* be accepted, derived from the
     * subscription rate-limit window the Agent SDK reports — see
     * {@link computeRateLimitWaitMs}. When the reset lands beyond the remaining
     * time budget the retry is abandoned immediately: every attempt inside the
     * budget is certain to be rejected again, so sleeping through it only
     * delays a failure the caller could already act on.
     */
    rateLimitWaitMs?: number;
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
        const elapsedMs = input.elapsedMs ?? 0;
        const maxTotalWaitMs = input.maxTotalWaitMs as number;
        if (elapsedMs >= maxTotalWaitMs) {
            return { kind: 'give-up' };
        }
        // A rate-limit window that does not reset before the budget runs out
        // cannot be waited out. Give up now rather than sleep towards a retry
        // that is guaranteed to be rejected.
        if (
            typeof input.rateLimitWaitMs === 'number' &&
            elapsedMs + input.rateLimitWaitMs > maxTotalWaitMs
        ) {
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

// ============================================================================
// Subscription rate limits (Agent SDK `rate_limit_event`)
// ============================================================================

/**
 * The subset of the Agent SDK's `SDKRateLimitInfo` this module reasons about.
 * Declared structurally so `agent-sdk-retry.ts` stays free of the SDK import
 * and remains loadable under `node --test`.
 *
 * These are **claude.ai subscription** limits, not API-key rate limits: the
 * `rateLimitType` names the window that was hit — the rolling 5-hour session
 * window (`five_hour`) or one of the weekly ones (`seven_day`,
 * `seven_day_opus`, `seven_day_sonnet`) — and `resetsAt` says when it clears.
 */
export interface SdkRateLimitInfoLike {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    /** Instant the window resets. Unix **seconds** as the SDK reports it. */
    resetsAt?: number;
    rateLimitType?: string;
    /** Fraction of the window consumed, 0..1. */
    utilization?: number;
}

/**
 * Extra wait added on top of a rate-limit reset before retrying. The reset
 * instant comes from the server's clock, so retrying at exactly `resetsAt`
 * races any skew between it and ours; two minutes is comfortably more than
 * any plausible drift and costs nothing against a window measured in hours.
 */
export const RATE_LIMIT_RESET_SKEW_MS = 2 * 60 * 1000;

/**
 * Values below this are read as Unix **seconds**, at or above it as
 * milliseconds. The two scales are five orders of magnitude apart around the
 * present day (~1.7e9 s vs ~1.7e12 ms), so the split is unambiguous for any
 * timestamp between 2001 and the year 33658.
 */
const MS_EPOCH_THRESHOLD = 1e12;

/**
 * Normalise `resetsAt` to epoch milliseconds, tolerating either scale.
 * Returns `undefined` when there is no usable reset instant.
 */
export function rateLimitResetAtMs(info: SdkRateLimitInfoLike | undefined): number | undefined {
    const raw = info?.resetsAt;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        return undefined;
    }
    return raw < MS_EPOCH_THRESHOLD ? raw * 1000 : raw;
}

/**
 * How long to wait before a retry can be accepted, given the last rate-limit
 * info seen on the stream.
 *
 * Only a **rejected** window produces a wait: `allowed` and `allowed_warning`
 * mean the request would still go through, so pinning the retry to their reset
 * would stall a call that was never blocked. A rejected window with no
 * `resetsAt` gives `undefined` too — there is nothing to schedule against, so
 * the caller falls back to exponential backoff.
 *
 * @returns milliseconds to wait (never negative), or `undefined` when the
 *          rate-limit info does not determine a retry instant.
 */
export function computeRateLimitWaitMs(
    info: SdkRateLimitInfoLike | undefined,
    nowMs: number,
    skewMs: number = RATE_LIMIT_RESET_SKEW_MS,
): number | undefined {
    if (info?.status !== 'rejected') { return undefined; }
    const resetAtMs = rateLimitResetAtMs(info);
    if (resetAtMs === undefined) { return undefined; }
    return Math.max(0, resetAtMs + skewMs - nowMs);
}

/**
 * One-line, user-facing description of a rate-limit state for the retry status
 * line, the live-trail and the tool log — e.g.
 * `five_hour limit rejected (100% used, resets 2026-08-02T13:00:00.000Z)`.
 * Returns `''` when there is no info to describe.
 */
export function describeRateLimit(info: SdkRateLimitInfoLike | undefined, nowMs: number): string {
    if (!info) { return ''; }
    const window = info.rateLimitType ? `${info.rateLimitType} limit` : 'rate limit';
    const parts: string[] = [];
    if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) {
        parts.push(`${Math.round(info.utilization * 100)}% used`);
    }
    const resetAtMs = rateLimitResetAtMs(info);
    if (resetAtMs !== undefined) {
        parts.push(`resets ${new Date(resetAtMs).toISOString()}`);
        if (resetAtMs > nowMs) {
            parts.push(`in ${formatRetryDuration(resetAtMs - nowMs)}`);
        }
    }
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `${window} ${info.status}${detail}`;
}

/**
 * Render a millisecond duration as `1h2m3s` / `4m5s` / `6s`. Shared by the
 * retry status lines and {@link describeRateLimit} so both read identically.
 */
export function formatRetryDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) { return `${hours}h${minutes}m${seconds}s`; }
    if (minutes > 0) { return `${minutes}m${seconds}s`; }
    return `${seconds}s`;
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
