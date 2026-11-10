/**
 * Repeated todos (src/utils/todoRepeat.ts): the rules, the next moment, what doing one writes.
 * Dates are local (as the extension computes them).
 *
 *   TRP-1 the rule check: what the schema allows and refuses
 *   TRP-2 after N days / weeks / months (a shorter month takes its last day), at a time
 *   TRP-3 daily every N days from the schedule
 *   TRP-4 weekly on several weekdays, every 2 weeks from the schedule's week
 *   TRP-5 monthly: day 15, day 31 in a short month, the last day, the 2nd Tuesday, the last Friday,
 *         the first and last working day, every 3 months
 *   TRP-6 yearly on a date, on the Nth weekday of a month, the last day of February in a leap year
 *   TRP-7 doing it: waiting-for-repeat with next_repeat, the count and a note; manual waits by hand;
 *         `count` and `until` end it (null: completed for good); not repeated: null
 *   TRP-8 due: only a waiting todo whose moment has come; the moment's text round-trips
 *   TRP-9 the rule in words
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    describeRepeat, formatRepeatMoment, isRepeatDue, nextRepeatAfter, parseRepeatMoment, repeatOnDone, repeatRuleError,
    type TodoRepeat,
} from '../todoRepeat';

const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min);
const day = (date: Date | null): string => (date ? formatRepeatMoment(date).slice(0, 16) : 'none');
const next = (r: TodoRepeat, done: Date, anchor?: Date): string => day(nextRepeatAfter(r, done, anchor));

describe('repeated todos', () => {
    test('TRP-1: the rule check', () => {
        for (const ok of [
            { rule: 'manual' }, { rule: 'after', every: 10, unit: 'days' }, { rule: 'daily', every: 2 },
            { rule: 'weekly', weekdays: ['mon', 'thu'] }, { rule: 'monthly', day: 'last' }, { rule: 'monthly', nth: 'last', weekday: 'fri' },
            { rule: 'monthly', working_day: 'first' }, { rule: 'yearly', month: 2, day: 29, time: '08:30', until: '2030-01-01', count: 5 },
        ]) { assert.equal(repeatRuleError(ok), null, JSON.stringify(ok)); }
        for (const bad of [
            null, { rule: 'hourly' }, { rule: 'after', every: 2 }, { rule: 'weekly' }, { rule: 'monthly' },
            { rule: 'monthly', day: 1, working_day: 'last' }, { rule: 'monthly', nth: 2 }, { rule: 'yearly', day: 1 },
            { rule: 'daily', every: 0 }, { rule: 'daily', time: '25:00' }, { rule: 'daily', colour: 'red' },
        ]) { assert.notEqual(repeatRuleError(bad), null, JSON.stringify(bad)); }
    });

    test('TRP-2: after N days, weeks, months', () => {
        assert.equal(next({ rule: 'after', every: 10, unit: 'days' }, at(2026, 11, 10, 15, 30)), '2026-11-20T00:00');
        assert.equal(next({ rule: 'after', every: 2, unit: 'weeks', time: '09:00' }, at(2026, 11, 10, 15)), '2026-11-24T09:00');
        assert.equal(next({ rule: 'after', every: 1, unit: 'months' }, at(2026, 1, 31)), '2026-02-28T00:00', 'February has no 31st');
        assert.equal(next({ rule: 'after', every: 1, unit: 'years' }, at(2026, 3, 1)), '2027-03-01T00:00');
    });

    test('TRP-3: daily every N days from the schedule', () => {
        assert.equal(next({ rule: 'daily' }, at(2026, 11, 10, 15)), '2026-11-11T00:00');
        assert.equal(next({ rule: 'daily', time: '18:00' }, at(2026, 11, 10, 15)), '2026-11-10T18:00', 'later the same day');
        assert.equal(next({ rule: 'daily', every: 3 }, at(2026, 11, 10, 15), at(2026, 11, 1)), '2026-11-13T00:00', '1, 4, 7, 10, 13');
    });

    test('TRP-4: weekly', () => {
        // 2026-11-10 is a Tuesday.
        assert.equal(next({ rule: 'weekly', weekdays: ['mon', 'thu'] }, at(2026, 11, 10, 12)), '2026-11-12T00:00');
        assert.equal(next({ rule: 'weekly', weekdays: ['mon'] }, at(2026, 11, 10, 12)), '2026-11-16T00:00');
        assert.equal(next({ rule: 'weekly', every: 2, weekdays: ['mon'], time: '09:00' }, at(2026, 11, 10, 12), at(2026, 11, 2)), '2026-11-16T09:00', 'the week of the 2nd, then every second week');
        assert.equal(next({ rule: 'weekly', every: 2, weekdays: ['mon'] }, at(2026, 11, 10, 12), at(2026, 11, 9)), '2026-11-23T00:00');
    });

    test('TRP-5: monthly', () => {
        const done = at(2026, 11, 10, 12);
        assert.equal(next({ rule: 'monthly', day: 15 }, done), '2026-11-15T00:00');
        assert.equal(next({ rule: 'monthly', day: 5 }, done), '2026-12-05T00:00');
        assert.equal(next({ rule: 'monthly', day: 31 }, at(2026, 2, 1)), '2026-02-28T00:00', 'a short month takes its last day');
        assert.equal(next({ rule: 'monthly', day: 'last' }, done), '2026-11-30T00:00');
        assert.equal(next({ rule: 'monthly', nth: 2, weekday: 'tue' }, done), '2026-12-08T00:00', 'the 10th was the 2nd Tuesday');
        assert.equal(next({ rule: 'monthly', nth: 'last', weekday: 'fri' }, done), '2026-11-27T00:00');
        assert.equal(next({ rule: 'monthly', nth: 1, weekday: 'mon' }, done), '2026-12-07T00:00');
        assert.equal(next({ rule: 'monthly', working_day: 'first' }, done), '2026-12-01T00:00');
        assert.equal(next({ rule: 'monthly', working_day: 'last' }, done), '2026-11-30T00:00', 'a Monday');
        assert.equal(next({ rule: 'monthly', working_day: 'last' }, at(2026, 1, 30, 12)), '2026-02-27T00:00', 'January 31st 2026 is a Saturday, so the 30th; then February 27th (a Friday)');
        assert.equal(next({ rule: 'monthly', every: 3, day: 1 }, done, at(2026, 1, 1)), '2027-01-01T00:00', 'January, April, July, October, January');
    });

    test('TRP-6: yearly', () => {
        const done = at(2026, 11, 10, 12);
        assert.equal(next({ rule: 'yearly', month: 3, day: 1 }, done), '2027-03-01T00:00');
        assert.equal(next({ rule: 'yearly', month: 11, day: 20 }, done), '2026-11-20T00:00');
        assert.equal(next({ rule: 'yearly', month: 11, nth: 4, weekday: 'thu' }, done), '2026-11-26T00:00', 'Thanksgiving');
        assert.equal(next({ rule: 'yearly', month: 2, day: 'last' }, at(2027, 3, 1)), '2028-02-29T00:00');
    });

    test('TRP-7: doing a repeated todo', () => {
        const now = at(2026, 11, 10, 12);
        const weekly = repeatOnDone({ status: 'in-progress', repeat: { rule: 'weekly', weekdays: ['mon'], time: '09:00' }, created: '2026-11-02' }, now);
        assert.ok(weekly);
        assert.equal(weekly.status, 'waiting-for-repeat');
        assert.equal(weekly.next_repeat?.slice(0, 16), '2026-11-16T09:00');
        assert.equal(weekly.repeat_count, 1);
        assert.match(weekly.note, /^2026-11-10 12:00: done \(1\), next 2026-11-16 09:00/);
        const manual = repeatOnDone({ repeat: { rule: 'manual' }, repeat_count: 4 }, now);
        assert.equal(manual?.next_repeat, undefined);
        assert.equal(manual?.repeat_count, 5);
        assert.match(manual!.note, /waiting to be repeated by hand/);
        assert.equal(repeatOnDone({ repeat: { rule: 'daily', count: 3 }, repeat_count: 2 }, now), null, 'the third time ends it');
        assert.equal(repeatOnDone({ repeat: { rule: 'monthly', day: 1, until: '2026-11-30' } }, now), null, 'December 1st is after until');
        assert.equal(repeatOnDone({ status: 'in-progress' }, now), null);
        // The schedule goes on from the moment it was last due, not from when it was done.
        const late = repeatOnDone({ repeat: { rule: 'daily', every: 7 }, next_repeat: formatRepeatMoment(at(2026, 11, 2)) }, at(2026, 11, 10, 12));
        assert.equal(late?.next_repeat?.slice(0, 10), '2026-11-16');
    });

    test('TRP-8: due', () => {
        const now = at(2026, 11, 10, 12);
        assert.equal(isRepeatDue({ status: 'waiting-for-repeat', next_repeat: formatRepeatMoment(at(2026, 11, 10, 11)) }, now), true);
        assert.equal(isRepeatDue({ status: 'waiting-for-repeat', next_repeat: formatRepeatMoment(at(2026, 11, 10, 13)) }, now), false);
        assert.equal(isRepeatDue({ status: 'waiting-for-repeat' }, now), false, 'manual');
        assert.equal(isRepeatDue({ status: 'not-started', next_repeat: formatRepeatMoment(at(2026, 1, 1)) }, now), false);
        const text = formatRepeatMoment(at(2026, 11, 16, 9));
        assert.match(text, /^2026-11-16T09:00(Z|[+-]\d{2}:\d{2})$/);
        assert.equal(parseRepeatMoment(text)?.getTime(), at(2026, 11, 16, 9).getTime());
        assert.equal(parseRepeatMoment('2026-11-16'), null);
    });

    test('TRP-9: the rule in words', () => {
        assert.equal(describeRepeat({ rule: 'weekly', every: 2, weekdays: ['mon', 'thu'], time: '09:00' }), 'every 2 weeks on Monday, Thursday at 09:00');
        assert.equal(describeRepeat({ rule: 'monthly', nth: 'last', weekday: 'fri' }), 'every month on the last Friday');
        assert.equal(describeRepeat({ rule: 'monthly', working_day: 'last', count: 6 }), 'every month on the last working day, 6 times');
        assert.equal(describeRepeat({ rule: 'yearly', month: 3, day: 1 }), 'every year on day 1 of March');
        assert.equal(describeRepeat({ rule: 'after', every: 10, unit: 'days' }), '10 days after it is done');
        assert.equal(describeRepeat({ rule: 'manual' }), 'repeated by hand');
    });
});
