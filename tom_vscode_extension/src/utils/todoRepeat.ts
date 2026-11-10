/**
 * Repeated todos: the rule (`repeat:`), the next moment (`next_repeat`) and
 * the count (`repeat_count`) of the workspace todo schema, and what happens
 * when a repeated todo is done.
 *
 * Done, a repeated todo does not become `completed`: it becomes
 * `waiting-for-repeat`, with `next_repeat` the next moment its rule names —
 * a calendar rule (daily, weekly, monthly, yearly) from its schedule (the
 * moment it was last due, else the day it was created), `after` from the
 * moment it was done — and the repeated-todo controller moves it back to
 * `not-started` once that moment has come. A `manual` rule names no moment:
 * the todo waits until it is repeated by hand (the todo panel's Repeat now),
 * and a `<prefix>*` walk runs it as it runs a `not-started` one. A rule that
 * has ended (`count` repetitions done, or the next one after `until`) lets the
 * todo be completed for good.
 *
 * Times are the machine's local time; `next_repeat` is written with its
 * offset. vscode-free.
 */

export type RepeatRuleKind = 'manual' | 'after' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** A todo's `repeat:` map, as the schema has it. */
export interface TodoRepeat {
    rule: RepeatRuleKind;
    every?: number;
    unit?: 'days' | 'weeks' | 'months' | 'years';
    weekdays?: Weekday[];
    /** 1–31, or `last` (the last day of the month). */
    day?: number | 'last';
    /** 1–5, or `last`, with `weekday`. */
    nth?: number | 'last';
    weekday?: Weekday;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    working_day?: 'first' | 'last';
    month?: number;
    time?: string;
    until?: string;
    count?: number;
}

export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NEXT_REPEAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

/** Why `repeat` is not a rule the schema allows, or null. Mirrors tom_todo_model's TomTodoRepeat.check. */
export function repeatRuleError(repeat: unknown): string | null {
    if (!repeat || typeof repeat !== 'object') { return '`repeat` must be a map with a `rule`'; }
    const r = repeat as TodoRepeat & Record<string, unknown>;
    const known = new Set(['rule', 'every', 'unit', 'weekdays', 'day', 'nth', 'weekday', 'working_day', 'month', 'time', 'until', 'count']);
    for (const key of Object.keys(r)) { if (!known.has(key)) { return `unknown field \`${key}\``; } }
    if (!['manual', 'after', 'daily', 'weekly', 'monthly', 'yearly'].includes(r.rule)) { return `unknown rule \`${String(r.rule)}\` (manual, after, daily, weekly, monthly, yearly)`; }
    if (r.every !== undefined && (!Number.isInteger(r.every) || r.every < 1)) { return '`every` must be a whole number, 1 or more'; }
    if (r.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.time))) { return '`time` must be HH:MM'; }
    if (r.until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.until))) { return '`until` must be YYYY-MM-DD'; }
    if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1)) { return '`count` must be a whole number, 1 or more'; }
    for (const w of r.weekdays ?? []) { if (!WEEKDAYS.includes(w)) { return `unknown weekday \`${w}\``; } }
    if (r.weekday !== undefined && !WEEKDAYS.includes(r.weekday)) { return `unknown weekday \`${r.weekday}\``; }
    switch (r.rule) {
        case 'after':
            if (!r.unit || !['days', 'weeks', 'months', 'years'].includes(r.unit)) { return '`after` needs `unit`: days, weeks, months or years'; }
            break;
        case 'weekly':
            if (!r.weekdays || r.weekdays.length === 0) { return '`weekly` needs `weekdays`'; }
            break;
        case 'monthly':
        case 'yearly': {
            const ways = [r.day !== undefined, r.nth !== undefined, r.working_day !== undefined].filter(Boolean).length;
            if (ways !== 1) { return `\`${r.rule}\` needs exactly one of \`day\` (1-31 or last), \`nth\` with \`weekday\`, \`working_day\``; }
            if (r.day !== undefined && r.day !== 'last' && (!Number.isInteger(r.day) || r.day < 1 || r.day > 31)) { return '`day` must be 1-31 or last'; }
            if (r.nth !== undefined && r.nth !== 'last' && (!Number.isInteger(r.nth) || r.nth < 1 || r.nth > 5)) { return '`nth` must be 1-5 or last'; }
            if (r.nth !== undefined && !r.weekday) { return '`nth` needs `weekday`'; }
            if (r.working_day !== undefined && r.working_day !== 'first' && r.working_day !== 'last') { return '`working_day` must be first or last'; }
            if (r.rule === 'yearly' && (!Number.isInteger(r.month) || (r.month as number) < 1 || (r.month as number) > 12)) { return '`yearly` needs `month` 1-12'; }
            break;
        }
        default:
            break;
    }
    return null;
}

