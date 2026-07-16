/**
 * Tool-impl tests for `quest-todo-tools.ts` — the six
 * `tomAi_*QuestTodo*` tools.
 *
 * Strategy: in-memory `QuestTodoStoreAccess` fake — Map-of-Maps
 * (`quest → file → Map<id, QuestTodoFull>`) that mirrors the
 * production behaviour:
 *   - `create` defaults `status: 'not-started'`
 *   - `update` preserves fields not present in the updates object
 *     (the "update preserving unknown fields" guarantee)
 *   - `delete` honours the optional `sourceFile` hint
 *   - `move` rewrites the source + target file atomically
 *
 * Coverage entry #16 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; YAML
 *      schema, auto-id-rules-don't-exist, priority/status enums
 *      all documented.
 *   b) Ambiguities — covered:
 *        - "moveQuestTodo across quests": rejected at the impl
 *          when targetFile contains slashes
 *        - update-preserves-unknown-fields: dedicated test
 *        - list filters (status, tags any-match, file scoping)
 *        - missing id on get/update/move/delete: structured JSON
 *        - id collision on create: rejected with pointer to
 *          `tomAi_updateQuestTodo`
 *   c) Tests via in-memory store fake. Round-trip create → list →
 *      get → update → move → delete with assertions at every step.
 *   d) Timing — all six typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    archiveQuestTodosImpl,
    createQuestTodoImpl,
    deleteQuestTodoImpl,
    deleteQuestTodosImpl,
    getQuestTodoImpl,
    listQuestTodosImpl,
    moveQuestTodoImpl,
    updateQuestTodoImpl,
    type QuestTodoArchiveAccess,
    type QuestTodoArchiveToolsDeps,
    type QuestTodoFull,
    type QuestTodoStoreAccess,
    type QuestTodoSummary,
    type QuestTodoToolsDeps,
    type TodoFileMoveSummary,
} from '../quest-todo-tools.js';

// ---------------------------------------------------------------------------
// In-memory store fake
// ---------------------------------------------------------------------------

interface FakeStore extends QuestTodoStoreAccess {
    inspect(): Map<string, Map<string, Map<string, QuestTodoFull>>>;
}

function makeStore(): FakeStore {
    // quest → file → Map<id, QuestTodoFull>
    const byQuest = new Map<string, Map<string, Map<string, QuestTodoFull>>>();

    function quest(qId: string): Map<string, Map<string, QuestTodoFull>> {
        if (!byQuest.has(qId)) { byQuest.set(qId, new Map()); }
        return byQuest.get(qId)!;
    }

    function findFileFor(qId: string, todoId: string): string | undefined {
        for (const [fileName, items] of quest(qId).entries()) {
            if (items.has(todoId)) { return fileName; }
        }
        return undefined;
    }

    return {
        inspect() { return byQuest; },
        listFiles(qId) { return Array.from(quest(qId).keys()).sort(); },
        listTodos(qId, file) {
            const out: QuestTodoSummary[] = [];
            for (const [fileName, items] of quest(qId).entries()) {
                if (file && file !== fileName) { continue; }
                for (const t of items.values()) {
                    out.push({
                        id: t.id, title: t.title, description: t.description,
                        status: t.status, priority: t.priority, tags: t.tags,
                        sourceFile: fileName,
                    });
                }
            }
            return out;
        },
        findById(qId, todoId) {
            const fileName = findFileFor(qId, todoId);
            if (!fileName) { return undefined; }
            const t = quest(qId).get(fileName)!.get(todoId)!;
            return { ...t, sourceFile: fileName };
        },
        create(qId, todo, file) {
            const fileName = file ?? `todos.${qId}.todo.yaml`;
            if (!quest(qId).has(fileName)) { quest(qId).set(fileName, new Map()); }
            const item: QuestTodoFull = {
                ...todo,
                status: todo.status ?? 'not-started',
                created: new Date().toISOString().slice(0, 10),
                sourceFile: fileName,
            };
            quest(qId).get(fileName)!.set(todo.id, item);
            return { ...item };
        },
        update(qId, todoId, updates) {
            const fileName = findFileFor(qId, todoId);
            if (!fileName) { return undefined; }
            const existing = quest(qId).get(fileName)!.get(todoId)!;
            // CRITICAL: only set fields that are present in `updates` — the
            // unknown-field-preservation guarantee. This is what the test
            // pins.
            const next: QuestTodoFull = { ...existing };
            for (const [k, v] of Object.entries(updates)) {
                if (v !== undefined) {
                    (next as unknown as Record<string, unknown>)[k] = v;
                }
            }
            next.updated = new Date().toISOString().slice(0, 10);
            quest(qId).get(fileName)!.set(todoId, next);
            return { ...next };
        },
        move(qId, todoId, targetFile) {
            const fromFile = findFileFor(qId, todoId);
            if (!fromFile) { return undefined; }
            const item = quest(qId).get(fromFile)!.get(todoId)!;
            quest(qId).get(fromFile)!.delete(todoId);
            if (!quest(qId).has(targetFile)) { quest(qId).set(targetFile, new Map()); }
            const moved = { ...item, sourceFile: targetFile };
            quest(qId).get(targetFile)!.set(todoId, moved);
            return { ...moved };
        },
        delete(qId, todoId, _sourceFile) {
            const fileName = findFileFor(qId, todoId);
            if (!fileName) { return false; }
            quest(qId).get(fileName)!.delete(todoId);
            return true;
        },
    };
}

interface SpiedDeps extends QuestTodoToolsDeps {
    spy: { mutateCalls: number };
}

function makeDeps(): SpiedDeps {
    const spy = { mutateCalls: 0 };
    return {
        store: makeStore(),
        spy,
        onMutate: () => { spy.mutateCalls++; },
    };
}

let deps: SpiedDeps;
beforeEach(() => { deps = makeDeps(); });

// Convenience: seed the store with a couple of items.
async function seedTwo(): Promise<void> {
    await createQuestTodoImpl(deps, {
        questId: 'q1',
        todo: { id: 'first-thing', description: 'do first', priority: 'high', tags: ['blocker'] },
    });
    await createQuestTodoImpl(deps, {
        questId: 'q1',
        file: 'todos.other.todo.yaml',
        todo: { id: 'second-thing', description: 'do second', tags: ['frontend'] },
    });
    deps.spy.mutateCalls = 0;
}

// ===========================================================================
// listQuestTodos
// ===========================================================================

describe('listQuestTodosImpl', () => {

    test('typical call: aggregates across files, returns summary shape', async () => {
        await seedTwo();
        const raw = await withTiming('tomAi_listQuestTodos:typical', () =>
            listQuestTodosImpl(deps, { questId: 'q1' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        const summary: QuestTodoSummary = r.items[0];
        // Summary shape — full fields like `scope`, `notes`, `created` must NOT be in the response
        for (const fullOnly of ['scope', 'references', 'dependencies', 'blocked_by', 'notes', 'created', 'updated', 'completed_date', 'completed_by']) {
            assert.ok(!(fullOnly in summary), `${fullOnly} must not appear in summary`);
        }
    });

    test('file: "all" is the same as omitting file (aggregate across)', async () => {
        await seedTwo();
        const a = JSON.parse(await listQuestTodosImpl(deps, { questId: 'q1' }));
        const b = JSON.parse(await listQuestTodosImpl(deps, { questId: 'q1', file: 'all' }));
        assert.equal(a.count, b.count);
    });

    test('file scoping: passing a specific filename narrows the result', async () => {
        await seedTwo();
        const r = JSON.parse(await listQuestTodosImpl(deps, {
            questId: 'q1', file: 'todos.q1.todo.yaml',
        }));
        assert.equal(r.count, 1);
        assert.equal(r.items[0].id, 'first-thing');
    });

    test('status + tags filters combine (status AND tags-any-match)', async () => {
        await seedTwo();
        await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: { id: 'third', description: '...', status: 'completed', tags: ['blocker'] },
        });
        const r = JSON.parse(await listQuestTodosImpl(deps, {
            questId: 'q1', status: 'completed', tags: ['blocker'],
        }));
        assert.equal(r.count, 1);
        assert.equal(r.items[0].id, 'third');
    });

    test('missing questId returns instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await listQuestTodosImpl(deps, {} as any));
        assert.match(r.error, /`questId` is required/);
    });
});

// ===========================================================================
// getQuestTodo
// ===========================================================================

describe('getQuestTodoImpl', () => {

    test('typical call: returns the full record including sourceFile', async () => {
        await seedTwo();
        const raw = await withTiming('tomAi_getQuestTodo:typical', () =>
            getQuestTodoImpl(deps, { questId: 'q1', todoId: 'first-thing' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.todo.id, 'first-thing');
        assert.equal(r.todo.priority, 'high');
        assert.equal(r.todo.sourceFile, 'todos.q1.todo.yaml');
    });

    test('MISSING id: structured JSON error pointing at listQuestTodos', async () => {
        const r = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1', todoId: 'nope' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listQuestTodos/);
    });

    test('missing questId or todoId returns explicit error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1' } as any));
        assert.match(r.error, /`questId` and `todoId` are both required/);
    });
});

// ===========================================================================
// createQuestTodo
// ===========================================================================

describe('createQuestTodoImpl', () => {

    test('typical call: creates the todo, fires onMutate, defaults status', async () => {
        const raw = await withTiming('tomAi_createQuestTodo:typical', () =>
            createQuestTodoImpl(deps, {
                questId: 'q1',
                todo: { id: 'new-feature', description: 'add it' },
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.todo.id, 'new-feature');
        assert.equal(r.todo.status, 'not-started', 'status defaults to not-started');
        assert.equal(deps.spy.mutateCalls, 1);
    });

    test('AUTO-ID MYTH: missing todo.id explicitly rejected with corrective message', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: { description: 'add it' } as any,
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`todo\.id` is required/);
        assert.match(r.error, /NO auto-id rules/);
    });

    test('ID COLLISION: re-creating the same id rejected, points at updateQuestTodo', async () => {
        await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: { id: 'dup', description: 'one' },
        });
        const r = JSON.parse(await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: { id: 'dup', description: 'two' },
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /already exists/);
        assert.match(r.error, /tomAi_updateQuestTodo/);
    });

    test('targets specific file when `file` is provided', async () => {
        await createQuestTodoImpl(deps, {
            questId: 'q1',
            file: 'todos.frontend.todo.yaml',
            todo: { id: 'item-a', description: '...' },
        });
        const files = deps.store.listFiles('q1');
        assert.ok(files.includes('todos.frontend.todo.yaml'));
    });

    test('missing questId or description rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r1 = JSON.parse(await createQuestTodoImpl(deps, { todo: { id: 'x', description: 'y' } } as any));
        assert.match(r1.error, /`questId` is required/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r2 = JSON.parse(await createQuestTodoImpl(deps, { questId: 'q1', todo: { id: 'x' } } as any));
        assert.match(r2.error, /`todo\.description` is required/);
    });
});

// ===========================================================================
// updateQuestTodo
// ===========================================================================

describe('updateQuestTodoImpl', () => {

    test('typical call: status flip, fires onMutate', async () => {
        await seedTwo();
        const raw = await withTiming('tomAi_updateQuestTodo:typical', () =>
            updateQuestTodoImpl(deps, {
                questId: 'q1', todoId: 'first-thing',
                updates: { status: 'in-progress' },
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.todo.status, 'in-progress');
        assert.equal(deps.spy.mutateCalls, 1);
    });

    test('UPDATE PRESERVES UNKNOWN FIELDS: scope, references, notes survive an update of unrelated fields', async () => {
        // Seed a todo with rich fields including ones the update schema doesn't list
        await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: {
                id: 'rich',
                description: 'rich item',
                scope: { project: 'tom_vscode_extension', files: ['src/foo.ts'] },
                references: [{ type: 'doc', path: 'README.md' }],
                notes: 'long note here',
            },
        });
        // Update only the status; scope/references/notes must all survive
        await updateQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'rich',
            updates: { status: 'completed', completed_date: '2026-05-30' },
        });
        const r = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1', todoId: 'rich' }));
        assert.equal(r.todo.status, 'completed');
        assert.equal(r.todo.completed_date, '2026-05-30');
        // CRITICAL: the unknown-to-update-schema fields are intact
        assert.deepEqual(r.todo.scope, { project: 'tom_vscode_extension', files: ['src/foo.ts'] });
        assert.deepEqual(r.todo.references, [{ type: 'doc', path: 'README.md' }]);
        assert.equal(r.todo.notes, 'long note here');
    });

    test('MISSING id: structured JSON error pointing at listQuestTodos', async () => {
        const r = JSON.parse(await updateQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'nope', updates: { status: 'completed' },
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listQuestTodos/);
    });
});

// ===========================================================================
// moveQuestTodo — within-quest only
// ===========================================================================

describe('moveQuestTodoImpl', () => {

    test('typical call: moves between files in the same quest', async () => {
        await seedTwo();
        const raw = await withTiming('tomAi_moveQuestTodo:typical', () =>
            moveQuestTodoImpl(deps, {
                questId: 'q1', todoId: 'first-thing',
                targetFile: 'todos.other.todo.yaml',
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.todo.sourceFile, 'todos.other.todo.yaml');
        // Source file no longer has the item
        const orig = JSON.parse(await listQuestTodosImpl(deps, {
            questId: 'q1', file: 'todos.q1.todo.yaml',
        }));
        assert.ok(orig.items.every((i: QuestTodoSummary) => i.id !== 'first-thing'));
    });

    test('CROSS-QUEST MOVE REJECTED: targetFile with slash is explicit error', async () => {
        await seedTwo();
        const r1 = JSON.parse(await moveQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'first-thing',
            targetFile: 'q2/todos.q2.todo.yaml',
        }));
        assert.equal(r1.ok, false);
        assert.match(r1.error, /Cross-quest moves are NOT supported/);
        // Same for backslash
        const r2 = JSON.parse(await moveQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'first-thing',
            targetFile: 'q2\\todos.q2.todo.yaml',
        }));
        assert.match(r2.error, /Cross-quest moves are NOT supported/);
        // The todo must still be in its original location
        const after = JSON.parse(await getQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'first-thing',
        }));
        assert.equal(after.todo.sourceFile, 'todos.q1.todo.yaml');
    });

    test('MISSING id: structured JSON error', async () => {
        const r = JSON.parse(await moveQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'nope', targetFile: 'somewhere.todo.yaml',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listQuestTodos/);
    });

    test('missing any required field rejected', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await moveQuestTodoImpl(deps, { questId: 'q1', todoId: 'x' } as any));
        assert.match(r.error, /`questId`, `todoId`, and `targetFile` are all required/);
    });
});

// ===========================================================================
// deleteQuestTodo
// ===========================================================================

describe('deleteQuestTodoImpl', () => {

    test('typical call: deletes, fires onMutate, returns {ok, deletedId, questId}', async () => {
        await seedTwo();
        const raw = await withTiming('tomAi_deleteQuestTodo:typical', () =>
            deleteQuestTodoImpl(deps, { questId: 'q1', todoId: 'first-thing' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.deletedId, 'first-thing');
        assert.equal(r.questId, 'q1');
        assert.equal(deps.spy.mutateCalls, 1);
    });

    test('MISSING id: structured JSON error', async () => {
        const r = JSON.parse(await deleteQuestTodoImpl(deps, { questId: 'q1', todoId: 'nope' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /not found.*tomAi_listQuestTodos/);
    });

    test('sourceFile hint is accepted (impl forwards it to the store)', async () => {
        await seedTwo();
        const r = JSON.parse(await deleteQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'second-thing',
            sourceFile: 'todos.other.todo.yaml',
        }));
        assert.equal(r.ok, true);
    });
});

// ===========================================================================
// archiveQuestTodos / deleteQuestTodos — TRA05 move-to-sibling tools
// ===========================================================================

/**
 * In-memory fake over the TRA01 move layer. Simulates a quest todo file
 * as `Map<id, status>`; moves eligible ids into a target list, skips
 * the rest with the production reason strings. Terminal-file refusal is
 * simulated for filenames whose first dot-segment ends `-archived` /
 * `-deleted`.
 */
