/**
 * Tests for the archive/delete todo-file naming helpers (TRA01).
 *
 * Naming rule: the archive/delete sibling of a todo file is derived by
 * suffixing the FIRST dot-separated segment of the file name with
 * `-archived` / `-deleted`. A file whose first segment already carries one
 * of those suffixes is terminal — it can never be a source, and the name
 * helpers throw when asked to derive a sibling for it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
    ALL_TODO_FILES,
    archivedTodoFileName,
    deletedTodoFileName,
    isArchivedOrDeletedTodoFile,
    isArchivedTodoFile,
    isDeletedTodoFile,
    matchesTodoFileScope,
} from '../todoArchiveNames.js';

describe('todoArchiveNames', () => {
    test('archivedTodoFileName suffixes the first dot-segment', () => {
        assert.equal(
            archivedTodoFileName('todos.vscode_extension.todo.yaml'),
            'todos-archived.vscode_extension.todo.yaml',
        );
    });

    test('deletedTodoFileName suffixes the first dot-segment', () => {
        assert.equal(
            deletedTodoFileName('todos.vscode_extension.todo.yaml'),
            'todos-deleted.vscode_extension.todo.yaml',
        );
    });

    test('works for session-todo file names', () => {
        assert.equal(
            archivedTodoFileName('session-todo.bomber.vscode_extension.todo.yaml'),
            'session-todo-archived.bomber.vscode_extension.todo.yaml',
        );
        assert.equal(
            deletedTodoFileName('session-todo.bomber.vscode_extension.todo.yaml'),
            'session-todo-deleted.bomber.vscode_extension.todo.yaml',
        );
    });

    test('accepts a full path and transforms only the basename', () => {
        const p = path.join('/some', 'dir', 'todos.q.todo.yaml');
        assert.equal(
            archivedTodoFileName(p),
            path.join('/some', 'dir', 'todos-archived.q.todo.yaml'),
        );
        assert.equal(
            deletedTodoFileName(p),
            path.join('/some', 'dir', 'todos-deleted.q.todo.yaml'),
        );
    });

    test('throws when the source is already archived/deleted (terminal)', () => {
        assert.throws(() => archivedTodoFileName('todos-archived.q.todo.yaml'));
        assert.throws(() => archivedTodoFileName('todos-deleted.q.todo.yaml'));
        assert.throws(() => deletedTodoFileName('todos-archived.q.todo.yaml'));
        assert.throws(() => deletedTodoFileName('todos-deleted.q.todo.yaml'));
    });

    test('isArchivedOrDeletedTodoFile detects terminal files', () => {
        assert.equal(isArchivedOrDeletedTodoFile('todos-archived.q.todo.yaml'), true);
        assert.equal(isArchivedOrDeletedTodoFile('todos-deleted.q.todo.yaml'), true);
        assert.equal(isArchivedOrDeletedTodoFile('session-todo-archived.h.q.todo.yaml'), true);
        assert.equal(isArchivedOrDeletedTodoFile('todos.q.todo.yaml'), false);
    });

    test('isArchivedOrDeletedTodoFile only looks at the FIRST segment', () => {
        // -archived in a later segment does not make the file terminal.
        assert.equal(isArchivedOrDeletedTodoFile('todos.foo-archived.todo.yaml'), false);
        assert.equal(isArchivedOrDeletedTodoFile('todos.foo-deleted.todo.yaml'), false);
    });

    test('isArchivedOrDeletedTodoFile works on full paths', () => {
        assert.equal(
            isArchivedOrDeletedTodoFile('/a/b/todos-archived.q.todo.yaml'),
            true,
        );
        assert.equal(
            isArchivedOrDeletedTodoFile('/a/b/todos.q.todo.yaml'),
            false,
        );
    });
});

describe('todoArchiveNames — archived vs deleted (TRA13)', () => {
    test('isArchivedTodoFile only matches the -archived suffix', () => {
        assert.equal(isArchivedTodoFile('todos-archived.q.todo.yaml'), true);
        assert.equal(isArchivedTodoFile('session-todo-archived.h.q.todo.yaml'), true);
        assert.equal(isArchivedTodoFile('/a/b/todos-archived.q.todo.yaml'), true);
        assert.equal(isArchivedTodoFile('todos-deleted.q.todo.yaml'), false);
        assert.equal(isArchivedTodoFile('todos.q.todo.yaml'), false);
        // Later segments never make a file terminal.
        assert.equal(isArchivedTodoFile('todos.foo-archived.todo.yaml'), false);
    });

    test('isDeletedTodoFile only matches the -deleted suffix', () => {
        assert.equal(isDeletedTodoFile('todos-deleted.q.todo.yaml'), true);
        assert.equal(isDeletedTodoFile('session-todo-deleted.h.q.todo.yaml'), true);
        assert.equal(isDeletedTodoFile('/a/b/todos-deleted.q.todo.yaml'), true);
        assert.equal(isDeletedTodoFile('todos-archived.q.todo.yaml'), false);
        assert.equal(isDeletedTodoFile('todos.q.todo.yaml'), false);
        assert.equal(isDeletedTodoFile('todos.foo-deleted.todo.yaml'), false);
    });

    test('isArchivedOrDeletedTodoFile is the union of the two', () => {
        for (const name of [
            'todos.q.todo.yaml',
            'todos-archived.q.todo.yaml',
            'todos-deleted.q.todo.yaml',
            'session-todo.h.q.todo.yaml',
            'todos.foo-archived.todo.yaml',
        ]) {
            assert.equal(
                isArchivedOrDeletedTodoFile(name),
                isArchivedTodoFile(name) || isDeletedTodoFile(name),
                name,
            );
        }
    });
});

describe('matchesTodoFileScope (TRA13)', () => {
    const normal = 'todos.q.todo.yaml';
    const session = 'session-todo.mbp.q.todo.yaml';
    const archived = 'todos-archived.q.todo.yaml';
    const deleted = 'todos-deleted.q.todo.yaml';

    test('defaults to normal files only', () => {
        assert.equal(matchesTodoFileScope(normal), true);
        assert.equal(matchesTodoFileScope(session), true);
        assert.equal(matchesTodoFileScope(archived), false);
        assert.equal(matchesTodoFileScope(deleted), false);
    });

    test('an empty scope object uses the same defaults', () => {
        assert.equal(matchesTodoFileScope(normal, {}), true);
        assert.equal(matchesTodoFileScope(archived, {}), false);
        assert.equal(matchesTodoFileScope(deleted, {}), false);
    });

    test('showArchiveFiles admits archived files only', () => {
        const scope = { showArchiveFiles: true };
        assert.equal(matchesTodoFileScope(normal, scope), true);
        assert.equal(matchesTodoFileScope(archived, scope), true);
        assert.equal(matchesTodoFileScope(deleted, scope), false);
    });

    test('showDeletedFiles admits deleted files only', () => {
        const scope = { showDeletedFiles: true };
        assert.equal(matchesTodoFileScope(normal, scope), true);
        assert.equal(matchesTodoFileScope(archived, scope), false);
        assert.equal(matchesTodoFileScope(deleted, scope), true);
    });

    test('showNormalFiles: false excludes non-terminal files', () => {
        const scope = { showNormalFiles: false, showArchiveFiles: true };
        assert.equal(matchesTodoFileScope(normal, scope), false);
        assert.equal(matchesTodoFileScope(session, scope), false);
        assert.equal(matchesTodoFileScope(archived, scope), true);
        assert.equal(matchesTodoFileScope(deleted, scope), false);
    });

    test('all three flags false matches nothing', () => {
        const scope = { showNormalFiles: false, showArchiveFiles: false, showDeletedFiles: false };
        for (const name of [normal, session, archived, deleted]) {
            assert.equal(matchesTodoFileScope(name, scope), false, name);
        }
    });

    test('ALL_TODO_FILES admits every todo file', () => {
        for (const name of [normal, session, archived, deleted]) {
            assert.equal(matchesTodoFileScope(name, ALL_TODO_FILES), true, name);
        }
    });
});
