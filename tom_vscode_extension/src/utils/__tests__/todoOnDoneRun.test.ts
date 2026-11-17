/**
 * Carrying out a completed todo's `on_done`: the plan (utils/todoOnDoneRun.ts; ww_a_collab-5).
 *
 *   OR-1 unblock: the entry naming the todo leaves each target's blocked_by (bare id in the same quest,
 *        `<quest>/<id>` across quests); a blocked target with nothing else blocking becomes not-started,
 *        decision-needed with an open decision, stays blocked with another blocker or a blocked_until
 *   OR-2 notify: notify_prompt, else the configured template, else none (no built-in text); its placeholders
 *        filled (escaped); into the queuing run and session (queuedBy), not sent without one
 *   OR-3 queue: each target with the group prompt, its walk placeholders filled and its record appended
 *   OR-4 skips: done targets (completed, cancelled, archived) skipped silently; a missing or deleted target
 *        skipped with a notes line; no on_done → nothing; none → nothing
 *   OR-5 when: a completion is `completed` asked for a todo not completed before (a repeated todo too); the
 *        queue's settle runs it when it was left to it or the todo is completed now
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fillTodoPlaceholders, isCompletion, onDoneDueAtSettle, planOnDoneRun,
    type OnDoneContext, type OnDoneTarget,
} from '../todoOnDoneRun';

const target = (status: string, extra: Partial<OnDoneTarget> = {}): OnDoneTarget =>
    ({ status, where: 'live', record: { id: 'x', status }, ...extra });

function ctx(todos: Record<string, OnDoneTarget>, extra: Partial<OnDoneContext> = {}): OnDoneContext {
    return {
        quest: 'q', run: 'r1', today: '2026-11-15',
        findTodo: (quest, id) => todos[`${quest}/${id}`],
        groupPrompt: () => 'Do ${repeatTodoId} — ${repeatTodoTitle} (todo ${repeatNumber}, quest ${quest}).',
        ...extra,
    };
}

describe('planOnDoneRun', () => {
    test('OR-1: unblock', () => {
        const todos = {
            'q/a': target('blocked', { blocked_by: ['n1'] }),
            'q/b': target('blocked', { blocked_by: ['n1', 'other'] }),
            'q/c': target('blocked', { blocked_by: ['n1'], decisions: [{ decision: '' }] }),
            'q/d': target('blocked', { blocked_by: ['n1'], blocked_until: ['tom_x >= 1.0.0'] }),
            'q/e': target('not-started', { blocked_by: ['n1'] }),
            'r/f': target('blocked', { blocked_by: ['q/n1'] }),
        };
        const plan = planOnDoneRun({ id: 'n1', on_done: { todos: ['a', 'b', 'c', 'd', 'e'], action: ['unblock'] } }, ctx(todos));
        assert.deepEqual(plan.unblock, [
            { quest: 'q', id: 'a', blockedBy: [], status: 'not-started' },
            { quest: 'q', id: 'b', blockedBy: ['other'] },
            { quest: 'q', id: 'c', blockedBy: [], status: 'decision-needed' },
            { quest: 'q', id: 'd', blockedBy: [] },
            { quest: 'q', id: 'e', blockedBy: [] },
        ]);
        const cross = planOnDoneRun({ id: 'n1', on_done: { quest: 'r', todos: ['f'], action: ['unblock'] } }, ctx(todos));
        assert.deepEqual(cross.unblock, [{ quest: 'r', id: 'f', blockedBy: [], status: 'not-started' }]);
        assert.deepEqual(planOnDoneRun({ id: 'zz', on_done: { todos: ['e'], action: ['unblock'] } }, ctx(todos)).unblock, [],
            'no entry for this todo and nothing to release: no write');
    });

    test('OR-2: notify', () => {
        const by = { quest: 'p', run: 'chg3', session: 'work' };
        const done = { id: 'n1', title: 'Wire ${x}', last_answer: 'All ${green}.', on_done: { quest: 'r', run: 'other', action: ['notify' as const], notify_prompt: 'Report ${todoId} (${todoTitle}) for ${senderRun}: ${itemAnswer}, to ${reportTo}', report_to: 'ideas/a.md#todos' } };
        const plan = planOnDoneRun(done, ctx({}, { queuedBy: by }));
        assert.deepEqual(plan.notify, { quest: 'p', run: 'chg3', session: 'work', text: 'Report n1 (Wire $${x}) for r1: All $${green}., to ideas/a.md#todos' },
            'into the queuing run and session, not on_done\'s quest and run; values escaped');
        const noSession = planOnDoneRun(done, ctx({}, { queuedBy: { quest: 'q', run: 'default' } }));
        assert.deepEqual([noSession.notify?.quest, noSession.notify?.run, noSession.notify?.session], ['q', 'default', undefined], 'no session: the run\'s queue default');
        const unknown = planOnDoneRun(done, ctx({}));
        assert.equal(unknown.notify, undefined, 'no queuing session: not sent (the own queue and run are no fallback)');
        assert.match(unknown.notifyNotSent ?? '', /no queuing session/);
        const bare = { ...done, on_done: { action: ['notify' as const] } };
        const none = planOnDoneRun(bare, ctx({}, { queuedBy: by }));
        assert.equal(none.notify, undefined, 'no notify_prompt and no template: no notification (no built-in text)');
        assert.match(none.notifyNotSent ?? '', /no done-notification template/);
        const templated = planOnDoneRun(bare, ctx({}, { queuedBy: by, notifyTemplate: 'T ${todoId} ${todoStatus}: ${itemAnswer}' }));
        assert.equal(templated.notify?.text, 'T n1 completed: All $${green}.', 'the configured template');
        assert.match(fillTodoPlaceholders('${itemAnswer}', { id: 'n2' }, { quest: 'q', run: 'r' }), /\(no answer recorded\)/);
    });

    test('OR-3: queue', () => {
        const todos = { 'r/t1': target('not-started', { title: 'First', record: { id: 't1', description: 'd' }, sourceFile: 'todos.r.todo.yaml' }) };
        const plan = planOnDoneRun({ id: 'n1', on_done: { quest: 'r', run: 'chg7', todos: ['t1'], action: ['queue'] } }, ctx(todos));
        assert.equal(plan.queue.length, 1);
        assert.equal(plan.queue[0].quest, 'r');
        assert.equal(plan.queue[0].run, 'chg7');
        assert.equal(plan.queue[0].todoId, 't1');
        assert.match(plan.queue[0].text, /^Do t1 — First \(todo 1, quest r\)\./);
        assert.match(plan.queue[0].text, /Here is the complete YAML of the todo:/);
        assert.match(plan.queue[0].text, /# todos\.r\.todo\.yaml\nid: t1/);
        assert.equal(plan.notify, undefined, 'queue sends no notification');
    });

    test('OR-4: skips', () => {
        const todos = {
            'q/c1': target('completed'), 'q/x1': target('cancelled'),
            'q/a1': target('not-started', { where: 'archived' }), 'q/d1': target('not-started', { where: 'deleted' }),
        };
        const plan = planOnDoneRun({ id: 'n1', on_done: { todos: ['c1', 'x1', 'a1', 'd1', 'gone1'], action: ['unblock', 'queue'] } }, ctx(todos));
        assert.deepEqual(plan.unblock, []);
        assert.deepEqual(plan.queue, []);
        assert.equal(plan.skipped.length, 3);
        assert.deepEqual(plan.notes, [
            '[on_done 2026-11-15] q/d1 was deleted; skipped.',
            '[on_done 2026-11-15] q/gone1 does not exist; skipped.',
        ], 'one line per target, though two actions name it');
        assert.deepEqual(planOnDoneRun({ id: 'n1' }, ctx({})), { unblock: [], queue: [], notes: [], skipped: [] });
        assert.deepEqual(planOnDoneRun({ id: 'n1', on_done: { action: ['none'], instructions: 'x' } }, ctx({})).notify, undefined);
    });

    test('OR-5: when it runs', () => {
        assert.equal(isCompletion({ status: 'in-progress' }, 'completed'), true);
        assert.equal(isCompletion({ status: 'waiting-for-repeat' }, 'completed'), true, 'a repeated todo again');
        assert.equal(isCompletion({ status: 'completed' }, 'completed'), false, 'saved again: no second run');
        assert.equal(isCompletion({ status: 'in-progress' }, 'blocked'), false);
        assert.equal(onDoneDueAtSettle(true, 'waiting-for-repeat'), true, 'left to the queue');
        assert.equal(onDoneDueAtSettle(false, 'completed'), true, 'completed by hand during the walk');
        assert.equal(onDoneDueAtSettle(false, 'in-progress'), false);
    });
});
