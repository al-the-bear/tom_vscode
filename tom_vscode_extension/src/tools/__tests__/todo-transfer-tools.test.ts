/**
 * tomAi_transferTodos over the real todo manager in a temp workspace.
 *
 *   TT-1  a session todo and a topic-file todo into the quest's own file, found without naming the file
 *   TT-2  into another quest, and from the workspace file back into a quest
 *   TT-3  per-id refusals are reported, the rest still move
 *   TT-4  input errors: no ids, no or two sources, no or two targets, unknown quest
 *   TT-5  registration: a writer, selectable, in the quest-todo category
 *
 * tomAi_renameTodoPrefix (the same module):
 *   RP-1  a dry run answers the renames and writes nothing; applied, the group is renamed with a stub per old id
 *         and the panels are refreshed once
 *   RP-2  input errors (no quest, no `from`, unknown quest) and refusals with their collisions; registration
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
import { RENAME_TODO_PREFIX_TOOL, renameTodoPrefixImpl, TRANSFER_TODOS_TOOL, transferTodosImpl, type RenameTodoPrefixDeps, type RenameTodoPrefixInput, type TransferTodosDeps, type TransferTodosInput } from '../todo-transfer-tools.js';
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

describe('tomAi_renameTodoPrefix', () => {
    let renamed = 0;
    const rdeps: RenameTodoPrefixDeps = {
        questExists: (q) => questTodo.questExists(q),
        renameTodoPrefix: (q, from, to, opts) => questTodo.renameTodoPrefix(q, from, to, opts),
        onMutate: () => { renamed++; },
    };
    const rcall = async (input: Partial<RenameTodoPrefixInput>): Promise<Json> => JSON.parse(await renameTodoPrefixImpl(rdeps, input as RenameTodoPrefixInput));

    test('RP-1: a dry run, then the rename', async () => {
        seed('r1', 'todos.r1.todo.yaml', ['ww1_a-x', 'ww2_a-y']);
        const before = fs.readFileSync(file('r1', 'todos.r1.todo.yaml'), 'utf8');
        const dry = await rcall({ questId: 'r1', from: 'ww', to: 'xx', dryRun: true });
        assert.equal(dry.ok, true);
        assert.equal(dry.dryRun, true);
        assert.deepEqual(dry.renames, [{ from: 'ww1_a-x', to: 'xx1_a-x' }, { from: 'ww2_a-y', to: 'xx2_a-y' }]);
        assert.equal(fs.readFileSync(file('r1', 'todos.r1.todo.yaml'), 'utf8'), before, 'nothing written');
        assert.equal(renamed, 0);
        const r = JSON.parse(await withTiming('tomAi_renameTodoPrefix:typical', () =>
            renameTodoPrefixImpl(rdeps, { questId: 'r1', from: 'ww', to: 'xx' })));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.stubs, 2);
        assert.ok(questTodo.findTodoByIdInFile(file('r1', 'todos.r1.todo.yaml'), 'xx1_a-x'));
        assert.ok(questTodo.findTodoByIdInFile(file('r1', 'todos-deleted.r1.todo.yaml'), 'ww1_a-x'), 'the stub');
        assert.equal(renamed, 1);
    });

    test('RP-2: input errors, refusals, registration', async () => {
        seed('r2', 'todos.r2.todo.yaml', ['aa1_a-x']);
        seed('r2', 'todos-archived.r2.todo.yaml', ['bb1_a-x']);
        assert.match((await rcall({ from: 'aa', to: 'bb' })).error, /questId/);
        assert.match((await rcall({ questId: 'r2', to: 'bb' })).error, /`from`/);
        assert.match((await rcall({ questId: 'nope', from: 'aa', to: 'bb' })).error, /No quest "nope"/);
        const clash = await rcall({ questId: 'r2', from: 'aa', to: 'bb' });
        assert.equal(clash.ok, false);
        assert.deepEqual(clash.collisions, ['bb1_a-x']);
        assert.match((await rcall({ questId: 'r2', from: 'aa', to: 'b9' })).error, /digit/);
        const live = ALL_SHARED_TOOLS.find((t) => t.name === 'tomAi_renameTodoPrefix');
        assert.ok(live, 'registered');
        assert.equal(RENAME_TODO_PREFIX_TOOL.readOnly, false);
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_renameTodoPrefix'));
        assert.ok(Object.values(CATEGORY_MAP).some((names) => names.includes('tomAi_renameTodoPrefix')));
    });
});
