/**
 * The retry loop behind `withRetryBudget` (direct Anthropic and Local LLM
 * transports), run with a fake clock: which statuses are retried, the wait
 * taken from the rate-limit headers, the budget, and what a wait beyond the
 * budget leaves on the error for the queue.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROVIDER_WAIT_MARGIN_MS, RetryWait, runRetryBudgetLoop, RetryBudgetLoopDeps } from '../retryBudgetLoop.js';
import { providerRetryDelayMs, readRetryNotBefore } from '../rateLimitHeaders.js';
import { isRetryableStatus } from '../retryableError.js';

const START = Date.parse('2026-11-04T12:00:00Z');

/** A fake clock whose sleep advances time; records every sleep. */
function fakeDeps(opts: { cancelled?: () => boolean } = {}): RetryBudgetLoopDeps & { sleeps: number[]; logs: string[]; clock: { now: number } } {
    const clock = { now: START };
    const sleeps: number[] = [];
    const logs: string[] = [];
    return {
        clock, sleeps, logs,
        now: () => clock.now,
        sleep: async (ms: number) => { sleeps.push(ms); clock.now += ms; },
        isCancelled: opts.cancelled ?? (() => false),
        log: (line: string) => { logs.push(line); },
    };
}

function apiError(status: number, headers: Record<string, string> = {}): Error & { status: number; headers: Headers } {
    return Object.assign(new Error(`${status} status code`), { status, headers: new Headers(headers) });
}

/** A call failing with each given error in turn, then answering 'ok'. */
function failingThen(errors: unknown[]): { call: () => Promise<string>; calls: () => number } {
    let n = 0;
    return {
        call: async () => {
            const err = errors[n++];
            if (err !== undefined) { throw err; }
            return 'ok';
        },
        calls: () => n,
    };
}

describe('status classes', () => {
    test('RB-1: 429, 529 and the transient 5xx are retried', async () => {
        for (const status of [429, 500, 502, 503, 504, 529]) {
            const deps = fakeDeps();
            const f = failingThen([apiError(status)]);
            assert.equal(await runRetryBudgetLoop({ call: f.call, totalWaitMs: 60_000 }, deps), 'ok', `status ${status}`);
            assert.equal(f.calls(), 2, `status ${status}`);
        }
    });

    test('RB-2: 400, 401, 403, 404, 501 and 505 fail at once', async () => {
        for (const status of [400, 401, 403, 404, 413, 501, 505]) {
            const deps = fakeDeps();
            const f = failingThen([apiError(status)]);
            await assert.rejects(runRetryBudgetLoop({ call: f.call, totalWaitMs: 60_000 }, deps), { message: `${status} status code` });
            assert.equal(f.calls(), 1, `status ${status}`);
            assert.deepEqual(deps.sleeps, []);
        }
    });

    test('RB-3: isRetryableStatus draws the same line', () => {
        for (const s of [429, 500, 502, 503, 504, 507, 529]) { assert.equal(isRetryableStatus(s), true, String(s)); }
        for (const s of [200, 400, 401, 404, 409, 501, 505, 600]) { assert.equal(isRetryableStatus(s), false, String(s)); }
    });
});

describe('backoff', () => {
    test('RB-4: doubles from initialDelayMs up to maxDelayMs', async () => {
        const deps = fakeDeps();
        const f = failingThen([apiError(529), apiError(529), apiError(529), apiError(529)]);
        await runRetryBudgetLoop({ call: f.call, totalWaitMs: 600_000, initialDelayMs: 1000, maxDelayMs: 3000 }, deps);
        assert.deepEqual(deps.sleeps, [1000, 2000, 3000, 3000]);
    });

    test('RB-5: never waits past the budget, then rethrows the last error', async () => {
        const deps = fakeDeps();
        const errors = Array.from({ length: 20 }, () => apiError(503));
        const f = failingThen(errors);
        await assert.rejects(runRetryBudgetLoop({ call: f.call, totalWaitMs: 10_000, initialDelayMs: 4000 }, deps), { message: '503 status code' });
        assert.deepEqual(deps.sleeps, [4000, 6000]);
        assert.equal(deps.clock.now - START, 10_000);
        assert.match(deps.logs.at(-1) ?? '', /budget exhausted/);
    });

    test('RB-6: a budget of 0 disables the backoff', async () => {
        const deps = fakeDeps();
        const f = failingThen([apiError(529)]);
        await assert.rejects(runRetryBudgetLoop({ call: f.call, totalWaitMs: 0 }, deps));
        assert.equal(f.calls(), 1);
    });
});

