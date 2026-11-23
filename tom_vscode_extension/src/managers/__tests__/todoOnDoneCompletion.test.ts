/**
 * A completed todo's `on_done` carried out through the todo writer and the runner (ww_a_collab-5).
 *
 *   OC-1 completing a todo outside a walk runs it once: unblock targets set free in the files (a group todo to
 *        `group`, another quest's target by `<quest>/<id>`, blocked_by untouched); the notification next in the
 *        queuing run and session; the instructions next in on_done's quest / run (another quest: its inbox); saving
 *        the completed todo again runs nothing
 *   OC-2 a repeated todo runs it on every completion (it then waits for its repetition)
 *   OC-3 a completion while the queue holds the todo's claim is left to the queue (deferred, taken once)
 *   OC-4 a deleted or missing target is noted on the todo; a done target passed over; a failing send does not stop
 *        the other actions
 *   OC-5 cancelling runs nothing of on_done
 *   OC-6 the built-in group prompt no longer tells the agent to carry out the instructions: the extension sends them
 *   OC-7 the notification goes next into the run and session that queued the todo (another quest: its inbox, the
 *        session named), also without `notify`; with notify filed-by to the filed-by quest and run; none without a
 *        queuing run; the template only when the queuing panel's bell was on
 *   OC-8 a group todo: its After done follows when its last member is completed, not before
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-on-done-run-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import {
    createTodoInFile, findTodoById, readAllTodos, readTodoFile, setTodoCompletionHook, updateTodo, ALL_TODO_FILES,
    type QuestTodoItem,
} from '../questTodoManager.js';
import { deferTodoOnDone, runTodoOnDone, setTodoOnDonePorts, takeDeferredTodoOnDone } from '../../services/todoOnDoneRunner.js';
import type { OnDoneSend, OnDoneTarget } from '../../utils/todoOnDoneRun.js';
import type { QueuedBy } from '../../utils/queuedBy.js';
import { BUILTIN_GROUP_PROMPT } from '../../utils/groupPrompts.js';

const Q = 'cq';
const OTHER = 'dq';
const qDir = path.join(tmpRoot, '_ai', 'quests', Q);
const oDir = path.join(tmpRoot, '_ai', 'quests', OTHER);
const main = path.join(qDir, `todos.${Q}.todo.yaml`);
const deleted = path.join(qDir, `todos-deleted.${Q}.todo.yaml`);

const add = (file: string, id: string, extra: Record<string, unknown> = {}): void => {
    createTodoInFile(file, { id, title: `T ${id}`, description: `do ${id}`, status: 'not-started', ...extra } as never);
};
const todo = (id: string): QuestTodoItem | undefined => readTodoFile(main).find((t) => t.id === id);

let local: OnDoneSend[] = [];
let hookQueuedBy: QueuedBy | undefined;
let posted: Array<OnDoneSend & { from: { quest: string; run: string } }> = [];
let claimed = new Set<string>();
let failLocal = false;
let template: string | undefined;
const pending: Array<Promise<unknown>> = [];

function where(sourceFile: string | undefined): OnDoneTarget['where'] {
    const first = (sourceFile ?? '').split('.')[0];
    return first.endsWith('-deleted') ? 'deleted' : first.endsWith('-archived') ? 'archived' : 'live';
}

beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, '_ai'), { recursive: true, force: true });
    fs.mkdirSync(qDir, { recursive: true });
    fs.mkdirSync(oDir, { recursive: true });
    local = []; posted = []; claimed = new Set(); failLocal = false; template = undefined;
    hookQueuedBy = { quest: Q, run: 'r1', session: 'work' };
    setTodoOnDonePorts({
        windowQuest: () => Q,
        findTodo: (quest, id) => {
            const t = readAllTodos(quest, ALL_TODO_FILES).find((x) => x.id === id);
            return t ? { status: t.status, decisions: t.decisions, title: t.title, where: where(t._sourceFile),
                group: t.status === 'group' || (t.comprised_of ?? []).length > 0 } : undefined;
        },
        notifyTemplate: () => template,
        writeTarget: (quest, id, status) => { updateTodo(quest, id, { status: status as never }); },
        appendNotes: (quest, id, lines) => {
            const old = findTodoById(quest, id)?.notes ?? '';
            updateTodo(quest, id, { notes: old ? `${old}\n${lines.join('\n')}` : lines.join('\n') });
        },
        enqueueLocal: async (s) => { if (failLocal) { throw new Error('queue down'); } local.push(s); },
        postToQuest: (s, from) => { posted.push({ ...s, from }); },
        log: () => undefined,
        today: () => '2026-11-15',
    });
    setTodoCompletionHook((quest, t) => {
        if (claimed.has(`${quest}/${t.id}`)) { deferTodoOnDone(quest, t.id); return; }
        // As the live hook: who queued the turn that completed it (here the queue item of run r1, session work).
        pending.push(runTodoOnDone(quest, { ...t, sourceFile: t._sourceFile }, 'r1', hookQueuedBy ? { queuedBy: hookQueuedBy } : {}));
    });
});
after(() => {
    setTodoCompletionHook(undefined);
    setTodoOnDonePorts(undefined);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

const settle = async (): Promise<void> => { await Promise.all(pending.splice(0)); };

describe('on_done at completion', () => {
    test('OC-1: completing runs it once', async () => {
        const otherMain = path.join(oDir, `todos.${OTHER}.todo.yaml`);
        add(main, 't1', { status: 'blocked', blocked_by: ['other1'] });
        add(main, 'other1');
        add(main, 'g1', { status: 'blocked', comprised_of: ['other1'] });
        add(otherMain, 'o1', { status: 'blocked' });
        add(main, 'n1', { on_done: { todos: ['t1', 'g1', `${OTHER}/o1`], action: ['unblock'], notify_prompt: 'n1 done', instructions: 'Tell the index.' } });
        add(main, 'n2', { on_done: { quest: OTHER, run: 'chg7', instructions: 'Over there.' } });
        updateTodo(Q, 'n1', { status: 'completed' });
        updateTodo(Q, 'n2', { status: 'completed' });
        await settle();
        assert.equal(todo('t1')!.status, 'not-started', 'set free though other1 still blocks it');
        assert.deepEqual(todo('t1')!.blocked_by, ['other1'], 'blocked_by untouched');
        assert.equal(todo('g1')!.status, 'group', 'a group todo goes to group');
        assert.equal(readTodoFile(otherMain).find((t) => t.id === 'o1')!.status, 'not-started', 'another quest by <quest>/<id>');
        assert.deepEqual(local.map((s) => [s.run, s.session ?? '', s.next]), [['r1', 'work', true], ['r1', '', true]],
            'the notification into the queuing session, the instructions into the completing run\'s default session, both next');
        assert.equal(local[0].text, 'n1 done');
        assert.match(local[1].text, /^The todo `cq\/n1` — T n1 was completed \(run r1\)\. Its After done sends you these instructions:\n\nTell the index\./);
        assert.deepEqual(posted.map((s) => [s.quest, s.run, s.next]), [[OTHER, 'chg7', true]], 'instructions for another quest: its inbox');
        assert.match(posted[0].text, /Over there\./);
        assert.deepEqual(posted[0].from, { quest: Q, run: 'r1' });
        updateTodo(Q, 'n1', { status: 'completed', notes: 'again' });
        await settle();
        assert.equal(local.length, 2, 'saving the completed todo again runs nothing');
    });

    test('OC-2: a repeated todo runs it on every completion', async () => {
        add(main, 'rep1', { repeat: { rule: 'manual' }, on_done: { notify_prompt: 'rep1 done' } });
        updateTodo(Q, 'rep1', { status: 'completed' });
        await settle();
        assert.equal(todo('rep1')!.status, 'waiting-for-repeat');
        updateTodo(Q, 'rep1', { status: 'not-started' });
        updateTodo(Q, 'rep1', { status: 'completed' });
        await settle();
        assert.deepEqual(local.map((s) => s.text), ['rep1 done', 'rep1 done']);
    });

    test('OC-3: a walk\'s claim takes the completion', async () => {
        add(main, 'w1', { on_done: { notify_prompt: 'w1 done' } });
        claimed.add(`${Q}/w1`);
        updateTodo(Q, 'w1', { status: 'completed' });
        await settle();
        assert.equal(local.length, 0, 'left to the queue');
        assert.equal(takeDeferredTodoOnDone(Q, 'w1'), true);
        assert.equal(takeDeferredTodoOnDone(Q, 'w1'), false, 'taken once');
    });

    test('OC-4: skips, notes, a failing send', async () => {
        add(main, 'c1', { status: 'completed' });
        add(deleted, 'd1');
        add(main, 'q1', { status: 'blocked' });
        add(main, 'n1', { on_done: { todos: ['c1', 'd1', 'gone1', 'q1'], action: ['unblock'], notify_prompt: 'x', instructions: 'y' } });
        failLocal = true;
        updateTodo(Q, 'n1', { status: 'completed' });
        await settle();
        const notes = todo('n1')!.notes ?? '';
        assert.match(notes, /cq\/d1 was deleted; not unblocked\./);
        assert.match(notes, /cq\/gone1 does not exist; not unblocked\./);
        assert.doesNotMatch(notes, /c1/, 'a done target is passed over without a note');
        assert.equal(todo('q1')!.status, 'not-started', 'the unblock ran though the sends failed');
    });

    test('OC-5: cancelling runs nothing', async () => {
        add(main, 't1', { status: 'blocked' });
        add(main, 'n1', { on_done: { todos: ['t1'], action: ['unblock'], notify_prompt: 'x', instructions: 'y' } });
        updateTodo(Q, 'n1', { status: 'cancelled' });
        await settle();
        assert.equal(local.length + posted.length, 0);
        assert.equal(todo('t1')!.status, 'blocked');
    });

    test('OC-7: the done notification: the queuing run, or notify filed-by', async () => {
        add(main, 'n1', { status: 'completed', on_done: { notify_prompt: 'n1 for ${senderRun}' } });
        const t = { ...findTodoById(Q, 'n1')!, sourceFile: 'todos.cq.todo.yaml' };
        await runTodoOnDone(Q, t, 'r1', { queuedBy: { quest: Q, run: 'chg3', session: 'work' } });
        assert.deepEqual(local.map((x) => [x.run, x.session, x.text, x.next]), [['chg3', 'work', 'n1 for r1', true]], 'without notify: the queuing run and session');
        local = [];
        await runTodoOnDone(Q, t, 'r1', { queuedBy: { quest: OTHER, run: 'r5', session: 's5' } });
        assert.deepEqual(posted.map((x) => [x.quest, x.run, x.session, x.text]), [[OTHER, 'r5', 's5', 'n1 for r1']], 'another quest: its inbox, the session named');
        posted = [];
        const plan = await runTodoOnDone(Q, t, 'r1');
        assert.equal(plan?.notify, undefined, 'no queuing run: none');
        const filed = { ...t, filed_by: { quest: OTHER, run: 'idea', session: 'once' }, on_done: { action: ['notify' as const], notify_prompt: 'to the filer' } };
        await runTodoOnDone(Q, filed, 'r1', { queuedBy: { quest: Q, run: 'chg3', session: 'work' } });
        assert.deepEqual(posted.map((x) => [x.quest, x.run, x.session ?? '', x.text]), [[OTHER, 'idea', '', 'to the filer']], 'notify filed-by: the filer\'s quest and run, its default session');
        assert.equal(local.length, 0);
        posted = [];
        template = 'T ${todoId}';
        const bare = { ...t, on_done: undefined };
        assert.equal((await runTodoOnDone(Q, bare, 'r1', { queuedBy: { quest: Q, run: 'r1' } })), undefined, 'bell off, no notify prompt: nothing');
        await runTodoOnDone(Q, bare, 'r1', { queuedBy: { quest: Q, run: 'r1', withTemplate: true } });
        assert.deepEqual(local.map((x) => x.text), ['T n1'], 'bell on: the template, also without After done');
    });

    test('OC-8: a group\'s After done follows its last member', async () => {
        add(main, 'm1');
        add(main, 'm2');
        add(main, 'grp1', { status: 'group', comprised_of: ['m1', 'm2'], on_done: { instructions: 'The group is done.' } });
        updateTodo(Q, 'm1', { status: 'completed' });
        await settle();
        assert.equal(local.length, 0, 'one member left: nothing yet');
        updateTodo(Q, 'm2', { status: 'completed' });
        await settle();
        assert.equal(findTodoById(Q, 'grp1')!.status, 'completed');
        assert.equal(local.length, 1, 'the group completed with its last member: its instructions');
        assert.match(local[0].text, /`cq\/grp1`[\s\S]*The group is done\./);
    });

    test('OC-6: the walk line is gone', () => {
        assert.doesNotMatch(BUILTIN_GROUP_PROMPT, /on_done/, 'the extension sends the instructions; the agent is not told to');
    });
});
