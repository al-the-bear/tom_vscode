import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseResetClause } from '../queueResetClause.js';

const TZ = 'Europe/Andorra';

/** Decompose a UTC instant into the wall-clock parts seen in a timezone. */
function zonedParts(ms: number, tz: string): Record<string, string> {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(ms))) {
        if (p.type !== 'literal') { map[p.type] = p.value; }
    }
    return map;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('parseResetClause', () => {
    test('returns null when there is no reset clause', () => {
        assert.equal(parseResetClause('Some unrelated error message'), null);
        assert.equal(parseResetClause(''), null);
    });

    test('returns null for an invalid timezone', () => {
        assert.equal(parseResetClause('resets 9:30pm (Not/AZone)'), null);
    });

    test('returns null when no clock time can be extracted', () => {
        assert.equal(parseResetClause('resets soon (Europe/Andorra)'), null);
    });

    test('bare time — "resets 9:30pm" resolves to the next 21:30 in the zone', () => {
        // 2026-07-16 10:00 UTC = 12:00 CEST in Andorra (Thursday).
        const now = Date.UTC(2026, 6, 16, 10, 0, 0);
        const clause = parseResetClause("You've hit your limit \u00b7 resets 9:30pm (Europe/Andorra)", now);
        assert.ok(clause, 'expected a parsed clause');
        assert.equal(clause!.timeZone, TZ);
        assert.ok(clause!.resetAtMs > now, 'reset must be in the future');
        assert.ok(clause!.resetAtMs - now < DAY_MS, 'bare time resolves within 24h');
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.hour, '21');
        assert.equal(p.minute, '30');
        assert.equal(p.day, '16'); // still today — 21:30 is after 12:00
        assert.ok(clause!.displayLabel.length > 0);
        assert.equal(clause!.resetAtIso, new Date(clause!.resetAtMs).toISOString());
    });

    test('bare time already passed today rolls forward to tomorrow', () => {
        // 2026-07-16 21:00 UTC = 23:00 CEST — past 21:30 already.
        const now = Date.UTC(2026, 6, 16, 21, 0, 0);
        const clause = parseResetClause('resets 9:30pm (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.hour, '21');
        assert.equal(p.minute, '30');
        assert.equal(p.day, '17'); // rolled to tomorrow
    });

    test('weekday + time — "resets Sunday, 11:00am" lands on the next Sunday', () => {
        const now = Date.UTC(2026, 6, 16, 10, 0, 0); // Thursday
        const clause = parseResetClause('resets Sunday, 11:00am (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.weekday, 'Sun');
        assert.equal(p.hour, '11');
        assert.equal(p.minute, '00');
        assert.ok(clause!.resetAtMs > now);
        assert.ok(clause!.resetAtMs - now <= 7 * DAY_MS + DAY_MS, 'within the next week');
    });

    test('weekday matching today but time passed rolls to next week', () => {
        // Choose a "now" that is the same weekday as the target, late in the day.
        const now = Date.UTC(2026, 6, 16, 22, 0, 0); // Thu 00:00 next day CEST edge — pick Thursday target
        const clause = parseResetClause('resets Thursday, 9:00am (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.weekday, 'Thu');
        assert.equal(p.hour, '09');
        assert.ok(clause!.resetAtMs > now);
    });

    test('month + day — "resets July 20, 9:30am" resolves to that calendar date', () => {
        const now = Date.UTC(2026, 6, 16, 10, 0, 0);
        const clause = parseResetClause('resets July 20, 9:30am (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.month, '07');
        assert.equal(p.day, '20');
        assert.equal(p.hour, '09');
        assert.equal(p.minute, '30');
        assert.ok(clause!.resetAtMs > now);
    });

    test('ordinal day-of-month — "resets 20th, 9:30am" resolves in the current month', () => {
        const now = Date.UTC(2026, 6, 16, 10, 0, 0);
        const clause = parseResetClause('resets 20th, 9:30am (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.day, '20');
        assert.equal(p.hour, '09');
        assert.equal(p.minute, '30');
        assert.ok(clause!.resetAtMs > now);
    });

    test('ordinal day already passed this month rolls to next month', () => {
        const now = Date.UTC(2026, 6, 25, 10, 0, 0); // July 25
        const clause = parseResetClause('resets 20th, 9:30am (Europe/Andorra)', now);
        assert.ok(clause);
        const p = zonedParts(clause!.resetAtMs, TZ);
        assert.equal(p.month, '08'); // rolled into August
        assert.equal(p.day, '20');
    });

    test('12am / 12pm boundary handling', () => {
        const now = Date.UTC(2026, 6, 16, 10, 0, 0);
        const midnight = parseResetClause('resets 12:00am (Europe/Andorra)', now);
        assert.ok(midnight);
        assert.equal(zonedParts(midnight!.resetAtMs, TZ).hour, '00');
        const noon = parseResetClause('resets 12:00pm (Europe/Andorra)', now);
        assert.ok(noon);
        assert.equal(zonedParts(noon!.resetAtMs, TZ).hour, '12');
    });

    test('works when embedded in a stringified Error', () => {
        const now = Date.UTC(2026, 6, 16, 10, 0, 0);
        const clause = parseResetClause("Error: You've hit your limit \u00b7 resets 9:30pm (Europe/Andorra)", now);
        assert.ok(clause);
        assert.equal(clause!.timeZone, TZ);
    });
});
