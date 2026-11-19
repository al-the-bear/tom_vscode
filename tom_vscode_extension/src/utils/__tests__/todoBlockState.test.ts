/**
 * Whether a todo is blocked right now, what a group waits for outside itself, and the walk's hold at a blocked
 * todo (src/utils/todoBlockState.ts, src/utils/queueStep3Utils.ts blockHoldingWalk / planMainStageDispatch).
 *
 *   BS-1 the block state: an unmet `blocked_by` entry blocks (an open todo, an unknown id, prose), a met one does
 *        not; status `blocked` with every entry met is releasable (its blockers were completed in the meantime);
 *        `blocked` with nothing named, or with a `blocked_until`, stays blocked; the reason names what it waits for
 *   BS-2 a group's blockers outside the group: unmet entries of its open members naming no member; blockers
 *        inside the group and done members are left out; `queuedAhead` marks a blocker the queue already holds
 *   BS-3 the question before queueing: the members, each blocker with its state, and what will happen
 *   BS-4 the walk: a blocked todo holds it when it is next (plan `todo-blocked`), not while todos before it are
 *        open; a decision before it holds first; a checked GROUP member is sent although blocked, the user's own
 *        todo is passed; a series of only blocked todos is not empty
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { outsideBlockers, outsideBlockersQuestion, todoBlockState } from '../todoBlockState.js';
import { blockHoldingWalk, decisionHoldingWalk, emptyTodoIterationReason, pickNextTodoForIteration, planMainStageDispatch, type TodoIterationSource } from '../queueStep3Utils.js';
import type { StatusLookup } from '../todoBlockingCascade.js';

const QUESTS = new Set(['qa', 'qb']);
const table: Record<string, string> = { 'qa/open1': 'in-progress', 'qa/done1': 'completed', 'qa/gone1': 'cancelled', 'qb/far1': 'not-started', 'qb/fardone1': 'completed', 'qa/m1': 'not-started', 'qa/m2': 'not-started' };
const statusOf: StatusLookup = (quest, id) => table[`${quest}/${id}`];
const state = (todo: { status?: string; blocked_by?: string[]; blocked_until?: string[] }) => todoBlockState({ id: 't1', ...todo }, 'qa', statusOf, QUESTS);

describe('whether a todo is blocked', () => {
    test('BS-1: the block state', () => {
        assert.deepEqual(state({ status: 'not-started' }), { blocked: false, open: [], met: [], releasable: false, reason: '' });
        // An open blocker, in the quest and in another.
        const open = state({ status: 'not-started', blocked_by: ['open1', 'done1', 'qb/far1'] });
        assert.deepEqual([open.blocked, open.open, open.met, open.releasable], [true, ['open1', 'qb/far1'], ['done1'], false]);
        assert.equal(open.reason, 'waits for open1 (in-progress), qb/far1 (not-started)');
        // Completed or cancelled blockers do not block, whatever the status says.
        assert.deepEqual(state({ status: 'not-started', blocked_by: ['done1', 'gone1', 'qb/fardone1'] }).blocked, false);
        const releasable = state({ status: 'blocked', blocked_by: ['done1', 'gone1'] });
        assert.deepEqual([releasable.blocked, releasable.releasable, releasable.reason], [false, true, ''], 'its blockers were completed in the meantime');
        // Nothing that can be read is not met: an unknown id, a bare quest name.
        assert.equal(state({ status: 'not-started', blocked_by: ['nothing9'] }).reason, 'waits for nothing9 (not found)');
        assert.equal(state({ status: 'not-started', blocked_by: ['qb'] }).reason, 'waits for qb (not found)');
        // Blocked with nothing named, or by a version condition.
        assert.deepEqual([state({ status: 'blocked' }).blocked, state({ status: 'blocked' }).reason], [true, 'is blocked (its status says so; no `blocked_by` names why)']);
        const until = state({ status: 'blocked', blocked_by: ['done1'], blocked_until: ['tom_x >= 2.0.0'] });
        assert.deepEqual([until.blocked, until.releasable, until.reason], [true, false, 'is blocked until tom_x >= 2.0.0']);
        assert.equal(state({ status: 'Blocked', blocked_by: ['open1'] }).blocked, true, 'the status is read as written by hand');
    });

    test('BS-2: a group\'s blockers outside the group', () => {
        const members = [
            { id: 'm1', status: 'not-started', blocked_by: ['open1', 'm2', 'done1'] },
            { id: 'm2', status: 'blocked', blocked_by: ['qb/far1', 'nothing9'] },
            { id: 'm3', status: 'completed', blocked_by: ['open1'] },
            { id: 'm4', status: 'not-started' },
        ];
        assert.deepEqual(outsideBlockers(members, 'qa', statusOf, QUESTS), [
            { member: 'm1', entry: 'open1', quest: 'qa', id: 'open1', status: 'in-progress' },
            { member: 'm2', entry: 'qb/far1', quest: 'qb', id: 'far1', status: 'not-started' },
            { member: 'm2', entry: 'nothing9', quest: 'qa', id: 'nothing9' },
        ], 'not the blocker inside the group (m2), not a met one, not a done member\'s');
        const ahead = outsideBlockers(members, 'qa', statusOf, QUESTS, (quest, id) => quest === 'qa' && id === 'open1');
        assert.equal(ahead[0].queuedAhead, true);
        assert.equal(ahead[1].queuedAhead, undefined);
        assert.deepEqual(outsideBlockers([{ id: 'm1', status: 'not-started', blocked_by: ['m2'] }, { id: 'm2', status: 'not-started' }], 'qa', statusOf, QUESTS), [], 'dependencies inside the group are the walk\'s own order');
        assert.deepEqual(outsideBlockers([], 'qa', statusOf, QUESTS), []);
    });

    test('BS-3: the question before queueing', () => {
        const blockers = outsideBlockers([{ id: 'm1', status: 'not-started', blocked_by: ['open1', 'nothing9'] }, { id: 'm2', status: 'not-started', blocked_by: ['qb/far1'] }], 'qa', statusOf, QUESTS,
            (_q, id) => id === 'far1');
        const q = outsideBlockersQuestion('The walk over m*', blockers);
        assert.equal(q.message, 'The walk over m*: 2 todos are blocked by todos outside it. Queue it anyway?');
        assert.deepEqual(q.detail.split('\n'), [
            '• m1 waits for open1 (in-progress)',
            '• m1 waits for nothing9 (not found)',
            '• m2 waits for qb/far1 (already in the queue ahead)',
            '',
            'A todo still blocked when the walk reaches it holds the item (item blocked) until its blocker is completed.',
        ]);
        const one = outsideBlockersQuestion('The group g1', blockers.filter((b) => b.queuedAhead));
        assert.equal(one.message, 'The group g1: todo m2 is blocked by todos outside it. Queue it anyway?');
        assert.match(one.detail, /Each blocker is in the queue ahead: when it is completed before the walk reaches the todo, the walk goes on\.$/);
    });

    test('BS-4: the walk holds at a blocked todo', () => {
        const t = (id: string, status: string, extra: Partial<TodoIterationSource> = {}): TodoIterationSource => ({ id, status, ...extra });
        const why = 'waits for gate1 (in-progress)';
        // Next in the series: held.
        const first = [t('w1_x', 'not-started', { blockedReason: why }), t('w2_x', 'not-started')];
        assert.deepEqual(blockHoldingWalk('w*', first).map((e) => [e.id, e.blockedReason]), [['w1_x', why]]);
        assert.deepEqual(planMainStageDispatch('w*', 0, 2, first), { mode: 'todo-blocked', todos: blockHoldingWalk('w*', first) });
        assert.equal(pickNextTodoForIteration('w*', first)?.id, 'w2_x', 'the pick alone would pass it; the plan holds first');
        // Further down: the todo before it runs.
        const later = [t('w1_x', 'not-started'), t('w2_x', 'blocked', { blockedReason: why })];
        assert.deepEqual(blockHoldingWalk('w*', later), []);
        assert.equal((planMainStageDispatch('w*', 0, 2, later) as { todo?: { id: string } }).todo?.id, 'w1_x');
        // Once the first is in progress, the walk has reached it.
        assert.equal(planMainStageDispatch('w*', 1, 2, [t('w1_x', 'in-progress'), later[1]]).mode, 'todo-blocked');
        // A decision before it holds first; a blocked todo before a decision holds first.
        const decisionFirst = [t('w1_x', 'decision-needed'), t('w2_x', 'not-started', { blockedReason: why })];
        assert.equal(planMainStageDispatch('w*', 0, 2, decisionFirst).mode, 'decision-needed');
        const blockedFirst = [t('w1_x', 'not-started', { blockedReason: why }), t('w2_x', 'decision-needed')];
        assert.deepEqual(decisionHoldingWalk('w*', blockedFirst), []);
        assert.equal(planMainStageDispatch('w*', 0, 2, blockedFirst).mode, 'todo-blocked');
        // Without a reason (the caller found nothing blocking) a todo marked blocked is passed, as before.
        assert.equal(planMainStageDispatch('w*', 0, 2, [t('w1_x', 'blocked'), t('w2_x', 'not-started')]).mode, 'todo');
        // A checked GROUP member is sent although blocked; an unchecked one holds nothing; the user's own is passed.
        assert.deepEqual(blockHoldingWalk('w*', [t('w1_x', 'not-started', { blockedReason: why, userAction: true }), t('w2_x', 'not-started')]), []);
        const group = [t('g1', 'group', { comprisedOf: ['a1', 'a2'] }), t('a1', 'not-started', { blockedReason: why, forced: true }), t('a2', 'not-started', { blockedReason: why, excluded: true })];
        assert.deepEqual(blockHoldingWalk('group:q1/g1', group), []);
        assert.equal(pickNextTodoForIteration('group:q1/g1', group)?.id, 'a1');
        assert.deepEqual(blockHoldingWalk('group:q1/g1', [group[0], t('a1', 'not-started', { blockedReason: why }), t('a2', 'not-started')]).map((e) => e.id), ['a1']);
        assert.deepEqual(blockHoldingWalk('todo:q1/a1', [t('a1', 'blocked', { blockedReason: why })]).map((e) => e.id), ['a1']);
        // A series of only blocked todos has something to do: the walk holds, it does not end in error.
        assert.equal(emptyTodoIterationReason('w*', [t('w1_x', 'not-started', { blockedReason: why })], 'q1'), undefined);
        assert.deepEqual(blockHoldingWalk(3, first), [], 'a count is no walk');
    });
});
