/**
 * moveTodoToDestination: a todo from any todo file into a quest's own file or
 * workspace.todo.yaml (the todo panels' "Move to…" and tomAi_transferTodos).
 *
 *   MD-1  a session todo into its quest's file: every field travels, no origin note, source emptied
 *   MD-2  a quest todo into the workspace file: created with its scope header, origin noted
 *   MD-3  a quest todo into another quest: origin noted
 *   MD-4  refusals write nothing: unknown id, target is the source, target already holds the id
 *   MD-5  renamed on the way (a prefix chosen for the target quest): the new id, a note naming the old one,
 *         and `blocked_by` / `dependencies` naming another moved todo follow its new id
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-move-dest-'));
installVscodeStub({ workspaceFolders: [ws] });

import * as questTodo from '../questTodoManager.js';

const questFile = (q: string, f: string): string => path.join(ws, '_ai', 'quests', q, f);
const read = (p: string): string => fs.readFileSync(p, 'utf8');

function seed(q: string, file: string, ids: string[]): string {
    const fp = questFile(q, file);
    for (const id of ids) {
        questTodo.createTodoInFile(fp, {
            id, title: `T ${id}`, description: `do ${id}`, status: 'decision-needed', priority: 'high', tags: ['x'],
            // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's field name
            decisions: [{ summary: 'which?', decision_needed: 'a or b' }],
        } as never);
    }
    return fp;
}

describe('moveTodoToDestination', () => {
    test('MD-1: session todo into its quest file', () => {
        const src = seed('qa', 'session-todo.mbp.qa.todo.yaml', ['s1', 's2']);
        const r = questTodo.moveTodoToDestination(src, 's1', { kind: 'quest', questId: 'qa' }, 'quest: qa');
        assert.equal(r.ok, true, JSON.stringify(r));
        const moved = questTodo.findTodoByIdInFile(questFile('qa', 'todos.qa.todo.yaml'), 's1')!;
        assert.equal(moved.title, 'T s1');
        assert.equal(moved.status, 'decision-needed');
        assert.deepEqual(moved.tags, ['x']);
        assert.equal(moved.decisions?.[0].summary, 'which?');
        assert.equal(moved.notes, undefined, 'staying in its quest is not noted');
        assert.equal(questTodo.findTodoByIdInFile(src, 's1'), undefined);
        assert.ok(questTodo.findTodoByIdInFile(src, 's2'), 'the other todo stays');
    });

    test('MD-2: quest todo into the workspace file', () => {
        const src = seed('qb', 'todos.qb.todo.yaml', ['w1']);
        const r = questTodo.moveTodoToDestination(src, 'w1', { kind: 'workspace' }, 'quest: qb');
        assert.equal(r.ok, true, JSON.stringify(r));
        const wsFile = path.join(ws, 'workspace.todo.yaml');
        assert.equal(r.ok && r.targetPath, wsFile);
        assert.match(read(wsFile), /area: workspace/);
        const moved = questTodo.findTodoByIdInFile(wsFile, 'w1')!;
        assert.match(moved.notes ?? '', /\[moved from quest: qb\]/);
        assert.equal(moved.decisions?.length, 1);
        assert.equal(questTodo.findTodoByIdInFile(src, 'w1'), undefined);
    });

    test('MD-3: into another quest', () => {
        const src = seed('qc', 'topic.qc.todo.yaml', ['c1']);
        fs.mkdirSync(path.join(ws, '_ai', 'quests', 'qd'), { recursive: true });
        const r = questTodo.moveTodoToDestination(src, 'c1', { kind: 'quest', questId: 'qd' }, 'quest: qc');
        assert.equal(r.ok, true);
        const moved = questTodo.findTodoByIdInFile(questFile('qd', 'todos.qd.todo.yaml'), 'c1')!;
        assert.match(moved.notes ?? '', /\[moved from quest: qc\]/);
    });

    test('MD-4: refusals write nothing', () => {
        const src = seed('qe', 'todos.qe.todo.yaml', ['e1']);
        const before = read(src);
        const unknown = questTodo.moveTodoToDestination(src, 'nope', { kind: 'workspace' });
        assert.equal(unknown.ok, false);
        assert.match(!unknown.ok ? unknown.reason : '', /not in todos\.qe\.todo\.yaml/);
        const same = questTodo.moveTodoToDestination(src, 'e1', { kind: 'quest', questId: 'qe' });
        assert.equal(same.ok, false);
        assert.match(!same.ok ? same.reason : '', /already in/);
        const other = seed('qf', 'todos.qf.todo.yaml', ['e1']);
        const otherBefore = read(other);
        const clash = questTodo.moveTodoToDestination(src, 'e1', { kind: 'quest', questId: 'qf' });
        assert.equal(clash.ok, false);
        assert.match(!clash.ok ? clash.reason : '', /already holds a todo e1/);
        assert.equal(read(src), before);
        assert.equal(read(other), otherBefore);
    });

    test('MD-5: renamed into another quest', () => {
        const src = questFile('qf', 'todos.qf.todo.yaml');
        questTodo.createTodoInFile(src, { id: 'f1_aa-one', title: 'one', description: 'd', status: 'not-started' } as never);
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's field name
        questTodo.createTodoInFile(src, { id: 'f2_aa-two', title: 'two', description: 'd', status: 'blocked', blocked_by: ['f1_aa-one', 'other'], dependencies: ['f1_aa-one'] } as never);
        fs.mkdirSync(path.join(ws, '_ai', 'quests', 'qg'), { recursive: true });
        const renames = new Map([['f1_aa-one', 'g5_aa-one'], ['f2_aa-two', 'g6_aa-two']]);
        for (const id of ['f1_aa-one', 'f2_aa-two']) {
            const r = questTodo.moveTodoToDestination(src, id, { kind: 'quest', questId: 'qg' }, 'quest: qf', renames);
            assert.equal(r.ok, true);
        }
        const target = questFile('qg', 'todos.qg.todo.yaml');
        assert.equal(questTodo.findTodoByIdInFile(target, 'f1_aa-one'), undefined, 'the old id is gone');
        const one = questTodo.findTodoByIdInFile(target, 'g5_aa-one')!;
        assert.match(one.notes ?? '', /\[moved from quest: qf as f1_aa-one\]/);
        const two = questTodo.findTodoByIdInFile(target, 'g6_aa-two')!;
        assert.deepEqual([two.blocked_by, two.dependencies], [['g5_aa-one', 'other'], ['g5_aa-one']], 'references to moved todos follow');
    });
});
