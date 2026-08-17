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
    decisionsJournalPathFor,
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
    decisions:
      - summary: sqlite or postgres
        decision_needed: Local dev wants sqlite; the fleet needs concurrent writers.
        decision: postgres
      - summary: retry budget
        decision_needed: How many retries before giving up?
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

describe('anyStatus option (panel Archive/Delete buttons)', () => {
    test('archiveTodos with anyStatus moves a non-completed todo', () => {
        const res = archiveTodos(sourceFile, ['t2'], { anyStatus: true });
        assert.deepEqual(res.moved, ['t2']);
        assert.deepEqual(res.skipped, []);
        assert.equal(res.targetFile, path.join(tmp, 'todos-archived.myquest.todo.yaml'));
        assert.deepEqual(readIds(sourceFile), ['t1', 't3', 't4', 't5']);
        assert.match(String(readTodoMap(res.targetFile)['t2'].archived), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('deleteTodos with anyStatus moves a completed todo', () => {
        const res = deleteTodos(sourceFile, ['t1'], { anyStatus: true });
        assert.deepEqual(res.moved, ['t1']);
        assert.deepEqual(res.skipped, []);
        assert.equal(res.targetFile, path.join(tmp, 'todos-deleted.myquest.todo.yaml'));
        assert.deepEqual(readIds(sourceFile), ['t2', 't3', 't4', 't5']);
        assert.match(String(readTodoMap(res.targetFile)['t1'].deleted), /^\d{4}-\d{2}-\d{2}$/);
    });

    test('anyStatus moves a mixed batch (all statuses) in one call', () => {
        const res = deleteTodos(sourceFile, ['t1', 't2', 't5'], { anyStatus: true });
        assert.deepEqual(res.moved.sort(), ['t1', 't2', 't5']);
        assert.deepEqual(res.skipped, []);
        assert.deepEqual(readIds(sourceFile), ['t3', 't4']);
    });

    test('anyStatus still refuses a terminal source file', () => {
        const terminal = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(terminal, SOURCE_YAML, 'utf8');
        const res = archiveTodos(terminal, ['t2'], { anyStatus: true });
        assert.ok(res.error);
        assert.deepEqual(res.moved, []);
    });

    test('anyStatus still reports unknown ids as skipped', () => {
        const res = archiveTodos(sourceFile, ['t2', 'missing'], { anyStatus: true });
        assert.deepEqual(res.moved, ['t2']);
        assert.equal(res.skipped.length, 1);
        assert.equal(res.skipped[0].id, 'missing');
        assert.match(res.skipped[0].reason, /not found/i);
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

describe('decisions journal', () => {
    // Archiving is where a decision would otherwise be lost: the todo leaves the
    // active file and takes its `decisions:` block with it. The journal is the
    // copy that stays behind.
    let journal: string;

    beforeEach(() => {
        journal = decisionsJournalPathFor(sourceFile);
    });

    test('archiving a todo with decisions writes them to decisions.<quest>.md', () => {
        assert.equal(journal, path.join(tmp, 'decisions.myquest.md'));

        archiveTodos(sourceFile, ['t1']);

        assert.equal(fs.existsSync(journal), true, 'journal created');
        const md = fs.readFileSync(journal, 'utf8');
        assert.match(md, /t1/, 'todo id recorded');
        assert.match(md, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'date and time recorded');
        assert.match(md, /sqlite or postgres/);
        assert.match(md, /postgres/);
    });

    test('an unresolved decision is journalled too, marked undecided', () => {
        archiveTodos(sourceFile, ['t1']);
        const md = fs.readFileSync(journal, 'utf8');
        assert.match(md, /retry budget/);
        assert.match(md, /not decided/i);
    });

    test('archiving a todo without decisions writes no journal', () => {
        archiveTodos(sourceFile, ['t4']);
        assert.equal(fs.existsSync(journal), false);
    });

    test('the todo keeps its decisions in the archive file', () => {
        // The journal is a copy, not a move — the archived todo must still be a
        // complete record of itself.
        const res = archiveTodos(sourceFile, ['t1']);
        const archived = readTodoMap(res.targetFile)['t1'];
        assert.equal(Array.isArray(archived.decisions), true);
        assert.equal((archived.decisions as unknown[]).length, 2);
    });

    test('a second archive appends rather than clobbering', () => {
        archiveTodos(sourceFile, ['t1']);
        const first = fs.readFileSync(journal, 'utf8');
        // Give t4 a decision and archive it too.
        const raw = fs.readFileSync(sourceFile, 'utf8').replace(
            '  - id: t4\n    description: Second completed todo\n',
            '  - id: t4\n    description: Second completed todo\n    decisions:\n      - summary: second decision\n        decision: yes\n',
        );
        fs.writeFileSync(sourceFile, raw, 'utf8');
        archiveTodos(sourceFile, ['t4']);

        const md = fs.readFileSync(journal, 'utf8');
        assert.ok(md.startsWith(first), 'earlier entry preserved verbatim at the top');
        assert.match(md, /second decision/);
    });

    test('the header is written once, not per entry', () => {
        archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(sourceFile, 'utf8').replace(
            '  - id: t4\n    description: Second completed todo\n',
            '  - id: t4\n    description: Second completed todo\n    decisions:\n      - summary: second decision\n        decision: yes\n',
        );
        fs.writeFileSync(sourceFile, raw, 'utf8');
        archiveTodos(sourceFile, ['t4']);

        const md = fs.readFileSync(journal, 'utf8');
        assert.equal(md.split('\n').filter(l => l.startsWith('# ')).length, 1);
    });

    test('archiveAllCompleted journals every decision-carrying todo it moves', () => {
        archiveAllCompleted(sourceFile);
        const md = fs.readFileSync(journal, 'utf8');
        assert.match(md, /sqlite or postgres/);
    });

    test('deleting a todo does not journal its decisions', () => {
        // A deleted todo was thrown away; recording its open questions as
        // decisions the project made would be a lie.
        deleteTodos(sourceFile, ['t1'], { anyStatus: true });
        assert.equal(fs.existsSync(journal), false);
    });

    /** Give an existing fixture todo a `decisions:` block. */
    function addDecisionTo(id: string, summary: string): void {
        const raw = fs.readFileSync(sourceFile, 'utf8');
        const anchor = `  - id: ${id}\n`;
        fs.writeFileSync(sourceFile, raw.replace(
            anchor,
            `${anchor}    decisions:\n      - summary: ${summary}\n        decision: yes\n`,
        ), 'utf8');
    }

    test('archiving a todo that is not completed does not journal its decisions', () => {
        // The panel's Archive button archives the user's selection whatever its
        // status. Only a completed todo's decisions are ones the project acted
        // on; an abandoned todo's are questions it never got to.
        addDecisionTo('t2', 'unfinished decision');
        archiveTodos(sourceFile, ['t2'], { anyStatus: true });
        assert.equal(fs.existsSync(journal), false);
    });

    test('a mixed archive journals the completed todo only', () => {
        addDecisionTo('t2', 'unfinished decision');
        archiveTodos(sourceFile, ['t1', 't2'], { anyStatus: true });

        const md = fs.readFileSync(journal, 'utf8');
        assert.match(md, /sqlite or postgres/, 'the completed todo is journalled');
        assert.doesNotMatch(md, /unfinished decision/, 'the in-progress one is not');
    });

    test('the non-completed todo still keeps its decisions in the archive file', () => {
        // Not journalling is about the journal, not about the todo — the
        // archived record stays complete either way.
        addDecisionTo('t2', 'unfinished decision');
        const res = archiveTodos(sourceFile, ['t2'], { anyStatus: true });
        const archived = readTodoMap(res.targetFile)['t2'];
        assert.equal((archived.decisions as unknown[]).length, 1);
    });
});

// The archive is written before the source is rewritten, so a failure between
// the two writes leaves the todo in both files — and the recovery is to run the
// archive again. That recovery is only a recovery if the second run reconciles
// the id it finds already in the archive instead of appending a second copy.
// It did not: `todos-archived.tom_core.todo.yaml` reached 30970 lines with six
// ids present five times over, and the corpus validator reported six
// `duplicate-id` findings. These tests pin the invariant that makes the
// write order safe.
describe('re-archiving is idempotent', () => {
    /** Put the fixture's todos back in the live file, as a failed run would. */
    function restoreSource(): void {
        fs.writeFileSync(sourceFile, SOURCE_YAML, 'utf8');
    }

    test('an id already in the archive is replaced, not appended', () => {
        const first = archiveTodos(sourceFile, ['t1']);
        restoreSource();
        const second = archiveTodos(sourceFile, ['t1']);

        assert.equal(second.targetFile, first.targetFile);
        assert.deepEqual(readIds(second.targetFile), ['t1'], 'exactly one copy');
        assert.deepEqual(readIds(sourceFile), ['t2', 't3', 't4', 't5']);
    });

    test('the replacement is reported so the caller can tell it happened', () => {
        archiveTodos(sourceFile, ['t1']);
        restoreSource();
        const res = archiveTodos(sourceFile, ['t1']);

        assert.deepEqual(res.moved, ['t1']);
        assert.deepEqual(res.replaced, ['t1']);
        assert.deepEqual(res.skipped, []);
    });

    test('a first-time archive reports nothing as replaced', () => {
        const res = archiveTodos(sourceFile, ['t1']);
        assert.deepEqual(res.replaced, []);
    });

    test('the live file wins: the replacement carries the newer content', () => {
        // The point of replacing rather than skipping. The live copy is the one
        // that was still being edited, so it is the one that must survive.
        archiveTodos(sourceFile, ['t1']);
        fs.writeFileSync(
            sourceFile,
            SOURCE_YAML.replace('notes: keep these notes', 'notes: edited after the first archive'),
            'utf8',
        );
        const res = archiveTodos(sourceFile, ['t1']);

        const archived = readTodoMap(res.targetFile)['t1'];
        assert.equal(archived.notes, 'edited after the first archive');
        assert.deepEqual(readIds(res.targetFile), ['t1']);
    });

    test('an archive that already holds duplicates is reconciled to one', () => {
        // The repair path for a file the old writer already corrupted: the
        // surplus copies go when the id is next archived, without a second tool.
        const target = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(target, `${SCHEMA_LINE}
quest: "myquest"
created: "2026-01-01"
updated: "2026-01-02"
todos:
  - id: t1
    description: stale copy one
    status: completed
    archived: 2026-01-02
  - id: t1
    description: stale copy two
    status: completed
    archived: 2026-01-03
  - id: t4
    description: unrelated archived todo
    status: completed
    archived: 2026-01-03
  - id: t1
    description: stale copy three
    status: completed
    archived: 2026-01-04
`, 'utf8');

        const res = archiveTodos(sourceFile, ['t1']);

        assert.deepEqual(res.replaced, ['t1']);
        assert.deepEqual(readIds(res.targetFile), ['t1', 't4'], 'one t1, t4 kept in place');
        assert.equal(readTodoMap(res.targetFile)['t1'].description, 'First completed todo');
    });

    test('the surviving entry keeps its position, so unrelated todos do not move', () => {
        // Replacing in place rather than remove-and-append keeps the archive's
        // ordering stable — otherwise every re-archive reshuffles the file and
        // the diff is unreadable.
        archiveTodos(sourceFile, ['t1']);
        archiveTodos(sourceFile, ['t4']);
        restoreSource();
        const res = archiveTodos(sourceFile, ['t1']);

        assert.deepEqual(readIds(res.targetFile), ['t1', 't4']);
    });

    test('bulk archiveAllCompleted is idempotent too', () => {
        archiveAllCompleted(sourceFile);
        restoreSource();
        const res = archiveAllCompleted(sourceFile);

        assert.deepEqual(res.moved.sort(), ['t1', 't4']);
        assert.deepEqual(res.replaced.sort(), ['t1', 't4']);
        assert.deepEqual(readIds(res.targetFile).sort(), ['t1', 't4']);
    });

    test('deleteTodos reconciles its own sibling the same way', () => {
        // Same writer, same hazard — the -deleted file is not a special case.
        deleteTodos(sourceFile, ['t2']);
        restoreSource();
        const res = deleteTodos(sourceFile, ['t2']);

        assert.deepEqual(res.replaced, ['t2']);
        assert.deepEqual(readIds(res.targetFile), ['t2']);
    });
});

describe('file-level updated key', () => {
    /** Index of the line starting with `key:` at column 0, or -1. */
    function topLevelLine(raw: string, key: string): number {
        return raw.split('\n').findIndex(l => l.startsWith(`${key}:`));
    }

    test('a new target file carries updated in the header, not after the todos', () => {
        // A key appended after a 30000-line `todos:` sequence is still valid
        // YAML, but it reads as a stray line at EOF and is where the duplicate
        // block was noticed.
        const res = archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');

        const updatedAt = topLevelLine(raw, 'updated');
        const todosAt = topLevelLine(raw, 'todos');
        assert.ok(updatedAt >= 0, 'updated present');
        assert.ok(updatedAt < todosAt, `updated (line ${updatedAt}) before todos (line ${todosAt})`);
    });

    test('exactly one file-level updated key is written', () => {
        archiveTodos(sourceFile, ['t1']);
        const res = archiveTodos(sourceFile, ['t4']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');
        assert.equal(raw.split('\n').filter(l => l.startsWith('updated:')).length, 1);
    });

    test('an existing target without updated gains it in the header', () => {
        const target = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(target, `${SCHEMA_LINE}
quest: "myquest"
created: "2026-01-01"
todos:
  - id: old
    description: previously archived
    status: completed
    archived: 2026-01-02
`, 'utf8');

        const res = archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');
        assert.ok(topLevelLine(raw, 'updated') < topLevelLine(raw, 'todos'));
    });

    test('a source file without updated gains it in the header', () => {
        const bare = path.join(tmp, 'todos.bare.todo.yaml');
        fs.writeFileSync(bare, `${SCHEMA_LINE}
quest: "bare"
created: "2026-01-01"
todos:
  - id: b1
    description: done
    status: completed
    created: 2026-01-01
  - id: b2
    description: open
    status: not-started
    created: 2026-01-01
`, 'utf8');

        archiveTodos(bare, ['b1']);
        const raw = fs.readFileSync(bare, 'utf8');
        assert.ok(topLevelLine(raw, 'updated') < topLevelLine(raw, 'todos'));
    });

    test('an existing updated key is rewritten in place, not duplicated', () => {
        // The fixture's own `updated:` sits after the todos list. Wherever it
        // is, there must still be exactly one of it afterwards.
        archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(sourceFile, 'utf8');
        assert.equal(raw.split('\n').filter(l => l.startsWith('updated:')).length, 1);
    });
});

// ============================================================================
// Duplicate keys
// ============================================================================

/**
 * A duplicate map key is illegal YAML that nothing throws on: the parser
 * records it in `doc.errors` and every reader carries on. It only bites on the
 * *next* write, where `doc.toString()` refuses — historically with a message
 * that named neither the file nor the key. Both halves are pinned here: what a
 * write must never produce, and what reaching a pre-broken file must report.
 */
describe('duplicate keys', () => {
    /** Every problem the yaml package found, rendered `line:code`. */
    function parseProblems(filePath: string): string[] {
        return parseDocument(fs.readFileSync(filePath, 'utf8'))
            .errors.map(e => `${e.linePos?.[0]?.line ?? '?'}:${e.code}`);
    }

    /** Occurrences of a `key:` at todo-entry indentation. */
    function keyCount(raw: string, key: string): number {
        return raw.split('\n').filter(l => l.trim().replace(/^- /, '').startsWith(`${key}:`)).length;
    }

    test('archiving a todo that already has completed_date emits exactly one', () => {
        // t1 carries `completed_date: 2026-02-01` in the source. The archive
        // stamp must not re-add a field the entry already had.
        const res = archiveTodos(sourceFile, ['t1']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');

        assert.equal(keyCount(raw, 'completed_date'), 1);
        assert.equal(keyCount(raw, 'archived'), 1);
        assert.deepEqual(parseProblems(res.targetFile), []);
        assert.equal(readTodoMap(res.targetFile)['t1'].completed_date, '2026-02-01');
    });

    test('re-archiving the same todo still emits exactly one completed_date', () => {
        // The recovery path: an interrupted move leaves the todo in both files,
        // so the entry is written into the target a second time.
        archiveTodos(sourceFile, ['t1']);
        fs.writeFileSync(sourceFile, SOURCE_YAML, 'utf8');
        const res = archiveTodos(sourceFile, ['t1']);

        assert.deepEqual(res.replaced, ['t1']);
        const raw = fs.readFileSync(res.targetFile, 'utf8');
        assert.equal(keyCount(raw, 'completed_date'), 1);
        assert.deepEqual(parseProblems(res.targetFile), []);
    });

    test('a pre-broken target archive file is reported with file, line and message', () => {
        const target = path.join(tmp, 'todos-archived.myquest.todo.yaml');
        fs.writeFileSync(target, `${SCHEMA_LINE}
quest: "myquest"
created: "2026-01-01"
todos:
  - id: old
    description: previously archived
    status: completed
    completed_date: 2026-08-09
    notes: some notes
    completed_date: 2026-08-09
    archived: 2026-08-09
`, 'utf8');

        const res = archiveTodos(sourceFile, ['t1']);

        assert.ok(res.error, 'the operation is refused, not silently half-done');
        assert.match(res.error!, /todos-archived\.myquest\.todo\.yaml/);
        assert.match(res.error!, /line 10/);
        assert.match(res.error!, /Map keys must be unique/);
        assert.doesNotMatch(res.error!, /cannot be stringified/);
        assert.deepEqual(res.moved, []);

        // Neither file was touched: the source still holds t1, and the broken
        // target is left exactly as found for a human to repair.
        assert.deepEqual(readIds(sourceFile), ['t1', 't2', 't3', 't4', 't5']);
        assert.deepEqual(parseProblems(target), ['10:DUPLICATE_KEY']);
    });

    test('a pre-broken source file is reported the same way', () => {
        fs.writeFileSync(sourceFile, `${SCHEMA_LINE}
quest: "myquest"
created: "2026-01-01"
todos:
  - id: t1
    description: done
    status: completed
    status: completed
    created: 2026-01-01
`, 'utf8');

        const res = archiveTodos(sourceFile, ['t1']);
        assert.ok(res.error, 'error is set');
        assert.match(res.error!, /todos\.myquest\.todo\.yaml/);
        assert.match(res.error!, /line 8/);
        assert.match(res.error!, /Map keys must be unique/);
        assert.deepEqual(res.moved, []);
    });
});
