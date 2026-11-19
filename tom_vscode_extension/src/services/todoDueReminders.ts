/**
 * The reminders of todos (vscimpb152aa, vscimpb152ab): checked on the
 * repeated-todo controller's tick (managers/timerEngine.ts,
 * `runRepeatedTodoCheck`), beside the release of repeated todos. A todo rings
 * through three fields (the rules: utils/todoDue.ts, utils/todoRemind.ts):
 *
 * - its `due` date, once, at `todoPanel.dueReminderTime` (default 09:00
 *   local) or any later check — recorded in `due_reminded`;
 * - its `remind` schedule, at each moment `next_remind` names — which then
 *   moves on, `remind_count` counting;
 * - each entry of its one-shot `reminders`, once — recorded in its
 *   `acknowledged`.
 *
 * Each is first recorded with a check-and-set under the todo file's lock
 * (`markDueReminded`, `markRemindSent`, `markReminderEntrySent`), so of two
 * controllers on the same file one sends; what one todo has due at a check
 * goes out as ONE notification through `tomAi_notifyUser`'s channel `auto` —
 * the quest's Telegram where set up, else a VS Code message — naming the
 * quest, the todo and why it rings. Completed, cancelled (and, for `remind`
 * and `reminders`, `waiting-for-repeat`) todos ring nothing.
 *
 * Only the window of the todo's quest sends (the user's rule for now): the
 * check is given that one quest. The record is in the todo either way, so
 * when more windows send, it still goes out once.
 */

import { dueDateOf, dueReminderText, isDueReminderDue, localDate, localMoment, reminderTime, type DueTodo } from '../utils/todoDue';
import {
    describeRemind, describeReminderEntry, isRemindDue, isReminderEntryDue,
    type RemindTodo, type TodoReminderEntry,
} from '../utils/todoRemind';

/** A todo as the check reads it. */
export type ReminderTodo = DueTodo & RemindTodo & { id: string; title?: string; reminders?: TodoReminderEntry[] };

/** What the check reads, writes and sends through; the live one is the todo manager and notifyUserLive. */
export interface DueReminderPort {
    readTodos(questId: string): ReminderTodo[];
    /** Check-and-set: true when this call recorded the reminder (and so sends it). */
    markReminded(questId: string, todoId: string, due: string, stamp: string): boolean;
    /** Check-and-set of a `remind` reminder: true when `next_remind` was still `expected` and moved on. Absent: schedules are not checked. */
    markRemindSent?(questId: string, todoId: string, expected: string, now: Date): boolean;
    /** Check-and-set of `reminders[index]`: true when it was still `entry`, due, and is now acknowledged. Absent: one-shot reminders are not checked. */
    markReminderEntrySent?(questId: string, todoId: string, index: number, entry: TodoReminderEntry, now: Date): boolean;
    notify(message: string, title: string): Promise<unknown> | unknown;
}

/** One reminder sent. */
export interface SentDueReminder {
    questId: string;
    todoId: string;
    due: string;
}

/** Why a todo rang at a check. */
export type ReminderKind = 'due' | 'remind' | 'reminder';

/** One notification sent: the todo and why it rang. */
export interface SentTodoReminder {
    questId: string;
    todoId: string;
    kinds: ReminderKind[];
    /** The `due` date, when the due reminder is one of them. */
    due?: string;
}

/** The notification's text: the quest, the todo, and every reason it rings now. */
export function todoReminderText(questId: string, todo: ReminderTodo, reasons: readonly string[]): string {
    return `Quest ${questId}: todo ${todo.id}${todo.title ? ` — ${todo.title}` : ''}: ${reasons.join('; ')}.`;
}

/**
 * Send every reminder of `questIds` due at `now` — the due date's, the
 * `remind` schedule's and the one-shot `reminders`' — one notification per
 * todo; answers what was sent and what failed.
 */
