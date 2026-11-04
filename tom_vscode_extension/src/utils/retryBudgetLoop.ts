/**
 * The retry loop behind `withRetryBudget`, free of `vscode` so it runs under
 * `node --test` with a fake clock and sleep.
 *
 * A failing call is retried while the error is transient (default
 * {@link isRetryableBusyError}: 429, 529, 5xx and the textual signals) and
 * the time spent since the first failure stays inside `totalWaitMs`:
 *
 *   - When the error says how long to wait (`waitFromError`, for the direct
 *     Anthropic transport the `retry-after` / `anthropic-ratelimit-*-reset`
 *     headers), the loop waits exactly that, plus a small margin — a rate
 *     limit resets at a stated instant and retrying earlier only burns a
 *     request. If that instant lies beyond the budget, the loop does not
 *     wait at all: it stamps the instant on the error
 *     ({@link stampRetryNotBefore}) and rethrows it, so the prompt queue can
 *     park the item until then (`waiting`) instead of failing it.
 *   - Otherwise it backs off exponentially (`initialDelayMs`, doubling, at
 *     most `maxDelayMs`), never past the budget.
 *
 * Every wait is announced through `onRetryWait` (structured) and
 * `onRetryStatus` (a UI-ready line) before it starts; `onRetryWait(null)`
 * follows when the wait is over and the call goes out again.
 */

import { isRetryableBusyError } from './retryableError';
import { stampRetryNotBefore } from './rateLimitHeaders';

/** Margin added to a provider-stated wait, so the retry lands after the reset. */
export const PROVIDER_WAIT_MARGIN_MS = 1000;

/** One wait of the retry loop, as the queue and the live trail show it. */
export interface RetryWait {
    /** `rate_limit`: the provider said how long; `backoff`: our own exponential delay. */
    kind: 'rate_limit' | 'backoff';
    /** How long this wait lasts. */
    waitMs: number;
    /** When it ends (epoch ms): the next attempt goes out then. */
    untilMs: number;
    /** The attempt that will be made after the wait (2 = the first retry). */
    attempt: number;
    /** Time since the first failure, and the budget it is measured against. */
    elapsedMs: number;
    totalWaitMs: number;
    /** The triggering error's message. */
    cause: string;
}

export interface RetryBudgetLoopOptions<T> {
    call: () => Promise<T>;
    /** Most time (ms) the loop may spend waiting after the first failure; 0 disables retries. */
    totalWaitMs: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    isRetryable?: (err: unknown) => boolean;
    /** Milliseconds the provider asks to wait before retrying `err`, or undefined. */
    waitFromError?: (err: unknown, nowMs: number) => number | undefined;
    backendLabel?: string;
    onRetryStatus?: (message: string, cause?: string) => void;
    onRetryWait?: (wait: RetryWait | null) => void;
}

/** What the loop needs from its host: a clock, a sleep that may be cancelled, a log. */
export interface RetryBudgetLoopDeps {
    now: () => number;
    /** Resolves after `ms`; rejects when the wait is cancelled. */
    sleep: (ms: number) => Promise<void>;
    isCancelled: () => boolean;
    log: (line: string) => void;
}

export async function runRetryBudgetLoop<T>(opts: RetryBudgetLoopOptions<T>, deps: RetryBudgetLoopDeps): Promise<T> {
    const isRetryable = opts.isRetryable ?? isRetryableBusyError;
    const initialDelayMs = opts.initialDelayMs ?? 1000;
    const maxDelayMs = opts.maxDelayMs ?? 5 * 60 * 1000;
    const label = opts.backendLabel ?? 'Backend busy';
    const totalWaitMs = Math.max(0, opts.totalWaitMs);
    let delay = initialDelayMs;
    let firstFailureAt: number | undefined;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        attempt++;
        try {
            return await opts.call();
        } catch (err) {
            if (!isRetryable(err)) { throw err; }
            const now = deps.now();
            const providerWaitMs = opts.waitFromError?.(err, now);
            const errMsg = err instanceof Error ? err.message : String(err);
            if (firstFailureAt === undefined) { firstFailureAt = now; }
            const elapsedMs = now - firstFailureAt;
            const remainingBudgetMs = totalWaitMs - elapsedMs;

            if (providerWaitMs !== undefined) {
                const waitMs = providerWaitMs + PROVIDER_WAIT_MARGIN_MS;
                if (waitMs > remainingBudgetMs) {
                    // Beyond the budget: hand the wait to whoever runs this
                    // call (the queue parks the item until then).
                    stampRetryNotBefore(err, now + waitMs);
                    deps.log(`[retry] ${label} — rate limited until ${new Date(now + waitMs).toISOString()}, beyond the retry budget (${formatDuration(Math.max(0, remainingBudgetMs))} left of ${formatDuration(totalWaitMs)}); giving up: ${errMsg}`);
                    throw err;
                }
                if (deps.isCancelled()) { throw new Error('Cancelled'); }
                const until = now + waitMs;
                const status = `${label} — rate limited; waiting ${formatDuration(waitMs)} until ${formatClock(until)} as the API asks (attempt ${attempt + 1}, ${formatDuration(elapsedMs)} / ${formatDuration(totalWaitMs)} elapsed)`;
                await waitAndAnnounce({ kind: 'rate_limit', waitMs, untilMs: until, attempt: attempt + 1, elapsedMs, totalWaitMs, cause: errMsg }, status, opts, deps);
                continue;
            }

            if (totalWaitMs <= 0) { throw err; }
            if (deps.isCancelled()) { throw new Error('Cancelled'); }
            if (remainingBudgetMs <= 0) {
                deps.log(`[retry] ${label} — budget exhausted after ${formatDuration(elapsedMs)} over ${attempt} attempt(s); giving up: ${errMsg}`);
                throw err;
            }
            const waitMs = Math.min(delay, remainingBudgetMs);
            const status = `${label} — retrying in ${formatDuration(waitMs)} (attempt ${attempt + 1}, ${formatDuration(elapsedMs)} / ${formatDuration(totalWaitMs)} elapsed)`;
            await waitAndAnnounce({ kind: 'backoff', waitMs, untilMs: now + waitMs, attempt: attempt + 1, elapsedMs, totalWaitMs, cause: errMsg }, status, opts, deps);
            delay = Math.min(delay * 2, maxDelayMs);
        }
    }
}

async function waitAndAnnounce<T>(wait: RetryWait, status: string, opts: RetryBudgetLoopOptions<T>, deps: RetryBudgetLoopDeps): Promise<void> {
    opts.onRetryWait?.(wait);
    opts.onRetryStatus?.(status, wait.cause);
    // Persisted to the Tom Tool Log: the status line is transient UI.
    deps.log(`[retry] ${status} — cause: ${wait.cause}`);
    try {
        await deps.sleep(wait.waitMs);
    } finally {
        opts.onRetryWait?.(null);
    }
}

/** Render a millisecond duration as `1h2m3s` / `4m5s` / `6s`. */
export function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) { return `${hours}h${minutes}m${seconds}s`; }
    if (minutes > 0) { return `${minutes}m${seconds}s`; }
    return `${seconds}s`;
}

/** Local wall-clock time `HH:MM:SS`. */
function formatClock(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
