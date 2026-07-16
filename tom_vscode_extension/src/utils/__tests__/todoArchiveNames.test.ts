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
    archivedTodoFileName,
    deletedTodoFileName,
    isArchivedOrDeletedTodoFile,
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