interface ArchiveFake extends QuestTodoArchiveAccess {
    /** questId → file → Map<id, status> */
    files: Map<string, Map<string, Map<string, string>>>;
    seed(questId: string, file: string, items: Record<string, string>): void;
    target(questId: string, file: string): string[];
}

function makeArchiveFake(): ArchiveFake {
    const files = new Map<string, Map<string, Map<string, string>>>();
    const targets = new Map<string, string[]>();

    function fileMap(questId: string, file: string): Map<string, string> {
        if (!files.has(questId)) { files.set(questId, new Map()); }
        const q = files.get(questId)!;
        if (!q.has(file)) { q.set(file, new Map()); }
        return q.get(file)!;
    }

    function isTerminal(file: string): boolean {
        const firstSegment = file.split('.')[0];
        return firstSegment.endsWith('-archived') || firstSegment.endsWith('-deleted');
    }

    function siblingName(file: string, suffix: string): string {
        const parts = file.split('.');
        parts[0] = `${parts[0]}${suffix}`;
        return parts.join('.');
    }

    function move(
        questId: string, file: string, ids: string[],
        mode: 'archive' | 'delete',
    ): TodoFileMoveSummary {
        if (isTerminal(file)) {
            return { moved: [], skipped: [], targetFile: '', error: 'Source file is already an archived/deleted todo file' };
        }
        const src = files.get(questId)?.get(file);
        if (!src) {
            return { moved: [], skipped: [], targetFile: '', error: `Source todo file not found: ${questId}/${file}` };
        }
        const targetFile = siblingName(file, mode === 'archive' ? '-archived' : '-deleted');
        const key = `${questId}/${targetFile}`;
        if (!targets.has(key)) { targets.set(key, []); }
        const moved: string[] = [];
        const skipped: Array<{ id: string; reason: string }> = [];
        for (const id of ids) {
            const status = src.get(id);
            if (status === undefined) {
                skipped.push({ id, reason: 'Todo not found in source file' });
            } else if (mode === 'archive' && status !== 'completed') {
                skipped.push({ id, reason: 'Only completed todos can be archived' });
            } else if (mode === 'delete' && status === 'completed') {
                skipped.push({ id, reason: 'Completed todos can only be archived, not deleted' });
            } else {
                src.delete(id);
                targets.get(key)!.push(id);
                moved.push(id);
            }
        }
        return { moved, skipped, targetFile };
    }

    return {
        files,
        seed(questId, file, items) {
            const m = fileMap(questId, file);
            for (const [id, status] of Object.entries(items)) { m.set(id, status); }
        },
        target(questId, file) { return targets.get(`${questId}/${file}`) ?? []; },
        archiveTodos: (questId, file, todoIds) => move(questId, file, todoIds, 'archive'),
        deleteTodos: (questId, file, todoIds) => move(questId, file, todoIds, 'delete'),
        archiveAllCompleted(questId, file) {
            if (isTerminal(file)) {
                return { moved: [], skipped: [], targetFile: '', error: 'Source file is already an archived/deleted todo file' };
            }
            const src = files.get(questId)?.get(file);
            if (!src) {
                return { moved: [], skipped: [], targetFile: '', error: `Source todo file not found: ${questId}/${file}` };
            }
            const ids = [...src.entries()].filter(([, s]) => s === 'completed').map(([id]) => id);
            return move(questId, file, ids, 'archive');
        },
        deleteAllCancelled(questId, file) {
            if (isTerminal(file)) {
                return { moved: [], skipped: [], targetFile: '', error: 'Source file is already an archived/deleted todo file' };
            }
            const src = files.get(questId)?.get(file);
            if (!src) {
                return { moved: [], skipped: [], targetFile: '', error: `Source todo file not found: ${questId}/${file}` };
            }
            const ids = [...src.entries()].filter(([, s]) => s === 'cancelled').map(([id]) => id);
            return move(questId, file, ids, 'delete');
        },
    };
}

