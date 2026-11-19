/**
 * Todo groups through the todo manager and the tools (vscimpb125).
 *
 *   TGM-1 comprised_of is written and read back; part_of is derived (bare in the same quest, `<quest>/<id>` across)
 *          and never written
 *   TGM-2 the group completes when its last member is done (notes line, completed_date) and returns to `group` when
 *          a member is reopened (completed_date removed)
 *   TGM-3 a todo blocked by the group is released when the group completes; a group of groups follows
 *   TGM-4 an archived member keeps the group's entry resolvable: the group completes with it
 *   TGM-5 renaming a member rewrites the group's comprised_of
 *   TGM-6 the tools: create / update take comprised_of and refuse part_of; getQuestTodo answers part_of
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb125_groups-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import * as questTodo from '../questTodoManager.js';
import { archiveTodos } from '../../utils/todoArchive.js';
import { createQuestTodoImpl, getQuestTodoImpl, updateQuestTodoImpl, type QuestTodoToolsDeps } from '../../tools/quest-todo-tools.js';

const { fileTodo, findTodoById, renameQuestTodo, todoPartOf, updateTodo, questTodoFilePath } = questTodo;
for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(tmpRoot, '_ai', 'quests', q), { recursive: true }); }
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const fileText = (q: string) => fs.readFileSync(questTodoFilePath(q, `todos.${q}.todo.yaml`), 'utf8');

describe('todo groups through the manager', () => {
    test('TGM-1: comprised_of and part_of', () => {
        fileTodo('qa', { id: 'm1', description: 'member 1', status: 'not-started' });
        fileTodo('qb', { id: 'm2', description: 'member 2', status: 'not-started' });
        fileTodo('qa', { id: 'g1', title: 'Group', description: 'a group', status: 'group', comprised_of: ['m1', 'qb/m2'] });
        assert.deepEqual(findTodoById('qa', 'g1')?.comprised_of, ['m1', 'qb/m2']);
        assert.deepEqual(todoPartOf('qa', 'm1'), ['g1']);
        assert.deepEqual(todoPartOf('qb', 'm2'), ['qa/g1']);
        assert.doesNotMatch(fileText('qa') + fileText('qb'), /part_of/);
    });

    test('TGM-2: the group follows its members', () => {
        updateTodo('qa', 'm1', { status: 'completed' });
        assert.equal(findTodoById('qa', 'g1')?.status, 'group', 'one member still open');
        updateTodo('qb', 'm2', { status: 'cancelled' });
        const done = findTodoById('qa', 'g1')!;
        assert.equal(done.status, 'completed');
        assert.match(String(done.notes), /\d{4}-\d{2}-\d{2}: group completed: every member is done\./);
        assert.match(String(done.completed_date), /^\d{4}-\d{2}-\d{2}$/);
        updateTodo('qa', 'm1', { status: 'in-progress' });
        const reopened = findTodoById('qa', 'g1')!;
        assert.equal(reopened.status, 'group');
        assert.equal(reopened.completed_date, undefined);
        assert.match(String(reopened.notes), /group reopened: m1 is in-progress\./);
    });

    test('TGM-3: a blocked todo and a group of groups follow', () => {
        fileTodo('qb', { id: 'outer', description: 'group of groups', status: 'group', comprised_of: ['qa/g1'] });
        fileTodo('qb', { id: 'after', description: 'waits for the group', status: 'blocked', blocked_by: ['qa/g1'] });
        updateTodo('qa', 'm1', { status: 'completed' });
        assert.equal(findTodoById('qa', 'g1')?.status, 'completed');
        assert.equal(findTodoById('qb', 'outer')?.status, 'completed', 'the group of groups completes with it');
        assert.equal(findTodoById('qb', 'after')?.status, 'not-started', 'released by the group');
        assert.equal(findTodoById('qb', 'after')?.blocked_by, undefined, 'the completed group left its blocked_by');
        updateTodo('qa', 'm1', { status: 'not-started' });
        assert.equal(findTodoById('qa', 'g1')?.status, 'group');
        assert.equal(findTodoById('qb', 'outer')?.status, 'group');
        assert.equal(findTodoById('qb', 'after')?.status, 'not-started', 'it no longer names the group, so the reopened group blocks it no more');
    });

    test('TGM-4: an archived member stays resolvable', () => {
        fileTodo('qa', { id: 'm3', description: 'member 3', status: 'not-started' });
        fileTodo('qa', { id: 'm4', description: 'member 4', status: 'not-started' });
        fileTodo('qa', { id: 'g2', description: 'second group', status: 'group', comprised_of: ['m3', 'm4'] });
        updateTodo('qa', 'm3', { status: 'completed' });
        archiveTodos(questTodoFilePath('qa', 'todos.qa.todo.yaml'), ['m3']);
        assert.deepEqual(findTodoById('qa', 'g2')?.comprised_of, ['m3', 'm4'], 'the entry stays');
        updateTodo('qa', 'm4', { status: 'completed' });
        assert.equal(findTodoById('qa', 'g2')?.status, 'completed', 'm3 is done in the archive');
    });

    test('TGM-5: renaming a member rewrites comprised_of', () => {
        fileTodo('qa', { id: 'm5', description: 'member 5', status: 'not-started' });
        fileTodo('qa', { id: 'g3', description: 'third group', status: 'group', comprised_of: ['m5'] });
        const r = renameQuestTodo('qa', 'm5', 'm9');
        assert.ok(r.ok, JSON.stringify(r));
        assert.deepEqual(findTodoById('qa', 'g3')?.comprised_of, ['m9']);
    });

    test('TGM-6: the tools', async () => {
        const deps: QuestTodoToolsDeps = {
            store: {
                list: (q: string) => questTodo.readAllTodos(q),
                findById: (q: string, id: string) => findTodoById(q, id),
                create: (q: string, t: never, f?: string) => fileTodo(q, t, f),
                update: (q: string, id: string, u: never) => updateTodo(q, id, u),
                delete: () => false,
            } as unknown as QuestTodoToolsDeps['store'],
            partOf: (q, id) => todoPartOf(q, id),
        };
        const refused = JSON.parse(await createQuestTodoImpl(deps, { questId: 'qa', todo: { id: 'x1', description: 'x', part_of: ['g1'] } as never }));
        assert.equal(refused.ok, false);
        assert.match(refused.error, /`part_of` is derived/);
        const created = JSON.parse(await createQuestTodoImpl(deps, { questId: 'qa', todo: { id: 'g4', description: 'tool group', status: 'group', comprised_of: ['m4'] } }));
        assert.equal(created.ok, true, JSON.stringify(created));
        assert.deepEqual(findTodoById('qa', 'g4')?.comprised_of, ['m4']);
        const upd = JSON.parse(await updateQuestTodoImpl(deps, { questId: 'qa', todoId: 'g4', updates: { comprised_of: ['m4', 'qb/m2'] } }));
        assert.equal(upd.ok, true, JSON.stringify(upd));
        assert.equal(JSON.parse(await updateQuestTodoImpl(deps, { questId: 'qa', todoId: 'm4', updates: { part_of: [] } as never })).ok, false);
        const got = JSON.parse(await getQuestTodoImpl(deps, { questId: 'qa', todoId: 'm4' }));
        assert.deepEqual(got.todo.part_of, ['g2', 'g4']);
    });
});
