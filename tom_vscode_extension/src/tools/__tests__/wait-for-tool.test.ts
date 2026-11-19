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
import { WAIT_FOR_DESCRIPTION, waitForImpl, type WaitForDeps } from '../wait-for-tool.js';

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

    test('WT-3: a message from the user ends the call with it; the agent waits on (vscimpb173)', async () => {
        // 61 of 90 minutes waited when the message comes.
        let t = NOW;
        const d: WaitForDeps = {
            registry: { wait: async () => { t += 61 * 60_000; return { outcome: 'message', message: 'Also bump the changelog.' }; } },
            now: () => t,
            queueItemId: () => 'q1',
        };
        const r = JSON.parse(await waitForImpl({ reason: 'pub.dev limit', minutes: 90 }, d));
        const until = new Date(NOW + 90 * 60_000).toISOString();
        assert.deepEqual([r.ok, r.outcome, r.message, r.waited, r.until, r.remaining], [true, 'message', 'Also bump the changelog.', '1 h 1 min', until, '29 min']);
        assert.match(r.instruction, /the wait is NOT over/);
        assert.ok(r.instruction.includes(`call tomAi_waitFor again with the same reason and \`until: "${until}"\` to go on waiting`));
        // Called again with that `until`, it waits for what was left.
        const again: Array<{ until: string }> = [];
        const d2: WaitForDeps = { registry: { wait: async (state) => { again.push(state); return 'elapsed'; } }, now: () => t, queueItemId: () => 'q1' };
        assert.equal(JSON.parse(await waitForImpl({ reason: 'pub.dev limit', until: r.until }, d2)).outcome, 'elapsed');
        assert.equal(again[0].until, until, 'the same end');
        // Written just as the wait ran out: nothing is left to wait for.
        const late: WaitForDeps = { registry: { wait: async () => { t = NOW + 200 * 60_000; return { outcome: 'message', message: 'm' }; } }, now: () => t, queueItemId: () => undefined };
        t = NOW;
        const over = JSON.parse(await waitForImpl({ reason: 'r', minutes: 90 }, late));
        assert.equal(over.remaining, 'none');
        assert.match(over.instruction, /then go on with the step you waited for/);
        assert.match(WAIT_FOR_DESCRIPTION, /`message` — the user wrote to you while you waited.*call tomAi_waitFor again with the same `until` to go on waiting/);
        assert.ok(WAIT_FOR_DESCRIPTION.length <= 1250, `description ${WAIT_FOR_DESCRIPTION.length} chars`);
    });
});
