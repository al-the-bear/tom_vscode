/**
 * `on_done` and `filed_by` through the todo manager, the todo tools and the rename tools (ww_a_collab-3; idea
 * agent_collaboration, part-todo-followups).
 *
 *   OM-1 filing a todo (fileTodo, the tools' create): `filed_by` from the registered call context (quest, run
 *        from the session's `@<run>`, session, the walk's claimed todo, the time); a caller's own `filed_by`
 *        replaced; the record reads back with `on_done` and `filed_by`
 *   OM-2 the unblock entries (BP-2): a target in the same quest gets the bare id, one in another quest
 *        `<quest>/<id>`; a completed target gets none; queue targets get none
 *   OM-3 replacing `on_done` drops the entries of the targets it no longer names and adds the new ones; removing
 *        it drops them all
 *   OM-4 cancelling the todo removes its entries from the targets and keeps its `on_done` (nothing else runs);
 *        reopening writes them again (DP-part-todo-followups-2)
 *   OM-5 renaming a target or the filing todo rewrites `on_done.todos` and `filed_by.todo` that name it, in the
 *        quest and across quests, and the dry run counts them
 *   OM-6 the tools: create and update refuse a caller's `filed_by`, an action without the field it needs, and an
 *        unblock / queue target that exists nowhere in its quest; an archived target is accepted; update replaces
 *        `on_done` as a whole; get answers both fields
 *   OM-7 the detail form's save compares `on_done`: a changed block is written, a form without the group changes
 *        nothing
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-on-done-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import {
    createTodoInFile, fileTodo, findTodoById, readTodoFile, renameQuestTodo, setTodoFiledByContextProvider, updateTodo,
    type QuestTodoItem,
} from '../questTodoManager.js';
import { createQuestTodoImpl, getQuestTodoImpl, updateQuestTodoImpl, type QuestTodoToolsDeps } from '../../tools/quest-todo-tools.js';
import { todoFormUnchanged } from '../../utils/todoFormSave.js';

const Q = 'oq';
const OTHER = 'xq';
const qDir = path.join(tmpRoot, '_ai', 'quests', Q);
const oDir = path.join(tmpRoot, '_ai', 'quests', OTHER);
const main = path.join(qDir, `todos.${Q}.todo.yaml`);
const archived = path.join(qDir, `todos-archived.${Q}.todo.yaml`);
const otherMain = path.join(oDir, `todos.${OTHER}.todo.yaml`);

const add = (file: string, id: string, extra: Record<string, unknown> = {}): void => {
    createTodoInFile(file, { id, title: `T ${id}`, description: `do ${id}`, status: 'not-started', ...extra } as never);
};
const todo = (file: string, id: string): QuestTodoItem | undefined => readTodoFile(file).find((t) => t.id === id);
const blockedBy = (file: string, id: string): string[] => todo(file, id)?.blocked_by ?? [];

/** The tools over the real manager, as chat-enhancement-tools wires them. */
const deps: QuestTodoToolsDeps = {
    store: {
        listFiles: () => [],
        listTodos: () => [],
        findById: (q, id) => findTodoById(q, id) as never,
        create: (q, t, f) => fileTodo(q, t as never, f) as never,
        update: (q, id, u) => updateTodo(q, id, u as never) as never,
        move: () => undefined,
        delete: () => false,
    },
};

beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, '_ai'), { recursive: true, force: true });
    fs.mkdirSync(qDir, { recursive: true });
    fs.mkdirSync(oDir, { recursive: true });
    setTodoFiledByContextProvider(() => ({ windowQuest: Q, session: 'idea@collab', claim: { quest: Q, id: 'walk1' } }));
});
after(() => {
    setTodoFiledByContextProvider(undefined);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('on_done and filed_by in the todo manager', () => {
    test('OM-1: filing a todo writes filed_by from the call context', () => {
        add(main, 't1');
        const created = fileTodo(Q, {
            id: 'n1', description: 'd', status: 'not-started',
            on_done: { todos: ['t1'], action: ['notify'], notify_prompt: 'done' },
            filed_by: { quest: 'forged' },
        } as never);
        const read = todo(main, 'n1')!;
        assert.equal(read.filed_by?.quest, Q);
        assert.equal(read.filed_by?.run, 'collab');
        assert.equal(read.filed_by?.session, 'idea');
        assert.equal(read.filed_by?.todo, 'walk1');
        assert.match(read.filed_by?.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
        assert.deepEqual(read.on_done, { todos: ['t1'], action: ['notify'], notify_prompt: 'done' });
        assert.deepEqual(created.filed_by, read.filed_by, 'the answer is what was written');
        assert.deepEqual(blockedBy(main, 't1'), [], 'notify writes no entry');
    });

    test('OM-2: the unblock entries', () => {
        add(main, 't1');
        add(main, 'done1', { status: 'completed' });
        add(main, 'q1');
        add(otherMain, 'far1');
        fileTodo(Q, { id: 'n1', description: 'd', status: 'not-started', on_done: { todos: ['t1', 'done1'], action: ['unblock'] } } as never);
        fileTodo(Q, { id: 'n2', description: 'd', status: 'not-started', on_done: { quest: OTHER, todos: ['far1'], action: ['unblock', 'notify'] } } as never);
        fileTodo(Q, { id: 'n3', description: 'd', status: 'not-started', on_done: { todos: ['q1'], action: ['queue'] } } as never);
        assert.deepEqual(blockedBy(main, 't1'), ['n1']);
        assert.deepEqual(blockedBy(main, 'done1'), [], 'a completed target waits for nothing');
        assert.deepEqual(blockedBy(otherMain, 'far1'), [`${Q}/n2`]);
        assert.deepEqual(blockedBy(main, 'q1'), [], 'queue writes no entry');
        assert.deepEqual(todo(main, 'n1')!.blocking, ['t1'], 'blocking follows by the write\'s own sync');
    });

    test('OM-3: replacing on_done moves the entries', () => {
        add(main, 't1', { blocked_by: ['keep1'] });
        add(main, 't2');
        add(main, 'keep1');
        fileTodo(Q, { id: 'n1', description: 'd', status: 'not-started', on_done: { todos: ['t1'], action: ['unblock'] } } as never);
        assert.deepEqual(blockedBy(main, 't1'), ['keep1', 'n1']);
        updateTodo(Q, 'n1', { on_done: { todos: ['t2'], action: ['unblock'] } });
        assert.deepEqual(blockedBy(main, 't1'), ['keep1'], 'the entry it no longer names goes; others stay');
        assert.deepEqual(blockedBy(main, 't2'), ['n1']);
        updateTodo(Q, 'n1', { on_done: null as never });
        assert.deepEqual(blockedBy(main, 't2'), []);
        assert.equal(todo(main, 'n1')!.on_done, undefined);
    });

    test('OM-4: cancelling removes the entries and keeps on_done', () => {
        add(main, 't1');
        fileTodo(Q, { id: 'n1', description: 'd', status: 'not-started', on_done: { todos: ['t1'], action: ['unblock', 'notify'], instructions: 'x' } } as never);
        updateTodo(Q, 'n1', { status: 'cancelled' });
        assert.deepEqual(blockedBy(main, 't1'), []);
        assert.deepEqual(todo(main, 'n1')!.on_done?.todos, ['t1'], 'the record stays');
        updateTodo(Q, 'n1', { status: 'not-started' });
        assert.deepEqual(blockedBy(main, 't1'), ['n1'], 'reopened: the entry is back');
    });

    test('OM-5: renames rewrite on_done.todos and filed_by.todo', () => {
        add(main, 'tgt1_x-a');
        add(main, 'walk1');
        fileTodo(Q, { id: 'n1', description: 'd', status: 'not-started', on_done: { todos: ['tgt1_x-a'], action: ['unblock'] } } as never);
        fs.writeFileSync(otherMain, `quest: ${OTHER}\ntodos:\n  - id: o1\n    description: d\n    status: not-started\n    on_done:\n      quest: ${Q}\n      todos: [tgt1_x-a]\n      action: [queue]\n    filed_by:\n      quest: ${Q}\n      todo: walk1\n`);
        const dry = renameQuestTodo(Q, 'tgt1_x-a', 'tgt2_x-a', { dryRun: true, committed: new Set() });
        assert.equal(dry.ok, true);
        assert.equal(dry.ok && dry.references, 2, 'the two on_done.todos');
        const r = renameQuestTodo(Q, 'tgt1_x-a', 'tgt2_x-a', { committed: new Set() });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(todo(main, 'n1')!.on_done?.todos, ['tgt2_x-a']);
        assert.deepEqual(blockedBy(main, 'tgt2_x-a'), ['n1']);
        assert.deepEqual(todo(otherMain, 'o1')!.on_done?.todos, ['tgt2_x-a'], 'across quests');
        const w = renameQuestTodo(Q, 'walk1', 'walk2', { committed: new Set() });
        assert.equal(w.ok, true);
        assert.equal(todo(main, 'n1')!.filed_by?.todo, 'walk2');
        assert.equal(todo(otherMain, 'o1')!.filed_by?.todo, 'walk2');
    });

    test('OM-6: the tools', async () => {
        add(main, 't1');
        add(archived, 'old1', { status: 'completed' });
        const call = async (p: Promise<string>): Promise<Record<string, any>> => JSON.parse(await p);
        const forged = await call(createQuestTodoImpl(deps, { questId: Q, todo: { id: 'n1', description: 'd', filed_by: { quest: 'x' } } as never }));
        assert.equal(forged.ok, false);
        assert.match(forged.error, /`filed_by` is written by the todo tools/);
        const noTodos = await call(createQuestTodoImpl(deps, { questId: Q, todo: { id: 'n1', description: 'd', on_done: { action: ['unblock'] } } }));
        assert.match(noTodos.error, /"unblock" needs/);
        const gone = await call(createQuestTodoImpl(deps, { questId: Q, todo: { id: 'n1', description: 'd', on_done: { todos: ['nope'], action: ['queue'] } } }));
        assert.match(gone.error, /"nope"/);
        assert.equal(todo(main, 'n1'), undefined, 'nothing written');
        const ok = await call(createQuestTodoImpl(deps, { questId: Q, todo: { id: 'n1', description: 'd', on_done: { todos: ['t1', 'old1'], action: ['unblock'] } } }));
        assert.equal(ok.ok, true, ok.error);
        assert.equal(ok.todo.filed_by.session, 'idea');
        assert.deepEqual(blockedBy(main, 't1'), ['n1']);
        const upd = await call(updateQuestTodoImpl(deps, { questId: Q, todoId: 'n1', updates: { on_done: { action: ['notify'], notify_prompt: 'p' } } }));
        assert.equal(upd.ok, true, upd.error);
        assert.deepEqual(upd.todo.on_done, { action: ['notify'], notify_prompt: 'p' }, 'replaced as a whole');
        assert.deepEqual(blockedBy(main, 't1'), []);
        const updForged = await call(updateQuestTodoImpl(deps, { questId: Q, todoId: 'n1', updates: { filed_by: {} } as never }));
        assert.equal(updForged.ok, false);
        const get = await call(getQuestTodoImpl(deps, { questId: Q, todoId: 'n1' }));
        assert.equal(get.todo.filed_by.quest, Q);
        assert.deepEqual(get.todo.on_done.action, ['notify']);
    });

    test('OM-7: the detail form compares on_done', () => {
        const current = { title: 't', on_done: { todos: ['a'], action: ['unblock'] } };
        assert.equal(todoFormUnchanged(current, { title: 't' }), true, 'a form without the group');
        assert.equal(todoFormUnchanged(current, { title: 't', on_done: { action: ['unblock'], todos: ['a'] } }), true);
        assert.equal(todoFormUnchanged(current, { title: 't', on_done: { todos: ['b'], action: ['unblock'] } }), false);
        assert.equal(todoFormUnchanged(current, { title: 't', on_done: null }), false, 'cleared');
    });
});
