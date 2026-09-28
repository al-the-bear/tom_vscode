/**
 * Tests for `AskUserRegistry` — the single pending-ask slot that blocks the
 * Anthropic round (and therefore the prompt queue) until the user answers.
 *
 * The registry is `vscode`-free and exposes injectable timer/id/clock seams,
 * so the resolution race and the timeout are tested deterministically without
 * real timers or a real editor: a fake `setTimer` captures the callback (and
 * the requested delay) instead of arming a real timeout, and the test fires it
 * by hand when it wants the timeout path.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    AskUserRegistry,
    type AskAnswerSource,
    type PendingAsk,
    type BeginAskParams,
} from '../askUserRegistry.js';

// ---------------------------------------------------------------------------
// Controllable harness
// ---------------------------------------------------------------------------

interface ArmedTimer { ms: number; cb: () => void; cleared: boolean; }

interface Harness {
    registry: AskUserRegistry;
    timers: ArmedTimer[];
    /** Fire the most recently-armed (still-live) timer. */
    fireLatestTimer(): void;
    nowValue: number;
}

function makeHarness(idSeq: string[] = ['id-1', 'id-2', 'id-3']): Harness {
    const timers: ArmedTimer[] = [];
    let idx = 0;
    const h: Harness = {
        timers,
        nowValue: 1_000,
        fireLatestTimer() {
            const live = [...timers].reverse().find((t) => !t.cleared);
            assert.ok(live, 'expected a live timer to fire');
            live.cb();
        },
        registry: new AskUserRegistry({
            setTimer: (ms, cb) => {
                const handle = { ms, cb, cleared: false };
                timers.push(handle);
                return handle as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimer: (handle) => {
                (handle as unknown as ArmedTimer).cleared = true;
            },
            genId: () => idSeq[Math.min(idx++, idSeq.length - 1)],
            now: () => h.nowValue,
        }),
    };
    return h;
}

interface Captured { opens: PendingAsk[]; resolves: Array<{ pending: PendingAsk; source: AskAnswerSource; answer: string }>; }

function beginWith(h: Harness, overrides: Partial<BeginAskParams> = {}): { promise: Promise<string>; captured: Captured } {
    const captured: Captured = { opens: [], resolves: [] };
    const promise = h.registry.begin({
        questions: ['Q1?', 'Q2?'],
        title: 'Decide',
        timeoutMs: 900_000,
        fallbackPrompt: 'FALLBACK',
        onOpen: (p) => captured.opens.push(p),
        onResolve: (p, source, answer) => captured.resolves.push({ pending: p, source, answer }),
        ...overrides,
    });
    return { promise, captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AskUserRegistry', () => {

    test('begin() opens synchronously and exposes a pending snapshot', async () => {
        const h = makeHarness();
        const { captured } = beginWith(h);
        assert.equal(h.registry.hasPending(), true);
        assert.equal(captured.opens.length, 1);
        const pending = h.registry.getPending();
        assert.ok(pending);
        assert.equal(pending.requestId, 'id-1');
        assert.deepEqual(pending.questions, ['Q1?', 'Q2?']);
        assert.equal(pending.title, 'Decide');
        assert.equal(pending.createdAt, 1_000);
        assert.equal(pending.timeoutAt, 1_000 + 900_000);
        // The armed timer carries the requested delay.
        assert.equal(h.timers[0].ms, 900_000);
    });

    test('vscode submit resolves the promise verbatim and clears the slot', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h);
        const id = h.registry.getPending()!.requestId;
        const accepted = h.registry.submit(id, '1. yes\n2. ship it', 'vscode');
        assert.equal(accepted, true);
        assert.equal(await promise, '1. yes\n2. ship it');
        assert.equal(h.registry.hasPending(), false);
        assert.equal(captured.resolves.length, 1);
        assert.equal(captured.resolves[0].source, 'vscode');
        assert.equal(captured.resolves[0].answer, '1. yes\n2. ship it');
        // Resolution clears the timer.
        assert.equal(h.timers[0].cleared, true);
    });

    test('telegram submit resolves verbatim', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h);
        const id = h.registry.getPending()!.requestId;
        assert.equal(h.registry.submit(id, 'from phone', 'telegram'), true);
        assert.equal(await promise, 'from phone');
        assert.equal(captured.resolves[0].source, 'telegram');
    });

    test('timeout resolves with the fallback prompt', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h, { fallbackPrompt: 'no answer — proceed' });
        h.fireLatestTimer();
        assert.equal(await promise, 'no answer — proceed');
        assert.equal(captured.resolves[0].source, 'timeout');
        assert.equal(h.registry.hasPending(), false);
    });

    test('cancel resolves with the note and source "cancel"', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h);
        h.registry.cancel('stopped');
        assert.equal(await promise, 'stopped');
        assert.equal(captured.resolves[0].source, 'cancel');
        assert.equal(h.registry.hasPending(), false);
    });

    test('cancel() with no pending ask is a no-op', () => {
        const h = makeHarness();
        assert.doesNotThrow(() => h.registry.cancel());
        assert.equal(h.registry.hasPending(), false);
    });

    test('begin() while one is pending rejects (singleton)', async () => {
        const h = makeHarness();
        beginWith(h);
        await assert.rejects(
            () => beginWith(h).promise,
            /already pending/,
        );
        // The original ask is untouched.
        assert.equal(h.registry.getPending()!.requestId, 'id-1');
    });

    test('stale submit (wrong requestId) returns false and leaves the ask pending', () => {
        const h = makeHarness();
        beginWith(h);
        assert.equal(h.registry.submit('not-the-id', 'x', 'vscode'), false);
        assert.equal(h.registry.hasPending(), true);
    });

    test('submit after the slot already resolved returns false (first wins)', async () => {
        const h = makeHarness();
        const { promise } = beginWith(h);
        const id = h.registry.getPending()!.requestId;
        assert.equal(h.registry.submit(id, 'first', 'vscode'), true);
        await promise;
        // A late Telegram reply that raced in after resolution is rejected.
        assert.equal(h.registry.submit(id, 'second', 'telegram'), false);
    });

    test('a timer that fires after resolution does not re-resolve', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h);
        const id = h.registry.getPending()!.requestId;
        h.registry.submit(id, 'answer', 'vscode');
        await promise;
        // Manually invoke the (now-cleared) timer callback — finish() guards
        // against re-entrancy, so this must be a no-op.
        h.timers[0].cb();
        assert.equal(captured.resolves.length, 1);
    });

    test('the static singleton is shared across accessors', () => {
        assert.equal(AskUserRegistry.instance, AskUserRegistry.instance);
    });
});

