import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyErrorTransition,
    applyResetToPending,
    itemHasInFlightProgress,
    resolveAnswerContainer,
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

describe('applyResetToPending — errored-rep counter rollback', () => {
    test('main-stage error rolls back item.repeatIndex by one (so reset+auto-send retries the errored rep)', () => {
        // Dispatch loop bumped repeatIndex from 2 → 3 right before
        // the failing send. After reset, the user expects auto-send to
        // re-try rep 3, not silently jump to rep 4.
        const item: any = {
            status: 'error',
            error: 'boom',
            repeatIndex: 3,
            lastDispatched: { kind: 'main', expandedText: 'rep-3-text', transport: 'anthropic', dispatchedAt: '' },
        };
        applyResetToPending(item);
        assert.equal(item.repeatIndex, 2, 'counter rolled back so the next dispatch fires rep 3 again');
    });

    test('pre-prompt error rolls back the right prePrompts[i].repeatIndex', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            prePrompts: [
                { repeatIndex: 1 },
                { repeatIndex: 2 },   // errored on rep 2 of this pre-prompt
            ],
            lastDispatched: { kind: 'prePrompt', prePromptIndex: 1, expandedText: '', transport: 'copilot', dispatchedAt: '' },
        };
        applyResetToPending(item);
        assert.equal(item.prePrompts[0].repeatIndex, 1, 'other pre-prompts untouched');
        assert.equal(item.prePrompts[1].repeatIndex, 1, 'errored pre-prompt rolled back from 2 → 1');
    });

    test('follow-up error rolls back the right followUps[i].repeatIndex', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            followUps: [
                { repeatIndex: 1 },
                { repeatIndex: 4 },
            ],
            lastDispatched: { kind: 'followUp', followUpIndex: 1, expandedText: '', transport: 'copilot', dispatchedAt: '' },
        };
        applyResetToPending(item);
        assert.equal(item.followUps[0].repeatIndex, 1);
        assert.equal(item.followUps[1].repeatIndex, 3, 'errored follow-up rolled back from 4 → 3');
    });

    test('rollback clamps at zero (defensive — should never underflow in practice)', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            repeatIndex: 0,   // already 0
            lastDispatched: { kind: 'main', expandedText: '', transport: 'copilot', dispatchedAt: '' },
        };
        applyResetToPending(item);
        assert.equal(item.repeatIndex, 0);
    });

    test('no rollback when item has no lastDispatched (defensive — should never happen for real errors)', () => {
        const item: any = { status: 'error', repeatIndex: 3 };
        applyResetToPending(item);
        assert.equal(item.repeatIndex, 3);
    });

    test('rollback uses 0-default when repeatIndex is undefined', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            lastDispatched: { kind: 'main', expandedText: '', transport: 'copilot', dispatchedAt: '' },
        };
        applyResetToPending(item);
        assert.equal(item.repeatIndex, 0);
    });

    test('prePromptIndex out of bounds is a no-op', () => {
        const item: any = {
            status: 'error',
            error: 'boom',
            prePrompts: [{ repeatIndex: 2 }],
            lastDispatched: { kind: 'prePrompt', prePromptIndex: 99, expandedText: '', transport: 'copilot', dispatchedAt: '' },
        };
        applyResetToPending(item);
        // No throw, no mutation of the existing pre-prompt.
        assert.equal(item.prePrompts[0].repeatIndex, 2);
    });
});