/** A moment as `next_repeat` writes it: local time with its offset, minutes. */
export function formatRepeatMoment(date: Date): string {
    const p = (n: number): string => String(Math.abs(n)).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`
        + `${sign}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`;
}

/** A `next_repeat` moment as a Date; null when it does not read. */
export function parseRepeatMoment(text: string | undefined): Date | null {
    if (!text) { return null; }
    if (!NEXT_REPEAT.test(text)) { return null; }
    const date = new Date(text);
    return isNaN(date.getTime()) ? null : date;
}

function atTime(day: Date, time: string | undefined): Date {
    const [h, min] = (time ?? '00:00').split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min, 0, 0);
}
const daysInMonth = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();
const weekdayIndex = (w: Weekday): number => (WEEKDAYS.indexOf(w) + 1) % 7; // JS: Sunday 0
const isWorkingDay = (d: Date): boolean => d.getDay() >= 1 && d.getDay() <= 5;

/** The day of month `m` (0-based) of year `y` the monthly / yearly part of `r` names; null when the month has none (a 5th weekday). */
function dayInMonth(r: TodoRepeat, y: number, m: number): Date | null {
    const last = daysInMonth(y, m);
    if (r.day === 'last') { return new Date(y, m, last); }
    if (typeof r.day === 'number') { return new Date(y, m, Math.min(r.day, last)); }
    if (r.working_day) {
        if (r.working_day === 'first') {
            for (let d = 1; d <= last; d++) { const x = new Date(y, m, d); if (isWorkingDay(x)) { return x; } }
        } else {
            for (let d = last; d >= 1; d--) { const x = new Date(y, m, d); if (isWorkingDay(x)) { return x; } }
        }
        return null;
    }
    if (r.nth !== undefined && r.weekday) {
        const target = weekdayIndex(r.weekday);
        if (r.nth === 'last') {
            for (let d = last; d >= 1; d--) { const x = new Date(y, m, d); if (x.getDay() === target) { return x; } }
            return null;
        }
        let seen = 0;
        for (let d = 1; d <= last; d++) {
            const x = new Date(y, m, d);
            if (x.getDay() === target && ++seen === r.nth) { return x; }
        }
        return null;
    }
    return null;
}

/** The Monday of `day`'s week. */
function weekStart(day: Date): Date {
    const back = (day.getDay() + 6) % 7;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back);
}

/**
 * The first moment the rule names after `doneAt`. `anchor` is the schedule
 * a calendar rule counts its intervals from (the moment the todo was last
 * due, else the day it was created); `after` counts from `doneAt`. Null for a
 * manual rule.
 */
export function nextRepeatAfter(repeat: TodoRepeat, doneAt: Date, anchor: Date = doneAt): Date | null {
    const every = repeat.every ?? 1;
    const later = (d: Date | null): d is Date => d !== null && d.getTime() > doneAt.getTime();
    switch (repeat.rule) {
        case 'manual':
            return null;
        case 'after': {
            const d = new Date(doneAt.getFullYear(), doneAt.getMonth(), doneAt.getDate());
            if (repeat.unit === 'days') { d.setDate(d.getDate() + every); }
            if (repeat.unit === 'weeks') { d.setDate(d.getDate() + 7 * every); }
            if (repeat.unit === 'months' || repeat.unit === 'years') {
                const months = repeat.unit === 'months' ? every : 12 * every;
                const y = d.getFullYear() + Math.floor((d.getMonth() + months) / 12);
                const m = (d.getMonth() + months) % 12;
                return atTime(new Date(y, m, Math.min(doneAt.getDate(), daysInMonth(y, m))), repeat.time);
            }
            return atTime(d, repeat.time);
        }
        case 'daily': {
            const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
            for (let k = 0; k < 100000; k++) {
                const c = atTime(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * every), repeat.time);
                if (later(c)) { return c; }
            }
            return null;
        }
        case 'weekly': {
            const days = (repeat.weekdays ?? []).map(weekdayIndex).map((i) => (i + 6) % 7).sort((a, b) => a - b);
            const first = weekStart(anchor);
            for (let k = 0; k < 20000; k++) {
                for (const offset of days) {
                    const c = atTime(new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7 * k * every + offset), repeat.time);
                    if (later(c)) { return c; }
                }
            }
            return null;
        }
        case 'monthly':
        case 'yearly': {
            const step = repeat.rule === 'monthly' ? every : 12 * every;
            const startMonth = repeat.rule === 'monthly' ? anchor.getMonth() : (repeat.month as number) - 1;
            const startYear = anchor.getFullYear();
            for (let k = 0; k < 5000; k++) {
                const total = startYear * 12 + startMonth + k * step;
                const day = dayInMonth(repeat, Math.floor(total / 12), total % 12);
                const c = day ? atTime(day, repeat.time) : null;
                if (later(c)) { return c; }
            }
            return null;
        }
        default:
            return null;
    }
}

/** The repeat fields of a todo as the todo files carry them. */
export interface RepeatedTodo {
    status?: string;
    repeat?: TodoRepeat;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    next_repeat?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    repeat_count?: number;
    created?: string;
    notes?: string;
}

/** What doing a repeated todo writes instead of `completed`. */
export interface RepeatOnDone {
    status: 'waiting-for-repeat';
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    next_repeat?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    repeat_count: number;
    /** The line appended to the notes: when it was done, the how-many-th time, when it comes back. */
    note: string;
}

/**
 * What doing `todo` at `now` writes: `waiting-for-repeat` with the next
 * moment and the count, or null when the todo is not repeated or its rule
 * has ended (it is completed for good then).
 */
export function repeatOnDone(todo: RepeatedTodo, now: Date): RepeatOnDone | null {
    const repeat = todo.repeat;
    if (!repeat || repeatRuleError(repeat)) { return null; }
    const done = (todo.repeat_count ?? 0) + 1;
    if (repeat.count !== undefined && done >= repeat.count) { return null; }
    const lastDue = parseRepeatMoment(todo.next_repeat);
    const created = todo.created && /^\d{4}-\d{2}-\d{2}$/.test(todo.created) ? new Date(`${todo.created}T00:00:00`) : null;
    const next = nextRepeatAfter(repeat, now, lastDue ?? created ?? now);
    if (next && repeat.until && formatRepeatMoment(next).slice(0, 10) > repeat.until) { return null; }
    const when = formatRepeatMoment(now);
    return {
        status: 'waiting-for-repeat',
        ...(next ? { next_repeat: formatRepeatMoment(next) } : {}),
        repeat_count: done,
        note: `${when.slice(0, 10)} ${when.slice(11, 16)}: done (${done}), ${next ? `next ${formatRepeatMoment(next).replace('T', ' ')}` : 'waiting to be repeated by hand'}.`,
    };
}

/** Whether a `waiting-for-repeat` todo is due at `now`: its `next_repeat` has come. A manual one never is. */
export function isRepeatDue(todo: RepeatedTodo, now: Date): boolean {
    if (todo.status !== 'waiting-for-repeat') { return false; }
    const next = parseRepeatMoment(todo.next_repeat);
    return next !== null && next.getTime() <= now.getTime();
}

/** The rule in words, for the todo panel: `every 2 weeks on Monday and Thursday at 09:00`. */
export function describeRepeat(repeat: TodoRepeat): string {
    const every = repeat.every ?? 1;
    const at = repeat.time ? ` at ${repeat.time}` : '';
    const n = (k: number, one: string, many: string): string => (k === 1 ? one : `${k} ${many}`);
    const ordinal = (k: number | 'last'): string => (k === 'last' ? 'last' : ['first', 'second', 'third', 'fourth', 'fifth'][k - 1] ?? `${k}th`);
    const dayPart = (): string => {
        if (repeat.day === 'last') { return 'the last day'; }
        if (typeof repeat.day === 'number') { return `day ${repeat.day}`; }
        if (repeat.working_day) { return `the ${repeat.working_day} working day`; }
        if (repeat.nth !== undefined && repeat.weekday) { return `the ${ordinal(repeat.nth)} ${WEEKDAY_NAMES[repeat.weekday]}`; }
        return '?';
    };
    let text: string;
    switch (repeat.rule) {
        case 'manual': text = 'repeated by hand'; break;
        case 'after': text = `${every} ${repeat.unit === undefined ? '' : every === 1 ? repeat.unit.replace(/s$/, '') : repeat.unit} after it is done`; break;
        case 'daily': text = `every ${n(every, 'day', 'days')}`; break;
        case 'weekly': text = `every ${n(every, 'week', 'weeks')} on ${(repeat.weekdays ?? []).map((w) => WEEKDAY_NAMES[w]).join(', ')}`; break;
        case 'monthly': text = `every ${n(every, 'month', 'months')} on ${dayPart()}`; break;
        case 'yearly': text = `every ${n(every, 'year', 'years')} on ${dayPart()} of ${MONTH_NAMES[(repeat.month ?? 1) - 1]}`; break;
        default: text = String(repeat.rule);
    }
    const end = repeat.count ? `, ${repeat.count} times` : repeat.until ? `, until ${repeat.until}` : '';
    return text + (repeat.rule === 'manual' ? '' : at) + end;
}
