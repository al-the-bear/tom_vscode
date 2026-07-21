import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    RETRY_BACKOFF_MS,
    RETRY_MAX_ATTEMPTS,
    computeRetryDecision,
    applyRetryScheduling,
    fireRetry,
    isRetryDue,
    clearRetryBookkeeping,
    applyStopRetrying,
    isPreviousMessageIdError,
    type RetryTransitionItem,
} from '../queueRetryTransitions.js';

describe('RETRY_BACKOFF_MS schedule', () => {
    test('is the documented 7-step 30s / 15 / 30 / 45 / 60 / 60 / 60 schedule', () => {
        assert.deepEqual([...RETRY_BACKOFF_MS], [
            30_000,
            15 * 60_000,
            30 * 60_000,
            45 * 60_000,
            60 * 60_000,
            60 * 60_000,
            60 * 60_000,
        ]);
        assert.equal(RETRY_MAX_ATTEMPTS, 7);
    });

    test('cumulative wall-clock to the last retry is 4h30m30s', () => {
        const totalMs = RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
        assert.equal(totalMs, (4 * 60 * 60 + 30 * 60 + 30) * 1000);
    });
});

describe('computeRetryDecision', () => {
    test('undefined consumed → first retry (30s), attempt 1/7', () => {
        const d = computeRetryDecision(undefined);
        assert.equal(d.kind, 'retry');
        if (d.kind === 'retry') {
            assert.equal(d.delayMs, 30_000);
            assert.equal(d.attempt, 1);
            assert.equal(d.total, 7);
        }
    });

    test('walks the schedule as retries are consumed', () => {
        assert.deepEqual(pick(computeRetryDecision(0)), { delayMs: 30_000, attempt: 1 });
        assert.deepEqual(pick(computeRetryDecision(1)), { delayMs: 15 * 60_000, attempt: 2 });
        assert.deepEqual(pick(computeRetryDecision(6)), { delayMs: 60 * 60_000, attempt: 7 });
    });

    test('once the schedule is spent → exhausted', () => {
        assert.equal(computeRetryDecision(7).kind, 'exhausted');
        assert.equal(computeRetryDecision(99).kind, 'exhausted');
    });

    test('negative / fractional consumed is clamped and floored', () => {
        assert.deepEqual(pick(computeRetryDecision(-3)), { delayMs: 30_000, attempt: 1 });
        assert.deepEqual(pick(computeRetryDecision(2.9)), { delayMs: 30 * 60_000, attempt: 3 });
    });
});

describe('applyRetryScheduling', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z');

    test('parks the item in retry with a countdown, bumps attempt, clears error', () => {
        const item: RetryTransitionItem = { status: 'sending', error: 'boom' };
        const d = computeRetryDecision(0);
        assert.equal(d.kind, 'retry');
        if (d.kind !== 'retry') { return; }
        applyRetryScheduling(item, d, { nowMs: now, errorText: 'boom', nowIso: '2026-07-21T12:00:00.000Z' });
        assert.equal(item.status, 'retry');
        assert.equal(item.error, undefined);
        assert.equal(item.retryAttempt, 1);
        assert.equal(item.retryUntil, new Date(now + 30_000).toISOString());
        assert.ok(item.warning);
        assert.equal(item.warning?.kind, 'interrupted');
        assert.match(item.warning?.message ?? '', /retry 1\/7 scheduled/);
    });

    test('uses the classified interruption kind + message when provided', () => {
        const item: RetryTransitionItem = { status: 'sending' };
        const d = computeRetryDecision(1);
        if (d.kind !== 'retry') { return; }
        applyRetryScheduling(item, d, {
            nowMs: now,
            interruption: { kind: 'overloaded', message: 'API overloaded' },
        });
        assert.equal(item.warning?.kind, 'overloaded');
        assert.match(item.warning?.message ?? '', /^API overloaded — retry 2\/7 scheduled$/);
        assert.equal(item.retryUntil, new Date(now + 15 * 60_000).toISOString());
    });
});

describe('fireRetry', () => {
    test('retry → pending, clears countdown, PRESERVES retryAttempt', () => {
        const item: RetryTransitionItem = {
            status: 'retry', retryAttempt: 3, retryUntil: '2026-07-21T13:00:00.000Z', error: undefined,
        };
        fireRetry(item);
        assert.equal(item.status, 'pending');
        assert.equal(item.retryUntil, undefined);
        assert.equal(item.retryAttempt, 3, 'attempt must survive so the backoff continues');
    });
});

describe('isRetryDue', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z');
    test('future instant is not due', () => {
        assert.equal(isRetryDue(new Date(now + 1000).toISOString(), now), false);
    });
    test('past / exact instant is due', () => {
        assert.equal(isRetryDue(new Date(now - 1).toISOString(), now), true);
        assert.equal(isRetryDue(new Date(now).toISOString(), now), true);
    });
    test('missing / unparseable is treated as due (never strand)', () => {
        assert.equal(isRetryDue(undefined, now), true);
        assert.equal(isRetryDue('not-a-date', now), true);
    });
});

describe('clearRetryBookkeeping', () => {
    test('wipes attempt + countdown, leaves status untouched', () => {
        const item: RetryTransitionItem = { status: 'sending', retryAttempt: 4, retryUntil: 'x' };
        clearRetryBookkeeping(item);
        assert.equal(item.retryAttempt, undefined);
        assert.equal(item.retryUntil, undefined);
        assert.equal(item.status, 'sending');
    });
});

describe('applyStopRetrying', () => {
    test('retry → error, stops countdown, keeps attempt + default message', () => {
        const item: RetryTransitionItem = { status: 'retry', retryAttempt: 2, retryUntil: 'x' };
        assert.equal(applyStopRetrying(item), true);
        assert.equal(item.status, 'error');
        assert.equal(item.retryUntil, undefined);
        assert.equal(item.retryAttempt, 2);
        assert.equal(item.error, 'Retrying stopped by user');
    });

    test('preserves a pre-existing error string', () => {
        const item: RetryTransitionItem = { status: 'retry', error: 'original cause' };
        applyStopRetrying(item);
        assert.equal(item.error, 'original cause');
    });

    test('no-op on non-retry items', () => {
        const item: RetryTransitionItem = { status: 'pending' };
        assert.equal(applyStopRetrying(item), false);
        assert.equal(item.status, 'pending');
    });
});

describe('isPreviousMessageIdError', () => {
    test('matches the SDK stale-previous_message_id 400', () => {
        assert.equal(isPreviousMessageIdError(
            'API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)',
        ), true);
    });
    test('does not match unrelated errors or empty text', () => {
        assert.equal(isPreviousMessageIdError('Rate limit hit'), false);
        assert.equal(isPreviousMessageIdError(''), false);
        assert.equal(isPreviousMessageIdError(undefined), false);
    });
});

function pick(d: ReturnType<typeof computeRetryDecision>): { delayMs: number; attempt: number } | null {
    return d.kind === 'retry' ? { delayMs: d.delayMs, attempt: d.attempt } : null;
}