describe('rate limits', () => {
    test('RB-7: waits the time retry-after states, plus the margin, not the backoff', async () => {
        const deps = fakeDeps();
        const f = failingThen([apiError(429, { 'retry-after': '45' })]);
        const waits: Array<RetryWait | null> = [];
        const statuses: string[] = [];
        const result = await runRetryBudgetLoop({
            call: f.call, totalWaitMs: 600_000, initialDelayMs: 1000,
            waitFromError: providerRetryDelayMs,
            onRetryWait: (w) => waits.push(w),
            onRetryStatus: (s) => statuses.push(s),
        }, deps);
        assert.equal(result, 'ok');
        assert.deepEqual(deps.sleeps, [45_000 + PROVIDER_WAIT_MARGIN_MS]);
        assert.equal(waits.length, 2);
        assert.deepEqual(waits[0], {
            kind: 'rate_limit', waitMs: 46_000, untilMs: START + 46_000, attempt: 2,
            elapsedMs: 0, totalWaitMs: 600_000, cause: '429 status code',
        });
        assert.equal(waits[1], null);
        assert.match(statuses[0], /rate limited; waiting 46s until \d\d:\d\d:\d\d/);
    });

    test('RB-8: the wait is computed from the anthropic-ratelimit reset headers', async () => {
        const deps = fakeDeps();
        const err = apiError(429, {
            'anthropic-ratelimit-output-tokens-remaining': '0',
            'anthropic-ratelimit-output-tokens-reset': new Date(START + 33_000).toISOString(),
        });
        const f = failingThen([err]);
        await runRetryBudgetLoop({ call: f.call, totalWaitMs: 600_000, waitFromError: providerRetryDelayMs }, deps);
        assert.deepEqual(deps.sleeps, [34_000]);
    });

    test('RB-9: a reset beyond the budget is not waited out; the instant is stamped for the queue', async () => {
        const deps = fakeDeps();
        const err = apiError(429, { 'retry-after': '3600' });
        const f = failingThen([err]);
        await assert.rejects(
            runRetryBudgetLoop({ call: f.call, totalWaitMs: 600_000, waitFromError: providerRetryDelayMs }, deps),
            (thrown: unknown) => thrown === err,
        );
        assert.deepEqual(deps.sleeps, []);
        assert.equal(readRetryNotBefore(err), START + 3_600_000 + PROVIDER_WAIT_MARGIN_MS);
        assert.match(deps.logs.at(-1) ?? '', /beyond the retry budget/);
    });

    test('RB-10: budget already spent on backoff: the next rate limit goes to the queue', async () => {
        const deps = fakeDeps();
        const late = apiError(429, { 'retry-after': '20' });
        const f = failingThen([apiError(529), apiError(529), late]);
        await assert.rejects(
            runRetryBudgetLoop({ call: f.call, totalWaitMs: 25_000, initialDelayMs: 8000, waitFromError: providerRetryDelayMs }, deps),
            (thrown: unknown) => thrown === late,
        );
        // 8s + 16s of backoff leaves 1s; the 21s rate-limit wait does not fit.
        assert.deepEqual(deps.sleeps, [8000, 16_000]);
        assert.equal(readRetryNotBefore(late), START + 24_000 + 21_000);
    });

    test('RB-11: with retries disabled a stated reset still reaches the queue', async () => {
        const deps = fakeDeps();
        const err = apiError(429, { 'retry-after': '5' });
        const f = failingThen([err]);
        await assert.rejects(runRetryBudgetLoop({ call: f.call, totalWaitMs: 0, waitFromError: providerRetryDelayMs }, deps));
        assert.equal(readRetryNotBefore(err), START + 6000);
    });

    test('RB-12: rate-limit waits and backoff share one budget', async () => {
        const deps = fakeDeps();
        const f = failingThen([
            apiError(429, { 'retry-after': '10' }),
            apiError(503),
            apiError(429, { 'retry-after': '10' }),
        ]);
        await runRetryBudgetLoop({ call: f.call, totalWaitMs: 60_000, initialDelayMs: 2000, waitFromError: providerRetryDelayMs }, deps);
        assert.deepEqual(deps.sleeps, [11_000, 2000, 11_000]);
    });

    test('RB-13: a non-retryable error is not stamped even with retry-after', async () => {
        const deps = fakeDeps();
        const err = apiError(400, { 'retry-after': '5' });
        await assert.rejects(runRetryBudgetLoop({ call: failingThen([err]).call, totalWaitMs: 60_000, waitFromError: providerRetryDelayMs }, deps));
        assert.equal(readRetryNotBefore(err), undefined);
    });
});

