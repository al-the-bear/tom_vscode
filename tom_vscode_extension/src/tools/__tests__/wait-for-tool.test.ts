/**
 * `tomAi_waitFor` (src/tools/wait-for-tool.ts; vscimpb82). Its rules and registry: utils/__tests__/waitFor.test.ts;
 * the queue item's side: queueWaitFor.queue.test.ts.
 *
 *   WT-1 an input error answers ok false and waits for nothing
 *   WT-2 elapsed / interrupted (a queue item's turn, or a chat send) / cancelled answer their outcome and message;
 *        the wait is opened for the queue item the call runs in
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import { waitForImpl, type WaitForDeps } from '../wait-for-tool.js';

const NOW = new Date(2026, 10, 13, 12, 0, 0).getTime();

function deps(outcomes: Array<'elapsed' | 'interrupted' | 'cancelled'>, item?: string): WaitForDeps & { calls: Array<string | undefined> } {
    let t = NOW;
    const calls: Array<string | undefined> = [];
    return {
        calls,
        registry: { wait: async (_state, id) => { calls.push(id); t += 61 * 60_000; return outcomes.shift()!; } },
        now: () => t,
        queueItemId: () => item,
    };
}

describe('tomAi_waitFor', () => {
    test('WT-1: an input error waits for nothing', async () => {
        const d = deps([]);
        const bad = JSON.parse(await withTiming('tomAi_waitFor:invalid', () => waitForImpl({ minutes: 5 }, d)));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /reason/);
        assert.equal(JSON.parse(await waitForImpl({ reason: 'r' }, d)).ok, false, 'no until / minutes');
        assert.deepEqual(d.calls, []);
    });

    test('WT-2: the outcomes', async () => {
        const elapsed = JSON.parse(await withTiming('tomAi_waitFor:typical', () => waitForImpl({ reason: 'pub.dev', minutes: 61 }, deps(['elapsed']))));
        assert.deepEqual([elapsed.ok, elapsed.outcome, elapsed.waited], [true, 'elapsed', '1 h 1 min']);
        const queued = deps(['interrupted'], 'q1');
        const inQueue = JSON.parse(await waitForImpl({ reason: 'pub.dev', minutes: 61 }, queued));
        assert.deepEqual(queued.calls, ['q1'], 'opened for the queue item');
        assert.equal(inQueue.outcome, 'interrupted');
        assert.match(inQueue.message, /End your turn now.*The queue puts this item back/);
        const inChat = JSON.parse(await waitForImpl({ reason: 'pub.dev', minutes: 61 }, deps(['interrupted'])));
        assert.doesNotMatch(inChat.message, /queue/);
        const cancelled = JSON.parse(await waitForImpl({ reason: 'pub.dev', minutes: 61 }, deps(['cancelled'])));
        assert.deepEqual([cancelled.ok, cancelled.outcome], [false, 'cancelled']);
    });
});
