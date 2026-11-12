/**
 * What follows a walk iteration whose todo is not completed (vscimpb58).
 *
 *   WV-1 completed, waiting-for-repeat, cancelled: done; gone: missing
 *   WV-2 blocked, decision-needed, an open decision (none or an empty one), a question waiting: a reason, no continuation
 *   WV-3 in-progress / not-started with nothing saying why: a continuation; answered decisions do not hold it
 *   WV-4 the texts: the continuation prompt, the needs-attention reason, the chip mark; numbers as given
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WALK_CONTINUATIONS, completionVerdict, continuationMark, continuationPrompt, needsAttentionReason, validContinuations } from '../walkCompletionCheck.js';

describe('walk completion check', () => {
    test('WV-1: done or missing', () => {
        for (const status of ['completed', 'waiting-for-repeat', 'cancelled']) {
            assert.deepEqual(completionVerdict({ status }, false), { kind: 'done' }, status);
        }
        assert.deepEqual(completionVerdict(undefined, false), { kind: 'missing' });
    });

    test('WV-2: a stated reason', () => {
        assert.equal(completionVerdict({ status: 'blocked' }, false).kind, 'reason');
        assert.equal(completionVerdict({ status: 'decision-needed' }, false).kind, 'reason');
        assert.deepEqual(completionVerdict({ status: 'in-progress', decisions: [{ decision: '' }] }, false), { kind: 'reason', why: 'the todo has an open decision' });
        assert.equal(completionVerdict({ status: 'in-progress', decisions: [{}] }, false).kind, 'reason');
        assert.deepEqual(completionVerdict({ status: 'in-progress' }, true), { kind: 'reason', why: 'a question waits for the user' });
    });

    test('WV-3: a continuation', () => {
        assert.deepEqual(completionVerdict({ status: 'in-progress' }, false), { kind: 'continue', status: 'in-progress' });
        assert.deepEqual(completionVerdict({ status: 'not-started' }, false), { kind: 'continue', status: 'not-started' });
        assert.equal(completionVerdict({ status: 'in-progress', decisions: [{ decision: '(a)' }] }, false).kind, 'continue');
    });

    test('WV-4: the texts and numbers', () => {
        assert.equal(continuationPrompt('ww3_x'), 'The todo ww3_x is not completed. If you started something, wait for it actively and finish the todo; if it cannot be finished, say why and set its status.');
        assert.match(needsAttentionReason('ww3_x', 'in-progress', 2), /^The todo ww3_x is still in-progress after 2 continuations; the walk stopped/);
        assert.equal(continuationMark(1), '1 continuation');
        assert.equal(continuationMark(2), '2 continuations');
        assert.equal(DEFAULT_WALK_CONTINUATIONS, 2);
        assert.deepEqual([validContinuations(3), validContinuations('0'), validContinuations(-1), validContinuations('x')], [3, 0, undefined, undefined]);
    });
});
