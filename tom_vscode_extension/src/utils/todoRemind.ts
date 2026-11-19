/**
 * Todo reminders (vscimpb152ab), the rules (pure). A todo rings through three
 * fields, each on its own; the reminder service (services/todoDueReminders.ts)
 * sends what is due of all three as one notification per todo.
 *
 * - **`due`** rings once on its day (utils/todoDue.ts, `due_reminded`).
 * - **`remind`** is a reminder schedule: the rule forms of `repeat`
 *   (utils/todoRepeat.ts) but `manual`. While the todo is open it rings at
 *   each moment the rule names; `next_remind` is the next one, written before
 *   the reminder is sent so it rings once across windows and hosts, and
 *   `remind_count` counts the reminders sent. `after` counts from the
 *   reminder before (the first from the moment the rule was set); a calendar
 *   rule keeps its schedule (it counts from the moment that rang). Missed
 *   moments ring once: `next_remind` then moves to the next moment to come.
 *   `count` and `until` end the schedule (`next_remind` removed, `remind`
 *   kept). Completed, cancelled and `waiting-for-repeat` todos ring nothing;
 *   when `repeat` brings the todo back, `next_remind` is computed again from
 *   that moment.
 * - **`reminders`** are one-shot reminders (Webwork D1 §3.5.1): `{at}` an
 *   instant with its offset, or `{before}` an ISO-8601 duration before `due`
 *   at `time` (the start of the day without one). Each rings once, not before
 *   `snoozed_until`; `acknowledged` (a UTC timestamp) records that it rang or
 *   was dismissed. Nothing rings on a completed, cancelled or
 *   `waiting-for-repeat` todo.
 *
 * Times are the machine's local time. vscode-free.
 */

/* eslint-disable @typescript-eslint/naming-convention -- `next_remind`, `remind_count`, `snoozed_until`: the todo schema's YAML keys */

import { describeRepeat, formatRepeatMoment, nextRepeatAfter, parseRepeatMoment, repeatRuleError, type TodoRepeat } from './todoRepeat';

/** The statuses that ring nothing: done, and done-until-it-comes-back. */
const SILENT = new Set(['completed', 'cancelled', 'waiting-for-repeat']);

/** Whether a todo of `status` may ring. */
export function ringsAtAll(status: string | undefined): boolean {
    return !SILENT.has((status ?? 'not-started').trim());
}

// ── remind ────────────────────────────────────────────────────────────────

/** Why `remind` is not a reminder rule, or null: a `repeat` rule that is not `manual`. */
export function remindRuleError(remind: unknown): string | null {
    const why = repeatRuleError(remind);
    if (why) { return why; }
    if ((remind as TodoRepeat).rule === 'manual') { return 'a reminder rule cannot be `manual`: it must name its moments (after, daily, weekly, monthly, yearly)'; }
    return null;
}

/** The fields of a todo the remind rules read. */
export interface RemindTodo {
    status?: string;
    remind?: TodoRepeat;
    next_remind?: string;
    remind_count?: number;
}

/** The moment after `now` the rule names, counted from `anchor`; null when it falls after `until` (or there is none). */
function nextMoment(rule: TodoRepeat, now: Date, anchor: Date): string | undefined {
    const next = nextRepeatAfter(rule, now, anchor);
    if (!next) { return undefined; }
    const text = formatRepeatMoment(next);
    if (rule.until && text.slice(0, 10) > rule.until) { return undefined; }
    return text;
}

/**
 * The first `next_remind` of a rule set (or set again, or brought back by
 * `repeat`) at `now`: the first moment after `now`, counted from `now`.
 * Undefined when the rule names none before its `until`, or `count` is
 * already reached by `sent` reminders.
 */
export function firstRemind(rule: TodoRepeat, now: Date, sent = 0): string | undefined {
    if (remindRuleError(rule)) { return undefined; }
    if (rule.count !== undefined && sent >= rule.count) { return undefined; }
    return nextMoment(rule, now, now);
}

/** Whether the todo's schedule rings at `now`: it may ring, has a valid rule, and its `next_remind` has come. */
export function isRemindDue(todo: RemindTodo, now: Date): boolean {
    if (!ringsAtAll(todo.status) || !todo.remind || remindRuleError(todo.remind)) { return false; }
    const next = parseRepeatMoment(todo.next_remind);
    return next !== null && next.getTime() <= now.getTime();
}

/** What a reminder of the schedule sent at `now` writes: the count, and the next moment (absent once the rule has ended). */
export interface RemindAdvance {
    next_remind?: string;
    remind_count: number;
}

/**
 * The schedule after a reminder at `now`: one more sent, and the next moment
 * after `now` — so moments missed meanwhile ring as this one reminder. A
 * calendar rule counts from the moment that rang (its schedule is kept),
 * `after` from `now`.
 */
export function advanceRemind(todo: RemindTodo, now: Date): RemindAdvance {
    const sent = (todo.remind_count ?? 0) + 1;
    const rule = todo.remind;
    if (!rule || remindRuleError(rule) || (rule.count !== undefined && sent >= rule.count)) { return { remind_count: sent }; }
    const anchor = rule.rule === 'after' ? now : (parseRepeatMoment(todo.next_remind) ?? now);
    const next = nextMoment(rule, now, anchor);
    return next ? { next_remind: next, remind_count: sent } : { remind_count: sent };
}

/** The rule in words: `every week on Monday at 09:00`, `every 3 days after the reminder before`. */
export function describeRemind(rule: TodoRepeat): string {
    if (rule.rule !== 'after') { return describeRepeat(rule); }
    const every = rule.every ?? 1;
    const unit = rule.unit ?? 'days';
    const at = rule.time ? ` at ${rule.time}` : '';
    const end = rule.count ? `, ${rule.count} times` : rule.until ? `, until ${rule.until}` : '';
    return `every ${every === 1 ? unit.replace(/s$/, '') : `${every} ${unit}`} after the reminder before${at}${end}`;
}

