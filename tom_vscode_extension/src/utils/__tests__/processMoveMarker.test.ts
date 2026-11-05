/**
 * The rules of the process-move marker (src/utils/processMoveMarker.ts): a
 * process step ends with its queue.
 *
 *   PM-1 an item of a Proceed run goes before that run's open marker; an item of another run, or of no run,
 *        goes where it would otherwise (-1); a marker that has moved (sent) takes nothing
 *   PM-2 the verdict: every earlier item of the run sent → move; one failed → held; one still pending,
 *        sending, waiting, staged or held for decisions → wait; items of other runs do not count
 *   PM-3 stepRunProgress: the quest's open marker, the run's items left (the marker not counted), held when
 *        the marker failed or an item did; none for another quest or when the marker has moved
 *   PM-4 openMarkerIds names the quest's open markers only; markerText and newProceedId
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { markerInsertIndex, markerText, markerVerdict, newProceedId, openMarkerIds, stepRunProgress, type MarkerQueueItem } from '../processMoveMarker.js';
import type { ProcessRun } from '../../services/processRunContext.js';

const STATE = { process: 'flow', phase: 'build', phaseIteration: 1, step: 'code', stepIteration: 1, substep: '', substepIteration: 1, completed: false };
const run = (proceedId: string, quest = 'q'): ProcessRun => ({ quest, state: STATE, proceedId });
const MOVE = { kind: 'proceed' as const, label: 'Proceed', to: 'Build #1 › Gate #1' };
const item = (id: string, status: string, r?: ProcessRun): MarkerQueueItem => ({ id, status, ...(r ? { processRun: r } : {}) });
const marker = (id: string, status: string, r: ProcessRun): MarkerQueueItem => ({ id, status, processRun: r, processMove: MOVE });

describe('process-move marker', () => {
    test('PM-1: where an item goes', () => {
        const items = [item('a', 'sent'), item('p', 'sending', run('r1')), marker('m', 'pending', run('r1')), item('x', 'pending')];
        assert.equal(markerInsertIndex(items, run('r1')), 2, 'before the marker of its run');
        assert.equal(markerInsertIndex(items, run('r2')), -1, 'another run');
        assert.equal(markerInsertIndex(items, undefined), -1, 'no run');
        assert.equal(markerInsertIndex(items, { quest: 'q', state: STATE }), -1, 'a position without a Proceed run');
        assert.equal(markerInsertIndex([marker('m', 'sent', run('r1'))], run('r1')), -1, 'a moved marker takes nothing');
        assert.equal(markerInsertIndex([marker('m', 'error', run('r1'))], run('r1')), 0, 'a held marker still does');
    });

    test('PM-2: the verdict', () => {
        const r = run('r1');
        const m = marker('m', 'pending', r);
        assert.equal(markerVerdict([item('p', 'sent', r), item('t', 'sent', r), m], m), 'move');
        assert.equal(markerVerdict([m], m), 'move', 'no item left (all removed)');
        assert.equal(markerVerdict([item('p', 'sent', r), item('t', 'error', r), m], m), 'held');
        for (const status of ['pending', 'sending', 'waiting', 'retry', 'staged', 'decision-needed', 'interrupted']) {
            assert.equal(markerVerdict([item('p', 'sent', r), item('t', status, r), m], m), 'wait', status);
        }
        assert.equal(markerVerdict([item('o', 'pending', run('r2')), item('n', 'error'), item('p', 'sent', r), m], m), 'move', 'other runs do not count');
        assert.equal(markerVerdict([item('p', 'sent', r), m, item('late', 'pending', r)], m), 'move', 'only items before the marker hold it');
    });

    test('PM-3: the running step', () => {
        const r = run('r1');
        const items = [item('p', 'sent', r), item('t1', 'sending', r), item('t2', 'pending', r), marker('m', 'pending', r), item('x', 'pending')];
        const p = stepRunProgress(items, 'q')!;
        assert.deepEqual([p.markerId, p.proceedId, p.left, p.held, p.move.to], ['m', 'r1', 2, false, 'Build #1 › Gate #1']);
        assert.equal(stepRunProgress(items, 'other'), undefined, 'another quest');
        items[1].status = 'error';
        assert.equal(stepRunProgress(items, 'q')!.held, true, 'an item failed');
        assert.equal(stepRunProgress([item('p', 'sent', r), marker('m', 'error', r)], 'q')!.held, true, 'the marker is held');
        assert.equal(stepRunProgress([item('p', 'sent', r), marker('m', 'sent', r)], 'q'), undefined, 'moved: no step running');
    });

    test('PM-4: open markers, text, ids', () => {
        const items = [marker('a', 'pending', run('r1')), marker('b', 'sent', run('r0')), marker('c', 'error', run('r2')), marker('d', 'pending', run('r3', 'other'))];
        assert.deepEqual(openMarkerIds(items, 'q'), ['a', 'c']);
        assert.equal(markerText(MOVE), '⏭ move the process to Build #1 › Gate #1');
        assert.match(newProceedId(0, 0.5), /^proceed-0-[0-9a-z]+$/);
        assert.notEqual(newProceedId(), newProceedId(Date.now() + 1));
    });
});
