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
 *
 * tomAi_renameQuestTodo (the same module):
 *   RQ-1  a dry run counts the references (in the quest, and `<quest>/<id>` in another quest) and writes nothing;
 *         applied, the todo has its new id and `[renamed from …]`, the references follow, the old id is a
 *         cancelled stub in the `-deleted` sibling naming the new one, the panels are refreshed once
 *   RQ-2  refusals, nothing written: empty / spaced / path-character ids (as the todo panel's ID edit), an id the
 *         quest has (an archived one too), its own id without a group, an unknown todo, an unknown quest, a group
 *         that is no prefix; input errors
 *   RQ-3  `group` puts it at the end of that id group; registration
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
import { RENAME_QUEST_TODO_TOOL, RENAME_TODO_PREFIX_TOOL, renameQuestTodoImpl, renameTodoPrefixImpl, TRANSFER_TODOS_TOOL, transferTodosImpl, type RenameQuestTodoDeps, type RenameQuestTodoInput, type RenameTodoPrefixDeps, type RenameTodoPrefixInput, type TransferTodosDeps, type TransferTodosInput } from '../todo-transfer-tools.js';
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

describe('tomAi_renameQuestTodo', () => {
    let refreshed = 0;
    const qdeps: RenameQuestTodoDeps = {
        questExists: (q) => questTodo.questExists(q),
        renameQuestTodo: (q, oldId, newId, opts) => questTodo.renameQuestTodo(q, oldId, newId, opts),
        onMutate: () => { refreshed++; },
    };
    const qcall = async (input: Partial<RenameQuestTodoInput>): Promise<Json> => JSON.parse(await renameQuestTodoImpl(qdeps, input as RenameQuestTodoInput));
    const ids = (q: string, f: string): string[] => questTodo.readTodoFile(file(q, f)).map((t) => t.id);

    test('RQ-1: a dry run, then the rename with its references and stub', async () => {
        seed('n1', 'todos.n1.todo.yaml', ['old1_a-x']);
        questTodo.createTodoInFile(file('n1', 'todos.n1.todo.yaml'), { id: 'after1_a-y', description: 'waits', status: 'blocked', blocked_by: ['old1_a-x'] } as never);
        questTodo.createTodoInFile(file('n2', 'todos.n2.todo.yaml'), { id: 'elsewhere1_a-z', description: 'other quest', status: 'not-started', dependencies: ['n1/old1_a-x'] } as never);
        const before = [fs.readFileSync(file('n1', 'todos.n1.todo.yaml'), 'utf8'), fs.readFileSync(file('n2', 'todos.n2.todo.yaml'), 'utf8')];
        const dry = await qcall({ questId: 'n1', todoId: 'old1_a-x', newId: 'new1_a-x', dryRun: true });
        assert.deepEqual(dry, { ok: true, dryRun: true, file: 'todos.n1.todo.yaml', references: 2, stubFile: 'todos-deleted.n1.todo.yaml', from: 'old1_a-x', to: 'new1_a-x' });
        assert.deepEqual([fs.readFileSync(file('n1', 'todos.n1.todo.yaml'), 'utf8'), fs.readFileSync(file('n2', 'todos.n2.todo.yaml'), 'utf8')], before, 'nothing written');
        assert.equal(fs.existsSync(file('n1', 'todos-deleted.n1.todo.yaml')), false);
        assert.equal(refreshed, 0);
        const r = JSON.parse(await withTiming('tomAi_renameQuestTodo:typical', () =>
            renameQuestTodoImpl(qdeps, { questId: 'n1', todoId: 'old1_a-x', newId: 'new1_a-x' })));
        assert.deepEqual(r, { ok: true, dryRun: false, file: 'todos.n1.todo.yaml', references: 2, stubFile: 'todos-deleted.n1.todo.yaml', from: 'old1_a-x', to: 'new1_a-x' });
        const renamedTodo = questTodo.findTodoByIdInFile(file('n1', 'todos.n1.todo.yaml'), 'new1_a-x') as Json;
        assert.ok(renamedTodo);
        assert.match(renamedTodo.notes, /\[renamed from old1_a-x\]/);
        assert.deepEqual((questTodo.findTodoByIdInFile(file('n1', 'todos.n1.todo.yaml'), 'after1_a-y') as Json).blocked_by, ['new1_a-x']);
        assert.deepEqual((questTodo.findTodoByIdInFile(file('n2', 'todos.n2.todo.yaml'), 'elsewhere1_a-z') as Json).dependencies, ['n1/new1_a-x']);
        const stub = questTodo.findTodoByIdInFile(file('n1', 'todos-deleted.n1.todo.yaml'), 'old1_a-x') as Json;
        assert.equal(stub?.status, 'cancelled', 'the stub');
        assert.match(JSON.stringify(stub), /new1_a-x/);
        assert.equal(refreshed, 1);
    });

    test('RQ-2: refusals and input errors', async () => {
        seed('n3', 'todos.n3.todo.yaml', ['keep1_a-x', 'other1_a-x']);
        seed('n3', 'todos-archived.n3.todo.yaml', ['done1_a-x']);
        const before = fs.readFileSync(file('n3', 'todos.n3.todo.yaml'), 'utf8');
        const refuse = async (input: Partial<RenameQuestTodoInput>, re: RegExp): Promise<void> => {
            const r = await qcall({ questId: 'n3', todoId: 'keep1_a-x', ...input });
            assert.equal(r.ok, false, JSON.stringify(input));
            assert.match(r.error, re);
        };
        await refuse({ newId: '' }, /own id: nothing to rename|Enter the new id/);
        await refuse({ newId: '   ', group: 'keep' }, /Enter the new id/);
        await refuse({ newId: 'two words' }, /one word: no spaces/);
        await refuse({ newId: 'a/b' }, /holds no \/ \\ : \* \? " < > \| # character/);
        await refuse({ newId: 'x#1' }, /holds no/);
        await refuse({ newId: 'other1_a-x' }, /already has a todo other1_a-x/);
        await refuse({ newId: 'done1_a-x' }, /already has a todo done1_a-x \(archived and deleted todos count\)/);
        await refuse({ newId: 'keep1_a-x' }, /own id: nothing to rename/);
        await refuse({ todoId: 'missing1_a-x', newId: 'n9_a-x' }, /missing1_a-x is in no live todo file of quest n3/);
        await refuse({ newId: 'n9_a-x', group: 'g9' }, /group: A prefix holds no digit/);
        assert.match((await qcall({ todoId: 'keep1_a-x', newId: 'x1' })).error, /questId/);
        assert.match((await qcall({ questId: 'n3', newId: 'x1' })).error, /`todoId`/);
        assert.match((await qcall({ questId: 'nope', todoId: 'keep1_a-x', newId: 'x1' })).error, /No quest "nope"/);
        assert.equal(fs.readFileSync(file('n3', 'todos.n3.todo.yaml'), 'utf8'), before, 'nothing written');
        assert.equal(fs.existsSync(file('n3', 'todos-deleted.n3.todo.yaml')), false);
    });

    test('RQ-3: into a group; registration', async () => {
        seed('n4', 'todos.n4.todo.yaml', ['loose1_a-x', 'grp1_a-x', 'grp2_a-x', 'tail1_a-x']);
        const r = await qcall({ questId: 'n4', todoId: 'loose1_a-x', newId: 'grp3_a-x', group: 'grp' });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.group, 'grp');
        assert.deepEqual(ids('n4', 'todos.n4.todo.yaml'), ['grp1_a-x', 'grp2_a-x', 'grp3_a-x', 'tail1_a-x'], 'at the end of its group');
        const live = ALL_SHARED_TOOLS.find((t) => t.name === 'tomAi_renameQuestTodo');
        assert.ok(live, 'registered');
        assert.equal(RENAME_QUEST_TODO_TOOL.readOnly, false);
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_renameQuestTodo'));
        assert.ok(Object.values(CATEGORY_MAP).some((names) => names.includes('tomAi_renameQuestTodo')));
    });
});
