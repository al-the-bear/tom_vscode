/**
 * Tests for the todo archive/delete move operations (TRA01).
 *
 * Strategy: a real on-disk fixture under `os.tmpdir()` holding a source
 * *.todo.yaml file; each test creates a fresh temp dir so tests are
 * fully isolated. The operations are pure fs+yaml (no vscode import),
 * so they run under plain `node --test`.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';

import {
    archiveTodos,
    deleteTodos,
    archiveAllCompleted,
    deleteAllCancelled,
} from '../todoArchive.js';

const SCHEMA_LINE = '# yaml-language-server: $schema=../../schemas/yaml/todo.schema.json';

const SOURCE_YAML = `${SCHEMA_LINE}
quest: "myquest"
created: "2026-01-01"
todos:
  - id: t1
    title: 'Completed one'
    description: First completed todo
    status: completed
    priority: high
    notes: keep these notes
    completed_date: 2026-02-01
    created: 2026-01-01
  - id: t2
    description: In progress todo
    status: in-progress
    created: 2026-01-02
  - id: t3
    description: Cancelled todo
    status: cancelled
    created: 2026-01-03
  - id: t4
    description: Second completed todo
    status: completed
    created: 2026-01-04
  - id: t5
    description: Untouched todo
    status: not-started
    created: 2026-01-05
updated: "2026-01-10"
`;

let tmp: string;
let sourceFile: string;

function readIds(filePath: string): string[] {
    const doc = parseDocument(fs.readFileSync(filePath, 'utf8'));
    const todos = doc.toJSON()?.todos ?? [];
    return todos.map((t: { id: string }) => t.id);
}

function readTodoMap(filePath: string): Record<string, Record<string, unknown>> {
    const doc = parseDocument(fs.readFileSync(filePath, 'utf8'));
    const todos = doc.toJSON()?.todos ?? [];
    const map: Record<string, Record<string, unknown>> = {};
    for (const t of todos) { map[t.id] = t; }
    return map;
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-archive-'));
    sourceFile = path.join(tmp, 'todos.myquest.todo.yaml');
    fs.writeFileSync(sourceFile, SOURCE_YAML, 'utf8');
});

afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('archiveTodos', () => {
    test('moves a completed todo to the -archived sibling with an archived stamp', () => {
        const res = archiveTodos(sourceFile, ['t1']);

        assert.deepEqual(res.moved, ['t1']);
        assert.deepEqual(res.skipped, []);
        assert.equal(res.error, undefined);
        assert.equal(res.targetFile, path.join(tmp, 'todos-archived.myquest.todo.yaml'));

        // Removed from source.
        assert.deepEqual(readIds(sourceFile), ['t2', 't3', 't4', 't5']);

        // Present in target with all fields preserved + archived stamp.
        const target = readTodoMap(res.targetFile);
        const t1 = target['t1'];
        assert.ok(t1, 'moved todo present in target');
        assert.equal(t1.title, 'Completed one');
        assert.equal(t1.description, 'First completed todo');
        assert.equal(t1.status, 'completed');
        assert.equal(t1.priority, 'high');
        assert.equal(t1.notes, 'keep these notes');
        assert.match(String(t1.archived), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('rejects non-completed todos with a per-todo skip', () => {
        const res = archiveTodos(sourceFile, ['t2']);
        assert.deepEqual(res.moved, []);
        assert.equal(res.skipped.length, 1);
        assert.equal(res.skipped[0].id, 't2');
        assert.match(res.skipped[0].reason, /completed/i);
        // Nothing moved; target not created.
        assert.deepEqual(readIds(sourceFile), ['t1', 't2', 't3', 't4', 't5']);
        assert.equal(fs.existsSync(res.targetFile), false);
    });

    test('mixed request: moves eligible, skips ineligible and unknown ids', () => {
        const res = archiveTodos(sourceFile, ['t1', 't2', 'missing']);
        assert.deepEqual(res.moved, ['t1']);
        assert.deepEqual(
            res.skipped.map(s => s.id).sort(),
            ['missing', 't2'],
        );
        const missing = res.skipped.find(s => s.id === 'missing');
        assert.match(missing!.reason, /not found/i);
    });

    test('refuses a source that is already an archived/deleted file', () => {
        const terminal = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(terminal, SOURCE_YAML, 'utf8');
        const res = archiveTodos(terminal, ['t1']);
        assert.ok(res.error, 'error is set');
        assert.deepEqual(res.moved, []);
        assert.equal(res.targetFile, '');
        // Source untouched.
        assert.deepEqual(readIds(terminal), ['t1', 't2', 't3', 't4', 't5']);
    });

    test('reports an error for a nonexistent source file', () => {
        const res = archiveTodos(path.join(tmp, 'nope.q.todo.yaml'), ['t1']);
        assert.ok(res.error);
        assert.deepEqual(res.moved, []);
    });

    test('appends to an existing target file (no clobber)', () => {
        const first = archiveTodos(sourceFile, ['t1']);
        const second = archiveTodos(sourceFile, ['t4']);
        assert.equal(first.targetFile, second.targetFile);
        assert.deepEqual(readIds(first.targetFile).sort(), ['t1', 't4']);
    });

    test('new target file carries the schema comment from the source', () => {
        const res = archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');
        assert.ok(raw.startsWith('# yaml-language-server:'), 'schema comment present');
    });
});

describe('deleteTodos', () => {
    test('moves non-completed todos to the -deleted sibling with a deleted stamp', () => {
        const res = deleteTodos(sourceFile, ['t2', 't3']);
        assert.deepEqual(res.moved, ['t2', 't3']);
        assert.deepEqual(res.skipped, []);
        assert.equal(res.targetFile, path.join(tmp, 'todos-deleted.myquest.todo.yaml'));

        assert.deepEqual(readIds(sourceFile), ['t1', 't4', 't5']);
        const target = readTodoMap(res.targetFile);
        assert.match(String(target['t2'].deleted), /^\d{4}-\d{2}-\d{2}$/);
        assert.match(String(target['t3'].deleted), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('rejects completed todos (completed can only be archived)', () => {
        const res = deleteTodos(sourceFile, ['t1']);
        assert.deepEqual(res.moved, []);
        assert.equal(res.skipped.length, 1);
        assert.equal(res.skipped[0].id, 't1');
        assert.match(res.skipped[0].reason, /archiv/i);
        assert.deepEqual(readIds(sourceFile), ['t1', 't2', 't3', 't4', 't5']);
    });

    test('refuses an archived/deleted source file', () => {
        const terminal = path.join(tmp, 'todos-deleted.myquest.todo.yaml');
        fs.writeFileSync(terminal, SOURCE_YAML, 'utf8');
        const res = deleteTodos(terminal, ['t2']);
        assert.ok(res.error);
        assert.deepEqual(res.moved, []);
    });
});

describe('bulk operations', () => {
    test('archiveAllCompleted moves exactly the completed todos', () => {
        const res = archiveAllCompleted(sourceFile);
        assert.deepEqual(res.moved.sort(), ['t1', 't4']);
        assert.deepEqual(res.skipped, []);
        assert.deepEqual(readIds(sourceFile), ['t2', 't3', 't5']);
        assert.deepEqual(readIds(res.targetFile).sort(), ['t1', 't4']);
    });

    test('deleteAllCancelled moves exactly the cancelled todos', () => {
        const res = deleteAllCancelled(sourceFile);
        assert.deepEqual(res.moved, ['t3']);
        assert.deepEqual(readIds(sourceFile), ['t1', 't2', 't4', 't5']);
        const target = readTodoMap(res.targetFile);
        assert.match(String(target['t3'].deleted), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('bulk no-op when nothing matches: no target file created', () => {
        // Remove all completed first, then archiveAllCompleted again.
        archiveAllCompleted(sourceFile);
        const res = archiveAllCompleted(sourceFile);
        assert.deepEqual(res.moved, []);
        assert.deepEqual(res.skipped, []);
        assert.equal(res.error, undefined);
    });

    test('bulk operations refuse terminal source files', () => {
        const terminal = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(terminal, SOURCE_YAML, 'utf8');
        assert.ok(archiveAllCompleted(terminal).error);
        assert.ok(deleteAllCancelled(terminal).error);
    });
});
