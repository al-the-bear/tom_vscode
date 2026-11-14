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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    runMainStageWithRefresh,
    shouldRunInteractiveRefreshHook,
    runInteractiveRefreshHook,
} from '../questRefreshDispatch.js';

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

describe('runMainStageWithRefresh: a stage that cannot be sent (finishvsf2)', () => {
    // A key-less direct-API stage is refused at dispatch. A due refresh used to
    // run first on the same profile, be refused too, and log "queued prompt still
    // sent" for a prompt that was not sent; the refresh was then carried to the
    // next item. It is now skipped while it stays due.
    test('a refused stage does not run the due refresh or count, and still fails with its own error', async () => {
        const order: string[] = [];
        let counted = 0;
        await assert.rejects(runMainStageWithRefresh<string>({
            shouldRefresh: () => { order.push('should'); return true; },
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => { counted += 1; },
            stageRefused: () => 'no API key: ANTHROPIC_X is not set',
            sendMain: async () => { order.push('main'); throw new Error('no API key: ANTHROPIC_X is not set'); },
        }), /no API key/);
        assert.deepEqual(order, ['main'], 'the refresh is neither asked for nor run');
        assert.equal(counted, 0, 'a prompt that was not sent does not count toward the interval');
    });

    test('a stage that is not refused refreshes as before', async () => {
        const order: string[] = [];
        await runMainStageWithRefresh<string>({
            shouldRefresh: () => true,
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => order.push('count'),
            stageRefused: () => undefined,
            sendMain: async () => { order.push('main'); return 'ok'; },
        });
        assert.deepEqual(order, ['refresh', 'count', 'main']);
    });

    test('the queue passes the key check and logs no "still sent"', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'), 'utf-8');
        const at = src.indexOf('private async _dispatchMainStageWithRefresh(');
        const body = src.slice(at, src.indexOf('\n    }\n', at));
        assert.match(body, /stageRefused: \(\) => stageKeyRefusal\(/);
        assert.doesNotMatch(src, /queued prompt still sent/);
        assert.match(body, /Quest Refresh failed — the main prompt is dispatched next/);
    });
});

describe('shouldRunInteractiveRefreshHook', () => {
    test('an ordinary interactive send runs the hook', () => {
        assert.equal(shouldRunInteractiveRefreshHook({}), true);
        assert.equal(shouldRunInteractiveRefreshHook({ isolated: false, skipQuestRefresh: false }), true);
    });

    test('a queue / programmatic send (skipQuestRefresh) does NOT run the hook', () => {
        // This is the no-double-count / no-double-trigger guarantee: the queue
        // sends its main prompt with skipQuestRefresh:true and runs the refresh
        // as a separate dispatch step, so the interactive hook must stay inert.
        assert.equal(shouldRunInteractiveRefreshHook({ skipQuestRefresh: true }), false);
    });

    test('an isolated sub-agent run does NOT run the hook', () => {
        assert.equal(shouldRunInteractiveRefreshHook({ isolated: true }), false);
        assert.equal(shouldRunInteractiveRefreshHook({ isolated: true, skipQuestRefresh: false }), false);
    });

    test('isolated AND skipQuestRefresh is inert', () => {
        assert.equal(shouldRunInteractiveRefreshHook({ isolated: true, skipQuestRefresh: true }), false);
    });
});

describe('runInteractiveRefreshHook', () => {
    test('runs refresh before counting when due', async () => {
        const order: string[] = [];
        let counted = 0;
        await runInteractiveRefreshHook({
            shouldRefresh: () => true,
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => { counted += 1; order.push('count'); },
        });
        assert.deepEqual(order, ['refresh', 'count']);
        assert.equal(counted, 1);
    });

    test('skips refresh but still counts when not due', async () => {
        let refreshCalls = 0;
        let counted = 0;
        await runInteractiveRefreshHook({
            shouldRefresh: () => false,
            runRefresh: async () => { refreshCalls += 1; },
            incrementCount: () => { counted += 1; },
        });
        assert.equal(refreshCalls, 0);
        assert.equal(counted, 1);
    });

    test('a refresh failure PROPAGATES and the prompt is NOT counted (interactive, unlike the queue)', async () => {
        let counted = 0;
        await assert.rejects(
            () => runInteractiveRefreshHook({
                shouldRefresh: () => true,
                runRefresh: async () => { throw new Error('interactive refresh boom'); },
                incrementCount: () => { counted += 1; },
            }),
            /interactive refresh boom/,
        );
        // The failing refresh threw before the count — matches the original
        // inline hook, and is the deliberate contrast with the queue path,
        // where the same failure is swallowed so the prompt still sends.
        assert.equal(counted, 0);
    });
});

describe('runMainStageWithRefresh: a process item (vscimpb97)', () => {
    test('a process item neither counts nor runs the due refresh; it is still sent', async () => {
        const order: string[] = [];
        let counted = 0;
        const result = await runMainStageWithRefresh<string>({
            shouldRefresh: () => true,
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => { counted += 1; },
            sendMain: async () => { order.push('main'); return 'answer'; },
            counts: false,
        });
        assert.equal(result, 'answer');
        assert.deepEqual(order, ['main'], 'the refresh stays due for the next item that counts');
        assert.equal(counted, 0);
    });

    test('an item that counts (the default) counts and refreshes as before', async () => {
        const order: string[] = [];
        let counted = 0;
        await runMainStageWithRefresh<void>({
            shouldRefresh: () => true,
            runRefresh: async () => { order.push('refresh'); },
            incrementCount: () => { counted += 1; },
            sendMain: async () => { order.push('main'); },
            counts: true,
        });
        assert.deepEqual(order, ['refresh', 'main']);
        assert.equal(counted, 1);
    });

    test('the queue passes the item\'s marker', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'), 'utf-8');
        assert.match(src, /counts: !item\.processItem,/);
    });
});