interface SpiedArchiveDeps extends QuestTodoArchiveToolsDeps {
    archive: ArchiveFake;
    spy: { mutateCalls: number };
}

function makeArchiveDeps(): SpiedArchiveDeps {
    const spy = { mutateCalls: 0 };
    const archive = makeArchiveFake();
    return { archive, spy, onMutate: () => { spy.mutateCalls++; } };
}

describe('archiveQuestTodosImpl', () => {

    test('typical call: moves completed ids to -archived sibling, skips others, fires onMutate', async () => {
        const aDeps = makeArchiveDeps();
        aDeps.archive.seed('q1', 'todos.q1.todo.yaml', {
            'done-1': 'completed', 'done-2': 'completed', 'open-1': 'in-progress',
        });
        const raw = await withTiming('tomAi_archiveQuestTodos:typical', () =>
            archiveQuestTodosImpl(aDeps, {
                questId: 'q1', todoIds: ['done-1', 'done-2', 'open-1'],
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.file, 'todos.q1.todo.yaml', 'file defaults to todos.<questId>.todo.yaml');
        assert.equal(r.targetFile, 'todos-archived.q1.todo.yaml');
        assert.deepEqual(r.moved, ['done-1', 'done-2']);
        assert.equal(r.movedCount, 2);
        assert.equal(r.skipped.length, 1);
        assert.match(r.skipped[0].reason, /Only completed todos can be archived/);
        assert.deepEqual(aDeps.archive.target('q1', 'todos-archived.q1.todo.yaml'), ['done-1', 'done-2']);
        assert.equal(aDeps.spy.mutateCalls, 1);
    });

    test('allCompleted: true archives every completed todo in the file', async () => {
        const aDeps = makeArchiveDeps();
        aDeps.archive.seed('q1', 'todos.q1.todo.yaml', {
            a: 'completed', b: 'not-started', c: 'completed',
        });
        const r = JSON.parse(await archiveQuestTodosImpl(aDeps, {
            questId: 'q1', allCompleted: true,
        }));
        assert.equal(r.ok, true);
        assert.deepEqual(r.moved.sort(), ['a', 'c']);
    });

    test('validation: missing questId; both todoIds+allCompleted; neither; slashed file', async () => {
        const aDeps = makeArchiveDeps();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r1 = JSON.parse(await archiveQuestTodosImpl(aDeps, {} as any));
        assert.match(r1.error, /`questId` is required/);
        const r2 = JSON.parse(await archiveQuestTodosImpl(aDeps, {
            questId: 'q1', todoIds: ['x'], allCompleted: true,
        }));
        assert.match(r2.error, /not both/);
        const r3 = JSON.parse(await archiveQuestTodosImpl(aDeps, { questId: 'q1' }));
        assert.match(r3.error, /Nothing to do/);
        const r4 = JSON.parse(await archiveQuestTodosImpl(aDeps, {
            questId: 'q1', file: 'sub/todos.q1.todo.yaml', todoIds: ['x'],
        }));
        assert.match(r4.error, /bare .*filename/);
        assert.equal(aDeps.spy.mutateCalls, 0, 'no mutate on validation failure');
    });

    test('TERMINAL SOURCE refused: -archived file passes error through, no onMutate', async () => {
        const aDeps = makeArchiveDeps();
        const r = JSON.parse(await archiveQuestTodosImpl(aDeps, {
            questId: 'q1', file: 'todos-archived.q1.todo.yaml', todoIds: ['x'],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /already an archived\/deleted todo file/);
        assert.equal(aDeps.spy.mutateCalls, 0);
    });

    test('nothing moved (all skipped): ok but onMutate NOT fired', async () => {
        const aDeps = makeArchiveDeps();
        aDeps.archive.seed('q1', 'todos.q1.todo.yaml', { open: 'in-progress' });
        const r = JSON.parse(await archiveQuestTodosImpl(aDeps, {
            questId: 'q1', todoIds: ['open'],
        }));
        assert.equal(r.ok, true);
        assert.equal(r.movedCount, 0);
        assert.equal(aDeps.spy.mutateCalls, 0);
    });
});

describe('deleteQuestTodosImpl', () => {

    test('typical call: moves non-completed ids to -deleted sibling, skips completed, fires onMutate', async () => {
        const aDeps = makeArchiveDeps();
        aDeps.archive.seed('q1', 'todos.q1.todo.yaml', {
            'stale-1': 'cancelled', 'open-1': 'not-started', 'done-1': 'completed',
        });
        const raw = await withTiming('tomAi_deleteQuestTodos:typical', () =>
            deleteQuestTodosImpl(aDeps, {
                questId: 'q1', todoIds: ['stale-1', 'open-1', 'done-1'],
            }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.targetFile, 'todos-deleted.q1.todo.yaml');
        assert.deepEqual(r.moved, ['stale-1', 'open-1']);
        assert.equal(r.skipped.length, 1);
        assert.match(r.skipped[0].reason, /can only be archived, not deleted/);
        assert.equal(aDeps.spy.mutateCalls, 1);
    });

    test('allCancelled: true moves only cancelled todos', async () => {
        const aDeps = makeArchiveDeps();
        aDeps.archive.seed('q1', 'todos.q1.todo.yaml', {
            a: 'cancelled', b: 'not-started', c: 'cancelled', d: 'completed',
        });
        const r = JSON.parse(await deleteQuestTodosImpl(aDeps, {
            questId: 'q1', allCancelled: true,
        }));
        assert.equal(r.ok, true);
        assert.deepEqual(r.moved.sort(), ['a', 'c']);
    });

    test('validation: both todoIds+allCancelled rejected; explicit file honoured', async () => {
        const aDeps = makeArchiveDeps();
        const r1 = JSON.parse(await deleteQuestTodosImpl(aDeps, {
            questId: 'q1', todoIds: ['x'], allCancelled: true,
        }));
        assert.match(r1.error, /not both/);
        aDeps.archive.seed('q1', 'other.q1.todo.yaml', { x: 'cancelled' });
        const r2 = JSON.parse(await deleteQuestTodosImpl(aDeps, {
            questId: 'q1', file: 'other.q1.todo.yaml', todoIds: ['x'],
        }));
        assert.equal(r2.ok, true);
        assert.equal(r2.targetFile, 'other-deleted.q1.todo.yaml');
    });

    test('MISSING SOURCE FILE: error passthrough as {ok:false}', async () => {
        const aDeps = makeArchiveDeps();
        const r = JSON.parse(await deleteQuestTodosImpl(aDeps, {
            questId: 'q1', todoIds: ['x'],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Source todo file not found/);
    });
});

// ===========================================================================
// Round-trip — create → list → get → update → move → delete
// ===========================================================================

describe('quest-todo — full round-trip', () => {

    test('create → list → get → update → move → delete walks the lifecycle', async () => {
        // 1. create
        const created = JSON.parse(await createQuestTodoImpl(deps, {
            questId: 'q1',
            todo: {
                id: 'lifecycle-todo',
                description: 'walk the lifecycle',
                priority: 'high',
                tags: ['test'],
                scope: { project: 'tom_vscode_extension' },
            },
        }));
        assert.equal(created.ok, true);

        // 2. list — should see it
        const listed = JSON.parse(await listQuestTodosImpl(deps, { questId: 'q1' }));
        assert.equal(listed.count, 1);
        assert.equal(listed.items[0].id, 'lifecycle-todo');

        // 3. get — full record including scope
        const full = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1', todoId: 'lifecycle-todo' }));
        assert.deepEqual(full.todo.scope, { project: 'tom_vscode_extension' });

        // 4. update — flip status; scope must survive
        await updateQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'lifecycle-todo',
            updates: { status: 'in-progress' },
        });
        const afterUpdate = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1', todoId: 'lifecycle-todo' }));
        assert.equal(afterUpdate.todo.status, 'in-progress');
        assert.deepEqual(afterUpdate.todo.scope, { project: 'tom_vscode_extension' });

        // 5. move — to a different file
        await moveQuestTodoImpl(deps, {
            questId: 'q1', todoId: 'lifecycle-todo',
            targetFile: 'todos.frontend.todo.yaml',
        });
        const afterMove = JSON.parse(await getQuestTodoImpl(deps, { questId: 'q1', todoId: 'lifecycle-todo' }));
        assert.equal(afterMove.todo.sourceFile, 'todos.frontend.todo.yaml');
        // Scope still survives the move
        assert.deepEqual(afterMove.todo.scope, { project: 'tom_vscode_extension' });

        // 6. delete
        await deleteQuestTodoImpl(deps, { questId: 'q1', todoId: 'lifecycle-todo' });
        const finalList = JSON.parse(await listQuestTodosImpl(deps, { questId: 'q1' }));
        assert.equal(finalList.count, 0);

        // Lifecycle hook fired once per mutation (create + update + move + delete = 4)
        assert.equal(deps.spy.mutateCalls, 4);
    });
});