describe('wiring', () => {
    const root = join(__dirname, '..', '..', '..');
    const read = (...p: string[]): string => readFileSync(join(root, 'src', ...p), 'utf-8');

    test('RB-16: the direct send waits as the headers say and reports each wait', () => {
        const src = read('handlers', 'anthropic-handler.ts');
        const at = src.indexOf('call: () => createMessageStreamed(client, createParams, abortSignal)');
        assert.ok(at > 0, 'the direct send goes through withRetryBudget');
        const call = src.slice(at, src.indexOf('});', at));
        assert.match(call, /waitFromError: providerRetryDelayMs/);
        assert.match(call, /onRetryWait: options\.onRetryWait/);
        assert.match(call, /liveTrail\?\.appendRetry\(text, cause\)/);
    });

    test('RB-17: the queue shows the wait and parks an item at the stamped reset', () => {
        const src = read('managers', 'promptQueueManager.ts');
        assert.match(src, /onRetryWait: \(wait\) => this\._showSendWait\(waitItem, wait\)/);
        assert.match(src, /finally \{\s*this\._showSendWait\(waitItem, null\);/);
        assert.match(src, /const notBefore = readRetryNotBefore\(err\);\s*const clause = notBefore !== undefined \? apiRateLimitClause\(notBefore\) : parseResetClause\(searchText\);/);
        const render = readFileSync(join(root, 'media', 'shared', 'queueEntryRenderFunctions.js'), 'utf-8');
        assert.match(render, /item\.sendWait\.kind === 'rate_limit' \? 'RATE LIMITED' : 'API BUSY'/);
    });
});

describe('cancellation', () => {
    test('RB-14: a cancelled send does not wait', async () => {
        const deps = fakeDeps({ cancelled: () => true });
        await assert.rejects(
            runRetryBudgetLoop({ call: failingThen([apiError(429, { 'retry-after': '5' })]).call, totalWaitMs: 60_000, waitFromError: providerRetryDelayMs }, deps),
            { message: 'Cancelled' },
        );
        assert.deepEqual(deps.sleeps, []);
    });

    test('RB-15: a wait cancelled midway clears the shown wait and rejects', async () => {
        const deps = fakeDeps();
        deps.sleep = async () => { throw new Error('Cancelled'); };
        const waits: Array<RetryWait | null> = [];
        await assert.rejects(
            runRetryBudgetLoop({ call: failingThen([apiError(529)]).call, totalWaitMs: 60_000, onRetryWait: (w) => waits.push(w) }, deps),
            { message: 'Cancelled' },
        );
        assert.equal(waits.length, 2);
        assert.equal(waits[1], null);
    });
});
