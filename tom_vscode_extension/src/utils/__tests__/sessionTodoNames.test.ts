/**
 * Tests for sessionTodoNames.ts (TRA04) — stable per-host session todo
 * file naming + detection of both the stable and the legacy per-window
 * naming schemes.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    isLegacySessionTodoFileName,
    isSessionTodoFileName,
    sessionTodoFilename,
} from '../sessionTodoNames.js';

describe('sessionTodoFilename', () => {
    test('builds session-todo.<host>.<quest>.todo.yaml', () => {
        assert.equal(
            sessionTodoFilename('mbp', 'vscode_extension'),
            'session-todo.mbp.vscode_extension.todo.yaml',
        );
    });

    test('round-trips through isSessionTodoFileName', () => {
        assert.equal(isSessionTodoFileName(sessionTodoFilename('bomber', 'd4rt')), true);
    });
});

describe('isLegacySessionTodoFileName', () => {
    test('matches the per-window scheme', () => {
        assert.equal(isLegacySessionTodoFileName('20260716_0930_win-1752600000000-ab12cd.todo.yaml'), true);
    });

    test('rejects the stable scheme and ordinary todo files', () => {
        assert.equal(isLegacySessionTodoFileName('session-todo.mbp.d4rt.todo.yaml'), false);
        assert.equal(isLegacySessionTodoFileName('todos.d4rt.todo.yaml'), false);
    });
});

describe('isSessionTodoFileName', () => {
    test('matches both stable and legacy forms', () => {
        assert.equal(isSessionTodoFileName('session-todo.mbp.vscode_extension.todo.yaml'), true);
        assert.equal(isSessionTodoFileName('20260716_0930_win-x.todo.yaml'), true);
    });

    test('rejects ordinary quest todo files', () => {
        assert.equal(isSessionTodoFileName('todos.vscode_extension.todo.yaml'), false);
        assert.equal(isSessionTodoFileName('workspace.todo.yaml'), false);
    });

    test('rejects the terminal -archived / -deleted siblings of the session file', () => {
        // TRA01 sibling naming appends -archived/-deleted to the FIRST dot
        // segment; those files are terminal stores, not live session files.
        assert.equal(isSessionTodoFileName('session-todo-archived.mbp.d4rt.todo.yaml'), false);
        assert.equal(isSessionTodoFileName('session-todo-deleted.mbp.d4rt.todo.yaml'), false);
    });
});
