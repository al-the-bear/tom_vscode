/**
 * SCC84 — a todo write that does not reach disk must not be reported as success.
 *
 * THE OBSERVED FAILURE. `tomAi_createQuestTodo` returned `{ok: true}` with the
 * complete todo echoed back in its response, and the todo was in no
 * `*.todo.yaml` file afterwards — archived and deleted siblings included. It was
 * recovered only because a sibling todo's notes happened to mention the id. The
 * information lost was a measured, high-priority interpreter bug.
 *
 * WHAT THE CAUSE IS NOT. The obvious diagnosis is a read-modify-write race
 * between two creates in one burst, and the obvious fix is a mutex keyed on the
 * file path. Measured: `questTodoManager` contains no `async`, `await` or
 * `Promise` at all, so every mutator runs synchronously from `loadDocument` to
 * `writeFileSync` with no suspension point between. Two creates in one extension
 * host CANNOT interleave, and a mutex would serialise what is already serial.
 *
 * The write is therefore lost to a writer outside this process — another
 * extension host over the shared `_ai` clone, a panel saving a stale whole-file
 * buffer, or a git merge driver. None of those is reachable from a lock, and all
 * of them are visible to a read-back. That is what these cases pin.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createRequire } from 'module';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

/**
 * The REAL `fs` module object, not the `import * as fs` namespace.
 *
 * TypeScript compiles the namespace import into a wrapper whose properties are
 * getters, so assigning to it throws "which has only a getter". The wrapper
 * delegates to this object, so patching here is what the module under test
 * actually sees.
 */
const realFs = createRequire(__filename)('fs') as typeof fs;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-lostwrite-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import {
    createTodo, deleteTodo, findTodoById, updateTodo, updateTodoInFile,
} from '../questTodoManager.js';
import type { QuestTodoItem } from '../questTodoManager.js';

const QUEST = 'lostquest';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);
const todoFile = path.join(questDir, `todos.${QUEST}.todo.yaml`);

const FIXTURE = `quest: "${QUEST}"
created: "2026-01-01"
updated: "2026-01-01"
todos:
  - id: pre-existing
    description: Already here
    status: not-started
    created: "2026-01-01"
`;

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
    fs.writeFileSync(todoFile, FIXTURE, 'utf8');
});

/**
 * Stand in for the external writer. `writeFileSync` is patched to drop the
 * payload and restore the file to what it held before — exactly what another
 * process clobbering the file looks like from in here, and indistinguishable
 * from the observed failure.
 */
function withLostWrite<T>(body: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(realFs, 'writeFileSync')!;
    const real = realFs.writeFileSync;
    const before = fs.readFileSync(todoFile, 'utf8');
    Object.defineProperty(realFs, 'writeFileSync', {
        configurable: true,
        writable: true,
        value: (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
            if (String(target) === todoFile) {
                return (real as (...a: unknown[]) => unknown)(target, before, 'utf8');
            }
            return (real as (...a: unknown[]) => unknown)(target, ...rest);
        },
    });
    try {
        return body();
    } finally {
        Object.defineProperty(realFs, 'writeFileSync', descriptor);
    }
}

describe('SCC84: a lost todo write is not reported as success', () => {
    test('F-SCC84-1: createTodo succeeds and the todo is readable back '
        + '[2026-09-07]', () => {
        const created = createTodo(QUEST, {
            id: 'landed-1', description: 'Reaches disk', status: 'not-started',
        });
        assert.equal(created.id, 'landed-1');
        assert.match(fs.readFileSync(todoFile, 'utf8'), /id: landed-1/);
    });

    test('F-SCC84-2: createTodo THROWS when the write is lost, rather than '
        + 'returning the echoed todo [2026-09-07]', () => {
        assert.throws(
            () => withLostWrite(() => createTodo(QUEST, {
                id: 'lost-1', description: 'Never reaches disk', status: 'not-started',
            })),
            /not in todos\.lostquest\.todo\.yaml when the file is read back/,
        );
        // The point of the case: the id really is absent, so the old behaviour
        // would have been a success response for a todo nobody can find.
        assert.doesNotMatch(fs.readFileSync(todoFile, 'utf8'), /id: lost-1/);
    });

    test('F-SCC84-3: deleteTodo THROWS when the removal is lost [2026-09-07]', () => {
        assert.throws(
            () => withLostWrite(() => deleteTodo(QUEST, 'pre-existing')),
            /STILL in todos\.lostquest\.todo\.yaml when the file is read back/,
        );
        assert.match(fs.readFileSync(todoFile, 'utf8'), /id: pre-existing/);
    });

    test('F-SCC84-4: deleteTodo succeeds normally and the todo is gone '
        + '[2026-09-07]', () => {
        assert.equal(deleteTodo(QUEST, 'pre-existing'), true);
        assert.doesNotMatch(fs.readFileSync(todoFile, 'utf8'), /id: pre-existing/);
    });
});

