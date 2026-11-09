/**
 * moveTodoToDestination: a todo from any todo file into a quest's own file or
 * workspace.todo.yaml (the todo panels' "Move to…" and tomAi_transferTodos).
 *
 *   MD-1  a session todo into its quest's file: every field travels, no origin note, source emptied
 *   MD-2  a quest todo into the workspace file: created with its scope header, origin noted
 *   MD-3  a quest todo into another quest: origin noted
 *   MD-4  refusals write nothing: unknown id, target is the source, target already holds the id
 *   MD-5  renamed on the way (a prefix chosen for the target quest): the new id, a note naming the old one,
 *         and `blocked_by` / `dependencies` naming another moved todo follow its new id; numbered into a group of
 *         the target, it lands at the end of the group, before its finalizer (`<prefix>999`)
 *   MD-6  renameQuestTodo: the new id, a note naming the old one, every `blocked_by` / `dependencies` entry
 *         naming it in the quest's live files follows (`<old>` and `<quest>/<old>`); the todo keeps its place
 *   MD-7  into a group: placed after the group's last todo below 999, before its finalizer — moved into the
 *         group's file when that is another
 *   MD-8  refusals write nothing: an unknown todo, an id the quest already has (archived ones too), a spaced id
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

    test('MD-5b: numbered into a group before its finalizer', () => {
        const src = seed('qm', 'todos.qm.todo.yaml', ['m1_ab-move']);
        seed('qn', 'todos.qn.todo.yaml', ['grp1_ab-a', 'grp2_ab-b', 'grp999_ab-final']);
        const r = questTodo.moveTodoToDestination(src, 'm1_ab-move', { kind: 'quest', questId: 'qn' }, 'quest: qm', new Map([['m1_ab-move', 'grp3_ab-move']]));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(questTodo.readAllTodos('qn').map((t) => t.id), ['grp1_ab-a', 'grp2_ab-b', 'grp3_ab-move', 'grp999_ab-final']);
    });

    test('MD-6: renaming a todo', () => {
        const fp = seed('qr', 'todos.qr.todo.yaml', ['old1_ac-x', 'dep1_ac-y', 'dep2_ac-z']);
        const topic = seed('qr', 'topic.qr.todo.yaml', ['t1_ac-w']);
        questTodo.updateTodoInFile(fp, 'dep1_ac-y', { blocked_by: ['old1_ac-x', 'other'] } as never);
        questTodo.updateTodoInFile(fp, 'dep2_ac-z', { dependencies: ['qr/old1_ac-x'] } as never);
        questTodo.updateTodoInFile(topic, 't1_ac-w', { dependencies: ['old1_ac-x'] } as never);
        const r = questTodo.renameQuestTodo('qr', 'old1_ac-x', 'new7_ac-x');
        assert.deepEqual(r, { ok: true, file: 'todos.qr.todo.yaml', references: 3 });
        const renamed = questTodo.findTodoByIdInFile(fp, 'new7_ac-x')!;
        assert.ok(renamed, 'the new id');
        assert.equal(questTodo.findTodoByIdInFile(fp, 'old1_ac-x'), undefined);
        assert.match(renamed.notes ?? '', /\[renamed from old1_ac-x\]/);
        assert.equal(renamed.title, 'T old1_ac-x', 'every field kept');
        assert.deepEqual(questTodo.findTodoByIdInFile(fp, 'dep1_ac-y')!.blocked_by, ['new7_ac-x', 'other']);
        assert.deepEqual(questTodo.findTodoByIdInFile(fp, 'dep2_ac-z')!.dependencies, ['qr/new7_ac-x']);
        assert.deepEqual(questTodo.findTodoByIdInFile(topic, 't1_ac-w')!.dependencies, ['new7_ac-x'], 'in the other file too');
        assert.deepEqual(questTodo.readTodoFile(fp).map((t) => t.id), ['new7_ac-x', 'dep1_ac-y', 'dep2_ac-z'], 'its place kept');
    });

    test('MD-7: into a group', () => {
        const main = seed('qh', 'todos.qh.todo.yaml', ['a1_ad-a', 'a2_ad-b', 'a999_ad-final', 'b1_ad-move', 'b2_ad-stay']);
        const r = questTodo.renameQuestTodo('qh', 'b1_ad-move', 'a3_ad-move', { group: 'a' });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(questTodo.readTodoFile(main).map((t) => t.id), ['a1_ad-a', 'a2_ad-b', 'a3_ad-move', 'a999_ad-final', 'b2_ad-stay']);
        // The group lives in another file: the todo moves there.
        const topic = seed('qh', 'topic.qh.todo.yaml', ['c1_ad-c', 'c999_ad-cfinal']);
        const moved = questTodo.renameQuestTodo('qh', 'b2_ad-stay', 'c2_ad-stay', { group: 'c', targetFile: topic });
        assert.deepEqual(moved, { ok: true, file: 'topic.qh.todo.yaml', references: 0 });
        assert.deepEqual(questTodo.readTodoFile(topic).map((t) => t.id), ['c1_ad-c', 'c2_ad-stay', 'c999_ad-cfinal']);
        assert.equal(questTodo.findTodoByIdInFile(main, 'b2_ad-stay'), undefined, 'gone from its file');
    });

    test('MD-8: refusals', () => {
        const fp = seed('qx', 'todos.qx.todo.yaml', ['x1_ae-a', 'x2_ae-b']);
        fs.writeFileSync(questFile('qx', 'todos-archived.qx.todo.yaml'), 'todos:\n  - id: x9_ae-gone\n    title: gone\n    status: completed\n');
        const before = read(fp);
        assert.equal(questTodo.renameQuestTodo('qx', 'nope', 'x5').ok, false);
        assert.match(JSON.stringify(questTodo.renameQuestTodo('qx', 'x1_ae-a', 'x2_ae-b')), /already has a todo x2_ae-b/);
        assert.match(JSON.stringify(questTodo.renameQuestTodo('qx', 'x1_ae-a', 'x9_ae-gone')), /already has a todo x9_ae-gone/, 'an archived id counts');
        assert.match(JSON.stringify(questTodo.renameQuestTodo('qx', 'x1_ae-a', 'two words')), /one word/);
        assert.equal(read(fp), before, 'nothing written');
    });
});
