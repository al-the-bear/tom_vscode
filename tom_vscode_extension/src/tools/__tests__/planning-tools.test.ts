/**
 * Tool-impl tests for `planning-tools.ts` — entry #25's pure local
 * controllers:
 *
 *   - tomAi_enterPlanMode  — flag flip
 *   - tomAi_exitPlanMode   — flag clear + duration report
 *   - tomAi_spawnSubagent  — delegate to a host-registered spawner
 *
 * Plan-mode state is process-global; each test resets it in a
 * `beforeEach` via `resetPlanModeForTests()`.
 *
 * Coverage entry #25 four-row checklist (controller half):
 *
 *   a) Description clarity — verified in the impl file: plan mode is
 *      advisory (the flag does NOT gate any tool by itself), and the
 *      sub-agent spawner is documented as not-re-entrant by default
 *      (host responsibility).
 *   b) Ambiguities covered:
 *        - nested `enterPlanMode` returns `nested: true` + original
 *          enteredAt/reason instead of silently overwriting
 *        - `exitPlanMode` while inactive returns `wasActive: false,
 *          noOp: true` (was a silent no-op with bare `wasActive: false`)
 *        - `spawnSubagent` validates maxRounds (positive int) and
 *          temperature [0,2] (were silently accepted)
 *        - "Spawner not registered" surfaces as ok:false with a hint
 *   c) Tests with a pinned clock + a fake spawner that records every
 *      call and can throw on demand. No real sub-agent is run.
 *   d) Timing — sub-ms (flag flips, fake spawner) via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    enterPlanModeImpl,
    exitPlanModeImpl,
    spawnSubagentImpl,
    isPlanModeActive,
    getPlanModeState,
    resetPlanModeForTests,
    type PlanModeClock,
    type SubagentSpawner,
    type SubagentSpawnerLookup,
    type SubagentSpawnOptions,
    type SubagentSpawnResult,
} from '../planning-tools.js';

// ===========================================================================
// Fake clock — lets us pin enteredAt + assert durationMs deterministically
// ===========================================================================

interface MutableClock extends PlanModeClock {
    set(t: number): void;
}
function makeClock(initial = 1_000_000): MutableClock {
    let t = initial;
    return { now: () => t, set: (x) => { t = x; } };
}

// ===========================================================================
// Fake spawner
// ===========================================================================

interface SpawnerCall { options: SubagentSpawnOptions }
interface FakeLookup extends SubagentSpawnerLookup {
    calls: SpawnerCall[];
    nextResult: SubagentSpawnResult;
    throwOnNext?: Error;
    setSpawner(fn: SubagentSpawner | null): void;
}

function makeLookup(): FakeLookup {
    const calls: SpawnerCall[] = [];
    let registered: SubagentSpawner | null = null;
    const fake: FakeLookup = {
        calls,
        nextResult: { summary: 'done', rounds: 1, toolCalls: 0, stopReason: 'end_turn' },
        get: () => registered,
        setSpawner: (fn) => { registered = fn; },
    };
    // Default spawner records the call and returns nextResult / throws.
    fake.setSpawner(async (options) => {
        calls.push({ options });
        if (fake.throwOnNext) {
            const e = fake.throwOnNext;
            fake.throwOnNext = undefined;
            throw e;
        }
        return fake.nextResult;
    });
    return fake;
}

beforeEach(() => { resetPlanModeForTests(); });

// ===========================================================================
// `tomAi_enterPlanMode` + `tomAi_exitPlanMode`
// ===========================================================================

describe('enterPlanModeImpl + exitPlanModeImpl', () => {

    test('typical: enter then exit reports durationMs and toggles flag', async () => {
        const clk = makeClock(100);
        const enterRaw = await withTiming('tomAi_enterPlanMode:typical', () =>
            enterPlanModeImpl({ reason: 'thinking it through' }, clk));
        const enterR = JSON.parse(enterRaw);
        assert.equal(enterR.ok, true);
        assert.equal(enterR.nested, false);
        assert.equal(enterR.active, true);
        assert.equal(enterR.reason, 'thinking it through');
        assert.equal(isPlanModeActive(), true);

        clk.set(2_500);  // 2_400ms later
        const exitRaw = await withTiming('tomAi_exitPlanMode:typical', () =>
            exitPlanModeImpl({ plan: 'final plan text' }, clk));
        const exitR = JSON.parse(exitRaw);
        assert.equal(exitR.ok, true);
        assert.equal(exitR.wasActive, true);
        assert.equal(exitR.noOp, false);
        assert.equal(exitR.durationMs, 2400);
        assert.equal(exitR.plan, 'final plan text');
        assert.equal(isPlanModeActive(), false);
    });

    test('nested enter: returns nested:true and preserves originalEnteredAt/reason', async () => {
        const clk = makeClock(100);
        await enterPlanModeImpl({ reason: 'first' }, clk);
        clk.set(200);
        const nested = JSON.parse(await enterPlanModeImpl({ reason: 'overwrite attempt' }, clk));
        assert.equal(nested.nested, true);
        assert.equal(nested.originalReason, 'first');
        // Original enteredAt preserved (clock was 100 on first call)
        assert.equal(nested.originalEnteredAt, new Date(100).toISOString());
        // State unchanged
        const state = getPlanModeState();
        assert.equal(state.reason, 'first', 'original reason preserved');
        assert.equal(state.enteredAt, 100, 'original enteredAt preserved');
    });

    test('exit while inactive → wasActive:false, noOp:true (not an error)', async () => {
        const r = JSON.parse(await exitPlanModeImpl({ plan: 'x' }));
        assert.equal(r.ok, true);
        assert.equal(r.wasActive, false);
        assert.equal(r.noOp, true);
        assert.equal(r.plan, 'x');
    });

    test('enter without reason → reason: null', async () => {
        const r = JSON.parse(await enterPlanModeImpl({}));
        assert.equal(r.reason, null);
    });

    test('exit without plan → plan: null', async () => {
        await enterPlanModeImpl({ reason: 'r' });
        const r = JSON.parse(await exitPlanModeImpl({}));
        assert.equal(r.plan, null);
    });
});

// ===========================================================================
// `tomAi_spawnSubagent`
// ===========================================================================

describe('spawnSubagentImpl', () => {

    test('typical: spawner result is wrapped in {ok, summary, rounds, toolCalls, stopReason}', async () => {
        const lookup = makeLookup();
        lookup.nextResult = { summary: 'I read 3 files', rounds: 2, toolCalls: 4, stopReason: 'tool_use_done' };
        const raw = await withTiming('tomAi_spawnSubagent:typical', () =>
            spawnSubagentImpl({ prompt: 'Read foo.ts and summarise.' }, lookup));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.summary, 'I read 3 files');
        assert.equal(r.rounds, 2);
        assert.equal(r.toolCalls, 4);
        assert.equal(r.stopReason, 'tool_use_done');
        assert.equal(lookup.calls.length, 1);
        assert.equal(lookup.calls[0].options.prompt, 'Read foo.ts and summarise.');
    });

    test('spawner forwards systemPrompt, enabledTools, maxRounds, temperature', async () => {
        const lookup = makeLookup();
        await spawnSubagentImpl({
            prompt: 'x',
            systemPrompt: 'You are a code reader.',
            enabledTools: ['tomAi_readFile', 'tomAi_findSymbol'],
            maxRounds: 5,
            temperature: 0.3,
        }, lookup);
        const opts = lookup.calls[0].options;
        assert.equal(opts.systemPrompt, 'You are a code reader.');
        assert.deepEqual(opts.enabledTools, ['tomAi_readFile', 'tomAi_findSymbol']);
        assert.equal(opts.maxRounds, 5);
        assert.equal(opts.temperature, 0.3);
    });

    test('empty prompt rejected, spawner NOT invoked', async () => {
        const lookup = makeLookup();
        const r = JSON.parse(await spawnSubagentImpl({ prompt: '   ' }, lookup));
        assert.equal(r.ok, false);
        assert.match(r.error, /`prompt` is required/);
        assert.equal(lookup.calls.length, 0);
    });

    test('maxRounds: zero rejected', async () => {
        const lookup = makeLookup();
        const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x', maxRounds: 0 }, lookup));
        assert.equal(r.ok, false);
        assert.match(r.error, /maxRounds.*positive integer/);
        assert.equal(lookup.calls.length, 0);
    });

    test('maxRounds: negative rejected', async () => {
        const lookup = makeLookup();
        const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x', maxRounds: -1 }, lookup));
        assert.equal(r.ok, false);
        assert.match(r.error, /maxRounds.*positive integer/);
    });

    test('temperature: out-of-range rejected', async () => {
        const lookup = makeLookup();
        for (const bad of [-0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x', temperature: bad }, lookup));
            assert.equal(r.ok, false, `temperature=${bad} should be rejected`);
            assert.match(r.error, /temperature.*\[0, 2\]/);
        }
        assert.equal(lookup.calls.length, 0);
    });

    test('temperature boundary values accepted: 0 and 2', async () => {
        const lookup = makeLookup();
        const r0 = JSON.parse(await spawnSubagentImpl({ prompt: 'x', temperature: 0 }, lookup));
        const r2 = JSON.parse(await spawnSubagentImpl({ prompt: 'x', temperature: 2 }, lookup));
        assert.equal(r0.ok, true);
        assert.equal(r2.ok, true);
    });

    test('no spawner registered → ok: false with hint', async () => {
        const unregistered: SubagentSpawnerLookup = { get: () => null };
        const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x' }, unregistered));
        assert.equal(r.ok, false);
        assert.match(r.error, /Sub-agent spawner is not registered/);
        assert.match(r.hint, /registerSubagentSpawner/);
        assert.match(r.hint, /useBuiltInTools/);
    });

    test('spawner throws → ok: false with reason', async () => {
        const lookup = makeLookup();
        lookup.throwOnNext = new Error('rate limited');
        const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x' }, lookup));
        assert.equal(r.ok, false);
        assert.match(r.error, /Sub-agent failed: rate limited/);
    });

    test('stopReason undefined from spawner → null in envelope', async () => {
        const lookup = makeLookup();
        lookup.nextResult = { summary: 'done', rounds: 1, toolCalls: 0 };
        const r = JSON.parse(await spawnSubagentImpl({ prompt: 'x' }, lookup));
        assert.equal(r.stopReason, null);
    });
});
