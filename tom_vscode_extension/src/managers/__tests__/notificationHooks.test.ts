/**
 * The todo writers emit NOTIFICATIONS events (vscimpb124).
 *
 *   NH-1 fileTodo: one `todoCreated`, with the todo's title and status
 *   NH-2 updateTodo: a status change is one `todoChanged` with old → new and the other fields of the call; an edit is
 *        one `todoUpdated`; an update that changes nothing emits nothing
 *   NH-3 updateTodoInFile (the todo panel's path) on a quest todo file emits too, with the quest from the path
 *   NH-4 the blocking cascade's status changes are the extension's (`blocked todos follow their blockers`)
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's YAML key */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb124_hooks-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { fileTodo, questTodoFilePath, updateTodo, updateTodoInFile } from '../questTodoManager.js';
import { configureNotificationLog, readNotificationEvents } from '../../services/notificationLog.js';

const LOG = path.join(tmpRoot, 'notifications', 'events.jsonl');
for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(tmpRoot, '_ai', 'quests', q), { recursive: true }); }
configureNotificationLog(LOG, { windowId: 'w1', quest: () => 'qa', run: () => 'default', who: () => ({ kind: 'user' }) });
after(() => { configureNotificationLog(undefined, undefined); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const since = (n: number) => readNotificationEvents(LOG).slice(n);
const count = () => readNotificationEvents(LOG).length;

describe('todo writers emit events', () => {
    test('NH-1: fileTodo', () => {
        const n = count();
        fileTodo('qa', { id: 'a1', title: 'First', description: 'd', status: 'not-started' });
        const [e, ...rest] = since(n);
        assert.equal(rest.length, 0);
        assert.equal(e.type, 'todoCreated');
        assert.deepEqual(e.todo, { id: 'a1', quest: 'qa', title: 'First', fields: [{ field: 'status', new: 'not-started' }] });
        assert.deepEqual(e.who, { kind: 'user' });
    });

    test('NH-2: updateTodo', () => {
        let n = count();
        updateTodo('qa', 'a1', { status: 'in-progress', priority: 'high' });
        let [e, ...rest] = since(n);
        assert.equal(rest.length, 0, 'one event per call');
        assert.equal(e.type, 'todoChanged');
        assert.deepEqual(e.todo!.fields, [{ field: 'priority', new: 'high' }, { field: 'status', old: 'not-started', new: 'in-progress' }]);
        n = count();
        updateTodo('qa', 'a1', { notes: 'a note' });
        [e, ...rest] = since(n);
        assert.equal(e.type, 'todoUpdated');
        assert.deepEqual(e.todo!.fields, [{ field: 'notes', new: 'a note' }]);
        n = count();
        updateTodo('qa', 'a1', { notes: 'a note' });
        assert.equal(since(n).length, 0, 'nothing changed: no event');
    });

    test('NH-3: updateTodoInFile on a quest todo file', () => {
        fileTodo('qb', { id: 'b1', description: 'second', status: 'not-started' });
        const n = count();
        updateTodoInFile(questTodoFilePath('qb', 'todos.qb.todo.yaml'), 'b1', { status: 'cancelled' });
        const [e] = since(n);
        assert.equal(e.type, 'todoChanged');
        assert.equal(e.todo!.quest, 'qb');
        assert.equal(e.todo!.title, 'second', 'the description stands in for a missing title');
    });

    test('NH-4: the cascade is the extension', () => {
        fileTodo('qa', { id: 'gate', description: 'g', status: 'in-progress' });
        fileTodo('qb', { id: 'waits', description: 'w', status: 'blocked', blocked_by: ['qa/gate'] });
        const n = count();
        updateTodo('qa', 'gate', { status: 'completed' });
        const events = since(n);
        const cascade = events.find((e) => e.todo?.id === 'waits');
        assert.ok(cascade, JSON.stringify(events));
        assert.equal(cascade.type, 'todoChanged');
        assert.deepEqual(cascade.who, { kind: 'extension', label: 'blocked todos follow their blockers' });
        assert.deepEqual(cascade.todo!.fields, [{ field: 'status', old: 'blocked', new: 'not-started' }]);
        assert.equal(events.find((e) => e.todo?.id === 'gate')?.who.kind, 'user');
    });
});