// ── reminders ─────────────────────────────────────────────────────────────

/** One entry of a todo's `reminders` list, as the schema has it. */
export interface TodoReminderEntry {
    at?: string;
    before?: string;
    time?: string;
    snoozed_until?: string;
    acknowledged?: string;
}

const DURATION = /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ENTRY_KEYS = new Set(['at', 'before', 'time', 'snoozed_until', 'acknowledged']);

/** An instant with its offset (or Z) as a Date; null when it does not read. */
function parseInstant(text: string | undefined): Date | null {
    if (!text || !MOMENT.test(text)) { return null; }
    const d = new Date(text);
    return isNaN(d.getTime()) ? null : d;
}

/** Why `entry` is not a reminder entry the schema allows, or null. Mirrors tom_todo_model's TomItemReminder. */
export function reminderEntryError(entry: unknown): string | null {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return 'a reminder must be a map with `at` or `before`'; }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) { if (!ENTRY_KEYS.has(key)) { return `unknown reminder field \`${key}\` (at, before, time, snoozed_until, acknowledged)`; } }
    const hasAt = e.at !== undefined && e.at !== null;
    const hasBefore = e.before !== undefined && e.before !== null;
    if (hasAt === hasBefore) { return 'a reminder has exactly one of `at` and `before`'; }
    if (hasAt && !parseInstant(String(e.at))) { return '`at` must be an instant with its offset, e.g. 2026-11-20T09:00+01:00'; }
    if (hasBefore && !DURATION.test(String(e.before))) { return '`before` must be an ISO-8601 duration, e.g. PT1H or P1D'; }
    if (e.time !== undefined && e.time !== null) {
        if (!hasBefore) { return '`time` goes with `before`'; }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.time))) { return '`time` must be HH:MM'; }
    }
    if (e.snoozed_until !== undefined && e.snoozed_until !== null && !parseInstant(String(e.snoozed_until))) { return '`snoozed_until` must be an instant with its offset'; }
    if (e.acknowledged !== undefined && e.acknowledged !== null && !parseInstant(String(e.acknowledged))) { return '`acknowledged` must be a UTC timestamp'; }
    return null;
}

/** Why `list` is not a `reminders` list, or null. */
export function remindersError(list: unknown): string | null {
    if (!Array.isArray(list)) { return '`reminders` must be a list'; }
    for (let i = 0; i < list.length; i++) {
        const why = reminderEntryError(list[i]);
        if (why) { return `reminders[${i}]: ${why}`; }
    }
    return null;
}

/** `date` moved back by the ISO-8601 duration `text`. */
function minusDuration(date: Date, text: string): Date | null {
    const m = DURATION.exec(text);
    if (!m) { return null; }
    const n = (i: number): number => (m[i] ? parseInt(m[i], 10) : 0);
    const d = new Date(date.getTime());
    if (n(1) || n(2)) { d.setMonth(d.getMonth() - 12 * n(1) - n(2)); }
    d.setDate(d.getDate() - 7 * n(3) - n(4));
    d.setTime(d.getTime() - ((n(5) * 60 + n(6)) * 60 + n(7)) * 1000);
    return d;
}

/** When `entry` rings: its `at`, or `due` at its `time` less `before`; null when it names no moment (a `before` without a `due`). */
export function reminderEntryMoment(entry: TodoReminderEntry, due: string | undefined): Date | null {
    if (entry.at) { return parseInstant(entry.at); }
    if (!entry.before) { return null; }
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec((due ?? '').trim());
    if (!day) { return null; }
    const [h, min] = (entry.time && /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : '00:00').split(':').map(Number);
    return minusDuration(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), h, min, 0, 0), entry.before);
}

/** Whether `entry` of a todo of `status` and `due` rings at `now`: not acknowledged, its moment has come, its snooze is over. */
export function isReminderEntryDue(entry: TodoReminderEntry, status: string | undefined, due: string | undefined, now: Date): boolean {
    if (!ringsAtAll(status) || reminderEntryError(entry) || (entry.acknowledged ?? '').trim()) { return false; }
    const moment = reminderEntryMoment(entry, due);
    if (!moment || moment.getTime() > now.getTime()) { return false; }
    const snoozed = parseInstant(entry.snoozed_until);
    return !snoozed || snoozed.getTime() <= now.getTime();
}

/** Whether two entries name the same reminder (the moment fields; snooze and acknowledgement left out). */
export function sameReminderEntry(a: TodoReminderEntry, b: TodoReminderEntry): boolean {
    return (a.at ?? '') === (b.at ?? '') && (a.before ?? '') === (b.before ?? '') && (a.time ?? '') === (b.time ?? '');
}

/** `now` as `acknowledged` is written: a UTC timestamp to the second. */
export function acknowledgedStamp(now: Date): string {
    return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The entry in words: `at 2026-11-20 09:00`, `1 hour before the due date at 17:00`. */
export function describeReminderEntry(entry: TodoReminderEntry): string {
    if (entry.at) { return `at ${entry.at.replace('T', ' ')}`; }
    const m = DURATION.exec(entry.before ?? '');
    if (!m) { return `before the due date (${entry.before ?? '?'})`; }
    const names = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];
    const parts = names.map((name, i) => {
        const v = m[i + 1] ? parseInt(m[i + 1], 10) : 0;
        return v ? `${v} ${name}${v === 1 ? '' : 's'}` : '';
    }).filter(Boolean);
    return `${parts.join(' ') || 'at the time'} before the due date${entry.time ? ` at ${entry.time}` : ''}`;
}
