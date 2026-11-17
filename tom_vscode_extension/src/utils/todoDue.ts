/**
 * A todo's target completion date, `due` (`YYYY-MM-DD`, the todo schema's):
 * the overdue state and the moment of its one reminder (vscimpb152aa).
 *
 * - **Overdue** is derived, not a status (TD-21 (a)): `due` before today and
 *   the status neither `completed` nor `cancelled`. On the date itself a todo
 *   is not overdue yet.
 * - **The reminder** goes out on the due date at a configurable local time
 *   (`todoPanel.dueReminderTime`, default 09:00), or at the first check after
 *   it (TD-22 (a)); once — the todo records it in `due_reminded`, which a
 *   change of `due` removes (questTodoManager.applyTodoUpdates).
 *
 * vscode-free.
 */

export const DEFAULT_DUE_REMINDER_TIME = '09:00';

/** The statuses that end a todo's date: no overdue state, no reminder. */
const CLOSED = new Set(['completed', 'cancelled']);

/** What the date rules read of a todo. */
export interface DueTodo {
    status?: string;
    due?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    due_reminded?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local date of `now`, `YYYY-MM-DD`. */
export function localDate(now: Date): string {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `now` as `YYYY-MM-DDTHH:MM` with its local offset (the form `due_reminded` is written in). */
export function localMoment(now: Date): string {
    const off = -now.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The `due` date of a todo when it is a valid `YYYY-MM-DD` (a timestamp gives its date part), else undefined. */
export function dueDateOf(todo: DueTodo): string | undefined {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec((todo.due ?? '').trim());
    return m ? m[1] : undefined;
}

/** Whether the todo is overdue on `today` (`YYYY-MM-DD`): its date has passed and it is still open. */
export function isTodoOverdue(todo: DueTodo, today: string): boolean {
    const due = dueDateOf(todo);
    return !!due && !CLOSED.has(todo.status ?? '') && due < today;
}

/** A valid `HH:MM` time, else the default 09:00. */
export function reminderTime(value: string | undefined): string {
    const v = (value ?? '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : DEFAULT_DUE_REMINDER_TIME;
}

/** The local moment the reminder for `due` goes out: that date at `time`. */
export function dueReminderMoment(due: string, time: string): Date {
    const [y, mo, d] = due.split('-').map(Number);
    const [h, mi] = reminderTime(time).split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi, 0, 0);
}

/**
 * Whether the todo's one reminder is to be sent at `now`: it has a date, is
 * open, has not been reminded, and the date's reminder moment has come.
 */
export function isDueReminderDue(todo: DueTodo, now: Date, time: string = DEFAULT_DUE_REMINDER_TIME): boolean {
    const due = dueDateOf(todo);
    if (!due || CLOSED.has(todo.status ?? '') || (todo.due_reminded ?? '').trim()) { return false; }
    return now.getTime() >= dueReminderMoment(due, time).getTime();
}

/** The reminder's text: the quest, the todo id and title, and the date (overdue when it has passed). */
export function dueReminderText(quest: string, todo: DueTodo & { id: string; title?: string }, today: string): string {
    const due = dueDateOf(todo) ?? todo.due ?? '';
    const when = due < today ? `was due on ${due} (overdue)` : `is due today (${due})`;
    return `Quest ${quest}: todo ${todo.id}${todo.title ? ` — ${todo.title}` : ''} ${when}.`;
}