/**
 * Waiting forever is the default. A question the user has not seen yet must not
 * expire on its own: the previous behaviour answered the model with a fallback
 * prompt after fifteen minutes, so a prompt left running overnight came back
 * having invented its own answer to a question nobody read.
 */
describe('AskUserRegistry — waiting indefinitely', () => {
    test('an ask with no timeout arms no timer at all', () => {
        const h = makeHarness();
        beginWith(h, { timeoutMs: undefined });
        assert.equal(h.timers.length, 0);
        assert.equal(h.registry.hasPending(), true);
    });

    test('a pending ask with no timeout reports no deadline', () => {
        // The webview renders a countdown from `timeoutAt`; `undefined` is what
        // tells it there is nothing to count down to.
        const h = makeHarness();
        beginWith(h, { timeoutMs: undefined });
        assert.equal(h.registry.getPending()!.timeoutAt, undefined);
    });

    test('a non-positive timeout means "wait", not "expire immediately"', () => {
        // 0 is the configured value for "no ceiling"; arming a 0 ms timer would
        // resolve the ask with the fallback before the panel even opened.
        for (const timeoutMs of [0, -1]) {
            const h = makeHarness();
            beginWith(h, { timeoutMs });
            assert.equal(h.timers.length, 0, `timeoutMs ${timeoutMs} armed a timer`);
            assert.equal(h.registry.getPending()!.timeoutAt, undefined);
        }
    });

    test('an untimed ask still resolves normally when the user answers', async () => {
        const h = makeHarness();
        const { promise, captured } = beginWith(h, { timeoutMs: undefined });
        const id = h.registry.getPending()!.requestId;
        assert.equal(h.registry.submit(id, 'answered eventually', 'vscode'), true);
        assert.equal(await promise, 'answered eventually');
        assert.equal(captured.resolves[0].source, 'vscode');
        assert.equal(h.registry.hasPending(), false);
    });

    test('an untimed ask can still be cancelled', async () => {
        // Without this the Stop button would leak an awaiting round forever.
        const h = makeHarness();
        const { promise } = beginWith(h, { timeoutMs: undefined });
        h.registry.cancel('stopped');
        assert.equal(await promise, 'stopped');
        assert.equal(h.registry.hasPending(), false);
    });

    test('an explicit positive timeout still arms a timer', () => {
        const h = makeHarness();
        beginWith(h, { timeoutMs: 60_000 });
        assert.equal(h.timers.length, 1);
        assert.equal(h.timers[0].ms, 60_000);
        assert.equal(h.registry.getPending()!.timeoutAt, 1_000 + 60_000);
    });
});
