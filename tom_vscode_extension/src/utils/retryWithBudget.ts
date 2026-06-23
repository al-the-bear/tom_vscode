/**
 * Shared retry-on-busy helper used by every LLM-call leaf (Ollama, OpenAI/vLLM,
 * Anthropic direct SDK). The retry runs until the cumulative elapsed time since
 * the first failure exceeds `totalWaitMs`, with exponential backoff capped at
 * `maxDelayMs`. Cancellation aborts the in-flight wait.
 *
 * The "is this worth retrying?" decision lives in the dependency-free
 * {@link isRetryableBusyError} (re-exported here for existing callers); the
 * Agent SDK transport shares the same classifier so all paths agree on the
 * retryable set (429 / 500 / 503 / 529 + textual signals).
 */
import * as vscode from 'vscode';
import { toolLog } from './toolLog';
import { isRetryableBusyError } from './retryableError';

export { isRetryableBusyError };

export interface RetryWithBudgetOptions<T> {
    /** The operation to retry. */
    call: () => Promise<T>;
    /**
     * Maximum cumulative elapsed time (ms) the retry loop is allowed to spend
     * waiting after the first failure. When the budget is exhausted, the most
     * recent error is rethrown. Set to 0 (or negative) to disable retries
     * entirely.
     */
    totalWaitMs: number;
    /** Initial backoff delay in ms. Default 1000. */
    initialDelayMs?: number;
    /** Maximum single-step backoff in ms. Default 5 minutes. */
    maxDelayMs?: number;
    /** Custom retryable predicate. Defaults to {@link isRetryableBusyError}. */
    isRetryable?: (err: unknown) => boolean;
    /**
     * Optional human-friendly label used in the status message
     * ("Backend busy" by default). Surfaces in lines like
     * `"<label> — retrying in 4s (attempt 3, 0:12/10:00 elapsed)"`.
     */
    backendLabel?: string;
    /** Cancellation token — cancels the in-flight wait. */
    cancellationToken?: vscode.CancellationToken;
    /**
     * Called before each backoff sleep with a string suitable for direct UI
     * display. The Anthropic chat panel binds this to the status line under
     * the prompt input via `AnthropicHandler._onStatusUpdate.fire`.
     */
    onRetryStatus?: (message: string) => void;
}

/**
 * Run `call`, retrying with exponential backoff while the error is classified
 * as transient (default: 429 / 503 / 529 plus the usual textual signals).
 * Stops as soon as the cumulative elapsed wait time crosses `totalWaitMs` or
 * the cancellation token fires.
 */
export async function withRetryBudget<T>(opts: RetryWithBudgetOptions<T>): Promise<T> {
    const isRetryable = opts.isRetryable ?? isRetryableBusyError;
    const initialDelayMs = opts.initialDelayMs ?? 1000;
    const maxDelayMs = opts.maxDelayMs ?? 5 * 60 * 1000;
    const label = opts.backendLabel ?? 'Backend busy';
    const totalWaitMs = Math.max(0, opts.totalWaitMs);
    let delay = initialDelayMs;
    let firstFailureAt: number | undefined;
    let attempt = 0;
    let lastErr: unknown;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        attempt++;
        try {
            return await opts.call();
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || totalWaitMs <= 0) { throw err; }
            if (opts.cancellationToken?.isCancellationRequested) { throw new Error('Cancelled'); }
            if (firstFailureAt === undefined) { firstFailureAt = Date.now(); }
            const elapsedMs = Date.now() - firstFailureAt;
            const remainingBudgetMs = totalWaitMs - elapsedMs;
            const errMsg = err instanceof Error ? err.message : String(err);
            if (remainingBudgetMs <= 0) {
                toolLog(`[retry] ${label} — budget exhausted after ${formatDuration(elapsedMs)} over ${attempt} attempt(s); giving up: ${errMsg}`);
                throw err;
            }
            const waitMs = Math.min(delay, remainingBudgetMs);
            const status = `${label} — retrying in ${formatDuration(waitMs)} (attempt ${attempt + 1}, ${formatDuration(elapsedMs)} / ${formatDuration(totalWaitMs)} elapsed)`;
            opts.onRetryStatus?.(status);
            // Persist the retry to the shared Tom Tool Log so the backoff is
            // visible after the fact (the status line is transient UI). Include
            // the triggering error so the user sees *why* it retried.
            toolLog(`[retry] ${status} — cause: ${errMsg}`);
            await sleepCancellable(waitMs, opts.cancellationToken);
            delay = Math.min(delay * 2, maxDelayMs);
        }
    }
}

function sleepCancellable(ms: number, ct?: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ct?.onCancellationRequested(() => {
            clearTimeout(t);
            reject(new Error('Cancelled'));
        });
    });
}

/** Render a millisecond duration as `1h2m3s` / `4m5s` / `6s`. */
function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) { return `${hours}h${minutes}m${seconds}s`; }
    if (minutes > 0) { return `${minutes}m${seconds}s`; }
    return `${seconds}s`;
}
