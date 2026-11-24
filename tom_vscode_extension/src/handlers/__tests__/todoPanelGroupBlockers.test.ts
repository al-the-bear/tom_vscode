/**
 * The todo panel before it queues a group (b and c of the 2026-11-19 request; src/handlers/questTodoPanel-handler.ts),
 * through the vscode stub in a sandbox workspace of its own.
 *
 *   GB-1 the members: a `<prefix>*` group's todos as the walk reads them, a group todo's members of its quest
 *   GB-2 the blockers that do not run first are found across quests: open ones, unknown ones, a member later in
 *        the group (walk order: lowest number first, or `comprised_of`); not a member earlier in it, not completed
 *        ones
 *   GB-3 with such blockers the user is warned first (a modal naming each member and what it waits for); Queue
 *        anyway goes on, anything else stops; without them nothing is asked (blockers ahead in the prompt queue are
 *        left out: BS-2)
 *   GB-4 the check comes before anything else: before the group prompt is picked, before the queue target is
 *        asked — for a `<prefix>*` walk, a group todo's GROUP item and a group todo's walk with a group prompt
 *   GB-5 every item queued from the todo panel names the todos it is about: the entry type requires
 *        `todoIdPattern`, and the walk over a `<prefix>*` group carries the prefix pattern
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_todoblocked_panel-')));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
for (const q of ['qa', 'qb']) { fs.mkdirSync(path.join(WS, '_ai', 'quests', q), { recursive: true }); }
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const asked: Json[][] = [];
let answer: string | undefined;
const vs = installVscodeStub({ workspaceFolders: [WS], methodOverrides: { showWarningMessage: async (...args: unknown[]) => { asked.push(args); return answer; } } });
(vs.stub.workspace as Json).workspaceFile = { fsPath: path.join(WS, 'qa.code-workspace'), scheme: 'file' };
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

import { createTodo, findTodoById } from '../../managers/questTodoManager.js';
import { WsPaths } from '../../utils/workspacePaths.js';
import { confirmGroupBlockers, groupOutsideBlockers, groupTodoMembers, prefixGroupMembers } from '../questTodoPanel-handler.js';

assert.ok(fs.realpathSync(WsPaths.aiRoot ?? '/').startsWith(SANDBOX), 'the _ai root is in the sandbox');

createTodo('qa', { id: 'gate1', description: 'an open blocker', status: 'in-progress' } as never);
createTodo('qa', { id: 'gate2', description: 'a done blocker', status: 'completed' } as never);
createTodo('qb', { id: 'far1', description: 'another quest\'s', status: 'not-started' } as never);
createTodo('qa', { id: 'grp1_x', description: 'first', status: 'not-started', blocked_by: ['gate1', 'gate2'] } as never);
createTodo('qa', { id: 'grp2_x', description: 'second', status: 'not-started', blocked_by: ['grp1_x', 'qb/far1'] } as never);
createTodo('qa', { id: 'grp3_x', description: 'third', status: 'completed', blocked_by: ['gate1'] } as never);
createTodo('qa', { id: 'grpother', description: 'no number: no member', status: 'not-started' } as never);
createTodo('qa', { id: 'free1_x', description: 'free', status: 'not-started' } as never);
createTodo('qa', { id: 'free2_x', description: 'free, waits inside', status: 'not-started', blocked_by: ['free1_x'] } as never);
createTodo('qa', { id: 'bundle', description: 'a group todo', status: 'group', comprised_of: ['grp2_x', 'free1_x', 'qb/far1', 'grp2_x'] } as never);
createTodo('qa', { id: 'reversed', description: 'a group todo in the wrong order', status: 'group', comprised_of: ['free2_x', 'free1_x'] } as never);

describe('the todo panel before it queues a group', () => {
    test('GB-1: the members', () => {
        assert.deepEqual(prefixGroupMembers('qa', 'grp').map((t) => t.id), ['grp1_x', 'grp2_x', 'grp3_x']);
        assert.deepEqual(prefixGroupMembers('qa', 'nothing'), []);
        assert.deepEqual(groupTodoMembers('qa', findTodoById('qa', 'bundle')).map((t) => t.id), ['grp2_x', 'free1_x'], 'its members of this quest, each once');
        assert.deepEqual(groupTodoMembers('qa', undefined), []);
    });

    test('GB-2: the blockers outside the group', () => {
        assert.deepEqual(groupOutsideBlockers('qa', prefixGroupMembers('qa', 'grp')), [
            { member: 'grp1_x', entry: 'gate1', quest: 'qa', id: 'gate1', status: 'in-progress' },
            { member: 'grp2_x', entry: 'qb/far1', quest: 'qb', id: 'far1', status: 'not-started' },
        ], 'not gate2 (completed), not grp1_x (a member), not the completed member\'s');
        // In the group todo, grp1_x is no member: it is outside.
        assert.deepEqual(groupOutsideBlockers('qa', groupTodoMembers('qa', findTodoById('qa', 'bundle'))).map((b) => `${b.member}<-${b.entry}`), ['grp2_x<-grp1_x', 'grp2_x<-qb/far1']);
        // A member waiting for a member after it: the walk reaches it first.
        assert.deepEqual(groupOutsideBlockers('qa', groupTodoMembers('qa', findTodoById('qa', 'reversed'))).map((b) => `${b.member}<-${b.entry}${b.laterInGroup ? ' (later)' : ''}`), ['free2_x<-free1_x (later)']);
        assert.deepEqual(groupOutsideBlockers('qa', prefixGroupMembers('qa', 'free')), [], 'a group that waits only inside itself');
    });

    test('GB-3: the question', async () => {
        asked.length = 0;
        answer = undefined;
        assert.equal(await confirmGroupBlockers('qa', prefixGroupMembers('qa', 'free'), 'The walk over free*'), true);
        assert.equal(asked.length, 0, 'nothing outside: nothing is asked');
        assert.equal(await confirmGroupBlockers('qa', prefixGroupMembers('qa', 'grp'), 'The walk over grp*'), false, 'dismissed: not queued');
        assert.equal(asked.length, 1);
        assert.equal(asked[0][0], 'The walk over grp*: 2 todos are blocked by todos that do not run before them — not ahead in the prompt queue, not earlier in the group. Queue it anyway?');
        assert.equal(asked[0][1].modal, true);
        assert.match(asked[0][1].detail, /^• grp1_x waits for gate1 \(in-progress\)\n• grp2_x waits for qb\/far1 \(not-started\)\n\nEvery todo is queued, blocked or not\. A todo still blocked when the walk reaches it holds the item/);
        assert.deepEqual(asked[0].slice(2), ['Queue anyway']);
        answer = 'Queue anyway';
        assert.equal(await confirmGroupBlockers('qa', prefixGroupMembers('qa', 'grp'), 'The walk over grp*'), true);
    });

    test('GB-4: before anything else', () => {
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf8');
        const walk = src.slice(src.indexOf('async function queueGroupWalk('), src.indexOf('async function queueGroupTodoWalk('));
        const check = walk.indexOf('confirmGroupBlockers(walkQuest, prefixGroupMembers(walkQuest, prefix)');
        assert.ok(check > 0 && check < walk.indexOf('pickWalkPrompt(') && check < walk.indexOf('queueTodoEntriesWithFlow('), 'the walk: before the prompt and the target');
        const todoWalk = src.slice(src.indexOf('async function queueGroupTodoWalk('), src.indexOf('async function pickWalkPrompt('));
        const todoCheck = todoWalk.indexOf('confirmGroupBlockers(todoQuest, groupTodoMembers(todoQuest, todo)');
        assert.ok(todoCheck > 0 && todoCheck < todoWalk.indexOf('pickWalkPrompt(') && todoCheck < todoWalk.indexOf('queueTodoEntriesWithFlow('), 'a group todo\'s walk: before the prompt and the target');
        assert.match(todoWalk, /repeatCount: spec\.repeatCount, todoIdPattern: spec\.todoIdPattern/, 'a GROUP item naming the group and its members');
        const item = src.slice(src.indexOf('async function queueTodoAsItem('), src.indexOf('async function queueGroupWalk('));
        const groupCheck = item.indexOf("kind === 'group' && !await confirmGroupBlockers(todoQuest, groupTodoMembers(todoQuest, todo)");
        assert.ok(groupCheck > 0 && groupCheck < item.indexOf('queueTodoEntriesWithFlow('), 'a group todo: before the target');
    });

    test('GB-5: every item queued from the panel names its todos', () => {
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf8');
        const entry = src.slice(src.indexOf('interface TodoQueueEntry {'), src.indexOf('}', src.indexOf('interface TodoQueueEntry {')));
        assert.match(entry, /\n    todoIdPattern: string;/, 'required: an entry without it does not compile');
        assert.match(src, /todoId: `\$\{prefix\}\*`, text: prompt\.text, repeatCount: `\$\{prefix\}\*`, todoIdPattern: `\$\{prefix\}\*`,/, 'the prefix walk');
        assert.match(src, /repeatCount: spec\.repeatCount,\s*todoIdPattern: spec\.todoIdPattern,/, 'TODO and GROUP items');
        assert.equal((src.match(/todoIdPattern: (todo\.id|todoId)\b/g) ?? []).length >= 3, true, 'the Queue button, the template queue, the stack');
    });
});
