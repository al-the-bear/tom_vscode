/**
 * The todo panel's quest scope (utils/todoPanelScope.ts) and Restore (utils/todoArchive.ts restoreTodos), vscimpb137.
 *
 *   PS-1 the default: the window's quest, live files, the groups combined, the prefix by default
 *   PS-2 normalising: unknown kinds and orders fall back, `one` gets a quest, `picked` and `prefix` are kept
 *   PS-3 resolving the quests: one (its quest, the window's when it no longer exists), open (existing ones, the
 *        window's first), all (every quest, or the ticked ones)
 *   PS-4 the file toggles as a listing scope; the plain scope (the panel as it always was)
 *   PS-5 the quest prefix: off with one quest, on with several, on by default where asked, the scope's choice wins
 *   PS-6 the button text; the retired kind of a file
 *   PS-7 liveTodoFileName
 *   PS-8 Restore: an archived and a deleted todo back into their live file without their stamp; refused when the
 *        live file holds the id, from a live file, for an unknown id
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';

import {
    defaultTodoPanelScope,
    isPlainScope,
    normalizeTodoPanelScope,
    questPrefixShown,
    resolveScopeQuests,
    retiredKindOf,
    scopeButtonText,
    scopeFileScope,
    todoPanelScopeKey,
} from '../todoPanelScope.js';
import { liveTodoFileName } from '../todoArchiveNames.js';
import { restoreTodos } from '../todoArchive.js';

const SOURCES = { all: ['alpha', 'beta', 'gamma', 'vx'], open: ['gamma', 'vx', 'gone'], windowQuest: 'vx' };

describe('todo panel quest scope', () => {
    test('PS-1: the default', () => {
        assert.deepEqual(defaultTodoPanelScope('vx'), { kind: 'one', quest: 'vx', files: { live: true, archived: false, deleted: false }, order: 'combined' });
        assert.equal(todoPanelScopeKey('ws'), 'tomAi.todoPanel.scope.ws');
    });

    test('PS-2: normalising', () => {
        assert.deepEqual(normalizeTodoPanelScope(undefined, 'vx'), defaultTodoPanelScope('vx'));
        assert.deepEqual(normalizeTodoPanelScope({ kind: 'nope', order: 'odd', files: { archived: true } }, 'vx'),
            { kind: 'one', quest: 'vx', files: { live: true, archived: true, deleted: false }, order: 'combined' });
        assert.deepEqual(normalizeTodoPanelScope({ kind: 'all', picked: ['alpha', 3, ''], order: 'quest-list', prefix: false, files: { live: false, deleted: true } }, 'vx'),
            { kind: 'all', picked: ['alpha'], files: { live: false, archived: false, deleted: true }, order: 'quest-list', prefix: false });
        assert.equal(normalizeTodoPanelScope({ kind: 'open', quest: 'alpha' }, 'vx').quest, undefined, 'only `one` names a quest');
    });

    test('PS-3: resolving the quests', () => {
        const one = (quest: string) => normalizeTodoPanelScope({ kind: 'one', quest }, 'vx');
        assert.deepEqual(resolveScopeQuests(one('beta'), SOURCES), ['beta']);
        assert.deepEqual(resolveScopeQuests(one('removed'), SOURCES), ['vx'], 'a quest that no longer exists: the window\'s');
        assert.deepEqual(resolveScopeQuests(one('removed'), { ...SOURCES, windowQuest: '' }), []);
        assert.deepEqual(resolveScopeQuests(normalizeTodoPanelScope({ kind: 'open' }, 'vx'), SOURCES), ['vx', 'gamma'], 'existing ones, the window\'s first');
        assert.deepEqual(resolveScopeQuests(normalizeTodoPanelScope({ kind: 'all' }, 'vx'), SOURCES), ['alpha', 'beta', 'gamma', 'vx']);
        assert.deepEqual(resolveScopeQuests(normalizeTodoPanelScope({ kind: 'all', picked: ['vx', 'alpha', 'gone'] }, 'vx'), SOURCES), ['alpha', 'vx'], 'the ticked ones');
    });

    test('PS-4: the file toggles; the plain scope', () => {
        assert.deepEqual(scopeFileScope({ live: true, archived: false, deleted: true }), { showNormalFiles: true, showArchiveFiles: false, showDeletedFiles: true });
        const base = defaultTodoPanelScope('vx');
        assert.equal(isPlainScope(base, ['vx'], 'vx'), true);
        assert.equal(isPlainScope(base, ['beta'], 'vx'), false, 'another quest than the panel\'s own');
        assert.equal(isPlainScope({ ...base, files: { live: true, archived: true, deleted: false } }, ['vx'], 'vx'), false, 'archived files too');
        assert.equal(isPlainScope(base, ['vx', 'beta'], 'vx'), false);
    });

    test('PS-5: the quest prefix', () => {
        const base = defaultTodoPanelScope('vx');
        assert.equal(questPrefixShown(base, 1), false, 'off with one quest');
        assert.equal(questPrefixShown(base, 2), true, 'on with several');
        assert.equal(questPrefixShown(base, 1, true), true, 'on by default in @TOM TODO');
        assert.equal(questPrefixShown({ ...base, prefix: false }, 3), false, 'the scope\'s choice wins');
        assert.equal(questPrefixShown({ ...base, prefix: true }, 1), true);
    });

    test('PS-6: the button text; the retired kind', () => {
        assert.equal(scopeButtonText(defaultTodoPanelScope('vx'), ['vx'], 4), 'vx');
        assert.equal(scopeButtonText({ ...defaultTodoPanelScope('vx'), kind: 'open' }, ['vx', 'gamma'], 4), 'Open windows (2)');
        assert.equal(scopeButtonText({ ...defaultTodoPanelScope('vx'), kind: 'all' }, ['a', 'b', 'c', 'd'], 4), 'All quests (4)');
        assert.equal(scopeButtonText({ ...defaultTodoPanelScope('vx'), kind: 'all', picked: ['a'] }, ['a'], 4), 'All quests (1/4)');
        assert.equal(retiredKindOf('vx/todos-archived.vx.todo.yaml'), 'archived');
        assert.equal(retiredKindOf('todos-deleted.vx.todo.yaml'), 'deleted');
        assert.equal(retiredKindOf('vx/todos.vx.todo.yaml'), undefined);
    });

    test('PS-7: liveTodoFileName', () => {
        assert.equal(liveTodoFileName('todos-archived.vx.todo.yaml'), 'todos.vx.todo.yaml');
        assert.equal(liveTodoFileName('/a/b/notes-deleted.vx.todo.yaml'), '/a/b/notes.vx.todo.yaml');
        assert.equal(liveTodoFileName('todos.vx.todo.yaml'), 'todos.vx.todo.yaml');
    });

    test('PS-8: Restore', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-restore-'));
        try {
            const live = path.join(dir, 'todos.vx.todo.yaml');
            const archived = path.join(dir, 'todos-archived.vx.todo.yaml');
            const deleted = path.join(dir, 'todos-deleted.vx.todo.yaml');
            fs.writeFileSync(live, 'quest: vx\ntodos:\n  - id: a1\n    title: Live\n    status: not-started\n');
            fs.writeFileSync(archived, 'quest: vx\ntodos:\n  - id: a2\n    title: Done\n    status: completed\n    notes: kept\n    archived: 2026-11-01\n  - id: a1\n    title: Twin\n    status: completed\n    archived: 2026-11-01\n');
            fs.writeFileSync(deleted, 'quest: vx\ntodos:\n  - id: a3\n    title: Dropped\n    status: not-started\n    deleted: 2026-11-02\n');
            const ids = (file: string): string[] => ((parseDocument(fs.readFileSync(file, 'utf8')).toJSON() as { todos: Array<{ id: string }> }).todos).map((t) => t.id);
            const todoIn = (file: string, id: string): Record<string, unknown> | undefined => ((parseDocument(fs.readFileSync(file, 'utf8')).toJSON() as { todos: Array<Record<string, unknown>> }).todos).find((t) => t.id === id);

            const r1 = restoreTodos(archived, ['a2']);
            assert.deepEqual(r1.moved, ['a2']);
            assert.equal(r1.targetFile, live);
            assert.deepEqual(ids(live), ['a1', 'a2']);
            assert.deepEqual(ids(archived), ['a1']);
            const back = todoIn(live, 'a2')!;
            assert.equal(back.archived, undefined, 'no archive stamp');
            assert.equal(back.notes, 'kept', 'every other field travels');
            assert.equal(back.status, 'completed');

            const r2 = restoreTodos(deleted, ['a3']);
            assert.deepEqual(r2.moved, ['a3']);
            assert.equal(todoIn(live, 'a3')!.deleted, undefined);
            assert.deepEqual(ids(deleted), []);

            const r3 = restoreTodos(archived, ['a1']);
            assert.deepEqual(r3.moved, [], 'the live file holds a1');
            assert.match(r3.skipped[0].reason, /already holds a todo a1/);
            assert.deepEqual(ids(archived), ['a1'], 'nothing written');

            assert.match(restoreTodos(live, ['a1']).error ?? '', /Only an archived or deleted todo/);
            assert.match(restoreTodos(archived, ['zz']).skipped[0].reason, /not found/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
