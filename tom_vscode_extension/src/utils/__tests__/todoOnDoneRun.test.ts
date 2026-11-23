/**
 * Carrying out a completed todo's `on_done`: the plan (utils/todoOnDoneRun.ts; ww_a_collab-5).
 *
 *   OR-1 unblock: each waiting target (blocked, not-started, decision-needed, group) is set free — a group todo to
 *        `group`, else `not-started`, `decision-needed` with an open decision — whatever else blocks it (blocked_by,
 *        blocked_until); its blocked_by is not touched; targets of another quest by `<quest>/<id>`; one already at
 *        its free status is not written; an in-progress or waiting-for-repeat target is passed over
 *   OR-2 the done notification: the notify prompt, sent next in the run and session that queued the todo, also
 *        without `notify`; without a notify prompt the template only when the queuing panel had its bell on
 *        (`withTemplate`); without a queuing run not sent; placeholders filled (escaped)
 *   OR-3 notify filed-by: the notification goes to the filed-by quest and run (the run's default session), the
 *        template allowed; without a filed-by quest not sent
 *   OR-4 instructions: sent next to on_done quest / run (unset: the own quest and the completing run), the run's
 *        default session, with a header naming the todo, the instructions (placeholders filled) and its answer
 *   OR-5 skips: done and archived targets passed over; a missing or deleted target with a notes line; no on_done
 *        and no template → nothing
 *   OR-6 when: a completion is `completed` asked for a todo not completed before (a repeated todo too); the queue's
 *        settle runs it when it was left to it or the todo is completed now
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fillTodoPlaceholders, instructionsPrompt, isCompletion, onDoneDueAtSettle, planOnDoneRun, unblockedStatus,
    type OnDoneContext, type OnDoneTarget,
} from '../todoOnDoneRun';

const target = (status: string, extra: Partial<OnDoneTarget> = {}): OnDoneTarget => ({ status, where: 'live', ...extra });

function ctx(todos: Record<string, OnDoneTarget>, extra: Partial<OnDoneContext> = {}): OnDoneContext {
    return { quest: 'q', run: 'r1', today: '2026-11-15', findTodo: (quest, id) => todos[`${quest}/${id}`], ...extra };
}

describe('planOnDoneRun', () => {
    test('OR-1: unblock', () => {
        const todos = {
            'q/a': target('blocked'),
            'q/b': target('blocked'),
            'q/c': target('blocked', { decisions: [{ decision: '' }] }),
            'q/d': target('decision-needed', { decisions: [{ decision: 'yes' }] }),
            'q/e': target('not-started'),
            'q/g': target('blocked', { group: true }),
            'q/h': target('in-progress'),
            'q/w': target('waiting-for-repeat'),
            'r/f': target('blocked'),
        };
        const plan = planOnDoneRun({ id: 'n1', on_done: { todos: ['a', 'b', 'c', 'd', 'e', 'g', 'h', 'w', 'r/f'], action: ['unblock'] } }, ctx(todos));
        assert.deepEqual(plan.unblock, [
            { quest: 'q', id: 'a', status: 'not-started' },
            { quest: 'q', id: 'b', status: 'not-started' },
            { quest: 'q', id: 'c', status: 'decision-needed' },
            { quest: 'q', id: 'd', status: 'not-started' },
            { quest: 'q', id: 'g', status: 'group' },
            { quest: 'r', id: 'f', status: 'not-started' },
        ], 'set free whatever else blocks them; not-started e is not written');
        assert.deepEqual(plan.skipped, ['h (in-progress)', 'w (waiting-for-repeat)']);
        assert.equal('blockedBy' in plan.unblock[0], false, 'blocked_by is not touched');
        assert.equal(unblockedStatus(target('blocked', { group: true, decisions: [{}] })), 'group');
        assert.deepEqual(planOnDoneRun({ id: 'n1', on_done: { todos: ['a'], action: ['notify'] } }, ctx(todos)).unblock, [], 'without unblock nothing');
    });

    test('OR-2: the done notification to the queuing run', () => {
        const by = { quest: 'p', run: 'chg3', session: 'work' };
        const done = { id: 'n1', title: 'Wire ${x}', last_answer: 'All ${green}.', on_done: { notify_prompt: 'Report ${todoId} (${todoTitle}) for ${senderRun}: ${itemAnswer}, to ${reportTo}', report_to: 'ideas/a.md#todos' } };
        const plan = planOnDoneRun(done, ctx({}, { queuedBy: by }));
        assert.deepEqual(plan.notify, { quest: 'p', run: 'chg3', session: 'work', text: 'Report n1 (Wire $${x}) for r1: All $${green}., to ideas/a.md#todos', next: true },
            'a notify prompt is sent without the checkbox, next in the queuing run and session; values escaped');
        const noSession = planOnDoneRun(done, ctx({}, { queuedBy: { quest: 'q', run: 'default' } }));
        assert.deepEqual([noSession.notify?.quest, noSession.notify?.run, noSession.notify?.session], ['q', 'default', undefined]);
        const unknown = planOnDoneRun(done, ctx({}));
        assert.equal(unknown.notify, undefined, 'no queuing run: not sent');
        assert.match(unknown.notifyNotSent ?? '', /no queuing run/);
        const bare = { id: 'n1', last_answer: 'All ${green}.' };
        const template = 'T ${todoId} ${todoStatus}: ${itemAnswer}';
        assert.equal(planOnDoneRun(bare, ctx({}, { queuedBy: by, notifyTemplate: template })).notify, undefined,
            'no notify prompt and the bell was off: no template');
        const belled = planOnDoneRun(bare, ctx({}, { queuedBy: { ...by, withTemplate: true }, notifyTemplate: template }));
        assert.equal(belled.notify?.text, 'T n1 completed: All $${green}.', 'the bell was on: the template, also without an on_done block');
        assert.equal(planOnDoneRun(bare, ctx({}, { queuedBy: { ...by, withTemplate: true } })).notify, undefined, 'no template configured');
        assert.match(fillTodoPlaceholders('${itemAnswer}', { id: 'n2' }, { quest: 'q', run: 'r' }), /\(no answer recorded\)/);
    });

    test('OR-3: notify filed-by', () => {
        const by = { quest: 'p', run: 'chg3', session: 'work' };
        const filed_by = { quest: 'idea', run: 'collab', session: 'once', todo: 'i3' };
        const plan = planOnDoneRun({ id: 'n1', filed_by, on_done: { action: ['notify'], notify_prompt: 'Done ${todoId}' } }, ctx({}, { queuedBy: by }));
        assert.deepEqual(plan.notify, { quest: 'idea', run: 'collab', text: 'Done n1', next: true }, 'the filed-by quest and run, its default session');
        const templated = planOnDoneRun({ id: 'n1', filed_by, on_done: { action: ['notify'] } }, ctx({}, { notifyTemplate: 'T ${todoId}' }));
        assert.equal(templated.notify?.text, 'T n1', 'with notify the template is allowed');
        const noFiler = planOnDoneRun({ id: 'n1', on_done: { action: ['notify'], notify_prompt: 'x' } }, ctx({}, { queuedBy: by }));
        assert.equal(noFiler.notify, undefined);
        assert.match(noFiler.notifyNotSent ?? '', /filed-by quest/);
        assert.match(planOnDoneRun({ id: 'n1', filed_by, on_done: { action: ['notify'] } }, ctx({})).notifyNotSent ?? '', /no notify_prompt/);
    });

    test('OR-4: instructions', () => {
        const todo = { id: 'n1', title: 'Wire it', last_answer: 'Done: 3 files.', on_done: { instructions: 'Update ${todoId} in the index.' } };
        const plan = planOnDoneRun(todo, ctx({}));
        assert.equal(plan.instructions?.quest, 'q');
        assert.equal(plan.instructions?.run, 'r1', 'unset: the run the todo was completed in');
        assert.equal(plan.instructions?.next, true);
        assert.equal('session' in (plan.instructions ?? {}), false, 'the run\'s default session');
        assert.equal(plan.instructions?.text, instructionsPrompt(todo, { quest: 'q', run: 'r1' }));
        assert.match(plan.instructions?.text ?? '', /^The todo `q\/n1` — Wire it was completed \(run r1\)\. Its After done sends you these instructions:\n\nUpdate n1 in the index\.\n\nThe answer the todo was completed with:\n\nDone: 3 files\.\n$/);
        const elsewhere = planOnDoneRun({ ...todo, on_done: { ...todo.on_done, quest: 'other', run: 'x' } }, ctx({}));
        assert.deepEqual([elsewhere.instructions?.quest, elsewhere.instructions?.run], ['other', 'x']);
        assert.equal(planOnDoneRun({ id: 'n1', on_done: { instructions: '  ' } }, ctx({})).instructions, undefined);
    });

    test('OR-5: skips', () => {
        const todos = {
            'q/c1': target('completed'), 'q/x1': target('cancelled'),
            'q/a1': target('not-started', { where: 'archived' }), 'q/d1': target('blocked', { where: 'deleted' }),
        };
        const plan = planOnDoneRun({ id: 'n1', on_done: { todos: ['c1', 'x1', 'a1', 'd1', 'gone1'], action: ['unblock'] } }, ctx(todos));
        assert.deepEqual(plan.unblock, []);
        assert.deepEqual(plan.skipped, ['c1 (completed)', 'x1 (cancelled)', 'a1 (archived)']);
        assert.deepEqual(plan.notes, [
            '[on_done 2026-11-15] q/d1 was deleted; not unblocked.',
            '[on_done 2026-11-15] q/gone1 does not exist; not unblocked.',
        ]);
        assert.deepEqual(planOnDoneRun({ id: 'n1' }, ctx({})), { unblock: [], notes: [], skipped: [] });
    });

    test('OR-6: when it runs', () => {
        assert.equal(isCompletion({ status: 'in-progress' }, 'completed'), true);
        assert.equal(isCompletion({ status: 'waiting-for-repeat' }, 'completed'), true, 'a repeated todo again');
        assert.equal(isCompletion({ status: 'completed' }, 'completed'), false, 'saved again: no second run');
        assert.equal(isCompletion({ status: 'in-progress' }, 'blocked'), false);
        assert.equal(onDoneDueAtSettle(true, 'waiting-for-repeat'), true, 'left to the queue');
        assert.equal(onDoneDueAtSettle(false, 'completed'), true, 'completed by hand during the walk');
        assert.equal(onDoneDueAtSettle(false, 'in-progress'), false);
    });
});
