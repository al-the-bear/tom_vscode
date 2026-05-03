import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyErrorTransition,
    applyResetToPending,
} from '../queueErrorTransitions.js';

describe('applyErrorTransition', () => {
    test('promotes a sending item to error and reports auto-send must be disabled', () => {
        const item: any = { status: 'sending' };
        const result = applyErrorTransition(item, new Error('boom'));
        assert.equal(item.status, 'error');
        assert.equal(item.error, 'Error: boom');
        assert.equal(result.transitioned, true);
        assert.equal(result.shouldDisableAutoSend, true);
    });

    test('coerces non-Error throws via String() — matches inlined catch behaviour', () => {
        const item: any = { status: 'sending' };
        applyErrorTransition(item, 'plain string');
        assert.equal(item.error, 'plain string');

        const item2: any = { status: 'sending' };
        applyErrorTransition(item2, { reason: 'boom' });
        assert.equal(item2.error, '[object Object]');
    });

    test('attaches a warning when an interruption is provided, using the supplied timestamp', () => {
        const item: any = { status: 'sending' };
        applyErrorTransition(
            item,
            new Error('rate-limited'),
            {
                interruption: { kind: 'rate_limit', message: 'try later' },
                nowIso: '2026-01-01T00:00:00.000Z',
            },
        );
        assert.deepEqual(item.warning, {
            kind: 'rate_limit',
            message: 'try later',
            at: '2026-01-01T00:00:00.000Z',
        });
    });

    test('leaves prior warning untouched when no interruption is provided', () => {
        const prior = { kind: 'overloaded' as const, message: 'old', at: '2025-12-31T00:00:00.000Z' };
        const item: any = { status: 'sending', warning: prior };
        applyErrorTransition(item, new Error('different cause'));
        assert.deepEqual(item.warning, prior);
    });

    test('overwrites prior warning when a fresh interruption is provided', () => {
        const item: any = {
            status: 'sending',
            warning: { kind: 'overloaded', message: 'old', at: '2025-12-31T00:00:00.000Z' },
        };
        applyErrorTransition(
            item,
            new Error('quota'),
            {
                interruption: { kind: 'quota_exceeded', message: 'monthly cap' },
                nowIso: '2026-02-02T00:00:00.000Z',
            },
        );
        assert.deepEqual(item.warning, {
            kind: 'quota_exceeded',
            message: 'monthly cap',
            at: '2026-02-02T00:00:00.000Z',
        });
    });

    test('is idempotent on already-errored items — does not re-trip the auto-send brake', () => {
        const item: any = { status: 'error', error: 'first' };
        const result = applyErrorTransition(item, new Error('second'));
        assert.equal(item.status, 'error');
        assert.equal(item.error, 'Error: second');
        assert.equal(result.transitioned, false);
        assert.equal(result.shouldDisableAutoSend, false);
    });

    test('still updates error/warning even on a second call (so the user sees the latest cause)', () => {
        const item: any = { status: 'error', error: 'first' };
        applyErrorTransition(
            item,
            new Error('second'),
            { interruption: { kind: 'cancelled', message: 'user stopped' }, nowIso: '2026-03-03T00:00:00.000Z' },
        );
        assert.equal(item.error, 'Error: second');
        assert.deepEqual(item.warning, {
            kind: 'cancelled',
            message: 'user stopped',
            at: '2026-03-03T00:00:00.000Z',
        });
    });
});

describe('applyResetToPending', () => {
    test('resets an error item to pending and clears failure + transient fields', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            warning: { kind: 'rate_limit', message: 'try later', at: '2026-01-01T00:00:00.000Z' },
            requestId: 'req-1',
            expectedRequestId: 'req-1',
            reminderSentCount: 3,
            lastReminderAt: '2026-01-01T00:01:00.000Z',
            sentAt: '2026-01-01T00:00:30.000Z',
        };

        const ok = applyResetToPending(item);

        assert.equal(ok, true);
        assert.equal(item.status, 'pending');
        assert.equal(item.error, undefined);
        assert.equal(item.warning, undefined);
        assert.equal(item.requestId, undefined);
        assert.equal(item.expectedRequestId, undefined);
        assert.equal(item.reminderSentCount, 0);
        assert.equal(item.lastReminderAt, undefined);
        assert.equal(item.sentAt, undefined);
    });

    test('preserves lastDispatched so the Resend button still works after a reset', () => {
        const lastDispatched = { expandedText: 'hi', transport: 'copilot', kind: 'main' };
        const item: any = {
            status: 'error',
            error: 'boom',
            lastDispatched,
        };
        applyResetToPending(item);
        assert.equal(item.status, 'pending');
        assert.deepEqual(item.lastDispatched, lastDispatched);
    });

    test('refuses to act on non-error items and reports false', () => {
        for (const status of ['staged', 'pending', 'sending', 'sent']) {
            const item: any = { status, requestId: 'keep-me' };
            const ok = applyResetToPending(item);
            assert.equal(ok, false, `status ${status} must not be reset`);
            assert.equal(item.status, status);
            assert.equal(item.requestId, 'keep-me');
        }
    });

    test('is idempotent — second call on a pending item is a no-op', () => {
        const item: any = { status: 'error', error: 'boom' };
        const first = applyResetToPending(item);
        const second = applyResetToPending(item);
        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal(item.status, 'pending');
    });
});
