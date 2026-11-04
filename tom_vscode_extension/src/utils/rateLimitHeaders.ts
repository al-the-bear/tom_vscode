/**
 * How long the provider asks us to wait before retrying, read from the
 * response headers an API error carries, and the "not before" instant a
 * retry loop stamps on an error it gives up on so the prompt queue can park
 * the item until then instead of failing it.
 *
 * Pure and dependency-free (no `vscode`, no SDK import), so it is shared by
 * the retry loop and the queue and unit-tested under `node --test`.
 *
 * Headers read, in this order:
 *
 *   - `retry-after-ms` — milliseconds (sent by some gateways; the SDK honours it).
 *   - `retry-after` — seconds, or an HTTP date (RFC 9110 §10.2.3). Anthropic
 *     sends it on 429 and may send it on 529.
 *   - on a 429 without either: the `anthropic-ratelimit-<bucket>-reset`
 *     instants (RFC 3339) of the buckets `requests`, `tokens`, `input-tokens`,
 *     `output-tokens`. The buckets whose `-remaining` is 0 are the exhausted
 *     ones and the retry has to wait for the latest of them; when no bucket
 *     says 0, the earliest future reset is the first moment anything frees up.
 *     These headers come on every response, so they are read only for a 429 —
 *     on a 529 or 5xx they say nothing about why the request failed.
 */

/** The parts of an API error this reads. The Anthropic SDK's `APIError` has both. */
interface ErrorWithHeaders {
    status?: number;
    headers?: unknown;
}

const RATE_LIMIT_BUCKETS = ['requests', 'tokens', 'input-tokens', 'output-tokens'];

/** Read one header from a `Headers` object or a plain record (any case). */
export function readHeader(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') { return undefined; }
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
        const value = (getter as (n: string) => unknown).call(headers, name);
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    }
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() !== lower) { continue; }
        const first = Array.isArray(value) ? value[0] : value;
        return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined;
    }
    return undefined;
}

/** `retry-after`: delta seconds or an HTTP date. Undefined when neither parses. */
function parseRetryAfter(value: string, nowMs: number): number | undefined {
    if (/^\d+(\.\d+)?$/.test(value)) {
        return Math.round(Number(value) * 1000);
    }
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : at - nowMs;
}

/**
 * Milliseconds until the provider allows the retry, or undefined when the
 * error says nothing (no headers, or none of the ones above). A stated
 * instant already in the past gives 0.
 */
export function providerRetryDelayMs(err: unknown, nowMs: number): number | undefined {
    if (!err || typeof err !== 'object') { return undefined; }
    const { status, headers } = err as ErrorWithHeaders;
    if (!headers) { return undefined; }

    const retryAfterMs = readHeader(headers, 'retry-after-ms');
    if (retryAfterMs && /^\d+(\.\d+)?$/.test(retryAfterMs)) {
        return Math.max(0, Math.round(Number(retryAfterMs)));
    }
    const retryAfter = readHeader(headers, 'retry-after');
    if (retryAfter) {
        const parsed = parseRetryAfter(retryAfter, nowMs);
        if (parsed !== undefined) { return Math.max(0, parsed); }
    }
    if (status !== 429) { return undefined; }

    const exhausted: number[] = [];
    const future: number[] = [];
    for (const bucket of RATE_LIMIT_BUCKETS) {
        const reset = readHeader(headers, `anthropic-ratelimit-${bucket}-reset`);
        const resetAt = reset ? Date.parse(reset) : Number.NaN;
        if (Number.isNaN(resetAt)) { continue; }
        const remaining = readHeader(headers, `anthropic-ratelimit-${bucket}-remaining`);
        if (remaining !== undefined && Number(remaining) <= 0) {
            exhausted.push(resetAt);
        }
        if (resetAt > nowMs) { future.push(resetAt); }
    }
    if (exhausted.length > 0) {
        return Math.max(0, Math.max(...exhausted) - nowMs);
    }
    if (future.length > 0) {
        return Math.min(...future) - nowMs;
    }
    return undefined;
}

const RETRY_NOT_BEFORE = '__tomRetryNotBefore';

/**
 * Stamp the instant (epoch ms) before which a retry is pointless onto an
 * error the retry loop gives up on. Non-enumerable, so it never leaks into a
 * JSON dump of the error. The error itself is rethrown unchanged.
 */
export function stampRetryNotBefore(err: unknown, atMs: number): void {
    if (!err || typeof err !== 'object') { return; }
    try {
        Object.defineProperty(err, RETRY_NOT_BEFORE, {
            value: atMs, enumerable: false, configurable: true, writable: true,
        });
    } catch {
        // A frozen error: the queue falls back to its ordinary error path.
    }
}

/**
 * The queue's waiting clause for a stamped instant: the reset to wait for and
 * the label the item shows ("WAITING FOR API RATE LIMIT RESET 14:32"), in
 * local time, with the date when it is not today.
 */
export function apiRateLimitClause(atMs: number, nowMs: number = Date.now()): { resetAtMs: number; displayLabel: string } {
    const at = new Date(atMs);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const sameDay = new Date(nowMs).toDateString() === at.toDateString();
    const date = sameDay ? '' : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `;
    return { resetAtMs: atMs, displayLabel: `API rate limit reset ${date}${time}` };
}

/** The instant stamped by {@link stampRetryNotBefore}, if any. */
export function readRetryNotBefore(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') { return undefined; }
    const value = (err as Record<string, unknown>)[RETRY_NOT_BEFORE];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
