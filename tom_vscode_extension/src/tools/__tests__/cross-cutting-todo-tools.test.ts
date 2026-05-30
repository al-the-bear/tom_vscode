/**
 * Tool-impl tests for `cross-cutting-todo-tools.ts` — the three
 * cross-cutting todo views (`tomAi_getCombinedTodos`,
 * `tomAi_listWorkspaceQuestTodos`, `tomAi_manageTodo`).
 *
 * Strategy: three small in-memory fakes — one per dep interface.
 *
 *   - `CombinedTodosSource`: hand-crafted quest items + session items
 *   - `WorkspaceTodosSource`: list of items spanning multiple quests
 *     (so the `byQuest` grouping + cross-quest sort can be asserted)
 *   - `ChatTodoSessionResolver`: returns `null` for the "legacy tool
 *     needs an active chat session" path; returns a recording fake
 *     for the operation tests
 *
 * Coverage entry #17 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; `getCombinedTodos`
 *      spells out single-quest scope; `listWorkspaceQuestTodos` says
 *      "every quest"; `manageTodo` is marked **LEGACY** with pointers.
 *   b) Ambiguities — covered:
 *        - sort order is deterministic (sourceFile, id) / (quest,
 *          sourceFile, id) — pinned by tests
 *        - pagination: maxResults cap + truncated flag tested
 *        - status filter shape: enum on workspace-list, 3-enum on
 *          manageTodo, no-filter on getCombined (intentionally)
 *        - missing-session error path on manageTodo carries a
 *          pointer at the alternative tool families
 *   c) Tests cover a multi-quest fixture (3 quests, 5 todos) for
 *      the workspace lister; multi-file fixture for getCombined.
 *   d) Timing — all three typical cases via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    getCombinedTodosImpl,
    listWorkspaceQuestTodosImpl,
    manageTodoImpl,
    type ChatTodoSession,
    type ChatTodoSessionResolver,
    type CombinedQuestTodo,
    type CombinedSessionTodo,
    type CombinedTodosSource,
    type LegacyChatTodoItem,
    type LegacyTodoResult,
    type LegacyTodoStatus,
    type ManageTodoInput,
    type WorkspaceQuestTodo,
    type WorkspaceTodosSource,
} from '../cross-cutting-todo-tools.js';

// ===========================================================================
// getCombinedTodos
// ===========================================================================

function makeCombinedSource(
    questItems: CombinedQuestTodo[],
    sessionItems: CombinedSessionTodo[],
): CombinedTodosSource & { calls: Array<{ method: string; args: unknown[] }> } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
        calls,
        questTodos(questId) {
            calls.push({ method: 'questTodos', args: [questId] });
            return questItems;
        },
        sessionTodos() {
            calls.push({ method: 'sessionTodos', args: [] });
            return sessionItems;
        },
    };
}

describe('getCombinedTodosImpl', () => {

    test('typical call: returns quest + session items with full envelope', async () => {
        const src = makeCombinedSource(
            [
                { id: 'a', description: 'Item A', status: 'not-started', priority: 'medium', sourceFile: 'todos.q1.todo.yaml' },
                { id: 'b', description: 'Item B', status: 'in-progress', priority: 'high', sourceFile: 'todos.q1.todo.yaml' },
            ],
            [
                { id: 'wt-1', title: 'session 1', status: 'pending', priority: 'medium', tags: [], source: 'copilot' },
            ],
        );
        const raw = await withTiming('tomAi_getCombinedTodos:typical', () =>
            getCombinedTodosImpl(src, { questId: 'q1' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.questId, 'q1');
        assert.equal(r.questTodos.length, 2);
        assert.equal(r.sessionTodos.length, 1);
        // `description` is now in the response (was dropped in the old impl)
        assert.equal(r.questTodos[0].description, 'Item A');
        // session items include `details` field — none here, so undefined OK
        assert.equal(r.counts.questTotal, 2);
        assert.equal(r.counts.sessionTotal, 1);
        assert.equal(r.counts.returned, 3);
        assert.equal(r.truncated, false);
    });

    test('SORT ORDER: items sorted by (sourceFile, id) — deterministic across runs', async () => {
        const src = makeCombinedSource(
            [
                { id: 'z-last', description: '...', status: 'not-started', sourceFile: 'todos.aaa.todo.yaml' },
                { id: 'a-first', description: '...', status: 'not-started', sourceFile: 'todos.bbb.todo.yaml' },
                { id: 'm-mid', description: '...', status: 'not-started', sourceFile: 'todos.aaa.todo.yaml' },
            ],
            [],
        );
        const r = JSON.parse(await getCombinedTodosImpl(src, { questId: 'q1' }));
        const order = r.questTodos.map((t: CombinedQuestTodo) => `${t.sourceFile}/${t.id}`);
        // sourceFile aaa < bbb, and within aaa: m-mid < z-last alphabetically
        assert.deepEqual(order, [
            'todos.aaa.todo.yaml/m-mid',
            'todos.aaa.todo.yaml/z-last',
            'todos.bbb.todo.yaml/a-first',
        ]);
    });

    test('PAGINATION: maxResults caps + truncated:true fires', async () => {
        const quest = Array.from({ length: 100 }, (_, i) => ({
            id: `t${String(i).padStart(3, '0')}`, description: '...', status: 'not-started' as const,
            sourceFile: 'todos.q1.todo.yaml',
        }));
        const session: CombinedSessionTodo[] = [];
        const src = makeCombinedSource(quest, session);
        const r = JSON.parse(await getCombinedTodosImpl(src, { questId: 'q1', maxResults: 10 }));
        assert.equal(r.counts.returned, 10);
        assert.equal(r.counts.questTotal, 100);
        assert.equal(r.truncated, true);
        assert.equal(r.questTodos.length, 10);
    });

    test('SOURCES grouping: count per sourceFile in the response', async () => {
        const src = makeCombinedSource(
            [
                { id: 'a', description: '...', status: 'not-started', sourceFile: 'todos.q1.todo.yaml' },
                { id: 'b', description: '...', status: 'not-started', sourceFile: 'todos.q1.todo.yaml' },
                { id: 'c', description: '...', status: 'not-started', sourceFile: 'todos.frontend.todo.yaml' },
            ],
            [],
        );
        const r = JSON.parse(await getCombinedTodosImpl(src, { questId: 'q1' }));
        const map = Object.fromEntries(r.sources.map((s: { file: string; count: number }) => [s.file, s.count]));
        assert.deepEqual(map, {
            'todos.q1.todo.yaml': 2,
            'todos.frontend.todo.yaml': 1,
        });
    });

    test('missing questId returns instructive error', async () => {
        const src = makeCombinedSource([], []);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await getCombinedTodosImpl(src, {} as any));
        assert.match(r.error, /`questId` is required/);
        assert.equal(src.calls.length, 0);
    });

    test('empty results: returned: 0, both counts 0', async () => {
        const src = makeCombinedSource([], []);
        const r = JSON.parse(await getCombinedTodosImpl(src, { questId: 'q1' }));
        assert.equal(r.ok, true);
        assert.equal(r.counts.returned, 0);
        assert.equal(r.truncated, false);
    });
});

// ===========================================================================
// listWorkspaceQuestTodos — multi-quest fixture
// ===========================================================================

const MULTI_QUEST_FIXTURE: WorkspaceQuestTodo[] = [
    // Quest "q-c" (last alphabetically)
    { questId: 'q-c', id: 'q-c-1', description: 'q-c first', status: 'completed', sourceFile: 'q-c/todos.q-c.todo.yaml' },
    // Quest "q-a" (first alphabetically)
    { questId: 'q-a', id: 'q-a-2', description: 'q-a second', status: 'in-progress', sourceFile: 'q-a/todos.q-a.todo.yaml' },
    { questId: 'q-a', id: 'q-a-1', description: 'q-a first', status: 'not-started', sourceFile: 'q-a/todos.q-a.todo.yaml' },
    // Quest "q-b"
    { questId: 'q-b', id: 'q-b-1', description: 'q-b first', status: 'blocked', sourceFile: 'q-b/todos.q-b.todo.yaml' },
    { questId: 'q-b', id: 'q-b-2', description: 'q-b second', status: 'completed', sourceFile: 'q-b/todos.q-b.todo.yaml' },
];

function makeWorkspaceSource(items: WorkspaceQuestTodo[] = MULTI_QUEST_FIXTURE): WorkspaceTodosSource & { listCalls: number } {
    let listCalls = 0;
    return {
        get listCalls() { return listCalls; },
        listAll() { listCalls++; return items; },
    };
}

describe('listWorkspaceQuestTodosImpl', () => {

    test('typical call: aggregates across quests with byQuest grouping', async () => {
        const src = makeWorkspaceSource();
        const raw = await withTiming('tomAi_listWorkspaceQuestTodos:typical', () =>
            listWorkspaceQuestTodosImpl(src, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 5);
        assert.equal(r.totalAvailable, 5);
        assert.equal(r.truncated, false);
        assert.deepEqual(r.byQuest, { 'q-a': 2, 'q-b': 2, 'q-c': 1 });
    });

    test('CROSS-QUEST SORT: items sorted by (questId, sourceFile, id) — stable across runs', async () => {
        const src = makeWorkspaceSource();
        const r = JSON.parse(await listWorkspaceQuestTodosImpl(src, {}));
        const order = r.items.map((t: WorkspaceQuestTodo) => `${t.questId}/${t.id}`);
        // questId asc: q-a, q-a, q-b, q-b, q-c; within q-a sorted by id (q-a-1 < q-a-2)
        assert.deepEqual(order, [
            'q-a/q-a-1', 'q-a/q-a-2',
            'q-b/q-b-1', 'q-b/q-b-2',
            'q-c/q-c-1',
        ]);
    });

    test('STATUS FILTER (proper enum): completed only', async () => {
        const src = makeWorkspaceSource();
        const r = JSON.parse(await listWorkspaceQuestTodosImpl(src, { status: 'completed' }));
        assert.equal(r.count, 2);
        assert.ok(r.items.every((t: WorkspaceQuestTodo) => t.status === 'completed'));
        assert.deepEqual(r.byQuest, { 'q-b': 1, 'q-c': 1 });
    });

    test('PAGINATION: maxResults cap + truncated', async () => {
        const src = makeWorkspaceSource();
        const r = JSON.parse(await listWorkspaceQuestTodosImpl(src, { maxResults: 2 }));
        assert.equal(r.count, 2);
        assert.equal(r.totalAvailable, 5);
        assert.equal(r.truncated, true);
        // byQuest reflects the FULL set, not the truncated slice — important
        // for the model deciding whether to drill deeper into a quest.
        assert.deepEqual(r.byQuest, { 'q-a': 2, 'q-b': 2, 'q-c': 1 });
    });

    test('empty workspace returns clean response', async () => {
        const r = JSON.parse(await listWorkspaceQuestTodosImpl(makeWorkspaceSource([]), {}));
        assert.equal(r.count, 0);
        assert.deepEqual(r.byQuest, {});
        assert.deepEqual(r.items, []);
    });
});

// ===========================================================================
// manageTodo — legacy chat-session todo manager
// ===========================================================================

function makeSessionFake(initial: LegacyChatTodoItem[] = []): ChatTodoSession & { items: LegacyChatTodoItem[] } {
    let items = [...initial];
    let nextId = items.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    return {
        get items() { return items; },
        async list(filter): Promise<LegacyTodoResult> {
            const filtered = filter ? items.filter((t) => t.status === filter) : items;
            return { message: `${filtered.length} todo(s)`, todos: filtered };
        },
        async add(title, description): Promise<LegacyTodoResult> {
            const item: LegacyChatTodoItem = { id: nextId++, title, description, status: 'not-started' };
            items.push(item);
            return { message: 'added', todos: items };
        },
        async update(id, updates): Promise<LegacyTodoResult> {
            const idx = items.findIndex((t) => t.id === id);
            if (idx === -1) { return { message: `id ${id} not found`, todos: items }; }
            items[idx] = {
                ...items[idx],
                title: updates.title ?? items[idx].title,
                description: updates.description ?? items[idx].description,
                status: updates.status ?? items[idx].status,
            };
            return { message: 'updated', todos: items };
        },
        async remove(id): Promise<LegacyTodoResult> {
            const before = items.length;
            items = items.filter((t) => t.id !== id);
            return { message: items.length < before ? 'removed' : `id ${id} not found`, todos: items };
        },
        async clear(): Promise<LegacyTodoResult> {
            items = [];
            return { message: 'cleared', todos: items };
        },
    };
}

function makeResolver(session: ChatTodoSession | null): ChatTodoSessionResolver {
    return { current: () => session };
}

describe('manageTodoImpl', () => {

    test('NO ACTIVE SESSION: returns clear error with pointers to alternative tool families', async () => {
        const raw = await withTiming('tomAi_manageTodo:typical', () =>
            manageTodoImpl(makeResolver(null), { operation: 'list' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, false);
        assert.match(r.error, /No active Tom AI Chat session/);
        // CRITICAL: error suggests both alternatives explicitly
        assert.match(r.error, /tomAi_addSessionTodo/);
        assert.match(r.error, /tomAi_createQuestTodo/);
    });

    test('add → list → update → remove → clear walks the legacy lifecycle', async () => {
        const session = makeSessionFake();
        const resolver = makeResolver(session);

        // add
        let r = JSON.parse(await manageTodoImpl(resolver, { operation: 'add', title: 'first' }));
        assert.equal(r.ok, true);
        assert.equal(r.operation, 'add');
        assert.equal(r.todos.length, 1);

        // add another
        await manageTodoImpl(resolver, { operation: 'add', title: 'second', description: 'with desc' });

        // list
        r = JSON.parse(await manageTodoImpl(resolver, { operation: 'list' }));
        assert.equal(r.todos.length, 2);

        // update (status flip)
        const id = (r.todos[0] as LegacyChatTodoItem).id;
        r = JSON.parse(await manageTodoImpl(resolver, { operation: 'update', id, status: 'completed' }));
        assert.equal(r.todos.find((t: LegacyChatTodoItem) => t.id === id)!.status, 'completed');

        // filterStatus on list
        r = JSON.parse(await manageTodoImpl(resolver, { operation: 'list', filterStatus: 'completed' }));
        assert.equal(r.todos.length, 1);

        // remove
        r = JSON.parse(await manageTodoImpl(resolver, { operation: 'remove', id }));
        assert.equal(r.todos.length, 1);

        // clear
        r = JSON.parse(await manageTodoImpl(resolver, { operation: 'clear' }));
        assert.equal(r.todos.length, 0);
    });

    test('add without title → instructive error', async () => {
        const session = makeSessionFake();
        const r = JSON.parse(await manageTodoImpl(makeResolver(session), { operation: 'add' }));
        assert.match(r.error, /`title` is required for `operation: "add"`/);
    });

    test('update without id → instructive error', async () => {
        const session = makeSessionFake();
        const r = JSON.parse(await manageTodoImpl(makeResolver(session), { operation: 'update', status: 'completed' }));
        assert.match(r.error, /`id` is required for `operation: "update"`/);
    });

    test('remove without id → instructive error', async () => {
        const session = makeSessionFake();
        const r = JSON.parse(await manageTodoImpl(makeResolver(session), { operation: 'remove' }));
        assert.match(r.error, /`id` is required for `operation: "remove"`/);
    });

    test('unknown operation → instructive error with allowed list', async () => {
        const session = makeSessionFake();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await manageTodoImpl(makeResolver(session), { operation: 'nope' as any }));
        assert.match(r.error, /Unknown operation: nope/);
        assert.match(r.error, /list, add, update, remove, clear/);
    });

    test('JSON envelope (not the legacy emoji text)', async () => {
        const session = makeSessionFake();
        const r = JSON.parse(await manageTodoImpl(makeResolver(session), { operation: 'list' }));
        // Old impl returned text like "0 todos\n\n**Current Todos:**\n..."
        // New impl returns JSON; check keys.
        for (const key of ['ok', 'operation', 'message', 'todos']) {
            assert.ok(key in r, `missing key: ${key}`);
        }
    });

    test('legacy 3-status enum honoured (no `blocked` / `cancelled`)', async () => {
        const session = makeSessionFake([{ id: 1, title: 'x', status: 'not-started' }]);
        // The TS type only allows the 3-status enum; this is the documented behaviour
        const valid: LegacyTodoStatus[] = ['not-started', 'in-progress', 'completed'];
        for (const status of valid) {
            const r = JSON.parse(await manageTodoImpl(makeResolver(session), {
                operation: 'update', id: 1, status,
            } as ManageTodoInput));
            assert.equal(r.ok, true);
        }
    });
});
