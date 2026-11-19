/**
 * Todo reminders, the rules (utils/todoRemind.ts, vscimpb152ab).
 *
 *   RM-1 the first moment of each rule form, counted from when the rule is set
 *   RM-2 the next moment after a reminder: a calendar rule keeps its schedule, `after` counts from the reminder,
 *        missed moments ring once
 *   RM-3 `count` and `until` end the schedule
 *   RM-4 only open todos ring (not completed, cancelled, waiting-for-repeat)
 *   RM-5 the rule check: `manual` is refused, a repeat rule error is passed on
 *   RM-6 one-shot reminders: their moment (`at`, `before` the due date at `time`), snooze, acknowledged, the checks
 *   RM-7 the rule and the entries in words
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    acknowledgedStamp, advanceRemind, describeRemind, describeReminderEntry, firstRemind, isRemindDue, isReminderEntryDue,
    reminderEntryError, reminderEntryMoment, remindersError, remindRuleError, ringsAtAll, sameReminderEntry,
} from '../todoRemind.js';
import { formatRepeatMoment, type TodoRepeat } from '../todoRepeat.js';

/** A local moment as the todo files write it. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): string => formatRepeatMoment(new Date(y, mo - 1, d, h, mi));
const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi);

describe('todo reminders: the remind schedule', () => {
    test('RM-1: the first moment of each rule form', () => {
        const now = local(2026, 11, 19, 10, 30); // a Thursday
        const cases: Array<[TodoRepeat, string]> = [
            [{ rule: 'daily', time: '09:00' }, at(2026, 11, 20, 9)],
            [{ rule: 'daily', time: '11:00' }, at(2026, 11, 19, 11)],
            [{ rule: 'daily', every: 3, time: '09:00' }, at(2026, 11, 22, 9)],
            [{ rule: 'weekly', weekdays: ['mon', 'thu'], time: '09:00' }, at(2026, 11, 23, 9)],
            [{ rule: 'weekly', weekdays: ['fri'] }, at(2026, 11, 20)],
            [{ rule: 'monthly', day: 1, time: '08:00' }, at(2026, 12, 1, 8)],
            [{ rule: 'monthly', day: 'last' }, at(2026, 11, 30)],
            [{ rule: 'monthly', nth: 2, weekday: 'tue' }, at(2026, 12, 8)],
            [{ rule: 'monthly', working_day: 'first', time: '09:00' }, at(2026, 12, 1, 9)],
            [{ rule: 'yearly', month: 3, day: 1 }, at(2027, 3, 1)],
            [{ rule: 'after', every: 2, unit: 'days', time: '09:00' }, at(2026, 11, 21, 9)],
            [{ rule: 'after', unit: 'weeks' }, at(2026, 11, 26)],
        ];
        for (const [rule, expected] of cases) { assert.equal(firstRemind(rule, now), expected, JSON.stringify(rule)); }
    });

    test('RM-2: the next moment after a reminder', () => {
        // A calendar rule keeps its schedule: every 2 days from Nov 20, rung (late) on Nov 21 → Nov 22.
        const daily2 = { status: 'not-started', remind: { rule: 'daily', every: 2, time: '09:00' } as TodoRepeat, next_remind: at(2026, 11, 20, 9) };
        assert.deepEqual(advanceRemind(daily2, local(2026, 11, 21, 15)), { next_remind: at(2026, 11, 22, 9), remind_count: 1 });
        // Missed moments ring once: the machine was off for a week; the next one is the next to come.
        const weekly = { status: 'in-progress', remind: { rule: 'weekly', weekdays: ['mon'], time: '09:00' } as TodoRepeat, next_remind: at(2026, 11, 2, 9), remind_count: 4 };
        assert.ok(isRemindDue(weekly, local(2026, 11, 19, 10)));
        assert.deepEqual(advanceRemind(weekly, local(2026, 11, 19, 10)), { next_remind: at(2026, 11, 23, 9), remind_count: 5 });
        // `after` counts from the reminder.
        const after = { status: 'not-started', remind: { rule: 'after', every: 3, unit: 'days', time: '09:00' } as TodoRepeat, next_remind: at(2026, 11, 10, 9) };
        assert.deepEqual(advanceRemind(after, local(2026, 11, 12, 18)), { next_remind: at(2026, 11, 15, 9), remind_count: 1 });
        // A monthly rule on the 31st takes a shorter month's last day.
        const monthly = { status: 'not-started', remind: { rule: 'monthly', day: 31 } as TodoRepeat, next_remind: at(2027, 1, 31) };
        assert.equal(advanceRemind(monthly, local(2027, 1, 31, 0, 5)).next_remind, at(2027, 2, 28));
        // Not yet due: nothing rings.
        assert.equal(isRemindDue({ ...daily2, next_remind: at(2026, 11, 20, 9) }, local(2026, 11, 20, 8, 59)), false);
        assert.equal(isRemindDue({ ...daily2, next_remind: at(2026, 11, 20, 9) }, local(2026, 11, 20, 9)), true);
    });

    test('RM-3: count and until end the schedule', () => {
        const counted = { status: 'not-started', remind: { rule: 'daily', count: 3 } as TodoRepeat, next_remind: at(2026, 11, 20), remind_count: 2 };
        assert.deepEqual(advanceRemind(counted, local(2026, 11, 20, 1)), { remind_count: 3 }, 'the third was the last');
        assert.equal(firstRemind({ rule: 'daily', count: 3 }, local(2026, 11, 20), 3), undefined, 'count already reached');
        const until = { status: 'not-started', remind: { rule: 'weekly', weekdays: ['mon'], until: '2026-11-30' } as TodoRepeat, next_remind: at(2026, 11, 30) };
        assert.deepEqual(advanceRemind(until, local(2026, 11, 30, 1)), { remind_count: 1 }, 'the next Monday is after until');
        assert.equal(firstRemind({ rule: 'weekly', weekdays: ['mon'], until: '2026-11-22' }, local(2026, 11, 19)), undefined);
        // An ended schedule (no next_remind) never rings.
        assert.equal(isRemindDue({ status: 'not-started', remind: { rule: 'daily' } }, local(2030, 1, 1)), false);
    });

    test('RM-4: only open todos ring', () => {
        const base = { remind: { rule: 'daily' } as TodoRepeat, next_remind: at(2026, 11, 19) };
        const now = local(2026, 11, 20);
        for (const status of ['not-started', 'in-progress', 'blocked', 'decision-needed', 'group']) { assert.ok(isRemindDue({ ...base, status }, now), status); }
        for (const status of ['completed', 'cancelled', 'waiting-for-repeat']) { assert.equal(isRemindDue({ ...base, status }, now), false, status); }
        assert.ok(ringsAtAll(undefined), 'no status reads as not-started');
    });

    test('RM-5: the rule check', () => {
        assert.match(remindRuleError({ rule: 'manual' }) ?? '', /cannot be `manual`/);
        assert.match(remindRuleError({ rule: 'weekly' }) ?? '', /weekdays/);
        assert.match(remindRuleError({ rule: 'hourly' }) ?? '', /unknown rule/);
        assert.equal(remindRuleError({ rule: 'daily', time: '09:00' }), null);
        assert.equal(isRemindDue({ status: 'not-started', remind: { rule: 'manual' }, next_remind: at(2026, 1, 1) }, local(2026, 11, 20)), false);
    });
});

describe('todo reminders: one-shot reminders', () => {
    test('RM-6: the moment, snooze, acknowledged and the checks', () => {
        const due = '2026-11-25';
        assert.equal(reminderEntryMoment({ at: '2026-11-20T09:00+01:00' }, undefined)?.toISOString(), '2026-11-20T08:00:00.000Z');
        assert.equal(reminderEntryMoment({ before: 'PT1H', time: '17:00' }, due)?.getTime(), local(2026, 11, 25, 16).getTime());
        assert.equal(reminderEntryMoment({ before: 'P1D' }, due)?.getTime(), local(2026, 11, 24).getTime());
        assert.equal(reminderEntryMoment({ before: 'P1W' }, due)?.getTime(), local(2026, 11, 18).getTime());
        assert.equal(reminderEntryMoment({ before: 'P1M' }, due)?.getTime(), local(2026, 10, 25).getTime());
        assert.equal(reminderEntryMoment({ before: 'PT30M' }, undefined), null, 'before without a due date names no moment');

        const entry = { before: 'PT1H', time: '17:00' };
        assert.equal(isReminderEntryDue(entry, 'not-started', due, local(2026, 11, 25, 15, 59)), false);
        assert.ok(isReminderEntryDue(entry, 'not-started', due, local(2026, 11, 25, 16)));
        assert.equal(isReminderEntryDue({ ...entry, acknowledged: '2026-11-25T15:00:00Z' }, 'not-started', due, local(2026, 11, 26)), false, 'rang already');
        const snoozed = { ...entry, snoozed_until: formatRepeatMoment(local(2026, 11, 25, 18)) };
        assert.equal(isReminderEntryDue(snoozed, 'not-started', due, local(2026, 11, 25, 17)), false, 'snoozed');
        assert.ok(isReminderEntryDue(snoozed, 'not-started', due, local(2026, 11, 25, 18)), 'snooze over');
        for (const status of ['completed', 'cancelled', 'waiting-for-repeat']) {
            assert.equal(isReminderEntryDue(entry, status, due, local(2026, 12, 1)), false, status);
        }

        assert.equal(reminderEntryError({ at: '2026-11-20T09:00+01:00' }), null);
        assert.equal(reminderEntryError({ before: 'P1DT2H', time: '08:30', acknowledged: '2026-11-20T08:00:00Z' }), null);
        assert.match(reminderEntryError({}) ?? '', /exactly one/);
        assert.match(reminderEntryError({ at: '2026-11-20T09:00+01:00', before: 'PT1H' }) ?? '', /exactly one/);
        assert.match(reminderEntryError({ at: '2026-11-20' }) ?? '', /offset/);
        assert.match(reminderEntryError({ before: '1 hour' }) ?? '', /duration/);
        assert.match(reminderEntryError({ at: '2026-11-20T09:00Z', time: '09:00' }) ?? '', /goes with `before`/);
        assert.match(reminderEntryError({ before: 'PT1H', colour: 'red' }) ?? '', /unknown reminder field/);
        assert.match(remindersError([{ at: '2026-11-20T09:00Z' }, { before: 'x' }]) ?? '', /^reminders\[1\]/);
        assert.match(remindersError('PT1H') ?? '', /must be a list/);

        assert.ok(sameReminderEntry({ before: 'PT1H', time: '17:00', acknowledged: 'x' }, { before: 'PT1H', time: '17:00' }));
        assert.equal(sameReminderEntry({ before: 'PT1H' }, { before: 'PT2H' }), false);
        assert.equal(acknowledgedStamp(new Date('2026-11-20T08:00:12.345Z')), '2026-11-20T08:00:12Z');
    });

    test('RM-7: in words', () => {
        assert.equal(describeRemind({ rule: 'weekly', weekdays: ['mon'], time: '09:00' }), 'every week on Monday at 09:00');
        assert.equal(describeRemind({ rule: 'after', every: 3, unit: 'days', count: 4 }), 'every 3 days after the reminder before, 4 times');
        assert.equal(describeRemind({ rule: 'after', unit: 'weeks', time: '08:00' }), 'every week after the reminder before at 08:00');
        assert.equal(describeReminderEntry({ at: '2026-11-20T09:00+01:00' }), 'at 2026-11-20 09:00+01:00');
        assert.equal(describeReminderEntry({ before: 'P1DT2H', time: '17:00' }), '1 day 2 hours before the due date at 17:00');
    });
});
