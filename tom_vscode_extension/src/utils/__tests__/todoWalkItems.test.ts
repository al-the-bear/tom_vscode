/**
 * TODO and GROUP items, the pure parts (vscimpb127).
 *
 *   TW-1 parseTodoWalk: `<prefix>*`, `todo:<quest>/<id>`, `group:<quest>/<id>`; anything else is no walk
 *   TW-2 collectWalkTodos: a TODO item's one todo; a GROUP item's members in comprised_of order, this quest's only,
 *        numbered 1, 2, …; a prefix as before
 *   TW-3 the walk rules apply: pick, decision hold, user-action pass, empty reasons; the series count
 *   TW-4 deriveQueueItemKind / parseQueueItemKind
 *   TW-5 todoQueueItemSpec: walk value, id pattern, refusals; the TODO item's text from the walk prompt
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectWalkTodos, emptyTodoIterationReason, parseTodoWalk, pickNextTodoForIteration, planMainStageDispatch, resolveTodoPrefixRepeatCount, todoWalkValue,
    type TodoIterationSource,
} from '../queueStep3Utils.js';
import { deriveQueueItemKind, parseQueueItemKind } from '../queueItemKind.js';
import { TODO_ITEM_TEXT, todoItemPromptText, todoQueueItemSpec } from '../todoQueueItems.js';
import { BUILTIN_GROUP_PROMPT } from '../groupPrompts.js';

const TODOS: TodoIterationSource[] = [
    { id: 'g1', status: 'group', comprisedOf: ['m3', 'q/m1', 'other/x', 'm2', 'm3', 'gone'] },
    { id: 'm1', status: 'not-started', title: 'one' },
    { id: 'm2', status: 'decision-needed' },
    { id: 'm3', status: 'not-started', userAction: true },
    { id: 's1', status: 'not-started' },
];

describe('TODO and GROUP walks', () => {
    test('TW-1: parseTodoWalk', () => {
        assert.deepEqual(parseTodoWalk('dsa*'), { kind: 'prefix', prefix: 'dsa' });
        assert.deepEqual(parseTodoWalk('todo:q/s1'), { kind: 'todo', quest: 'q', id: 's1' });
        assert.deepEqual(parseTodoWalk(' group:q/g1 '), { kind: 'group', quest: 'q', id: 'g1' });
        for (const v of [3, '3', 'myVar', 'todo:s1', 'group:/g1', 'todo:q/', '*', undefined]) { assert.equal(parseTodoWalk(v), undefined, String(v)); }
        assert.equal(todoWalkValue('group', 'q', 'g1'), 'group:q/g1');
    });

    test('TW-2: collectWalkTodos', () => {
        assert.deepEqual(collectWalkTodos({ kind: 'todo', quest: 'q', id: 's1' }, TODOS).map((e) => [e.id, e.index]), [['s1', 1]]);
        assert.deepEqual(collectWalkTodos({ kind: 'todo', quest: 'q', id: 'nope' }, TODOS), []);
        assert.deepEqual(collectWalkTodos({ kind: 'group', quest: 'q', id: 'g1' }, TODOS).map((e) => [e.id, e.index]), [['m3', 1], ['m1', 2], ['m2', 3]],
            'comprised_of order; q/m1 is this quest\'s; other/x, a repeat and a missing member are left out');
        assert.deepEqual(collectWalkTodos({ kind: 'prefix', prefix: 'm' }, TODOS).map((e) => e.id), ['m1', 'm2', 'm3']);
    });

    test('TW-3: the walk rules', () => {
        assert.equal(pickNextTodoForIteration('todo:q/s1', TODOS)?.id, 's1');
        // The user's m3 is passed; m1 is next, then the decision on m2 holds the walk.
        const plan = planMainStageDispatch('group:q/g1', 0, 3, TODOS);
        assert.equal(plan.mode, 'todo');
        assert.equal(plan.mode === 'todo' && plan.todo.id, 'm1');
        assert.deepEqual(plan.mode === 'todo' && plan.waitingForUser?.map((t) => t.id), ['m3']);
        const afterM1 = TODOS.map((t) => (t.id === 'm1' ? { ...t, status: 'completed' } : t));
        assert.equal(planMainStageDispatch('group:q/g1', 1, 3, afterM1).mode, 'decision-needed');
        assert.equal(emptyTodoIterationReason('todo:q/s1', TODOS, 'q'), undefined);
        assert.match(emptyTodoIterationReason('todo:q/nope', TODOS, 'q')!, /has no todo "nope"/);
        assert.match(emptyTodoIterationReason('todo:other/s1', TODOS, 'q')!, /is a todo of quest "other"/);
        assert.match(emptyTodoIterationReason('group:q/s1', TODOS, 'q')!, /has no member in quest "q"/);
        assert.match(emptyTodoIterationReason('todo:q/s1', TODOS.map((t) => ({ ...t, status: 'completed' })), 'q')!, /none of the 1 todo of todo s1/);
        assert.equal(resolveTodoPrefixRepeatCount('group:q/g1', TODOS), 3, 'a group counts its walked members');
        assert.equal(resolveTodoPrefixRepeatCount('todo:q/s1', TODOS), 1);
        assert.equal(resolveTodoPrefixRepeatCount('m*', ['m1', 'm7']), 7, 'ids still work for a prefix');
    });

    test('TW-4: the item kind', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ repeatCount: 'todo:q/a' }, 'todo'], [{ repeatCount: 'group:q/g' }, 'group'], [{ repeatCount: 'dsa*' }, 'prefix'],
            [{ repeatCount: 3 }, 'iteration'], [{ repeatCount: '4' }, 'iteration'], [{ repeatCount: 'myCount' }, 'iteration'],
            [{ repeatCount: 1 }, 'prompt'], [{}, 'prompt'], [{ status: 'chat' }, 'chat'], [{ status: 'chat-sent', repeatCount: 3 }, 'chat'],
        ];
        for (const [item, kind] of cases) { assert.equal(deriveQueueItemKind(item), kind, JSON.stringify(item)); }
        assert.equal(parseQueueItemKind('group'), 'group');
        assert.equal(parseQueueItemKind('walk'), undefined);
    });

    test('TW-5: todoQueueItemSpec', () => {
        assert.deepEqual(todoQueueItemSpec('todo', 'q', 's1', { id: 's1' }), { ok: true, kind: 'todo', quest: 'q', id: 's1', repeatCount: 'todo:q/s1', todoIdPattern: 's1' });
        const g = todoQueueItemSpec('group', 'q', 'g1', { id: 'g1', status: 'group', comprised_of: ['m3', 'q/m1', 'other/x', 'm3'] });
        assert.equal(g.ok && g.todoIdPattern, 'g1,m3,m1');
        assert.match((todoQueueItemSpec('group', 'q', 's1', { id: 's1', status: 'not-started' }) as { error: string }).error, /no todo group/);
        assert.match((todoQueueItemSpec('todo', 'q', 'x', undefined) as { error: string }).error, /has no todo "x"/);
        assert.match((todoQueueItemSpec('todo', 'default', 'x', { id: 'x' }) as { error: string }).error, /no quest is open/);
        assert.doesNotMatch(todoItemPromptText(BUILTIN_GROUP_PROMPT), /of this group walk/);
        assert.match(todoItemPromptText(BUILTIN_GROUP_PROMPT), /Do the quest todo \$\{repeatTodoId\} — \$\{repeatTodoTitle\}\. Its complete record/);
        assert.match(TODO_ITEM_TEXT, /\$\{repeatTodoId\}/);
    });
});