export async function sendTodoReminders(
    port: DueReminderPort,
    questIds: readonly string[],
    now: Date = new Date(),
    time?: string,
): Promise<{ sent: SentTodoReminder[]; failed: string[] }> {
    const sent: SentTodoReminder[] = [];
    const failed: string[] = [];
    const at = reminderTime(time);
    const today = localDate(now);
    for (const questId of questIds) {
        let todos: ReminderTodo[];
        try { todos = port.readTodos(questId); } catch { continue; }
        for (const todo of todos) {
            const kinds: ReminderKind[] = [];
            const reasons: string[] = [];
            let due: string | undefined;
            const key = `${questId}/${todo.id}`;
            try {
                if (isDueReminderDue(todo, now, at)) {
                    const d = dueDateOf(todo)!;
                    if (port.markReminded(questId, todo.id, d, localMoment(now))) {
                        kinds.push('due'); due = d;
                        reasons.push(d < today ? `was due on ${d} (overdue)` : `is due today (${d})`);
                    }
                }
                if (port.markRemindSent && todo.remind && todo.next_remind && isRemindDue(todo, now)) {
                    if (port.markRemindSent(questId, todo.id, todo.next_remind, now)) {
                        kinds.push('remind');
                        reasons.push(`reminder (${describeRemind(todo.remind)})`);
                    }
                }
                if (port.markReminderEntrySent) {
                    (todo.reminders ?? []).forEach((entry, index) => {
                        if (!isReminderEntryDue(entry, todo.status, todo.due, now)) { return; }
                        if (port.markReminderEntrySent!(questId, todo.id, index, entry, now)) {
                            if (!kinds.includes('reminder')) { kinds.push('reminder'); }
                            reasons.push(`reminder ${describeReminderEntry(entry)}`);
                        }
                    });
                }
            } catch {
                failed.push(key);
            }
            if (!kinds.length) { continue; }
            try {
                const onlyDue = kinds.length === 1 && kinds[0] === 'due';
                await port.notify(onlyDue ? dueReminderText(questId, todo, today) : todoReminderText(questId, todo, reasons), onlyDue ? 'Todo due' : 'Todo reminder');
                sent.push({ questId, todoId: todo.id, kinds, ...(due ? { due } : {}) });
            } catch {
                if (!failed.includes(key)) { failed.push(key); }
            }
        }
    }
    return { sent, failed };
}

/** Send every due-date reminder of `questIds` at `now` (sendTodoReminders with only the due date checked). */
export async function sendDueReminders(
    port: DueReminderPort,
    questIds: readonly string[],
    now: Date = new Date(),
    time?: string,
): Promise<{ sent: SentDueReminder[]; failed: string[] }> {
    const dueOnly: DueReminderPort = { readTodos: port.readTodos.bind(port), markReminded: port.markReminded.bind(port), notify: port.notify.bind(port) };
    const result = await sendTodoReminders(dueOnly, questIds, now, time);
    return { sent: result.sent.map((s) => ({ questId: s.questId, todoId: s.todoId, due: s.due ?? '' })), failed: result.failed };
}

/** The live port: the quest todo manager and notifyUserLive (both loaded lazily: they pull in vscode). */
export function liveDueReminderPort(): DueReminderPort {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const manager = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
    const notifier = require('../tools/chat-enhancement-tools') as typeof import('../tools/chat-enhancement-tools');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return {
        readTodos: (questId) => manager.readAllTodos(questId),
        markReminded: (questId, todoId, due, stamp) => manager.markDueReminded(questId, todoId, due, stamp),
        markRemindSent: (questId, todoId, expected, now) => manager.markRemindSent(questId, todoId, expected, now),
        markReminderEntrySent: (questId, todoId, index, entry, now) => manager.markReminderEntrySent(questId, todoId, index, entry, now),
        notify: (message, title) => notifier.notifyUserLive({ message, title, channel: 'auto' }),
    };
}
