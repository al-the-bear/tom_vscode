/**
 * A completed todo's `on_done` carried out through the todo writer and the runner (ww_a_collab-5).
 *
 *   OC-1 completing a todo outside a walk runs it once: an unblock target released in the files (its entry gone,
 *        not-started), a queued todo and a notification in this window's queue, a notification for another quest
 *        posted to its inbox; saving the completed todo again runs nothing
 *   OC-2 a repeated todo runs it on every completion (it then waits for its repetition)
 *   OC-3 a completion while the queue holds the todo's claim is left to the queue (deferred, taken once)
 *   OC-4 a deleted or missing target is noted on the todo; a done target skipped; a failing send does not stop
 *        the other actions
 *   OC-5 cancelling runs nothing of on_done
 *   OC-6 the built-in group prompt tells the agent to carry out only the instructions
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
let posted: Array<OnDoneSend & { from: { quest: string; run: string } }> = [];
let claimed = new Set<string>();
let failLocal = false;
const pending: Array<Promise<unknown>> = [];

function where(sourceFile: string | undefined): OnDoneTarget['where'] {
    const first = (sourceFile ?? '').split('.')[0];
    return first.endsWith('-deleted') ? 'deleted' : first.endsWith('-archived') ? 'archived' : 'live';
}

beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, '_ai'), { recursive: true, force: true });
    fs.mkdirSync(qDir, { recursive: true });
    fs.mkdirSync(oDir, { recursive: true });
    local = []; posted = []; claimed = new Set(); failLocal = false;
    setTodoOnDonePorts({
        windowQuest: () => Q,
        findTodo: (quest, id) => {
            const t = readAllTodos(quest, ALL_TODO_FILES).find((x) => x.id === id);
            return t ? { status: t.status, blocked_by: t.blocked_by, blocked_until: t.blocked_until, decisions: t.decisions,
                where: where(t._sourceFile), record: t as never, sourceFile: t._sourceFile, title: t.title } : undefined;
        },
        groupPrompt: () => 'Do ${repeatTodoId}.',
        writeTarget: (quest, id, blockedBy, status) => { updateTodo(quest, id, { blocked_by: blockedBy, ...(status ? { status: status as never } : {}) }); },
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
        pending.push(runTodoOnDone(quest, { ...t, sourceFile: t._sourceFile }, 'r1'));
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
        add(main, 't1', { status: 'blocked' });
        add(main, 't2');
        add(path.join(oDir, `todos.${OTHER}.todo.yaml`), 'o1');
        add(main, 'n1', { on_done: { todos: ['t1'], action: ['unblock'] } });
        updateTodo(Q, 't1', { blocked_by: ['n1'] });
        add(main, 'n2', { on_done: { todos: ['t2'], action: ['queue', 'notify'] } });
        add(main, 'n3', { on_done: { quest: OTHER, run: 'chg7', todos: ['o1'], action: ['queue', 'notify'], notify_prompt: 'n3 done' } });
        updateTodo(Q, 'n1', { status: 'completed' });
        updateTodo(Q, 'n2', { status: 'completed' });
        updateTodo(Q, 'n3', { status: 'completed' });
        await settle();
        assert.deepEqual(todo('t1')!.blocked_by ?? [], [], 'the entry is met');
        assert.equal(todo('t1')!.status, 'not-started');
        assert.deepEqual(local.map((s) => [s.todoId ?? 'notify', s.run]), [['t2', 'r1'], ['notify', 'r1']]);
        assert.match(local[0].text, /^Do t2\./);
        assert.match(local[1].text, /^Todo n2 \(T n2\) of quest cq is completed\./);
        assert.deepEqual(posted.map((s) => [s.quest, s.run, s.todoId ?? s.text]), [[OTHER, 'chg7', 'o1'], [OTHER, 'chg7', 'n3 done']]);
        assert.deepEqual(posted[0].from, { quest: Q, run: 'r1' });
        updateTodo(Q, 'n2', { status: 'completed', notes: 'again' });
        await settle();
        assert.equal(local.length, 2, 'saving the completed todo again runs nothing');
    });

    test('OC-2: a repeated todo runs it on every completion', async () => {
        add(main, 'rep1', { repeat: { rule: 'manual' }, on_done: { action: ['notify'], notify_prompt: 'rep1 done' } });
        updateTodo(Q, 'rep1', { status: 'completed' });
        await settle();
        assert.equal(todo('rep1')!.status, 'waiting-for-repeat');
        updateTodo(Q, 'rep1', { status: 'not-started' });
        updateTodo(Q, 'rep1', { status: 'completed' });
        await settle();
        assert.deepEqual(local.map((s) => s.text), ['rep1 done', 'rep1 done']);
    });

    test('OC-3: a walk\'s claim takes the completion', async () => {
        add(main, 'w1', { on_done: { action: ['notify'], notify_prompt: 'w1 done' } });
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
        add(main, 'q1');
        add(main, 'n1', { on_done: { todos: ['c1', 'd1', 'gone1', 'q1'], action: ['unblock', 'queue', 'notify'] } });
        updateTodo(Q, 'q1', { blocked_by: ['n1'] });
        failLocal = true;
        updateTodo(Q, 'n1', { status: 'completed' });
        await settle();
        const notes = todo('n1')!.notes ?? '';
        assert.match(notes, /cq\/d1 was deleted; skipped\./);
        assert.match(notes, /cq\/gone1 does not exist; skipped\./);
        assert.doesNotMatch(notes, /c1/, 'a done target is skipped without a note');
        assert.deepEqual(todo('q1')!.blocked_by ?? [], [], 'the unblock ran though the sends failed');
    });

    test('OC-5: cancelling runs nothing', async () => {
        add(main, 't1');
        add(main, 'n1', { on_done: { todos: ['t1'], action: ['queue', 'notify'] } });
        updateTodo(Q, 'n1', { status: 'cancelled' });
        await settle();
        assert.equal(local.length + posted.length, 0);
    });

    test('OC-6: the walk line', () => {
        assert.match(BUILTIN_GROUP_PROMPT, /When the todo is completed, carry out what its `on_done` leaves to you \(its `instructions`\)\./);
    });
});
