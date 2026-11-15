/**
 * The todo done notification (utils/todoDoneNotification.ts; ww_a_collab-6).
 *
 *   TN-1 the template: the configured one, else the default (BP-3 with DP-6's sentence)
 *   TN-2 which todo: a single id, not a pattern or a list; a `<prefix>*` repeat count is a walk
 *   TN-3 the placeholders filled from the todo, escaped; a todo that is gone reads `(todo <id> not found)`
 *   TN-4 the item the planner gets: none without on_done (-3); notify_prompt replaces the template (-4); the target
 *        is on_done's quest and run, else the item's own (BP-3); per todo its own run key, the pause and a temporary
 *        session stay with the item, the answer is that todo's
 *   TN-5 through planDoneNotification: `${itemOutcome}` done / error, another run's lane, another quest's inbox
 *   TN-6 the panel's box: unset reads on, false off
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fillTodoNotification, filedByLine, isWalkItem, onDoneYaml, singleTodoOf, todoDoneNotificationTemplate, todoNotificationItem,
    TODO_DONE_NOTIFICATION_DEFAULT, type TodoForNotification,
} from '../todoDoneNotification';
import { planDoneNotification, type DoneNotificationItem } from '../doneNotification';
import { todoPanelDoneNotificationOn } from '../todoPanelRunSession';

const TODO: TodoForNotification = {
    id: 'w1', title: 'Wire ${x}', status: 'completed', file: '_ai/quests/q/todos.q.todo.yaml', last_answer: 'All ${green}.',
    on_done: { todos: ['t2'], action: ['unblock'], instructions: 'Note it' },
    filed_by: { quest: 'q', run: 'default', session: 'chat', at: '2026-11-15T07:00+01:00' },
};
const ITEM: DoneNotificationItem = {
    id: 'it1', status: 'sent', run: 'default', runId: 'r1', todoIdPattern: 'w1', transport: 'anthropic', session: 'work',
    doneNotificationPrompt: TODO_DONE_NOTIFICATION_DEFAULT, doneNotificationTodo: true, pauseAfter: true, temporarySession: true,
    repetitionAnswers: [{ key: 'w1', text: 'answer w1' }, { key: 'w2', text: 'answer w2' }],
};

describe('the todo done notification', () => {
    test('TN-1: the template', () => {
        assert.match(TODO_DONE_NOTIFICATION_DEFAULT, /^Todo \$\{todoId\} \(\$\{todoTitle\}\) is \$\{itemOutcome\}\. Its follow-up: \$\{todoOnDone\}\. Do what it says; if it says nothing, there is nothing to do\. If it is not done, report that and do not carry out the follow-up\.$/);
        assert.equal(todoDoneNotificationTemplate(undefined), TODO_DONE_NOTIFICATION_DEFAULT);
        assert.equal(todoDoneNotificationTemplate({ todoPanel: { doneNotificationTemplate: '  ' } }), TODO_DONE_NOTIFICATION_DEFAULT);
        assert.equal(todoDoneNotificationTemplate({ todoPanel: { doneNotificationTemplate: 'Mine ${todoId}' } }), 'Mine ${todoId}');
    });

    test('TN-2: which todo', () => {
        assert.equal(singleTodoOf({ todoIdPattern: 'w1' }), 'w1');
        assert.equal(singleTodoOf({ todoIdPattern: 'w1,w2' }), undefined);
        assert.equal(singleTodoOf({ todoIdPattern: 'w*' }), undefined);
        assert.equal(isWalkItem({ repeatCount: 'w-*' }), true);
        assert.equal(isWalkItem({ repeatCount: 3 }), false);
    });

    test('TN-3: the placeholders', () => {
        const text = fillTodoNotification('${todoId}|${todoTitle}|${todoFile}|${todoStatus}|${todoLastAnswer}|${filedBy}|${todoOnDone}', 'w1', TODO);
        const [id, title, file, status, answer, filedBy, onDone] = text.split('|');
        assert.equal(id, 'w1');
        assert.equal(title, 'Wire $${x}', 'escaped');
        assert.equal(file, '_ai/quests/q/todos.q.todo.yaml');
        assert.equal(status, 'completed');
        assert.equal(answer, 'All $${green}.');
        assert.equal(filedBy, 'quest q, run default, session chat, at 2026-11-15T07:00+01:00');
        assert.match(onDone, /todos:\n {2}- t2\naction:\n {2}- unblock/);
        assert.equal(filedByLine(undefined), '(unknown)');
        assert.equal(onDoneYaml(undefined), '(none)');
        assert.match(fillTodoNotification('${todoTitle} ${todoOnDone}', 'gone1', undefined), /^\(todo gone1 not found\) \(todo gone1 not found\)$/);
    });

    test('TN-4: the item the planner gets', () => {
        assert.equal(todoNotificationItem(ITEM, 'w1', { ...TODO, on_done: undefined }, { perTodo: false }), null, 'no on_done: none (-3)');
        const single = todoNotificationItem(ITEM, 'w1', TODO, { perTodo: false })!;
        assert.match(single.doneNotificationPrompt!, /^Todo w1 \(Wire \$\$\{x\}\) is \$\{itemOutcome\}\. Its follow-up: todos:/);
        assert.equal(single.doneNotificationQuest, undefined, 'no on_done.quest: the item\'s own');
        assert.equal(single.runId, 'r1');
        assert.equal(single.pauseAfter, true, 'a single item hands its pause over');
        const own = todoNotificationItem(ITEM, 'w1', { ...TODO, on_done: { ...TODO.on_done, quest: 'q2', run: 'chg7', notify_prompt: 'Report ${todoId}' } }, { perTodo: false })!;
        assert.equal(own.doneNotificationPrompt, 'Report w1', 'notify_prompt replaces the template (-4)');
        assert.equal(own.doneNotificationQuest, 'q2');
        assert.equal(own.doneNotificationRun, 'chg7');
        const walk = todoNotificationItem(ITEM, 'w2', { ...TODO, id: 'w2' }, { perTodo: true })!;
        assert.equal(walk.runId, 'r1:w2', 'each todo once');
        assert.equal(walk.pauseAfter, false);
        assert.equal(walk.temporarySession, false);
        assert.deepEqual(walk.repetitionAnswers, [{ key: 'w2', text: 'answer w2' }]);
        const gone = todoNotificationItem(ITEM, 'gone1', undefined, { perTodo: false })!;
        assert.match(gone.doneNotificationPrompt!, /\(todo gone1 not found\)/, 'gone: still told, in the item\'s own queue');
        assert.equal(gone.doneNotificationQuest, undefined);
    });

    test('TN-5: through the planner', () => {
        const items = [{ id: 'it1', status: 'sent' }, { id: 'p', status: 'pending' }];
        const done = planDoneNotification(todoNotificationItem(ITEM, 'w1', TODO, { perTodo: false })!, { kind: 'done' }, items, 'q')!;
        assert.match(done.text, /^Todo w1 \(Wire \$\$\{x\}\) is done\./);
        assert.equal(done.targetRun, 'default');
        const error = planDoneNotification(todoNotificationItem(ITEM, 'w1', TODO, { perTodo: false })!, { kind: 'error', message: 'quota' }, items, 'q')!;
        assert.match(error.text, /is error: quota\. [\s\S]*If it is not done, report that/);
        const otherRun = planDoneNotification(todoNotificationItem(ITEM, 'w1', { ...TODO, on_done: { ...TODO.on_done, run: 'r2' } }, { perTodo: false })!, { kind: 'done' }, items, 'q')!;
        assert.equal(otherRun.targetRun, 'r2');
        assert.equal(otherRun.session, 'work', 'that run\'s own session (the queue makes it work@r2)');
        const otherQuest = planDoneNotification(todoNotificationItem(ITEM, 'w1', { ...TODO, on_done: { ...TODO.on_done, quest: 'q2' } }, { perTodo: false })!, { kind: 'done' }, items, 'q')!;
        assert.equal(otherQuest.targetQuest, 'q2');
        assert.equal(otherQuest.targetRun, 'default');
    });

    test('TN-6: the panel\'s box', () => {
        assert.equal(todoPanelDoneNotificationOn(undefined), true, 'unset: on (BP-3)');
        assert.equal(todoPanelDoneNotificationOn(true), true);
        assert.equal(todoPanelDoneNotificationOn(false), false);
    });
});
