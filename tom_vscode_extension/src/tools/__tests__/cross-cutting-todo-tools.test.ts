/**
 * Tool-impl tests for `cross-cutting-todo-tools.ts` — the cross-cutting
 * todo views (`tomAi_getCombinedTodos`, `tomAi_listWorkspaceQuestTodos`).
 *
 * Strategy: small in-memory fakes — one per dep interface.
 *
 *   - `CombinedTodosSource`: hand-crafted quest items + session items
 *   - `WorkspaceTodosSource`: list of items spanning multiple quests
 *     (so the `byQuest` grouping + cross-quest sort can be asserted)
 *
 * Coverage entry #17 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; `getCombinedTodos`
 *      spells out single-quest scope; `listWorkspaceQuestTodos` says
 *      "every quest".
 *   b) Ambiguities — covered:
 *        - sort order is deterministic (sourceFile, id) / (quest,
 *          sourceFile, id) — pinned by tests
 *        - pagination: maxResults cap + truncated flag tested
 *        - status filter shape: enum on workspace-list, no filter on
 *          getCombined (intentionally)
 *   c) Tests cover a multi-quest fixture (3 quests, 5 todos) for
 *      the workspace lister; multi-file fixture for getCombined.
 *   d) Timing — both typical cases via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    getCombinedTodosImpl,
    listWorkspaceQuestTodosImpl,
    type CombinedQuestTodo,
    type CombinedSessionTodo,
    type CombinedTodosSource,
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
