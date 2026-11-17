/**
 * A todo's target date `due`, its overdue state and its one reminder
 * (vscimpb152aa; managers/questTodoManager.ts, utils/todoDue.ts,
 * services/todoDueReminders.ts, tools/quest-todo-tools.ts), on real todo files.
 *
 *   DU-1 the tools create and update `due` (a timestamp written as its date, "" removes it); get and list report it
 *        with `overdue` (derived), and the list filters on `overdue`
 *   DU-2 the reminder is sent once: two controllers on the same file at the same moment send one, the todo records
 *        `due_reminded`, and a later tick sends nothing
 *   DU-3 a changed `due` re-arms it (the record goes); the same date keeps it; a move keeps the record
 *   DU-4 the todo panel's Created date is written (it was sent and dropped)
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-due-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, findTodoById, markDueReminded, moveTodo, readAllTodos, updateTodo } from '../questTodoManager.js';
import {
    createQuestTodoImpl, getQuestTodoImpl, listQuestTodosImpl, updateQuestTodoImpl,
    type QuestTodoFull, type QuestTodoToolsDeps,
} from '../../tools/quest-todo-tools.js';
import { sendDueReminders, type DueReminderPort } from '../../services/todoDueReminders.js';

const QUEST = 'dueq';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);
const todoFile = path.join(questDir, `todos.${QUEST}.todo.yaml`);

const toFull = (t: { _sourceFile?: string } & Record<string, unknown>): QuestTodoFull => {
    const { _sourceFile, ...rest } = t;
    return { ...rest, sourceFile: _sourceFile } as QuestTodoFull;
};
const deps: QuestTodoToolsDeps = {
    store: {
        listFiles: () => [],
        listTodos: (q) => readAllTodos(q).map((t) => ({ id: t.id, title: t.title, description: t.description, status: t.status as never, ...(t.due ? { due: t.due } : {}) })),
        findById: (q, id) => { const t = findTodoById(q, id); return t ? toFull(t as never) : undefined; },
        create: (q, todo, file) => toFull(createTodo(q, todo as never, file) as never),
        update: (q, id, updates) => { const t = updateTodo(q, id, updates as never); return t ? toFull(t as never) : undefined; },
        move: () => undefined,
        delete: () => false,
    },
    today: () => '2026-12-02',
};

const call = async (impl: Promise<string>): Promise<Record<string, any>> => JSON.parse(await impl);

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
});
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A port on the real manager, with the notifications collected. */
function realPort(sent: string[]): DueReminderPort {
    return {
        readTodos: (q) => readAllTodos(q),
        markReminded: (q, id, due, stamp) => markDueReminded(q, id, due, stamp),
        notify: (message) => { sent.push(message); },
    };
}

