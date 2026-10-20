/**
 * The process position a queued prompt runs for (src/services/processRunContext.ts).
 *
 *   PR-1 inside runInProcessPosition the run is current, outside it is not; without a run, fn just runs
 *   PR-2 concurrent sends keep their own positions across awaits
 *   PR-3 an item queued during a run inherits it; an explicit position wins; outside a run, none
 *   PR-4 the queue file shape round-trips through YAML; anything else is no run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';

import {
    currentProcessRun,
    inheritedProcessRun,
    parseProcessRun,
    runInProcessPosition,
    type ProcessRun,
} from '../processRunContext.js';

const at = (step: string, substep = ''): ProcessRun => ({
    quest: 'tom_uam',
    state: { process: 'tom_specs', phase: 'phase2', phaseIteration: 1, step, stepIteration: 1, substep, substepIteration: 1, completed: false },
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('process run context', () => {
    test('PR-1: current inside, not outside', async () => {
        assert.equal(currentProcessRun(), undefined);
        const run = at('03-iteration', '01-questions-round');
        const seen = await runInProcessPosition(run, async () => { await tick(); return currentProcessRun(); });
        assert.deepEqual(seen, run);
        assert.equal(currentProcessRun(), undefined, 'gone after the send');
        assert.equal(await runInProcessPosition(undefined, async () => currentProcessRun()), undefined);
    });

    test('PR-2: concurrent sends keep their own positions', async () => {
        const a = at('03-iteration', '01-questions-round');
        const b = at('03-iteration', '02-structural-requirements-pass');
        const [sa, sb] = await Promise.all([
            runInProcessPosition(a, async () => { await tick(); await tick(); return currentProcessRun()?.state.substep; }),
            runInProcessPosition(b, async () => { await tick(); return currentProcessRun()?.state.substep; }),
        ]);
        assert.deepEqual([sa, sb], ['01-questions-round', '02-structural-requirements-pass']);
    });

    test('PR-3: what a queued item inherits', async () => {
        const run = at('03-iteration', '01-questions-round');
        const other = at('04-final-consistency');
        await runInProcessPosition(run, async () => {
            assert.deepEqual(inheritedProcessRun(undefined), run, 'queued during the run: its position');
            assert.deepEqual(inheritedProcessRun(other), other, 'an explicit position wins');
        });
        assert.equal(inheritedProcessRun(undefined), undefined, 'outside a run: none');
    });

    test('PR-4: the queue file shape', () => {
        const run = at('03-iteration', '01-questions-round');
        assert.deepEqual(parseProcessRun(parse(stringify({ 'process-run': run }))['process-run']), run);
        assert.equal(parseProcessRun(undefined), undefined);
        assert.equal(parseProcessRun({ quest: 'q' }), undefined);
        assert.equal(parseProcessRun('x'), undefined);
    });
});
