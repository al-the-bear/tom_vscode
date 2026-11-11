/**
 * The PROCESS view's run messages (src/services/processRunActions.ts) against a fake store and fake pickers.
 *
 *   RA-1 a new run's name: not empty, the run-name rules (`default` reserved), not a run the quest has
 *   RA-2 a click on a run selects it; on the current one it changes nothing
 *   RA-3 +: the name, then the process (none yet first, then the processes); either dismissed creates nothing;
 *        a name the input box let through but the rules refuse is refused again
 *   RA-4 trash: the runs but `default` to choose from; nothing chosen or not confirmed deletes nothing; the
 *        confirmation names the runs and, when it is among them, this window's run; only `default`: refused
 *   RA-5 the message routing: the three run messages are handled, any other is not
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createRunAction, deleteRunsAction, handleRunMessage, runNameInputError, selectRunAction,
    type RunListEntry, type RunStorePort, type RunUiPort,
} from '../processRunActions.js';

function fakeStore(runs: RunListEntry[]): RunStorePort & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        runs: () => runs,
        processes: () => [{ id: 'main', name: 'Main' }, { id: 'change', name: '' }],
        selectRun: (run) => { calls.push(`select ${run}`); return { ok: true }; },
        createRun: (run, process) => { calls.push(`create ${run} ${process ?? '-'}`); return { ok: true }; },
        deleteRuns: (r) => { calls.push(`delete ${r.join(',')}`); return { ok: true }; },
    };
}
const entry = (run: string, current = false, process = 'main'): RunListEntry => ({ run, process, position: 'P1 › Plan', changed: '2026-11-11T07:00:00.000Z', current });

function fakeUi(answers: { name?: string; process?: string | null; runs?: string[]; confirm?: boolean }): RunUiPort & { seen: Record<string, unknown>[] } {
    const seen: Record<string, unknown>[] = [];
    return {
        seen,
        inputRunName: async (validate) => { seen.push({ validate }); return answers.name; },
        pickProcess: async (items) => { seen.push({ processes: items }); return answers.process; },
        pickRuns: async (items) => { seen.push({ runs: items }); return answers.runs; },
        confirm: async (message, detail, button) => { seen.push({ message, detail, button }); return answers.confirm === true; },
    };
}

describe('the PROCESS view\'s run messages', () => {
    test('RA-1: a new run\'s name', () => {
        assert.match(runNameInputError('  ', []) ?? '', /Enter the name/);
        assert.match(runNameInputError('a b', []) ?? '', /no run name/);
        assert.match(runNameInputError('x.y', []) ?? '', /no run name/, 'no dot: it is part of a file name');
        assert.equal(runNameInputError('default', []), 'every quest has the run "default" already');
        assert.equal(runNameInputError('chg1', ['default', 'chg1']), 'The quest has a run "chg1" already.');
        assert.equal(runNameInputError(' chg2 ', ['default', 'chg1']), undefined);
    });

    test('RA-2: select', () => {
        const store = fakeStore([entry('default', true), entry('chg1')]);
        assert.deepEqual(selectRunAction(store, 'chg1'), { ok: true });
        assert.deepEqual(selectRunAction(store, 'default'), { ok: true });
        assert.deepEqual(store.calls, ['select chg1'], 'the current run again: no change');
        assert.deepEqual(selectRunAction(store, ''), { ok: false, error: 'no run named' });
    });

    test('RA-3: create', async () => {
        const store = fakeStore([entry('default', true)]);
        const ui = fakeUi({ name: ' chg1 ', process: 'main' });
        assert.deepEqual(await createRunAction(store, ui), { ok: true });
        assert.deepEqual(store.calls, ['create chg1 main']);
        const validate = ui.seen[0].validate as (v: string) => string | undefined;
        assert.equal(validate('default'), 'every quest has the run "default" already');
        assert.deepEqual((ui.seen[1].processes as Array<{ id: string; label: string }>).map((i) => [i.id, i.label]),
            [['', '— no process yet —'], ['main', 'Main'], ['change', 'change']]);
        const none = fakeStore([entry('default', true)]);
        assert.deepEqual(await createRunAction(none, fakeUi({ name: 'chg2', process: null })), { ok: true });
        assert.deepEqual(none.calls, ['create chg2 -'], 'none yet');
        const dismissed = fakeStore([entry('default', true)]);
        assert.equal(await createRunAction(dismissed, fakeUi({ name: undefined })), undefined);
        assert.equal(await createRunAction(dismissed, fakeUi({ name: 'chg3', process: undefined })), undefined);
        assert.deepEqual(dismissed.calls, [], 'dismissed: nothing created');
        assert.deepEqual(await createRunAction(dismissed, fakeUi({ name: 'default', process: 'main' })), { ok: false, error: 'every quest has the run "default" already' });
    });

    test('RA-4: delete', async () => {
        const store = fakeStore([entry('chg1', true), entry('default'), entry('chg2', false, '')]);
        const ui = fakeUi({ runs: ['chg1', 'chg2'], confirm: true });
        assert.deepEqual(await deleteRunsAction(store, ui), { ok: true });
        assert.deepEqual((ui.seen[0].runs as Array<{ run: string; description: string }>).map((i) => [i.run, i.description]),
            [['chg1', 'main — P1 › Plan · this window\'s run'], ['chg2', 'no process yet']], 'default is not offered');
        assert.equal(ui.seen[1].message, 'Delete 2 runs: chg1, chg2?');
        assert.match(String(ui.seen[1].detail), /"chg1" is this window's run: the window goes back to "default"\./);
        assert.equal(ui.seen[1].button, 'Delete 2 runs');
        assert.deepEqual(store.calls, ['delete chg1,chg2']);
        const keep = fakeStore([entry('default', true), entry('chg1')]);
        assert.equal(await deleteRunsAction(keep, fakeUi({ runs: ['chg1'], confirm: false })), undefined);
        assert.equal(await deleteRunsAction(keep, fakeUi({ runs: [] })), undefined);
        assert.equal(await deleteRunsAction(keep, fakeUi({ runs: undefined })), undefined);
        assert.deepEqual(keep.calls, [], 'nothing deleted');
        const one = fakeUi({ runs: ['chg1'], confirm: false });
        await deleteRunsAction(keep, one);
        assert.equal(one.seen[1].message, 'Delete the run "chg1"?');
        assert.doesNotMatch(String(one.seen[1].detail), /this window's run/);
        assert.deepEqual(await deleteRunsAction(fakeStore([entry('default', true)]), fakeUi({})), { ok: false, error: 'the quest has no run besides "default", which is never deleted' });
    });

    test('RA-5: the routing', async () => {
        const store = fakeStore([entry('default', true), entry('chg1')]);
        assert.deepEqual(await handleRunMessage({ type: 'selectRun', run: 'chg1' }, store, fakeUi({})), { handled: true, result: { ok: true } });
        assert.deepEqual(await handleRunMessage({ type: 'createRun' }, store, fakeUi({})), { handled: true, result: undefined });
        assert.deepEqual(await handleRunMessage({ type: 'deleteRuns' }, store, fakeUi({})), { handled: true, result: undefined });
        assert.deepEqual(await handleRunMessage({ type: 'action' }, store, fakeUi({})), { handled: false });
    });
});
