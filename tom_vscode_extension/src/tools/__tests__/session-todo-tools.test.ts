/**
 * Tool-impl tests for `session-todo-tools.ts` — the five
 * `tomAi_*SessionTodo*` tools.
 *
 * Strategy: in-memory `SessionTodoStoreAccess` fake (Map-backed,
 * generates `wt-N` ids monotonically; delete removes the item, mirroring
 * the TRA03 move-to-sibling semantics of the live store). The `onMutate`
 * callback is spied so we can assert the side-effect hook fires.
 *
 * Coverage entry #15 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; every
 *      description opens with "session todos ≠ quest todos" and
 *      points at the quest-todo siblings.
 *   b) Ambiguities — covered:
 *        - session-vs-quest distinction is in every description
 *        - `listSessionTodos` vs `getAllSessionTodos` — when to use
 *          which; both tested side-by-side
 *        - status enum values (`pending` / `done`); the YAML
 *          on-disk enum (`not-started` / `completed` / `cancelled`)
 *          is hidden from the tool surface
 *        - id collision: `wt-N` is monotonic, never re-used
 *        - missing id on update/delete returns structured JSON
 *          (was free-form string)
 *   c) Tests via in-memory store fake. Round-trip add → list →
 *      update → delete + observe the `onMutate` hook.
 *   d) Timing — all five typical cases via `withTiming`.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    addSessionTodoImpl,
    deleteSessionTodoImpl,
    getAllSessionTodosImpl,
    listSessionTodosImpl,
    updateSessionTodoImpl,
    type SessionTodoSnapshot,
    type SessionTodoStoreAccess,
    type SessionTodoToolsDeps,
} from '../session-todo-tools.js';

// ---------------------------------------------------------------------------
// In-memory store fake
// ---------------------------------------------------------------------------

interface FakeStore extends SessionTodoStoreAccess {
    items: Map<string, SessionTodoSnapshot>;
    nextSeq: number;
}

function makeStore(seed: SessionTodoSnapshot[] = []): FakeStore {
    const items = new Map<string, SessionTodoSnapshot>(seed.map((s) => [s.id, s]));
    let nextSeq = seed.reduce((m, s) => {
        const n = parseInt(s.id.match(/^wt-(\d+)$/)?.[1] ?? '0', 10);
        return n > m ? n : m;
    }, 0) + 1;
    return {
        items,
        get nextSeq() { return nextSeq; },
        set nextSeq(v: number) { nextSeq = v; },
        add(input) {
            const id = `wt-${nextSeq++}`;
            const now = new Date().toISOString();
            const item: SessionTodoSnapshot = {
                id,
                title: input.title,
                details: input.details,
                priority: input.priority ?? 'medium',
                tags: input.tags ?? [],
                status: 'pending',
                createdAt: now,
                updatedAt: now,
            };
            items.set(id, item);
            return { ...item };
        },
        list(filter) {
            let xs = Array.from(items.values());
            if (filter?.status && filter.status !== 'all') {
                xs = xs.filter((x) => x.status === filter.status);
            }
            if (filter?.tags && filter.tags.length > 0) {
                const tagSet = new Set(filter.tags);
                xs = xs.filter((x) => x.tags.some((t) => tagSet.has(t)));
            }
            return xs.map((x) => ({ ...x }));
        },
        getAll() {
            const todos = Array.from(items.values()).map((x) => ({ ...x }));
            return {
                todos,
                count: todos.length,
                pendingCount: todos.filter((t) => t.status === 'pending').length,
            };
        },
        update(id, updates) {
            const existing = items.get(id);
            if (!existing) { return undefined; }
            const next: SessionTodoSnapshot = {
                ...existing,
                title: updates.title ?? existing.title,
                details: updates.details ?? existing.details,
                priority: updates.priority ?? existing.priority,
                status: updates.status ?? existing.status,
                updatedAt: new Date().toISOString(),
            };
            items.set(id, next);
            return { ...next };
        },
        delete(id) {
            return items.delete(id);
        },
    };
}

interface SpiedDeps extends SessionTodoToolsDeps {
    spy: { mutateCalls: number };
}

function makeDeps(store: FakeStore = makeStore()): SpiedDeps {
    const spy = { mutateCalls: 0 };
    return {
        store,
        spy,
        onMutate: () => { spy.mutateCalls++; },
    };
}

let deps: SpiedDeps;
beforeEach(() => { deps = makeDeps(); });

// ===========================================================================
// add
// ===========================================================================

describe('addSessionTodoImpl', () => {

    test('typical call: creates a wt-N todo, returns the item + fires onMutate', async () => {
        const raw = await withTiming('tomAi_addSessionTodo:typical', () =>
            addSessionTodoImpl(deps, { title: 'fix the build' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'wt-1');
        assert.equal(r.item.title, 'fix the build');
        assert.equal(r.item.status, 'pending');
        assert.equal(r.item.priority, 'medium', 'default priority is medium');
        assert.deepEqual(r.item.tags, []);
        assert.equal(deps.spy.mutateCalls, 1, 'onMutate must fire after a successful add');
    });

    test('id is monotonic — `wt-N` never re-used in a window', async () => {
        const a = JSON.parse(await addSessionTodoImpl(deps, { title: 'a' }));
        const b = JSON.parse(await addSessionTodoImpl(deps, { title: 'b' }));
        const c = JSON.parse(await addSessionTodoImpl(deps, { title: 'c' }));
        assert.deepEqual([a.id, b.id, c.id], ['wt-1', 'wt-2', 'wt-3']);
        // Delete and re-add: new todo gets wt-4, not wt-1 reused
        await deleteSessionTodoImpl(deps, { id: 'wt-1' });
        const d = JSON.parse(await addSessionTodoImpl(deps, { title: 'd' }));
        assert.equal(d.id, 'wt-4');
    });

    test('all options propagate (details, priority, tags)', async () => {
        const r = JSON.parse(await addSessionTodoImpl(deps, {
            title: 't',
            details: 'detail',
            priority: 'high',
            tags: ['blocker', 'frontend'],
        }));
        assert.equal(r.item.details, 'detail');
        assert.equal(r.item.priority, 'high');
        assert.deepEqual(r.item.tags, ['blocker', 'frontend']);
    });

    test('empty title rejected with structured error, no mutate', async () => {
        const r = JSON.parse(await addSessionTodoImpl(deps, { title: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`title` is required/);
        assert.equal(deps.spy.mutateCalls, 0);
    });
});

// ===========================================================================
// list vs getAll
// ===========================================================================

describe('listSessionTodosImpl', () => {

    test('typical call returns {ok, count, items}', async () => {
        await addSessionTodoImpl(deps, { title: 'a' });
        await addSessionTodoImpl(deps, { title: 'b' });
        const raw = await withTiming('tomAi_listSessionTodos:typical', () =>
            listSessionTodosImpl(deps, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 2);
        assert.equal(r.items.length, 2);
    });

    test('status filter narrows the result', async () => {
        await addSessionTodoImpl(deps, { title: 'a' });
        const b = JSON.parse(await addSessionTodoImpl(deps, { title: 'b' }));
        await updateSessionTodoImpl(deps, { id: b.id, status: 'done' });
        const pending = JSON.parse(await listSessionTodosImpl(deps, { status: 'pending' }));
        const done = JSON.parse(await listSessionTodosImpl(deps, { status: 'done' }));
        assert.equal(pending.count, 1);
        assert.equal(pending.items[0].title, 'a');
        assert.equal(done.count, 1);
        assert.equal(done.items[0].title, 'b');
    });

    test('tags filter is any-match', async () => {
        await addSessionTodoImpl(deps, { title: 'a', tags: ['x'] });
        await addSessionTodoImpl(deps, { title: 'b', tags: ['y'] });
        await addSessionTodoImpl(deps, { title: 'c', tags: ['x', 'y'] });
        const filtered = JSON.parse(await listSessionTodosImpl(deps, { tags: ['x'] }));
        assert.equal(filtered.count, 2);   // a + c
    });
});

describe('getAllSessionTodosImpl', () => {

    test('typical call returns {ok, todos, count, pendingCount}', async () => {
        await addSessionTodoImpl(deps, { title: 'a' });
        const b = JSON.parse(await addSessionTodoImpl(deps, { title: 'b' }));
        await updateSessionTodoImpl(deps, { id: b.id, status: 'done' });
        const raw = await withTiming('tomAi_getAllSessionTodos:typical', () =>
            getAllSessionTodosImpl(deps, {}));
        const r = JSON.parse(raw);
        assert.equal(r.count, 2);
        assert.equal(r.pendingCount, 1);
        assert.equal(r.todos.length, 2);
    });

    test('empty list returns count: 0, pendingCount: 0', async () => {
        const r = JSON.parse(await getAllSessionTodosImpl(deps, {}));
        assert.equal(r.count, 0);
        assert.equal(r.pendingCount, 0);
        assert.deepEqual(r.todos, []);
    });
});

// ===========================================================================
// update
// ===========================================================================

describe('updateSessionTodoImpl', () => {

    test('typical call: change status to done, returns updated item + fires onMutate', async () => {
        const added = JSON.parse(await addSessionTodoImpl(deps, { title: 'a' }));
        deps.spy.mutateCalls = 0;
        const raw = await withTiming('tomAi_updateSessionTodo:typical', () =>
            updateSessionTodoImpl(deps, { id: added.id, status: 'done' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.item.status, 'done');
        assert.equal(deps.spy.mutateCalls, 1);
    });

    test('change title + priority simultaneously', async () => {
        const added = JSON.parse(await addSessionTodoImpl(deps, { title: 'old' }));
        const r = JSON.parse(await updateSessionTodoImpl(deps, {
            id: added.id, title: 'new', priority: 'high',
        }));
        assert.equal(r.item.title, 'new');
        assert.equal(r.item.priority, 'high');
    });

    test('MISSING id: structured JSON error pointing at listSessionTodos', async () => {
        const r = JSON.parse(await updateSessionTodoImpl(deps, { id: 'wt-9999' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Session todo "wt-9999" not found/);
        assert.match(r.error, /tomAi_listSessionTodos/);
        assert.equal(deps.spy.mutateCalls, 0, 'no mutate fires on miss');
    });

    test('missing id field returns instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await updateSessionTodoImpl(deps, {} as any));
        assert.match(r.error, /`id` is required/);
    });
});

// ===========================================================================
// delete
// ===========================================================================

describe('deleteSessionTodoImpl', () => {

    test('typical call: deletes, returns deletedId + onMutate', async () => {
        const added = JSON.parse(await addSessionTodoImpl(deps, { title: 'a' }));
        deps.spy.mutateCalls = 0;
        const raw = await withTiming('tomAi_deleteSessionTodo:typical', () =>
            deleteSessionTodoImpl(deps, { id: added.id }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.deletedId, added.id);
        // onMutate fired AFTER successful delete
        assert.equal(deps.spy.mutateCalls, 1);
    });

    test('MISSING id (already gone) returns structured error', async () => {
        const r = JSON.parse(await deleteSessionTodoImpl(deps, { id: 'wt-9999' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Session todo "wt-9999" not found/);
        assert.match(r.error, /tomAi_listSessionTodos/);
    });

    test('missing id field returns instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await deleteSessionTodoImpl(deps, {} as any));
        assert.match(r.error, /`id` is required/);
        // onMutate should NOT have fired
        assert.equal(deps.spy.mutateCalls, 0);
    });
});

// ===========================================================================
// Round-trip — add → list → update → delete (the c-row's requirement)
// ===========================================================================

describe('session-todo — full round-trip', () => {

    test('add → list → update → delete walks the full lifecycle', async () => {
        // 1. add
        const added = JSON.parse(await addSessionTodoImpl(deps, {
            title: 'finish entry #15',
            priority: 'high',
            tags: ['quest', 'coverage'],
        }));
        assert.equal(added.ok, true);
        const id = added.id;

        // 2. list (filtered by tag)
        const listed = JSON.parse(await listSessionTodosImpl(deps, { tags: ['quest'] }));
        assert.equal(listed.count, 1);
        assert.equal(listed.items[0].id, id);

        // 3. getAll for summary
        let summary = JSON.parse(await getAllSessionTodosImpl(deps, {}));
        assert.equal(summary.pendingCount, 1);
        assert.equal(summary.count, 1);

        // 4. update — mark done
        const updated = JSON.parse(await updateSessionTodoImpl(deps, { id, status: 'done' }));
        assert.equal(updated.item.status, 'done');
        summary = JSON.parse(await getAllSessionTodosImpl(deps, {}));
        assert.equal(summary.pendingCount, 0, 'done todo drops pendingCount');
        assert.equal(summary.count, 1, 'done todo stays in the list');

        // 5. delete
        const deleted = JSON.parse(await deleteSessionTodoImpl(deps, { id }));
        assert.equal(deleted.ok, true);
        // After delete the list is empty
        const final = JSON.parse(await listSessionTodosImpl(deps, {}));
        assert.equal(final.count, 0);

        // Verify the lifecycle hook fired correctly across the round-trip
        // (add + update + delete each call onMutate)
        assert.equal(deps.spy.mutateCalls, 3, 'add + update + delete → 3 mutates');
    });
});
