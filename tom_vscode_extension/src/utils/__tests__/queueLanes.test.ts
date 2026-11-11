/**
 * The lanes of the prompt queue (src/utils/queueLanes.ts, vscimpb46: Queue per run).
 *
 *   QL-1 an item's run: its Proceed's, else its own, else `default`; its lane: the run with Queue per run on,
 *        the single lane `''` with it off
 *   QL-2 off: at most the first pending item starts, and only while nothing sends (the queue as it was)
 *   QL-3 on: per lane its first pending item, in queue order; a lane whose first item cannot start waits (its
 *        later items do not jump ahead); a busy lane starts nothing; another lane starts beside it
 *   QL-4 on: two prompts never share a conversation — an item in a session another sending item runs in waits,
 *        and the Copilot transport sends one item at a time; a process-move marker conflicts with nothing
 *   QL-5 on: a held run starts nothing; the hold only applies with Queue per run on
 *   QL-6 the lane summaries: `default` first, every run of the quest and of the items, sending / pending / held;
 *        none with Queue per run off
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    SINGLE_LANE, isLaneHeld, itemRun, laneConflict, laneOf, laneSummaries, pickLaneStarts,
    type LaneItem, type LaneTarget,
} from '../queueLanes';

type It = LaneItem & { session?: string; copilot?: boolean };
const it = (id: string, status: string, run?: string, extra: Partial<It> = {}): It => ({ id, status, ...(run ? { run } : {}), ...extra });
const target = (i: It): LaneTarget => i.copilot ? { transport: 'copilot' } : { transport: 'anthropic', session: i.session ?? `s-${i.id}` };
const on = { perRun: true, heldRuns: [] as string[] };
const off = { perRun: false, heldRuns: [] as string[] };
const ids = (items: It[]): string[] => items.map((i) => i.id);

describe('queue lanes', () => {
    test('QL-1: run and lane', () => {
        assert.equal(itemRun(it('a', 'pending')), 'default');
        assert.equal(itemRun(it('a', 'pending', 'chg1')), 'chg1');
        assert.equal(itemRun(it('a', 'pending', 'chg1', { processRun: { run: 'chg2' } })), 'chg2', 'the Proceed\'s run first');
        assert.equal(laneOf(it('a', 'pending', 'chg1'), true), 'chg1');
        assert.equal(laneOf(it('a', 'pending', 'chg1'), false), SINGLE_LANE);
    });

    test('QL-2: off — one at a time, in order', () => {
        const items = [it('a', 'pending', 'r1'), it('b', 'pending', 'r2')];
        assert.deepEqual(ids(pickLaneStarts(items, off, target)), ['a']);
        assert.deepEqual(ids(pickLaneStarts([it('x', 'sending', 'r9'), ...items], off, target)), [], 'something sends: nothing starts');
        assert.match(laneConflict(items[1], [it('x', 'sending', 'r9')], off, target) ?? '', /x is sending/);
        assert.equal(laneConflict(items[1], [], off, target), undefined);
    });

    test('QL-3: on — one per lane, each lane in order', () => {
        const items = [it('a1', 'pending', 'r1'), it('b1', 'pending', 'r2'), it('a2', 'pending', 'r1'), it('c1', 'pending')];
        assert.deepEqual(ids(pickLaneStarts(items, on, target)), ['a1', 'b1', 'c1'], 'r1, r2 and default; a2 waits behind a1');
        const busy = [it('a0', 'sending', 'r1'), ...items];
        assert.deepEqual(ids(pickLaneStarts(busy, on, target)), ['b1', 'c1'], 'r1 is sending: its items wait, the others go');
        // r1's first item cannot start (its session is taken): r1's later item does not jump ahead.
        const blocked = [it('z', 'sending', 'r2', { session: 'shared' }), it('a1', 'pending', 'r1', { session: 'shared' }), it('a2', 'pending', 'r1')];
        assert.deepEqual(ids(pickLaneStarts(blocked, on, target)), []);
    });

    test('QL-4: on — sessions and the Copilot chat', () => {
        const sameSession = [it('a', 'pending', 'r1', { session: 'work' }), it('b', 'pending', 'r2', { session: 'work' })];
        assert.deepEqual(ids(pickLaneStarts(sameSession, on, target)), ['a'], 'b waits for session work');
        assert.match(laneConflict(sameSession[1], [it('a', 'sending', 'r1', { session: 'work' })], on, target) ?? '', /session work is busy with a/);
        const copilot = [it('a', 'pending', 'r1', { copilot: true }), it('b', 'pending', 'r2', { copilot: true }), it('c', 'pending', 'r3')];
        assert.deepEqual(ids(pickLaneStarts(copilot, on, target)), ['a', 'c'], 'one Copilot item at a time');
        assert.match(laneConflict(copilot[1], [it('a', 'sending', 'r1', { copilot: true })], on, target) ?? '', /Copilot chat is busy/);
        const marker = it('m', 'pending', 'r2', { processMove: { to: 'next' }, copilot: true });
        assert.deepEqual(ids(pickLaneStarts([it('a', 'sending', 'r1', { copilot: true }), marker], on, target)), ['m'], 'a marker sends no prompt');
    });

    test('QL-5: on — a held run', () => {
        const items = [it('a', 'pending', 'r1'), it('b', 'pending', 'r2')];
        const held = { perRun: true, heldRuns: ['r1'] };
        assert.deepEqual(ids(pickLaneStarts(items, held, target)), ['b']);
        assert.equal(isLaneHeld(items[0], held), true);
        assert.equal(isLaneHeld(items[0], { perRun: false, heldRuns: ['r1'] }), false, 'off: no hold');
        assert.deepEqual(ids(pickLaneStarts(items, { perRun: false, heldRuns: ['r1'] }, target)), ['a']);
    });

    test('QL-6: the lane summaries', () => {
        const items = [it('a', 'sending', 'r2'), it('b', 'pending', 'r2'), it('c', 'pending'), it('d', 'sent', 'r9'), it('e', 'pending', 'r3')];
        assert.deepEqual(laneSummaries(items, ['default', 'r1', 'r2'], { perRun: true, heldRuns: ['r1'] }), [
            { run: 'default', sending: 0, pending: 1, held: false },
            { run: 'r1', sending: 0, pending: 0, held: true },
            { run: 'r2', sending: 1, pending: 1, held: false },
            { run: 'r3', sending: 0, pending: 1, held: false },
        ]);
        assert.deepEqual(laneSummaries(items, ['default'], off), []);
    });
});
