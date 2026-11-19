/**
 * Todo reminders on real todo files (vscimpb152ab; managers/questTodoManager.ts,
 * services/todoDueReminders.ts, tools/quest-todo-tools.ts, utils/todoRemind.ts).
 *
 *   RR-1 the tools set `remind` (next_remind computed, a changed rule starts again, null removes it with its moment and
 *        count) and `reminders`; a manual rule, a bad entry and a hand-set next_remind are refused
 *   RR-2 a schedule rings at its moments, once per moment also with two controllers; `count` ends it
 *   RR-3 completed, cancelled and waiting-for-repeat todos ring nothing; brought back by `repeat`, next_remind is
 *        computed again from then
 *   RR-4 a one-shot reminder rings once (acknowledged), also with two controllers; a changed due lets a `before` one
 *        ring again
 *   RR-5 what one todo has due at a check goes out as one notification
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-remind-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, findTodoById, markDueReminded, markReminderEntrySent, markRemindSent, readAllTodos, updateTodo } from '../questTodoManager.js';
import { createQuestTodoImpl, updateQuestTodoImpl, type QuestTodoFull, type QuestTodoToolsDeps } from '../../tools/quest-todo-tools.js';
import { sendTodoReminders, type DueReminderPort } from '../../services/todoDueReminders.js';
import { formatRepeatMoment } from '../../utils/todoRepeat.js';

const QUEST = 'remq';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);

const toFull = (t: { _sourceFile?: string } & Record<string, unknown>): QuestTodoFull => {
    const { _sourceFile, ...rest } = t;
    return { ...rest, sourceFile: _sourceFile } as QuestTodoFull;
};
const deps: QuestTodoToolsDeps = {
    store: {
        listFiles: () => [],
        listTodos: (q) => readAllTodos(q).map((t) => ({ id: t.id, title: t.title, description: t.description, status: t.status as never })),
        findById: (q, id) => { const t = findTodoById(q, id); return t ? toFull(t as never) : undefined; },
        create: (q, todo, file) => toFull(createTodo(q, todo as never, file) as never),
        update: (q, id, updates) => { const t = updateTodo(q, id, updates as never); return t ? toFull(t as never) : undefined; },
        move: () => undefined,
        delete: () => false,
    },
    today: () => '2026-11-19',
};
const call = async (impl: Promise<string>): Promise<Record<string, any>> => JSON.parse(await impl);
const at = (y: number, mo: number, d: number, h = 0, mi = 0): string => formatRepeatMoment(new Date(y, mo - 1, d, h, mi));
const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi);

/** A port on the real manager, the notifications collected. */
function realPort(sent: Array<{ message: string; title: string }>): DueReminderPort {
    return {
        readTodos: (q) => readAllTodos(q),
        markReminded: (q, id, due, stamp) => markDueReminded(q, id, due, stamp),
        markRemindSent: (q, id, expected, now) => markRemindSent(q, id, expected, now),
        markReminderEntrySent: (q, id, index, entry, now) => markReminderEntrySent(q, id, index, entry, now),
        notify: (message, title) => { sent.push({ message, title }); },
    };
}

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
});
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('todo reminders on todo files', () => {
    test('RR-1: the tools set remind and reminders', async () => {
        const created = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: {
            id: 'a', title: 'Weekly', description: 'x', remind: { rule: 'weekly', weekdays: ['mon'], time: '09:00' },
            reminders: [{ at: '2026-12-01T09:00+01:00' }, { before: 'PT1H', time: '17:00' }],
        } as never }));
        assert.equal(created.ok, true, created.error);
        let todo = findTodoById(QUEST, 'a')!;
        assert.deepEqual(todo.remind, { rule: 'weekly', weekdays: ['mon'], time: '09:00' });
        assert.match(todo.next_remind ?? '', /^\d{4}-\d{2}-\d{2}T09:00[+-]\d{2}:\d{2}$/);
        assert.equal(new Date(todo.next_remind!).getDay(), 1, 'a Monday');
        assert.equal(todo.reminders?.length, 2);

        // Unchanged rule, other fields changed: the schedule runs on.
        updateTodo(QUEST, 'a', { next_remind: at(2026, 11, 23, 9), remind_count: 3 } as never);
        await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { remind: { rule: 'weekly', weekdays: ['mon'], time: '09:00' }, title: 'Weekly!' } as never }));
        todo = findTodoById(QUEST, 'a')!;
        assert.equal(todo.next_remind, at(2026, 11, 23, 9));
        assert.equal(todo.remind_count, 3);
        // A changed rule starts again.
        await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { remind: { rule: 'daily', time: '08:00' } } as never }));
        todo = findTodoById(QUEST, 'a')!;
        assert.equal(todo.remind_count, undefined);
        assert.match(todo.next_remind ?? '', /T08:00/);
        // null removes it, with its moment and count.
        const removed = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { remind: null, reminders: null } as never }));
        assert.equal(removed.ok, true, removed.error);
        todo = findTodoById(QUEST, 'a')!;
        assert.equal(todo.remind, undefined);
        assert.equal(todo.next_remind, undefined);
        assert.equal(todo.reminders, undefined);
        assert.doesNotMatch(fs.readFileSync(path.join(questDir, `todos.${QUEST}.todo.yaml`), 'utf8'), /remind/);

        const manual = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { remind: { rule: 'manual' } } as never }));
        assert.equal(manual.ok, false);
        assert.match(manual.error, /manual/);
        const bad = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { reminders: [{ before: 'an hour' }] } as never }));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /reminders\[0\].*duration/);
        const byHand = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'a', updates: { next_remind: at(2026, 12, 1) } as never }));
        assert.equal(byHand.ok, false);
        assert.match(byHand.error, /kept by the extension/);
    });

    test('RR-2: a schedule rings at its moments, once per moment', async () => {
        createTodo(QUEST, { id: 's', title: 'Chase', description: 'x', status: 'in-progress',
            remind: { rule: 'daily', time: '09:00', count: 2 }, next_remind: at(2026, 11, 20, 9) } as never);
        const sent: Array<{ message: string; title: string }> = [];
        assert.equal((await sendTodoReminders(realPort(sent), [QUEST], local(2026, 11, 20, 8, 59))).sent.length, 0, 'not yet');
        const now = local(2026, 11, 20, 9, 1);
        const [a, b] = await Promise.all([sendTodoReminders(realPort(sent), [QUEST], now), sendTodoReminders(realPort(sent), [QUEST], now)]);
        assert.equal(a.sent.length + b.sent.length, 1, 'one reminder between two controllers');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].title, 'Todo reminder');
        assert.equal(sent[0].message, 'Quest remq: todo s — Chase: reminder (every day at 09:00, 2 times).');
        let todo = findTodoById(QUEST, 's')!;
        assert.equal(todo.next_remind, at(2026, 11, 21, 9));
        assert.equal(todo.remind_count, 1);
        assert.equal(markRemindSent(QUEST, 's', at(2026, 11, 20, 9), now), false, 'the moment already moved on');
        // Missed for three days: one reminder, and it was the last (count 2).
        await sendTodoReminders(realPort(sent), [QUEST], local(2026, 11, 24, 10));
        assert.equal(sent.length, 2);
        todo = findTodoById(QUEST, 's')!;
        assert.equal(todo.remind_count, 2);
        assert.equal(todo.next_remind, undefined, 'ended');
        assert.deepEqual(todo.remind, { rule: 'daily', time: '09:00', count: 2 }, 'the rule stays');
        await sendTodoReminders(realPort(sent), [QUEST], local(2026, 12, 24, 10));
        assert.equal(sent.length, 2);
    });

    test('RR-3: closed and waiting todos ring nothing; repeat brings the schedule back from then', async () => {
        for (const [id, status] of [['c', 'completed'], ['x', 'cancelled'], ['w', 'waiting-for-repeat']]) {
            createTodo(QUEST, { id, description: 'x', status, remind: { rule: 'daily' }, next_remind: at(2026, 11, 1),
                reminders: [{ at: '2026-11-01T09:00+01:00' }], due: '2026-11-01', due_reminded: '2026-11-01T09:00+01:00' } as never);
        }
        const sent: Array<{ message: string; title: string }> = [];
        await sendTodoReminders(realPort(sent), [QUEST], local(2026, 11, 19, 10));
        assert.equal(sent.length, 0);
        // Repeat now (or the controller): back to not-started, the schedule starts again from now — not the old moment.
        const before = Date.now();
        updateTodo(QUEST, 'w', { status: 'not-started' });
        const next = new Date(findTodoById(QUEST, 'w')!.next_remind!).getTime();
        assert.ok(next > before && next <= before + 24 * 3600_000 + 60_000, 'the next midnight');
    });

    test('RR-4: a one-shot reminder rings once; a changed due lets a before one ring again', async () => {
        createTodo(QUEST, { id: 'o', title: 'Ship', description: 'x', status: 'not-started', due: '2026-11-25',
            due_reminded: '2026-11-25T09:00+01:00', reminders: [{ before: 'PT1H', time: '17:00' }, { at: formatRepeatMoment(local(2026, 11, 30, 12)) }] } as never);
        const sent: Array<{ message: string; title: string }> = [];
        const now = local(2026, 11, 25, 16, 5);
        await Promise.all([sendTodoReminders(realPort(sent), [QUEST], now), sendTodoReminders(realPort(sent), [QUEST], now)]);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].message, 'Quest remq: todo o — Ship: reminder 1 hour before the due date at 17:00.');
        let todo = findTodoById(QUEST, 'o')!;
        assert.match(todo.reminders![0].acknowledged ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        assert.equal(todo.reminders![1].acknowledged, undefined, 'the later one not yet');
        await sendTodoReminders(realPort(sent), [QUEST], local(2026, 11, 26));
        assert.equal(sent.length, 1, 'once only');
        updateTodo(QUEST, 'o', { due: '2026-12-02' });
        todo = findTodoById(QUEST, 'o')!;
        assert.equal(todo.reminders![0].acknowledged, undefined, 'moved with the date');
        await sendTodoReminders(realPort(sent), [QUEST], local(2026, 12, 2, 16, 30));
        // The `before` one again, the `at` one (Nov 30) now too, and the new due date's reminder: one notification.
        assert.equal(sent.length, 2);
        assert.equal(sent[1].message, 'Quest remq: todo o — Ship: is due today (2026-12-02); reminder 1 hour before the due date at 17:00; reminder at '
            + formatRepeatMoment(local(2026, 11, 30, 12)).replace('T', ' ') + '.');
    });

    test('RR-5: what one todo has due goes out as one notification; a due date alone keeps its own text', async () => {
        createTodo(QUEST, { id: 'm', title: 'Many', description: 'x', status: 'not-started', due: '2026-11-20',
            remind: { rule: 'daily', time: '09:00' }, next_remind: at(2026, 11, 20, 9) } as never);
        createTodo(QUEST, { id: 'd', title: 'Date', description: 'x', status: 'not-started', due: '2026-11-20' } as never);
        const sent: Array<{ message: string; title: string }> = [];
        const result = await sendTodoReminders(realPort(sent), [QUEST], local(2026, 11, 20, 9, 30));
        assert.deepEqual(result.sent.map((s) => [s.todoId, s.kinds]), [['m', ['due', 'remind']], ['d', ['due']]]);
        assert.deepEqual(sent, [
            { title: 'Todo reminder', message: 'Quest remq: todo m — Many: is due today (2026-11-20); reminder (every day at 09:00).' },
            { title: 'Todo due', message: 'Quest remq: todo d — Date is due today (2026-11-20).' },
        ]);
    });
});
