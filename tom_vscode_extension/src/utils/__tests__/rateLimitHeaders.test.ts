/**
 * The wait a rate-limited or overloaded direct-API error asks for, read from
 * its headers, and the "not before" stamp the retry loop leaves for the queue.
 * Pure module: no `vscode`, no SDK.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    apiRateLimitClause,
    providerRetryDelayMs,
    readHeader,
    readRetryNotBefore,
    stampRetryNotBefore,
} from '../rateLimitHeaders.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');

/** An SDK-like API error: `status` plus a Web `Headers` object. */
function apiError(status: number, headers: Record<string, string>): Error & { status: number; headers: Headers } {
    return Object.assign(new Error(`${status} error`), { status, headers: new Headers(headers) });
}

describe('readHeader', () => {
    test('RL-1: reads a Headers object and a plain record, any case', () => {
        assert.equal(readHeader(new Headers({ 'Retry-After': '7' }), 'retry-after'), '7');
        assert.equal(readHeader({ 'Retry-After': '7' }, 'retry-after'), '7');
        assert.equal(readHeader({ 'retry-after': ['9', '10'] }, 'Retry-After'), '9');
        assert.equal(readHeader(undefined, 'retry-after'), undefined);
        assert.equal(readHeader({ 'retry-after': '  ' }, 'retry-after'), undefined);
    });
});

describe('providerRetryDelayMs', () => {
    test('RL-2: retry-after in seconds', () => {
        assert.equal(providerRetryDelayMs(apiError(429, { 'retry-after': '30' }), NOW), 30_000);
    });

    test('RL-3: retry-after as an HTTP date', () => {
        const err = apiError(429, { 'retry-after': new Date(NOW + 90_000).toUTCString() });
        assert.equal(providerRetryDelayMs(err, NOW), 90_000);
    });

    test('RL-4: retry-after-ms wins over retry-after', () => {
        assert.equal(providerRetryDelayMs(apiError(429, { 'retry-after-ms': '1500', 'retry-after': '30' }), NOW), 1500);
    });

    test('RL-5: a 529 with retry-after is honoured too', () => {
        assert.equal(providerRetryDelayMs(apiError(529, { 'retry-after': '5' }), NOW), 5000);
    });

    test('RL-6: 429 without retry-after waits for the latest reset of the exhausted buckets', () => {
        const err = apiError(429, {
            'anthropic-ratelimit-requests-remaining': '10',
            'anthropic-ratelimit-requests-reset': new Date(NOW + 5_000).toISOString(),
            'anthropic-ratelimit-input-tokens-remaining': '0',
            'anthropic-ratelimit-input-tokens-reset': new Date(NOW + 40_000).toISOString(),
            'anthropic-ratelimit-output-tokens-remaining': '0',
            'anthropic-ratelimit-output-tokens-reset': new Date(NOW + 20_000).toISOString(),
        });
        assert.equal(providerRetryDelayMs(err, NOW), 40_000);
    });

    test('RL-7: 429 with no bucket at 0 waits for the earliest future reset', () => {
        const err = apiError(429, {
            'anthropic-ratelimit-requests-reset': new Date(NOW + 25_000).toISOString(),
            'anthropic-ratelimit-tokens-reset': new Date(NOW + 12_000).toISOString(),
        });
        assert.equal(providerRetryDelayMs(err, NOW), 12_000);
    });

    test('RL-8: the reset headers say nothing on a 529 or 5xx', () => {
        const headers = {
            'anthropic-ratelimit-tokens-remaining': '0',
            'anthropic-ratelimit-tokens-reset': new Date(NOW + 12_000).toISOString(),
        };
        assert.equal(providerRetryDelayMs(apiError(529, headers), NOW), undefined);
        assert.equal(providerRetryDelayMs(apiError(503, headers), NOW), undefined);
    });

    test('RL-9: a stated instant in the past gives 0', () => {
        assert.equal(providerRetryDelayMs(apiError(429, { 'retry-after': new Date(NOW - 10_000).toUTCString() }), NOW), 0);
        const err = apiError(429, {
            'anthropic-ratelimit-tokens-remaining': '0',
            'anthropic-ratelimit-tokens-reset': new Date(NOW - 1_000).toISOString(),
        });
        assert.equal(providerRetryDelayMs(err, NOW), 0);
    });

    test('RL-10: no headers, garbage headers or a non-error give undefined', () => {
        assert.equal(providerRetryDelayMs(new Error('HTTP 429'), NOW), undefined);
        assert.equal(providerRetryDelayMs(apiError(429, { 'retry-after': 'soon' }), NOW), undefined);
        assert.equal(providerRetryDelayMs(apiError(429, {}), NOW), undefined);
        assert.equal(providerRetryDelayMs(null, NOW), undefined);
        assert.equal(providerRetryDelayMs('429', NOW), undefined);
    });
});

describe('retry-not-before stamp', () => {
    test('RL-11: stamped, read back, not enumerable', () => {
        const err = new Error('rate limited');
        assert.equal(readRetryNotBefore(err), undefined);
        stampRetryNotBefore(err, NOW + 60_000);
        assert.equal(readRetryNotBefore(err), NOW + 60_000);
        assert.deepEqual(Object.keys(err), []);
        assert.equal(JSON.stringify({ ...err }), '{}');
    });

    test('RL-12: non-objects and frozen errors are left alone', () => {
        stampRetryNotBefore('x', NOW);
        stampRetryNotBefore(null, NOW);
        const frozen = Object.freeze(new Error('frozen'));
        stampRetryNotBefore(frozen, NOW);
        assert.equal(readRetryNotBefore(frozen), undefined);
        assert.equal(readRetryNotBefore(undefined), undefined);
    });
});

describe('apiRateLimitClause', () => {
    test('RL-13: today shows the time, another day the date too', () => {
        const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
        const today = apiRateLimitClause(new Date(2026, 10, 4, 14, 32, 5).getTime(), now);
        assert.equal(today.displayLabel, 'API rate limit reset 14:32');
        assert.equal(today.resetAtMs, new Date(2026, 10, 4, 14, 32, 5).getTime());
        const tomorrow = apiRateLimitClause(new Date(2026, 10, 5, 0, 5, 0).getTime(), now);
        assert.equal(tomorrow.displayLabel, 'API rate limit reset 2026-11-05 00:05');
    });
});
