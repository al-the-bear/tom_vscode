/**
 * Tests for the todo-file scoping of `listTodoFiles` / `readAllTodos`
 * (TRA13).
 *
 * The bug this pins: `listTodoFiles` used to return EVERY `*.todo.yaml`
 * in the quest folder, so the `-archived` / `-deleted` terminal siblings
 * were folded into every aggregate read. A todo the user had deliberately
 * archived still inflated `readAllTodos`, and through it the id list that
 * backs the `<prefix>*` repeat count — producing a real queue iteration
 * against a retired todo.
 *
 * The default is now live-files-only; callers that must see the retired
 * files (the file picker, find-by-id) opt back in with `ALL_TODO_FILES`.
 *
 * `questTodoManager` requires `vscode` + a workspace folder to resolve
 * `_ai/quests/<quest>/`, so the shared stub is installed against a temp
 * workspace root before importing the module.
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-scope-'));

installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import {
    ALL_TODO_FILES,
    listTodoFiles,
    readAllTodos,
    findTodoById,
} from '../questTodoManager.js';

const QUEST = 'scope_quest';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);

/** Write a todo file holding one todo with the given id. */
function writeTodoFile(name: string, id: string): void {
    fs.writeFileSync(
        path.join(questDir, name),
        `quest: ${QUEST}\ntodos:\n  - id: ${id}\n    description: ${id}\n    status: not-started\n`,
        'utf-8',
    );
}

before(() => {
    fs.mkdirSync(questDir, { recursive: true });
    writeTodoFile(`todos.${QUEST}.todo.yaml`, 'dsa1');
    writeTodoFile(`session-todo.mbp.${QUEST}.todo.yaml`, 'wt-1');
    writeTodoFile(`todos-archived.${QUEST}.todo.yaml`, 'dsa9');
    writeTodoFile(`todos-deleted.${QUEST}.todo.yaml`, 'dsa7');
});

describe('listTodoFiles scoping (TRA13)', () => {
    test('lists only the live files by default', () => {
        assert.deepEqual(listTodoFiles(QUEST), [
            `session-todo.mbp.${QUEST}.todo.yaml`,
            `todos.${QUEST}.todo.yaml`,
        ]);
    });

    test('showArchiveFiles adds the archive sibling, not the delete one', () => {
        assert.deepEqual(listTodoFiles(QUEST, { showArchiveFiles: true }), [
            `session-todo.mbp.${QUEST}.todo.yaml`,
            `todos-archived.${QUEST}.todo.yaml`,
            `todos.${QUEST}.todo.yaml`,
        ]);
    });

    test('showDeletedFiles adds the delete sibling, not the archive one', () => {
        assert.deepEqual(listTodoFiles(QUEST, { showDeletedFiles: true }), [
            `session-todo.mbp.${QUEST}.todo.yaml`,
            `todos-deleted.${QUEST}.todo.yaml`,
            `todos.${QUEST}.todo.yaml`,
        ]);
    });

    test('showNormalFiles: false lists only what is explicitly enabled', () => {
        assert.deepEqual(
            listTodoFiles(QUEST, { showNormalFiles: false, showArchiveFiles: true, showDeletedFiles: true }),
            [
                `todos-archived.${QUEST}.todo.yaml`,
                `todos-deleted.${QUEST}.todo.yaml`,
            ],
        );
    });

    test('ALL_TODO_FILES lists every todo file', () => {
        assert.equal(listTodoFiles(QUEST, ALL_TODO_FILES).length, 4);
    });
});

describe('readAllTodos scoping (TRA13)', () => {
    test('an archived todo does not inflate the aggregate read', () => {
        const ids = readAllTodos(QUEST).map(t => t.id).sort();
        assert.deepEqual(ids, ['dsa1', 'wt-1']);
        // The concrete regression: `dsa9` was archived, so a `dsa*` repeat
        // count derived from these ids must resolve to 1, not 9.
        assert.equal(ids.includes('dsa9'), false);
        assert.equal(ids.includes('dsa7'), false);
    });

    test('ALL_TODO_FILES brings the retired todos back', () => {
        const ids = readAllTodos(QUEST, ALL_TODO_FILES).map(t => t.id).sort();
        assert.deepEqual(ids, ['dsa1', 'dsa7', 'dsa9', 'wt-1']);
    });
});

describe('findTodoById reaches retired todos (TRA13)', () => {
    test('resolves a live todo', () => {
        assert.equal(findTodoById(QUEST, 'dsa1')?.id, 'dsa1');
    });

    test('still resolves an archived todo', () => {
        assert.equal(findTodoById(QUEST, 'dsa9')?.id, 'dsa9');
    });

    test('still resolves a deleted todo', () => {
        assert.equal(findTodoById(QUEST, 'dsa7')?.id, 'dsa7');
    });

    test('returns undefined for an id that exists nowhere', () => {
        assert.equal(findTodoById(QUEST, 'nope'), undefined);
    });
});