/**
 * SCD202 — a write reported as success must have landed FIELD BY FIELD.
 *
 * SCC84 above verified that the RECORD reached disk. That is the whole answer
 * for a create (missing) and a delete (still there), and no answer at all for
 * an update: a lost update leaves the todo PRESENT with its old content, so
 * presence proves nothing and the caller is told the edit landed while the file
 * holds the previous text. Nothing is absent and no grep comes up empty.
 *
 * THE PLAN WAS TO COMPARE ONE REPRESENTATIVE SCALAR, on the reasoning that
 * structured values would not compare cleanly and a verification that produces
 * false failures gets deleted — taking the working create/delete checks with
 * it. Measured before building: a plain string round-trips byte-for-byte
 * through folded blocks, blank lines, indented continuations, tabs, leading
 * spaces and a trailing newline, and so do string arrays and normalised
 * decisions. Ten of ten cases exactly equal.
 *
 * So the conservative plan was aimed away from the defect, and F-SCD202-1 is
 * why that matters: `createTodo` was dropping `scope`, `references`,
 * `blocked_by`, `completed_date` and `completed_by` outright — its plain-object
 * builder had no branch for them, while `createTodoInFile` beside it did — and
 * returning `{...todo}` so the caller saw every one of them echoed back. A
 * one-scalar comparison never looks at `scope`, and the loss stays invisible.
 *
 * EACH CASE HERE HAS BEEN SEEN TO FAIL:
 *
 *   | Injected fault                                        | Fires |
 *   | ----------------------------------------------------- | ----- |
 *   | createTodo's five-field branch removed again           | 1     |
 *   | updateTodo's field check removed                       | 2, 3  |
 *   | updateTodoInFile's field check removed                 | 5     |
 *   | the `scope` key-order normalisation removed            | 1, 4  |
 *   | "an empty value is a delete" removed                   | 4     |
 *
 * THE LAST TWO ROWS ARE THE POINT OF F-SCD202-4. It asserts that a CORRECT
 * write is not rejected, which reads like a tautology until one of the
 * normalisations is taken away and it goes red — that is the false-failure mode
 * the whole mechanism was nearly abandoned over, reproduced on demand.
 */
