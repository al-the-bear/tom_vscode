/**
 * Parser for the "resets <time> <timezone>" clause that Anthropic
 * rate-limit / quota errors carry, e.g.
 *
 *   "You've hit your limit · resets 9:30pm (Europe/Andorra)"
 *   "You've hit your limit · resets Sunday, 11:00am (Europe/Andorra)"
 *   "You've hit your limit · resets July 20, 9:30am (Europe/Andorra)"
 *   "You've hit your limit · resets 20th, 9:30am (Europe/Andorra)"
 *
 * When a queued prompt fails with such a clause the queue must stop
 * retrying (further sends would just burn another blocked request) and
 * park the item in a `waiting` state until the reset instant. The retry
 * is armed for **5 minutes after** the parsed reset time — the caller
 * owns that buffer; this parser only resolves the reset instant itself.
 *
 * Resolution is timezone-aware: the wall-clock time is interpreted in
 * the parenthesised IANA timezone and mapped to a concrete UTC instant
 * via `Intl.DateTimeFormat` (no external date library). The *next*
 * occurrence is chosen — if the stated time has already passed today it
 * rolls forward (to tomorrow for a bare time, to next week for a
 * weekday, to next month for an ordinal day-of-month, to next year for
 * a month+day date).
 *
 * Pure and side-effect free so the whole thing is unit-testable with an
 * injected `nowMs`.
 */

export interface ResetClause {
    /** The matched "resets …" substring from the source message. */
    raw: string;
    /** IANA timezone from the parenthesised suffix, e.g. "Europe/Andorra". */
    timeZone: string;
    /** Resolved next-occurrence reset instant, UTC epoch milliseconds. */
    resetAtMs: number;
    /** Same instant as an ISO-8601 UTC string. */
    resetAtIso: string;
    /**
     * Human-friendly label rendered in the source timezone, e.g.
     * "Sun, Jul 20, 11:00 AM". Drives the "Waiting for <date/time>"
     * status shown on the queue item.
     */
    displayLabel: string;
}

const WEEKDAYS: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a reset clause out of an arbitrary error message. Returns
 * `null` when there is no `resets … (<tz>)` clause, when the timezone
 * is not a valid IANA zone, or when no clock time can be extracted
 * (a reset with no time cannot be scheduled).
 */
export function parseResetClause(message: string, nowMs: number = Date.now()): ResetClause | null {
    if (!message) { return null; }

    // Isolate the "resets <when> (<timezone>)" span. `[^()]*?` keeps the
    // "when" text greedy-minimal so the first parenthesised group is the
    // timezone even if the surrounding message has other parentheses.
    const clauseMatch = /resets\s+([^()]*?)\s*\(([^)]+)\)/i.exec(message);
    if (!clauseMatch) { return null; }

    const whenText = clauseMatch[1].trim();
    const timeZone = clauseMatch[2].trim();
    if (!isValidTimeZone(timeZone)) { return null; }

    const time = parseClockTime(whenText);
    if (!time) { return null; }

    const weekday = parseWeekday(whenText);
    const monthDay = parseMonthDay(whenText);

    const instant = resolveNextOccurrence(nowMs, timeZone, time.hour24, time.minute, weekday, monthDay);

    return {
        raw: clauseMatch[0],
        timeZone,
        resetAtMs: instant,
        resetAtIso: new Date(instant).toISOString(),
        displayLabel: formatInZone(instant, timeZone),
    };
}

interface ClockTime { hour24: number; minute: number; }

/** Extract `9:30pm` / `11am` / `9 pm` → 24-hour components. */
function parseClockTime(text: string): ClockTime | null {
    const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(text);
    if (!m) { return null; }
    const hour12 = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const isPm = m[3].toLowerCase() === 'p';
    if (hour12 < 1 || hour12 > 12 || minute > 59) { return null; }
    let hour24 = hour12 % 12;
    if (isPm) { hour24 += 12; }
    return { hour24, minute };
}

/** Extract a weekday index (0 = Sunday) or `null`. */
function parseWeekday(text: string): number | null {
    const m = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(text);
    if (!m) { return null; }
    return WEEKDAYS[m[1].toLowerCase()] ?? null;
}

interface MonthDay { month: number | null; day: number; }

