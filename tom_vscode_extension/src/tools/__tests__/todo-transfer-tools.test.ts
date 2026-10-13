/**
 * tomAi_transferTodos over the real todo manager in a temp workspace.
 *
 *   TT-1  a session todo and a topic-file todo into the quest's own file, found without naming the file
 *   TT-2  into another quest, and from the workspace file back into a quest
 *   TT-3  per-id refusals are reported, the rest still move
 *   TT-4  input errors: no ids, no or two sources, no or two targets, unknown quest
 *   TT-5  registration: a writer, selectable, in the quest-todo category
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-transfer-'));
installVscodeStub({ workspaceFolders: [ws] });

import * as questTodo from '../../managers/questTodoManager.js';
import { TRANSFER_TODOS_TOOL, transferTodosImpl, type TransferTodosDeps, type TransferTodosInput } from '../todo-transfer-tools.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';
import { ALL_SHARED_TOOLS } from '../tool-executors.js';

let mutations = 0;
const deps: TransferTodosDeps = {
    questExists: (q) => questTodo.questExists(q),
    questTodoSourcePath: (q, id, f) => questTodo.questTodoSourcePath(q, id, f),
    workspaceTodoPath: () => questTodo.todoDestinationPath({ kind: 'workspace' }),
    move: (s, id, d, o) => questTodo.moveTodoToDestination(s, id, d, o),
    onMutate: () => { mutations++; },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const call = async (input: Partial<TransferTodosInput>): Promise<Json> => JSON.parse(await transferTodosImpl(deps, input as TransferTodosInput));
const file = (q: string, f: string): string => path.join(ws, '_ai', 'quests', q, f);
const seed = (q: string, f: string, ids: string[]): void => {
    for (const id of ids) { questTodo.createTodoInFile(file(q, f), { id, description: `do ${id}`, status: 'not-started' } as never); }
};

describe('tomAi_transferTodos', () => {
    test('TT-1: into the quest\'s own file, the source file found by id', async () => {
        seed('q1', 'session-todo.mbp.q1.todo.yaml', ['s1']);
        seed('q1', 'topic.q1.todo.yaml', ['t1']);
        const r = JSON.parse(await withTiming('tomAi_transferTodos:typical', () =>
            transferTodosImpl(deps, { sourceQuestId: 'q1', todoIds: ['s1', 't1'], targetQuestId: 'q1' })));
        assert.deepEqual(r, { ok: true, target: 'todos.q1.todo.yaml', moved: ['s1', 't1'] });
        assert.ok(questTodo.findTodoByIdInFile(file('q1', 'todos.q1.todo.yaml'), 's1'));
        assert.ok(questTodo.findTodoByIdInFile(file('q1', 'todos.q1.todo.yaml'), 't1'));
        assert.equal(mutations, 1);
    });

    test('TT-2: into another quest, and from the workspace back into a quest', async () => {
        seed('q2', 'todos.q2.todo.yaml', ['a1']);
        fs.mkdirSync(path.join(ws, '_ai', 'quests', 'q3'), { recursive: true });
        assert.equal((await call({ sourceQuestId: 'q2', todoIds: ['a1'], toWorkspace: true })).target, 'workspace.todo.yaml');
        const back = await call({ fromWorkspace: true, todoIds: ['a1'], targetQuestId: 'q3' });
        assert.deepEqual(back.moved, ['a1']);
        const moved = questTodo.findTodoByIdInFile(file('q3', 'todos.q3.todo.yaml'), 'a1')!;
        assert.match(moved.notes ?? '', /\[moved from quest: q2\]/);
        assert.match(moved.notes ?? '', /\[moved from workspace\]/);
    });

    test('TT-3: refusals are per id', async () => {
        seed('q4', 'todos.q4.todo.yaml', ['b1', 'b2']);
        seed('q5', 'todos.q5.todo.yaml', ['b2']);
        const r = await call({ sourceQuestId: 'q4', todoIds: ['b1', 'b2', 'ghost'], targetQuestId: 'q5' });
        assert.equal(r.ok, true);
        assert.deepEqual(r.moved, ['b1']);
        assert.deepEqual(r.skipped.map((s: Json) => s.id), ['b2', 'ghost']);
        assert.match(r.skipped[0].reason, /already holds a todo b2/);
        assert.ok(questTodo.findTodoByIdInFile(file('q4', 'todos.q4.todo.yaml'), 'b2'), 'a refused todo stays');
        const none = await call({ sourceQuestId: 'q4', todoIds: ['b2'], targetQuestId: 'q4' });
        assert.equal(none.ok, false);
        assert.match(none.skipped[0].reason, /already in todos\.q4\.todo\.yaml/);
    });

    test('TT-4: input errors', async () => {
        assert.match((await call({ sourceQuestId: 'q4', todoIds: [], toWorkspace: true })).error, /at least one/);
        assert.match((await call({ todoIds: ['x'], toWorkspace: true })).error, /exactly one source/);
        assert.match((await call({ sourceQuestId: 'q4', fromWorkspace: true, todoIds: ['x'], toWorkspace: true })).error, /exactly one source/);
        assert.match((await call({ sourceQuestId: 'q4', todoIds: ['x'] })).error, /exactly one target/);
        assert.match((await call({ sourceQuestId: 'q4', todoIds: ['x'], targetQuestId: 'q5', toWorkspace: true })).error, /exactly one target/);
        assert.match((await call({ sourceQuestId: 'nope', todoIds: ['x'], toWorkspace: true })).error, /No quest "nope"/);
        assert.match((await call({ fromWorkspace: true, sourceFile: 'a.todo.yaml', todoIds: ['x'], targetQuestId: 'q4' })).error, /does not apply/);
    });

    test('TT-5: registration', () => {
        const live = ALL_SHARED_TOOLS.find((t) => t.name === 'tomAi_transferTodos');
        assert.ok(live, 'registered');
        assert.equal(live!.readOnly, false);
        assert.equal(TRANSFER_TODOS_TOOL.readOnly, false);
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_transferTodos'));
        assert.ok(Object.values(CATEGORY_MAP).some((names) => names.includes('tomAi_transferTodos')));
    });
});