describe('SCD202: a field a mutator claims to have written is readable back', () => {
    test('F-SCD202-1: createTodo persists scope, references, blocked_by and '
        + 'the completion fields [2026-09-15]', () => {
        // The red-first case. Before the fix this passed its `ok` response back
        // with all five fields and wrote none of them.
        createTodo(QUEST, {
            id: 'fields-1',
            description: 'Has the structured fields',
            status: 'not-started',
            scope: { projects: ['tom_d4rt'], area: 'mirror', files: ['lib/a.dart'] },
            blocked_by: ['something-else'],
            completed_date: '2026-09-15',
            completed_by: 'claude',
        });

        const onDisk = fs.readFileSync(todoFile, 'utf8');
        assert.match(onDisk, /scope:/, 'scope reached disk');
        assert.match(onDisk, /area: mirror/, 'the scope body reached disk');
        assert.match(onDisk, /blocked_by:/, 'blocked_by reached disk');
        assert.match(onDisk, /completed_by: claude/, 'completed_by reached disk');

        const back = findTodoById(QUEST, 'fields-1');
        assert.deepEqual(back?.scope?.projects, ['tom_d4rt']);
        assert.equal(back?.scope?.area, 'mirror');
        assert.deepEqual(back?.blocked_by, ['something-else']);
        assert.equal(back?.completed_by, 'claude');
    });

    test('F-SCD202-2: updateTodo THROWS when the write is lost, rather than '
        + 'returning the echoed todo [2026-09-15]', () => {
        // The case presence cannot make: the todo is still there afterwards,
        // with its ORIGINAL description, and the old code returned success.
        assert.throws(
            () => withLostWrite(() => updateTodo(QUEST, 'pre-existing', {
                description: 'Edited, but the write is dropped',
                status: 'in-progress',
            })),
            /not readable back from todos\.lostquest\.todo\.yaml/,
        );
        const onDisk = fs.readFileSync(todoFile, 'utf8');
        assert.match(onDisk, /id: pre-existing/, 'the record is still present');
        assert.match(onDisk, /description: Already here/, 'with its OLD content');
    });

    test('F-SCD202-3: the failure names the fields and what each of them '
        + 'actually reads back [2026-09-15]', () => {
        // A verification whose message does not say WHAT differs sends the
        // reader to diff two files by hand, which is where SCC84's own report
        // said the cost is.
        try {
            withLostWrite(() => updateTodo(QUEST, 'pre-existing', {
                description: 'Dropped', status: 'in-progress',
            }));
            assert.fail('expected updateTodo to throw');
        } catch (err) {
            const message = (err as Error).message;
            assert.match(message, /description: wrote "Dropped", read "Already here"/);
            assert.match(message, /status: wrote "in-progress", read "not-started"/);
        }
    });

    test('F-SCD202-4: a correct update of every field shape is NOT rejected '
        + '[2026-09-15]', () => {
        // The case that decides whether this mechanism survives. A false
        // failure here is worse than the gap it closes, so every shape the
        // writer normalises is exercised: a long multi-line block, a string
        // list, a scope whose keys the reader re-orders, decisions that are
        // rewritten on the way in, and an empty value that means DELETE.
        const description = 'FIRST PARAGRAPH, long enough that the emitter has '
            + 'to fold it when writing it back.\n\nSECOND PARAGRAPH.\n'
            + '    an indented continuation\nlast line.';
        const updated = updateTodo(QUEST, 'pre-existing', {
            description,
            title: 'A title',
            status: 'in-progress',
            priority: 'high',
            notes: 'notes\twith a tab and a trailing newline\n',
            tags: ['one', 'two'],
            dependencies: ['dep-a'],
            blocked_by: [],                       // empty means delete
            scope: { area: 'mirror', projects: ['p'], files: ['f'] },
            decisions: [{ summary: 's', decision_needed: 'dn' }],
            completed_date: '2026-09-15',
            completed_by: 'claude',
        });
        assert.equal(updated?.description, description);

        const back = findTodoById(QUEST, 'pre-existing');
        assert.equal(back?.description, description, 'the block survives the round trip');
        assert.equal(back?.notes, 'notes\twith a tab and a trailing newline\n');
        assert.deepEqual(back?.tags, ['one', 'two']);
        assert.equal(back?.scope?.area, 'mirror');
        assert.equal(back?.blocked_by, undefined, 'an empty list is a delete');
    });

    test('F-SCD202-5: updateTodoInFile is held to the same check [2026-09-15]', () => {
        // The second updater. SCD202 was filed as "updateTodo is the one
        // mutator SCC84 left unverified"; measured, there were four — this one,
        // `createTodoInFile`, and both halves of the move helpers. Leaving a
        // second copy of the same defect beside the fixed one is how the next
        // reader concludes the class was handled.
        assert.throws(
            () => withLostWrite(() => updateTodoInFile(todoFile, 'pre-existing', {
                description: 'Also dropped',
            })),
            /not readable back from todos\.lostquest\.todo\.yaml/,
        );
    });

    test('F-SCD202-7: a string reference round-trips instead of becoming '
        + 'unreachable data [2026-09-18] (PASS)', () => {
        // `references` is schema-defined as a list of OBJECTS and the reader
        // mapped only maps, so a list of STRINGS wrote to YAML and read back
        // empty — data that is on disk and unreachable, which is worse than
        // data that was refused.
        //
        // SCD202 made that THROW, which stopped the loss and left the tool
        // rejecting a shape its own description promises to persist. SCE5
        // changed the contract rather than the diagnostic: a bare string is a
        // reference, stored as `{path}` on the way in and read back the same
        // way, so the two forms are one value and the description is true.
        // The failure this case was written for — a write nobody can read —
        // is still impossible; it is now impossible by working.
        assert.doesNotThrow(() => createTodo(QUEST, {
            id: 'refs-strings',
            description: 'string references',
            status: 'not-started',
            references: ['a/path.dart (why)'] as unknown as QuestTodoItem['references'],
        }));
        assert.deepEqual(
            findTodoById(QUEST, 'refs-strings')?.references,
            [{ type: undefined, path: 'a/path.dart (why)', url: undefined, description: undefined, lines: undefined }],
        );
        // The schema-correct shape is unaffected.
        assert.doesNotThrow(() => createTodo(QUEST, {
            id: 'refs-objects',
            description: 'object references',
            status: 'not-started',
            references: [{ type: 'file', path: 'a/path.dart', description: 'why' }],
        }));
        assert.deepEqual(
            findTodoById(QUEST, 'refs-objects')?.references,
            [{ type: 'file', path: 'a/path.dart', url: undefined, description: 'why', lines: undefined }],
        );
    });

    test('F-SCD202-6: a field this cannot compare is skipped, not guessed at '
        + '[2026-09-15]', () => {
        // `created` and `updated` are stamped by the writer rather than taken
        // from the caller, so there is nothing the caller asked for to compare
        // and an attempt to compare would fail on every correct write.
        const before = fs.readFileSync(todoFile, 'utf8');
        assert.doesNotThrow(() => updateTodo(QUEST, 'pre-existing', {
            created: '1999-01-01', updated: '1999-01-01',
        } as Parameters<typeof updateTodo>[2]));
        assert.notEqual(fs.readFileSync(todoFile, 'utf8'), before);
    });
});
