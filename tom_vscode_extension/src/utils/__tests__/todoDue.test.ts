/**
 * The date rules of a todo's `due` (src/utils/todoDue.ts, vscimpb152aa).
 *
 *   TDU-1 overdue: before the date no, on the date no, after it yes; completed and cancelled never; every other
 *         status (in-progress, blocked, waiting-for-repeat, group, …) yes; no or a malformed date never
 *   TDU-2 the reminder moment: the date at the configured time (default 09:00, an invalid time is the default),
 *         due from that moment on, not before; never twice (due_reminded), never for a closed todo
 *   TDU-3 the record's form (local time with offset) and the reminder's text (today / overdue)
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_DUE_REMINDER_TIME, dueReminderMoment, dueReminderText, isDueReminderDue, isTodoOverdue, localDate, localMoment, reminderTime,
} from '../todoDue';

describe('todo due dates', () => {
    test('TDU-1: overdue', () => {
        const t = (status: string, due?: string) => ({ status, due });
        assert.equal(isTodoOverdue(t('not-started', '2026-12-02'), '2026-12-01'), false, 'before the date');
        assert.equal(isTodoOverdue(t('not-started', '2026-12-01'), '2026-12-01'), false, 'on the date');
        assert.equal(isTodoOverdue(t('not-started', '2026-11-30'), '2026-12-01'), true, 'after the date');
        assert.equal(isTodoOverdue(t('completed', '2026-11-30'), '2026-12-01'), false, 'completed');
        assert.equal(isTodoOverdue(t('cancelled', '2026-11-30'), '2026-12-01'), false, 'cancelled');
        for (const status of ['in-progress', 'blocked', 'decision-needed', 'waiting-for-repeat', 'group']) {
            assert.equal(isTodoOverdue(t(status, '2026-11-30'), '2026-12-01'), true, status);
        }
        assert.equal(isTodoOverdue(t('not-started'), '2026-12-01'), false, 'no date');
        assert.equal(isTodoOverdue(t('not-started', 'soon'), '2026-12-01'), false, 'not a date');
        assert.equal(isTodoOverdue(t('not-started', '2026-11-30T23:00:00+01:00'), '2026-12-01'), true, 'a timestamp counts as its date');
    });

    test('TDU-2: the reminder moment', () => {
        assert.equal(reminderTime(undefined), DEFAULT_DUE_REMINDER_TIME);
        assert.equal(reminderTime('25:00'), '09:00');
        assert.equal(reminderTime('07:30'), '07:30');
        assert.deepEqual(dueReminderMoment('2026-12-01', '07:30'), new Date(2026, 11, 1, 7, 30));
        const todo = { status: 'not-started', due: '2026-12-01' };
        assert.equal(isDueReminderDue(todo, new Date(2026, 11, 1, 8, 59)), false, 'before 09:00');
        assert.equal(isDueReminderDue(todo, new Date(2026, 11, 1, 9, 0)), true, 'at 09:00');
        assert.equal(isDueReminderDue(todo, new Date(2026, 11, 3, 6, 0)), true, 'the first check after it');
        assert.equal(isDueReminderDue(todo, new Date(2026, 11, 1, 7, 30), '07:30'), true, 'a configured time');
        assert.equal(isDueReminderDue(todo, new Date(2026, 10, 30, 23, 0)), false, 'the day before');
        assert.equal(isDueReminderDue({ ...todo, due_reminded: '2026-12-01T09:00+01:00' }, new Date(2026, 11, 2)), false, 'sent already');
        assert.equal(isDueReminderDue({ ...todo, status: 'completed' }, new Date(2026, 11, 2)), false, 'completed');
        assert.equal(isDueReminderDue({ ...todo, status: 'cancelled' }, new Date(2026, 11, 2)), false, 'cancelled');
        assert.equal(isDueReminderDue({ status: 'not-started' }, new Date(2026, 11, 2)), false, 'no date');
    });

    test('TDU-3: the record and the text', () => {
        const now = new Date(2026, 11, 1, 9, 5);
        assert.equal(localDate(now), '2026-12-01');
        assert.match(localMoment(now), /^2026-12-01T09:05[+-]\d{2}:\d{2}$/);
        assert.equal(dueReminderText('q', { id: 'a1', title: 'Clean up', due: '2026-12-01' }, '2026-12-01'), 'Quest q: todo a1 — Clean up is due today (2026-12-01).');
        assert.equal(dueReminderText('q', { id: 'a1', due: '2026-11-28' }, '2026-12-01'), 'Quest q: todo a1 was due on 2026-11-28 (overdue).');
    });
});
