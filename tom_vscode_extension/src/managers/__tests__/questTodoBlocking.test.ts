/**
 * `blocking` through the todo manager's own writers: every path that writes a
 * todo file keeps the reverse of `blocked_by` in step
 * (src/utils/todoBlockingSync.ts, called from questTodoManager and todoArchive).
 *
 *   QBM-1 updating a todo's blocked_by writes the blocker's blocking; clearing it removes it again
 *   QBM-2 a todo created in another quest with `<quest>/<id>` in blocked_by appears as `<quest>/<id>`
 *   QBM-3 archiving the blocked todo removes it from the blocker's blocking
 *   QBM-4 the todo tools refuse `blocking` on create and update, naming the field to set instead
 *   QBM-5 a todo read back carries its blocking
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's YAML key */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-blocking-mgr-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { createTodo, findTodoById, moveTodoToSiblingByStatus, persistentTodoPath, updateTodo } from '../questTodoManager.js';
import { validateNoBlocking } from '../../tools/quest-todo-tools.js';

for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(tmpRoot, '_ai', 'quests', q), { recursive: true }); }

describe('blocking through the todo manager', () => {
    test('QBM-1: updating blocked_by writes and clears the blocker\'s blocking', () => {
        createTodo('qa', { id: 'blocker', description: 'b', status: 'not-started' });
        createTodo('qa', { id: 'waits', description: 'w', status: 'not-started' });
        updateTodo('qa', 'waits', { blocked_by: ['blocker'] });
        assert.deepEqual(findTodoById('qa', 'blocker')?.blocking, ['waits']);
        updateTodo('qa', 'waits', { blocked_by: [] });
        assert.equal(findTodoById('qa', 'blocker')?.blocking, undefined);
        updateTodo('qa', 'waits', { blocked_by: ['blocker'] });
    });

    test('QBM-2: a blocker across quests', () => {
        createTodo('qb', { id: 'far', description: 'f', status: 'not-started', blocked_by: ['qa/blocker'] });
        assert.deepEqual(findTodoById('qa', 'blocker')?.blocking, ['qb/far', 'waits']);
    });

    test('QBM-3: archiving the blocked todo removes it', () => {
        updateTodo('qa', 'waits', { status: 'completed' });
        moveTodoToSiblingByStatus(persistentTodoPath('qa'), 'waits');
        assert.deepEqual(findTodoById('qa', 'blocker')?.blocking, ['qb/far']);
    });

    test('QBM-4: the tools refuse blocking', () => {
        const message = validateNoBlocking({ blocking: ['x'] });
        assert.ok(message && /blocked_by/.test(message));
        assert.equal(validateNoBlocking({ blocked_by: ['x'] }), undefined);
        assert.equal(validateNoBlocking(undefined), undefined);
    });

    test('QBM-5: read back', () => {
        const text = fs.readFileSync(persistentTodoPath('qa'), 'utf8');
        assert.match(text, /- id: blocker[\s\S]*blocking:\n\s+- qb\/far/);
    });
});
