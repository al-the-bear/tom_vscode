/**
 * Tests for runMainStageWithRefresh — the queue's Quest Refresh pre-step.
 *
 * Reproduces the qr1 bug: the refresh used to fire re-entrantly *inside* the
 * queued turn's own sendMessage, so a failing refresh propagated out and the
 * user's queued prompt was never sent. The helper runs the refresh as an
 * explicit sequential step and isolates its failure so the main prompt is
 * always dispatched exactly once.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { runMainStageWithRefresh } from '../questRefreshDispatch.js';

describe('runMainStageWithRefresh', () => {
    test('refresh failure does NOT block the main prompt (qr1 regression)', async () => {
        const order: string[] = [];
        let counted = 0;
        const result = await runMainStageWithRefresh<string>({
            shouldRefresh: () => true,
            runRefresh: async () => {
                order.push('refresh');
                throw new Error('refresh boom');
            },
            incrementCount: () => { counted += 1; },
            onRefreshError: () => order.push('refresh-error'),
            sendMain: async () => {
                order.push('main');
                return 'answer';
            },
        });
        // The queued prompt is still sent, and its answer is returned.
        assert.equal(result, 'answer');
        // Refresh ran, its failure was caught, then the main prompt sent.
        assert.deepEqual(order, ['refresh', 'refresh-error', 'main']);
        // The main prompt still counts toward the interval.
        assert.equal(counted, 1);
    });

    test('runs refresh before the main send when due, counting once', async () => {
        const order: string[] = [];
        let counted = 0;
        await runMainStageWithRefresh<void>({
            shouldRefresh: () => true,
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => { counted += 1; order.push('count'); },
            sendMain: async () => { order.push('main'); },
        });
        assert.deepEqual(order, ['refresh', 'count', 'main']);
        assert.equal(counted, 1);
    });

    test('skips the refresh when not due but still counts and sends', async () => {
        const order: string[] = [];
        let refreshCalls = 0;
        let counted = 0;
        await runMainStageWithRefresh<void>({
            shouldRefresh: () => false,
            runRefresh: async () => { refreshCalls += 1; },
            incrementCount: () => { counted += 1; },
            sendMain: async () => { order.push('main'); },
        });
        assert.equal(refreshCalls, 0);
        assert.equal(counted, 1);
        assert.deepEqual(order, ['main']);
    });

    test('calls sendMain exactly once (no re-entrancy)', async () => {
        let mainCalls = 0;
        await runMainStageWithRefresh<void>({
            shouldRefresh: () => true,
            runRefresh: async () => { /* a proper, separate dispatch */ },
            incrementCount: () => { /* noop */ },
            sendMain: async () => { mainCalls += 1; },
        });
        assert.equal(mainCalls, 1);
    });

    test('a throwing shouldRefresh is isolated too — main still sends', async () => {
        let counted = 0;
        const result = await runMainStageWithRefresh<string>({
            shouldRefresh: () => { throw new Error('predicate boom'); },
            runRefresh: async () => { throw new Error('should not run'); },
            incrementCount: () => { counted += 1; },
            sendMain: async () => 'answer',
        });
        assert.equal(result, 'answer');
        assert.equal(counted, 1);
    });
});
