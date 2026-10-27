/**
 * A `<prefix>*` walk and the todos that are the user's to do (`user_action: true`
 * in the todo file, `userAction` here).
 *
 * Such a todo is work only a person can do — looking at a screen, answering
 * questions. Sent to an agent it can only be prepared and reported, and while it
 * stays `not-started` the walk picks it again on every pass, so a series loops
 * on it. The walk therefore skips it and goes on with the next todo; the todo
 * stays `not-started` and waits for the user.
 *
 *   UA-1 a user-action todo is never picked; the next todo of the series is
 *   UA-2 the plan names the user-action todos it passed (todo mode and exhausted)
 *   UA-3 a series of only user-action todos is exhausted, not looped on
 *   UA-4 the plan stays as it was for a series without one (no empty list added)
 *   UA-5 an unmade decision still holds the series, user-action todo or not
 *   UA-6 only `not-started` user-action todos are reported as waiting
 *   UA-7 work that has to wait for the user (e.g. a check after the user reloads the window): a user-action
 *        todo, and the work `blocked` with `blocked_by` naming it. The walk passes both until the user
 *        completes the user-action todo; then the blocked one is released and sent
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { collectPrefixTodos, pickNextTodoForIteration, planMainStageDispatch, todosToUnblock } from '../queueStep3Utils.js';

function t(id: string, status?: string, userAction?: boolean) {
    return { id, status, ...(userAction ? { userAction } : {}) };
}

describe('prefix walk: user-action todos', () => {
    test('UA-1: skipped by the pick', () => {
        const todos = [t('vbs1', 'completed'), t('vbs3', 'not-started', true), t('vbs4', 'not-started')];
        assert.equal(pickNextTodoForIteration('vbs*', todos)?.id, 'vbs4');
        assert.equal(collectPrefixTodos('vbs', todos)[1].userAction, true, 'the entry carries the mark');
        const plan = planMainStageDispatch('vbs*', 0, 4, todos);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'vbs4');
    });

    test('UA-2: the plan names the ones it passed', () => {
        const todos = [t('vbs3', 'not-started', true), t('vbs4', 'not-started'), t('vbs5', 'not-started', true)];
        const plan = planMainStageDispatch('vbs*', 0, 5, todos);
        assert.equal(plan.mode, 'todo');
        assert.deepEqual(plan.mode === 'todo' && plan.waitingForUser?.map((e) => e.id), ['vbs3', 'vbs5']);
        const done = planMainStageDispatch('vbs*', 1, 5, [t('vbs3', 'not-started', true), t('vbs4', 'in-progress')]);
        assert.equal(done.mode, 'exhausted');
        assert.deepEqual(done.mode === 'exhausted' && done.waitingForUser?.map((e) => e.id), ['vbs3']);
    });

    test('UA-3: only user-action todos left — exhausted, never looped on', () => {
        const todos = [t('vbs3', 'not-started', true)];
        assert.equal(pickNextTodoForIteration('vbs*', todos), undefined);
        assert.equal(planMainStageDispatch('vbs*', 0, 3, todos).mode, 'exhausted');
    });

    test('UA-4: unchanged without one', () => {
        assert.deepEqual(planMainStageDispatch('vbs*', 0, 1, [t('vbs1', 'completed')]), { mode: 'exhausted' });
        const plan = planMainStageDispatch('vbs*', 0, 1, [t('vbs1', 'not-started')]);
        assert.deepEqual(Object.keys(plan).sort(), ['mode', 'todo']);
    });

    test('UA-5: an unmade decision still holds the series', () => {
        const plan = planMainStageDispatch('vbs*', 0, 4, [t('vbs3', 'decision-needed', true), t('vbs4', 'not-started')]);
        assert.equal(plan.mode, 'decision-needed');
    });

    test('UA-6: only not-started ones wait for the user', () => {
        const plan = planMainStageDispatch('vbs*', 0, 4, [t('vbs2', 'completed', true), t('vbs3', 'blocked', true), t('vbs4', 'not-started')]);
        assert.deepEqual(Object.keys(plan).sort(), ['mode', 'todo']);
    });

    test('UA-7: waiting for the user through blocked_by', () => {
        const reload = { id: 'vbs5', status: 'not-started', userAction: true };
        const check = { id: 'vbs6', status: 'blocked', blockedBy: ['vbs5'] };
        const before = [reload, check];
        const lookup = (todos: Array<{ id: string; status: string }>) => (ref: string) => todos.find((x) => x.id === ref);
        const plan = planMainStageDispatch('vbs*', 0, 6, before);
        assert.equal(plan.mode, 'exhausted', 'nothing is sent while the user has not acted');
        assert.deepEqual(plan.mode === 'exhausted' && plan.waitingForUser?.map((e) => e.id), ['vbs5']);
        assert.deepEqual(todosToUnblock('vbs*', before, lookup(before)), [], 'the check stays blocked');
        const after = [{ ...reload, status: 'completed' }, check];
        assert.deepEqual(todosToUnblock('vbs*', after, lookup(after)).map((u) => u.id), ['vbs6'], 'released once the user is done');
        const next = planMainStageDispatch('vbs*', 0, 6, [after[0], { ...check, status: 'not-started' }]);
        assert.equal(next.mode === 'todo' && next.todo.id, 'vbs6');
    });
});
