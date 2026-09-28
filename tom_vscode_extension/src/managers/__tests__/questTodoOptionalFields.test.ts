/**
 * Tests for how `updateTodoInFile` clears an optional todo field.
 *
 * The bug this pins: the writer cleared a field with
 * `item.set(key, value || undefined)`. In the `yaml` package that does NOT
 * remove the key — it writes `key: null`. The todo schema types every one of
 * these fields as a string, so `completed_date: null` fails validation with
 * `None is not of type 'string'`, and the pre-commit hook then refuses the
 * commit. Three such keys in `todos.tom_core.todo.yaml` had to be deleted by
 * hand before a commit could go through.
 *
 * An absent optional field must be omitted, not written as null.
 *
 * `questTodoManager` needs `vscode` + a workspace folder, so the shared stub is
 * installed against a temp workspace root before the module is imported.
 */

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-optional-'));

installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { updateTodoInFile } from '../questTodoManager.js';

const todoFile = path.join(tmpRoot, 'todos.optquest.todo.yaml');

const FIXTURE = `quest: optquest
created: "2026-01-01"
updated: "2026-01-01"
todos:
  - id: o1
    title: A completed todo
    description: Has every optional field set
    status: completed
    priority: high
    notes: some notes
    tags:
      - alpha
    completed_date: 2026-02-01
    completed_by: someone
    created: 2026-01-01
`;

beforeEach(() => {
    fs.writeFileSync(todoFile, FIXTURE, 'utf8');
});

after(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Top-level keys of the single todo, as written to disk. */
function keysOnDisk(): string[] {
    const raw = fs.readFileSync(todoFile, 'utf8');
    return raw
        .split('\n')
        .filter(l => /^ {4}[a-z_]+:/.test(l))
        .map(l => l.trim().split(':')[0]);
}

function rawFile(): string {
    return fs.readFileSync(todoFile, 'utf8');
}

describe('clearing an optional field omits the key', () => {
    // Reopening a completed todo is the path that produced the corruption: the
    // panel sends `{status: 'not-started', completed_date: '', completed_by: ''}`.
    test('reopening a todo removes completed_date and completed_by', () => {
        updateTodoInFile(todoFile, 'o1', {
            status: 'not-started',
            completed_date: '',
            completed_by: '',
        });

        const keys = keysOnDisk();
        assert.equal(keys.includes('completed_date'), false, 'completed_date removed');
        assert.equal(keys.includes('completed_by'), false, 'completed_by removed');
        assert.doesNotMatch(rawFile(), /: null/, 'no null-valued key written');
    });

    test('clearing the title, priority and notes removes those keys', () => {
        updateTodoInFile(todoFile, 'o1', { title: '', priority: undefined, notes: '' });

        const keys = keysOnDisk();
        assert.equal(keys.includes('title'), false);
        assert.equal(keys.includes('notes'), false);
        assert.doesNotMatch(rawFile(), /: null/);
    });

    test('clearing tags removes the key rather than writing an empty list', () => {
        updateTodoInFile(todoFile, 'o1', { tags: [] });

        assert.equal(keysOnDisk().includes('tags'), false);
        assert.doesNotMatch(rawFile(), /tags:\s*(null|\[\])/);
    });

    test('the todo still round-trips as a valid todo after clearing', () => {
        const updated = updateTodoInFile(todoFile, 'o1', {
            status: 'not-started',
            completed_date: '',
            completed_by: '',
        });

        assert.ok(updated, 'update returned the todo');
        assert.equal(updated!.status, 'not-started');
        assert.equal(updated!.completed_date, undefined);
        assert.equal(updated!.description, 'Has every optional field set');
    });

    test('setting a value still writes it', () => {
        // The guard against nulls must not become a guard against writes.
        updateTodoInFile(todoFile, 'o1', { completed_date: '2026-03-04', notes: 'new notes' });

        const raw = rawFile();
        assert.match(raw, /completed_date: 2026-03-04/);
        assert.match(raw, /notes: new notes/);
    });

    test('a field not mentioned in the update is left alone', () => {
        updateTodoInFile(todoFile, 'o1', { status: 'in-progress' });

        const keys = keysOnDisk();
        assert.equal(keys.includes('completed_date'), true, 'untouched field survives');
        assert.equal(keys.includes('notes'), true);
    });
});
