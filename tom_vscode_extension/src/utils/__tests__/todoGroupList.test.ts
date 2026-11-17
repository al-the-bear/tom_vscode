/**
 * The todo panel's group data (vscimpb126): the handler's list and its queue target.
 *
 *   TGL-1 groupListInfo reads the corpus: part_of per todo, a group's members with title and status (live first,
 *         else archived), not found ones marked
 *   TGL-2 withTodoGroups adds part_of and group_members to the rows of a quest; rows of no quest are left as they are
 *   TGL-3 todoListItem carries comprised_of
 *   TGL-4 a group's queue button queues through the queue-target flow (vscimpb139), into the group's own quest
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { groupListInfo } from '../todoBlockingCascade.js';
import { todoListItem, withTodoGroups } from '../todoListItem.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const root = fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb126_groups-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(quest: string, file: string, yaml: string): void {
    fs.mkdirSync(path.join(root, quest), { recursive: true });
    fs.writeFileSync(path.join(root, quest, file), yaml);
}

write('qa', 'todos.qa.todo.yaml', `todos:
  - id: g1
    title: Release
    description: d
    status: group
    comprised_of:
      - a1
      - qb/b1
      - a9
      - gone
  - id: a1
    description: First member, a long description that stands in for a title
    status: completed
`);
write('qa', 'todos-archived.qa.todo.yaml', `todos:
  - id: a9
    title: Archived member
    description: d
    status: completed
`);
write('qb', 'todos.qb.todo.yaml', `todos:
  - id: b1
    title: Member in qb
    description: d
    status: in-progress
  - id: gb
    title: qb group
    description: d
    status: group
    comprised_of:
      - qa/a1
`);

describe('the panel group data', () => {
    test('TGL-1: groupListInfo', () => {
        const info = groupListInfo(root);
        assert.deepEqual(info.partOf('qa', 'a1'), ['g1', 'qb/gb']);
        assert.deepEqual(info.partOf('qb', 'b1'), ['qa/g1']);
        assert.deepEqual(info.partOf('qa', 'g1'), []);
        assert.deepEqual(info.members('qa', ['a1', 'qb/b1', 'a9', 'gone']), [
            { ref: 'a1', quest: 'qa', id: 'a1', title: 'First member, a long description that stands in for a title', status: 'completed', found: true },
            { ref: 'qb/b1', quest: 'qb', id: 'b1', title: 'Member in qb', status: 'in-progress', found: true },
            { ref: 'a9', quest: 'qa', id: 'a9', title: 'Archived member', status: 'completed', found: true },
            { ref: 'gone', quest: 'qa', id: 'gone', found: false },
        ]);
    });

    test('TGL-2 / TGL-3: the list rows', () => {
        const rows = [
            todoListItem({ id: 'g1', title: 'Release', status: 'group', comprised_of: ['a1', 'qb/b1'] }, 'todos.qa.todo.yaml'),
            todoListItem({ id: 'a1', status: 'completed' }, 'todos.qa.todo.yaml'),
            todoListItem({ id: 'ws1', status: 'not-started' }, 'workspace.todo.yaml'),
        ];
        assert.deepEqual(rows[0].comprised_of, ['a1', 'qb/b1']);
        const out = withTodoGroups(rows, (r) => (r.sourceFile.startsWith('todos.qa') ? 'qa' : undefined), groupListInfo(root));
        assert.deepEqual(out[0].group_members?.map((m) => [m.ref, m.status]), [['a1', 'completed'], ['qb/b1', 'in-progress']]);
        assert.deepEqual(out[1].part_of, ['g1', 'qb/gb']);
        assert.equal(out[1].group_members, undefined);
        assert.equal(out[2], rows[2], 'no quest: left as it is');
    });

    test('TGL-4: the queue target', () => {
        const host = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        assert.match(host, /case 'qtQueueTodoGroup':[\s\S]{0,200}queueTodoAsItem\(effectiveQuestId\(msg\.questId\), String\(msg\.todoId \|\| ''\), instance, 'group', msg\.sourceFile\)/);
        assert.match(host, /await queueTodoEntriesWithFlow\(instance, todoQuest, noun, \[\{[\s\S]*?\}\], todoQuest\);/, 'the flow, into the group\'s own quest');
    });
});
