/**
 * Shared retry-on-busy helper used by every LLM-call leaf (Ollama, OpenAI/vLLM,
 * Anthropic direct SDK). The retry runs until the cumulative elapsed time since
 * the first failure exceeds `totalWaitMs`, with exponential backoff capped at
 * `maxDelayMs`. Cancellation aborts the in-flight wait.
 *
 * The "is this worth retrying?" decision lives in the dependency-free
 * {@link isRetryableBusyError} (re-exported here for existing callers); the
 * Agent SDK transport shares the same classifier so all paths agree on the
 * retryable set (429 / 529 / 5xx + textual signals).
 */
import * as vscode from 'vscode';
import { toolLog } from './toolLog';
import { isRetryableBusyError } from './retryableError';
import { runRetryBudgetLoop, RetryWait } from './retryBudgetLoop';

export { isRetryableBusyError };
export type { RetryWait };

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
     * Called before each backoff sleep with a UI-ready status string and the
     * triggering error's text. The Anthropic chat panel binds this to the
     * status line under the prompt input via `AnthropicHandler._onStatusUpdate`
     * and mirrors the retry into the quest live-trail (`cause` shown there).
     */
    onRetryStatus?: (message: string, cause?: string) => void;
    /**
     * Milliseconds the provider asks to wait before retrying this error
     * (e.g. `providerRetryDelayMs`, which reads `retry-after` and the
     * Anthropic rate-limit reset headers), or undefined to back off as
     * usual. A stated wait beyond the budget is not waited out here: the
     * instant is stamped on the rethrown error for the queue.
     */
    waitFromError?: (err: unknown, nowMs: number) => number | undefined;
    /** Structured form of each wait; `null` when it is over and the call goes out again. */
    onRetryWait?: (wait: RetryWait | null) => void;
}

/**
 * Run `call`, retrying while the error is transient (default: 429 / 529 / 5xx
 * plus the usual textual signals): with exponential backoff, or for as long as
 * the provider asks when `waitFromError` reads that from the error. Stops as
 * soon as the cumulative wait would cross `totalWaitMs` or the cancellation
 * token fires. The loop itself is {@link runRetryBudgetLoop}.
 */
export async function withRetryBudget<T>(opts: RetryWithBudgetOptions<T>): Promise<T> {
    return runRetryBudgetLoop(opts, {
        now: () => Date.now(),
        sleep: (ms) => sleepCancellable(ms, opts.cancellationToken),
        isCancelled: () => opts.cancellationToken?.isCancellationRequested === true,
        log: toolLog,
    });
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