describe('itemHasInFlightProgress — fresh-vs-resume gate predicate', () => {
    test('fresh item with no counters → false', () => {
        assert.equal(itemHasInFlightProgress({}), false);
        assert.equal(itemHasInFlightProgress({ repeatIndex: 0 }), false);
        assert.equal(itemHasInFlightProgress({ followUpIndex: 0 }), false);
        assert.equal(itemHasInFlightProgress({ prePrompts: [], followUps: [] }), false);
    });

    test('main repeatIndex > 0 → true', () => {
        assert.equal(itemHasInFlightProgress({ repeatIndex: 1 }), true);
        assert.equal(itemHasInFlightProgress({ repeatIndex: 17 }), true);
    });

    test('followUpIndex > 0 → true (advanced past a fully-replayed follow-up)', () => {
        assert.equal(itemHasInFlightProgress({ followUpIndex: 1 }), true);
    });

    test('any pre-prompt repeatIndex > 0 → true', () => {
        assert.equal(itemHasInFlightProgress({ prePrompts: [{ repeatIndex: 0 }, { repeatIndex: 2 }] }), true);
        assert.equal(itemHasInFlightProgress({ prePrompts: [{ repeatIndex: 1 }] }), true);
    });

    test('any follow-up repeatIndex > 0 → true', () => {
        assert.equal(itemHasInFlightProgress({ followUps: [{ repeatIndex: 0 }, { repeatIndex: 3 }] }), true);
        assert.equal(itemHasInFlightProgress({ followUps: [{ repeatIndex: 1 }] }), true);
    });

    test('undefined counters treated as 0', () => {
        assert.equal(itemHasInFlightProgress({ prePrompts: [{}], followUps: [{}] }), false);
    });

    test('paused-mid-flight scenario: main rep 3 of 5 already dispatched → true', () => {
        // Real-world state: user paused after rep 3 of 5 completed; auto-send
        // off; item still 'sending'; gate predicate must say "has progress"
        // so the pause check in `dispatchNextStageForSendingItem` triggers.
        assert.equal(itemHasInFlightProgress({ repeatIndex: 3 }), true);
    });

    test('error-reset scenario after counter rollback: rep 3 errored, counter rolled back to 2 → still true', () => {
        // After `applyResetToPending` decrements the errored rep's counter,
        // the item still carries progress from prior successful reps. The
        // gate must keep treating it as a resume so `sendItem` preserves
        // the counters instead of resetting them.
        assert.equal(itemHasInFlightProgress({ repeatIndex: 2 }), true);
    });
});

describe('resolveAnswerContainer — route a captured answer to the last-dispatched stage', () => {
    test('main stage resolves to the item itself', () => {
        const item: any = {
            answerText: undefined,
            lastDispatched: { kind: 'main' },
        };
        const container = resolveAnswerContainer(item);
        assert.equal(container, item, 'main stage container is the item itself');
        container!.answerText = 'captured';
        assert.equal(item.answerText, 'captured', 'writing answerText lands on the item');
    });

    test('pre-prompt stage resolves to the addressed pre-prompt container', () => {
        const pp0 = { answerText: undefined };
        const pp1 = { answerText: undefined };
        const item: any = {
            prePrompts: [pp0, pp1],
            lastDispatched: { kind: 'prePrompt', prePromptIndex: 1 },
        };
        const container = resolveAnswerContainer(item);
        assert.equal(container, pp1, 'resolves the pre-prompt at the dispatched index');
    });

    test('follow-up stage resolves to the addressed follow-up container', () => {
        const fu0 = { answerText: undefined };
        const fu1 = { answerText: undefined };
        const item: any = {
            followUps: [fu0, fu1],
            lastDispatched: { kind: 'followUp', followUpIndex: 0 },
        };
        const container = resolveAnswerContainer(item);
        assert.equal(container, fu0, 'resolves the follow-up at the dispatched index');
    });

    test('returns undefined when there is no lastDispatched snapshot', () => {
        assert.equal(resolveAnswerContainer({} as any), undefined);
    });

    test('returns undefined when the pre-prompt index is out of bounds', () => {
        const item: any = {
            prePrompts: [{ answerText: undefined }],
            lastDispatched: { kind: 'prePrompt', prePromptIndex: 99 },
        };
        assert.equal(resolveAnswerContainer(item), undefined);
    });

    test('returns undefined when the follow-up index is missing', () => {
        const item: any = {
            followUps: [{ answerText: undefined }],
            lastDispatched: { kind: 'followUp' },
        };
        assert.equal(resolveAnswerContainer(item), undefined);
    });
});