describe('due: the overdue state and the one reminder', () => {
    test('DU-1: the tools write and report due and overdue', async () => {
        const c = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'late', description: 'x', title: 'Late one', due: '2026-12-01T18:00:00+01:00' } }));
        assert.equal(c.ok, true, c.error);
        assert.match(fs.readFileSync(todoFile, 'utf8'), /\n {4}due: 2026-12-01\n/, 'written as its date');
        await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'today', description: 'x', due: '2026-12-02' } }));
        await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'done', description: 'x', due: '2026-11-01', status: 'completed' } }));
        await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'none', description: 'x' } }));

        const late = await call(getQuestTodoImpl(deps, { questId: QUEST, todoId: 'late' }));
        assert.deepEqual([late.todo.due, late.todo.overdue], ['2026-12-01', true]);
        const today = await call(getQuestTodoImpl(deps, { questId: QUEST, todoId: 'today' }));
        assert.equal(today.todo.overdue, false, 'on the date: not yet');
        const none = await call(getQuestTodoImpl(deps, { questId: QUEST, todoId: 'none' }));
        assert.equal('overdue' in none.todo, false, 'no date, no state');

        const list = await call(listQuestTodosImpl(deps, { questId: QUEST }));
        const by = Object.fromEntries(list.items.map((i: { id: string }) => [i.id, i]));
        assert.deepEqual([by.late.overdue, by.today.overdue, by.done.overdue, by.none.overdue], [true, undefined, undefined, undefined]);
        assert.equal(by.late.due, '2026-12-01');
        const only = await call(listQuestTodosImpl(deps, { questId: QUEST, overdue: true }));
        assert.deepEqual(only.items.map((i: { id: string }) => i.id), ['late']);
        const others = await call(listQuestTodosImpl(deps, { questId: QUEST, overdue: false }));
        assert.deepEqual(others.items.map((i: { id: string }) => i.id).sort(), ['done', 'none', 'today']);

        const cleared = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'late', updates: { due: '' } }));
        assert.equal(cleared.ok, true, cleared.error);
        assert.equal(findTodoById(QUEST, 'late')?.due, undefined, '"" removes it');
    });

    test('DU-2: the reminder is sent once, also by two controllers on the same file', async () => {
        createTodo(QUEST, { id: 'r1', description: 'x', title: 'Remind me', status: 'not-started', due: '2026-12-01' } as never);
        createTodo(QUEST, { id: 'r2', description: 'x', status: 'completed', due: '2026-12-01' } as never);
        createTodo(QUEST, { id: 'r3', description: 'x', status: 'not-started', due: '2026-12-09' } as never);
        const sent: string[] = [];
        const now = new Date(2026, 11, 1, 9, 30);
        const [a, b] = await Promise.all([
            sendDueReminders(realPort(sent), [QUEST], now),
            sendDueReminders(realPort(sent), [QUEST], now),
        ]);
        assert.equal(a.sent.length + b.sent.length, 1, 'one reminder between the two');
        assert.equal(sent.length, 1);
        assert.match(sent[0], /^Quest dueq: todo r1 — Remind me is due today \(2026-12-01\)\.$/);
        const recorded = findTodoById(QUEST, 'r1')?.due_reminded;
        assert.match(recorded ?? '', /^2026-12-01T09:30[+-]\d{2}:\d{2}$/);
        assert.equal(findTodoById(QUEST, 'r2')?.due_reminded, undefined, 'a completed todo gets none');
        assert.equal(findTodoById(QUEST, 'r3')?.due_reminded, undefined, 'a later date not yet');
        const later = await sendDueReminders(realPort(sent), [QUEST], new Date(2026, 11, 3, 10, 0));
        assert.equal(later.sent.length, 0, 'once only');
        assert.equal(sent.length, 1);
        assert.equal(markDueReminded(QUEST, 'r1', '2026-12-01', '2026-12-03T10:00+01:00'), false, 'already recorded');
        assert.equal(markDueReminded(QUEST, 'r3', '2026-12-08', '2026-12-03T10:00+01:00'), false, 'another date than the todo has');
        // A controller holding the file's lock (another window, now): this one leaves it to that one.
        const lock = `${todoFile}.due-reminder.lock`;
        fs.mkdirSync(lock);
        assert.equal(markDueReminded(QUEST, 'r3', '2026-12-09', '2026-12-09T09:00+01:00'), false, 'locked: not this one');
        assert.equal(findTodoById(QUEST, 'r3')?.due_reminded, undefined);
        // A lock left by a window that died is taken over.
        const old = new Date(Date.now() - 5 * 60_000);
        fs.utimesSync(lock, old, old);
        assert.equal(markDueReminded(QUEST, 'r3', '2026-12-09', '2026-12-09T09:00+01:00'), true, 'a stale lock is taken over');
        assert.equal(fs.existsSync(lock), false, 'and released');
    });

    test('DU-3: a changed due re-arms the reminder; the same date keeps it; a move carries it', async () => {
        createTodo(QUEST, { id: 'm', description: 'x', status: 'in-progress', due: '2026-12-01' } as never);
        assert.equal(markDueReminded(QUEST, 'm', '2026-12-01', '2026-12-01T09:00+01:00'), true);
        updateTodo(QUEST, 'm', { due: '2026-12-01', notes: 'touched' } as never);
        assert.equal(findTodoById(QUEST, 'm')?.due_reminded, '2026-12-01T09:00+01:00', 'the same date keeps it');
        const moved = moveTodo(QUEST, 'm', 'todos-other.dueq.todo.yaml');
        assert.ok(moved);
        assert.equal(findTodoById(QUEST, 'm')?.due_reminded, '2026-12-01T09:00+01:00', 'a move carries it');
        updateTodo(QUEST, 'm', { due: '2026-12-08' } as never);
        assert.equal(findTodoById(QUEST, 'm')?.due_reminded, undefined, 'another date clears it');
        const sent: string[] = [];
        await sendDueReminders(realPort(sent), [QUEST], new Date(2026, 11, 8, 9, 0));
        assert.equal(sent.length, 1, 're-armed: the new date gets its reminder');
        assert.throws(() => updateTodo(QUEST, 'm', { due_reminded: 'soon' } as never), /due_reminded must read/);
    });

    test('DU-4: the todo panel\'s Created date is written', () => {
        createTodo(QUEST, { id: 'c', description: 'x', status: 'not-started', created: '2026-11-01' } as never);
        updateTodo(QUEST, 'c', { created: '2026-10-15' } as never);
        assert.equal(findTodoById(QUEST, 'c')?.created, '2026-10-15');
    });
});