/**
 * Extract a calendar day from the clause, either as `July 20`
 * (month + day) or an ordinal `20th` (day only, current month).
 * Bare integers are deliberately ignored — they are ambiguous with the
 * clock hour and Anthropic's messages always suffix a lone day-of-month.
 */
function parseMonthDay(text: string): MonthDay | null {
    const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(text);
    if (named) {
        const day = Number(named[2]);
        if (day >= 1 && day <= 31) {
            return { month: MONTHS[named[1].toLowerCase()], day };
        }
    }
    const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/i.exec(text);
    if (ordinal) {
        const day = Number(ordinal[1]);
        if (day >= 1 && day <= 31) {
            return { month: null, day };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Timezone-aware resolution (Intl-based; no external date library)
// ---------------------------------------------------------------------------

function isValidTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

interface ZonedParts {
    year: number; month: number; day: number;
    hour: number; minute: number; second: number;
    weekday: number;
}

/** Decompose a UTC instant into the wall-clock parts seen in `timeZone`. */
function getZonedParts(utcMs: number, timeZone: string): ZonedParts {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short',
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) {
        if (p.type !== 'literal') { map[p.type] = p.value; }
    }
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: map.hour === '24' ? 0 : Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
        weekday: WEEKDAYS[(map.weekday || '').slice(0, 3).toLowerCase()] ?? 0,
    };
}

/** Offset (timezone − UTC) in ms effective at the given UTC instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
    const p = getZonedParts(utcMs, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asIfUtc - utcMs;
}

/** Map a wall-clock time in `timeZone` to a concrete UTC instant. */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const offset = tzOffsetMs(guess, timeZone);
    let utc = guess - offset;
    // One refinement pass handles DST boundaries where the initial
    // guess landed in a different offset than the resolved instant.
    const refined = tzOffsetMs(utc, timeZone);
    if (refined !== offset) { utc = guess - refined; }
    return utc;
}

/**
 * Resolve the next occurrence (strictly after `nowMs`) of the given
 * wall-clock time, optionally constrained to a weekday or a calendar
 * day, all interpreted in `timeZone`.
 */
function resolveNextOccurrence(
    nowMs: number,
    timeZone: string,
    hour24: number,
    minute: number,
    weekday: number | null,
    monthDay: MonthDay | null,
): number {
    const now = getZonedParts(nowMs, timeZone);
    let y = now.year;
    let mo = now.month;
    let d = now.day;

    if (monthDay) {
        if (monthDay.month !== null) { mo = monthDay.month; }
        d = monthDay.day;
    } else if (weekday !== null) {
        const delta = (weekday - now.weekday + 7) % 7;
        ({ y, mo, d } = addDays(y, mo, d, delta));
    }

    let instant = zonedWallClockToUtc(y, mo, d, hour24, minute, timeZone);
    if (instant > nowMs) { return instant; }

    // Stated time already passed — roll to the next occurrence.
    if (monthDay && monthDay.month !== null) {
        y += 1;
    } else if (monthDay) {
        ({ y, mo, d } = addMonths(y, mo, d, 1));
    } else if (weekday !== null) {
        ({ y, mo, d } = addDays(y, mo, d, 7));
    } else {
        ({ y, mo, d } = addDays(y, mo, d, 1));
    }
    instant = zonedWallClockToUtc(y, mo, d, hour24, minute, timeZone);
    return instant;
}

interface Ymd { y: number; mo: number; d: number; }

function addDays(y: number, mo: number, d: number, days: number): Ymd {
    const carrier = new Date(Date.UTC(y, mo - 1, d));
    carrier.setUTCDate(carrier.getUTCDate() + days);
    return { y: carrier.getUTCFullYear(), mo: carrier.getUTCMonth() + 1, d: carrier.getUTCDate() };
}

function addMonths(y: number, mo: number, d: number, months: number): Ymd {
    const carrier = new Date(Date.UTC(y, mo - 1, d));
    carrier.setUTCMonth(carrier.getUTCMonth() + months);
    return { y: carrier.getUTCFullYear(), mo: carrier.getUTCMonth() + 1, d: carrier.getUTCDate() };
}

/** Friendly "Sun, Jul 20, 11:00 AM" rendering in the source timezone. */
function formatInZone(utcMs: number, timeZone: string): string {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date(utcMs));
    } catch {
        return new Date(utcMs).toISOString();
    }
}
