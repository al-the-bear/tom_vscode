/**
 * The one reminder of a todo's `due` date (vscimpb152aa, TD-22 (a)): checked
 * on the repeated-todo controller's tick (managers/timerEngine.ts,
 * `runRepeatedTodoCheck`), beside the release of repeated todos.
 *
 * A todo whose `due` has a reminder moment that has come (that date at
 * `todoPanel.dueReminderTime`, default 09:00 local — or any later check), that
 * is not completed or cancelled and carries no `due_reminded`, is first marked
 * (`markDueReminded`: a check-and-set under a lock, so of two controllers on
 * the same file one sends), then announced through `tomAi_notifyUser`'s
 * channel `auto` — the quest's Telegram where set up, else a VS Code message —
 * naming the quest, the todo and the date.
 *
 * Only the window of the todo's quest sends (the user's rule for now): the
 * check is given that one quest. The record is in the todo either way, so
 * when more windows send, it still goes out once.
 */

import { dueDateOf, dueReminderText, isDueReminderDue, localDate, localMoment, reminderTime, type DueTodo } from '../utils/todoDue';

/** What the check reads, writes and sends through; the live one is the todo manager and notifyUserLive. */
export interface DueReminderPort {
    readTodos(questId: string): Array<DueTodo & { id: string; title?: string }>;
    /** Check-and-set: true when this call recorded the reminder (and so sends it). */
    markReminded(questId: string, todoId: string, due: string, stamp: string): boolean;
    notify(message: string, title: string): Promise<unknown> | unknown;
}

/** One reminder sent. */
export interface SentDueReminder {
    questId: string;
    todoId: string;
    due: string;
}

/** Send every due reminder of `questIds` at `now`; answers what was sent and what failed. */
export async function sendDueReminders(
    port: DueReminderPort,
    questIds: readonly string[],
    now: Date = new Date(),
    time?: string,
): Promise<{ sent: SentDueReminder[]; failed: string[] }> {
    const sent: SentDueReminder[] = [];
    const failed: string[] = [];
    const at = reminderTime(time);
    const today = localDate(now);
    for (const questId of questIds) {
        let todos: Array<DueTodo & { id: string; title?: string }>;
        try { todos = port.readTodos(questId); } catch { continue; }
        for (const todo of todos) {
            if (!isDueReminderDue(todo, now, at)) { continue; }
            const due = dueDateOf(todo)!;
            let marked = false;
            try { marked = port.markReminded(questId, todo.id, due, localMoment(now)); } catch { failed.push(`${questId}/${todo.id}`); continue; }
            if (!marked) { continue; }
            try {
                await port.notify(dueReminderText(questId, todo, today), 'Todo due');
                sent.push({ questId, todoId: todo.id, due });
            } catch {
                failed.push(`${questId}/${todo.id}`);
            }
        }
    }
    return { sent, failed };
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
        notify: (message, title) => notifier.notifyUserLive({ message, title, channel: 'auto' }),
    };
}
