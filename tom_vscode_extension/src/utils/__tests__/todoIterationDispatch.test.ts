/**
 * Tests for the main-stage dispatch gate — the decision "is there another
 * main prompt to send, and what drives it".
 *
 * Two modes share one gate:
 *
 * - **counter** — the classic behaviour. A numeric (or variable-resolved)
 *   repeat count; send while `sentCount < repeatCount`.
 * - **todo iteration** — triggered by a `<prefix>*` repeat count. The repeat
 *   count becomes display-only (the size of the series); what actually drives
 *   the loop is whether a `not-started` todo is still left. Since the
 *   dispatcher marks the picked todo `in-progress`, the candidate set shrinks
 *   on every pass and the loop terminates.
 *
 * The gate is pure so both modes can be pinned without the vscode-coupled
 * PromptQueueManager.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { planMainStageDispatch } from '../queueStep3Utils.js';

/** Terse fixture builder: `t('dsa2', 'not-started', 'Fix the thing')`. */
function t(id: string, status?: string, title?: string) {
    return { id, status, title };
}

describe('planMainStageDispatch — counter mode', () => {
    test('dispatches while the sent count is below the repeat count', () => {
        assert.deepEqual(planMainStageDispatch(3, 0, 3, []), { mode: 'counter', repeatIndex: 0 });
        assert.deepEqual(planMainStageDispatch(3, 2, 3, []), { mode: 'counter', repeatIndex: 2 });
    });

    test('is exhausted once the sent count reaches the repeat count', () => {
        assert.deepEqual(planMainStageDispatch(3, 3, 3, []), { mode: 'exhausted' });
    });

    test('a non-prefix string repeat count still counts — todos are ignored', () => {
        // `batchCount` is a chat variable; it was already resolved into the
        // repeat count, so the todos must not influence the gate.
        assert.deepEqual(
            planMainStageDispatch('batchCount', 1, 2, [t('dsa1', 'not-started')]),
            { mode: 'counter', repeatIndex: 1 },
        );
    });
});

describe('planMainStageDispatch — todo iteration mode', () => {
    test('dispatches the first not-started todo', () => {
        const plan = planMainStageDispatch('dsa*', 0, 3, [t('dsa2'), t('dsa1', undefined, 'First')]);
        assert.equal(plan.mode, 'todo');
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa1');
        assert.equal(plan.mode === 'todo' && plan.todo.title, 'First');
    });

    test('the sent count does not gate the walk — only the todos do', () => {
        // The series is `dsa1..dsa9` so the count is 9, but only `dsa9` is
        // left. Counter mode would send eight more times; todo mode sends once.
        const todos = [t('dsa1', 'completed'), t('dsa9', 'not-started')];
        const plan = planMainStageDispatch('dsa*', 0, 9, todos);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa9');
        assert.equal(plan.mode === 'todo' && plan.todo.index, 9);
    });

    test('keeps walking even after more reps went out than the count', () => {
        // A stale/short resolved count must never cut the walk short.
        const plan = planMainStageDispatch('dsa*', 99, 1, [t('dsa4', 'not-started')]);
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'dsa4');
    });

    test('is exhausted once every matching todo has been dispatched', () => {
        const todos = [t('dsa1', 'in-progress'), t('dsa2', 'completed')];
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 2, todos), { mode: 'exhausted' });
    });

    test('is exhausted when the prefix matches no todo at all', () => {
        // Deliberate: `resolveTodoPrefixRepeatCount` floors at 1, but sending
        // a "work on ${repeatTodoId}" prompt with no todo to name is worse
        // than not sending it. The manager logs this case.
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 1, [t('xyz1')]), { mode: 'exhausted' });
        assert.deepEqual(planMainStageDispatch('dsa*', 0, 1, []), { mode: 'exhausted' });
    });
});
