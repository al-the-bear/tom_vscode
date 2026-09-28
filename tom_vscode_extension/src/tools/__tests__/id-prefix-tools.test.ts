/**
 * Tests for the pure date→id-prefix encoder in `tools/id-prefix-tools.ts`.
 *
 * The encoder produces the 4-letter, letters-only date code used to make
 * hand-authored ids (todos, quests, issues) collision-free across sessions
 * and machines while staying deterministic: two calls in the same clock hour
 * MUST return the same code, which is what lets a re-run reproduce an id.
 *
 * Positional contract (each position is independent):
 *   1. year   a=2026, b=2027, … z=2051
 *   2. month  a=January … l=December
 *   3. day    a=1 … z=26, ä=27, ñ=28, ö=29, ß=30, ü=31
 *   4. hour   a=0 … x=23 (24h clock)
 *
 * Dates are built with the local-time `Date` constructor because the encoder
 * reads local calendar fields — a developer generating an id at 14:00 local
 * expects the 14:00 letter regardless of UTC offset.
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/id-prefix-tools.test.js
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    GENERATE_ID_PREFIX_TOOL,
    ID_PREFIX_FIRST_YEAR,
    ID_PREFIX_LAST_YEAR,
    buildIdPrefix,
    describeIdPrefixParts,
    generateIdPrefixImpl,
} from '../id-prefix-tools.js';
// Neither of these imports pulls in `vscode`, so the encoder tests stay free of
// the extension-host stub.
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { categorizeTools } from '../../utils/toolCategories.js';

// ---------------------------------------------------------------------------
// Position 1 — year
// ---------------------------------------------------------------------------

describe('buildIdPrefix — year letter', () => {
    test('the base year 2026 encodes as "a"', () => {
        assert.equal(buildIdPrefix(new Date(2026, 0, 1, 0))[0], 'a');
    });

    test('each following year advances one letter', () => {
        assert.equal(buildIdPrefix(new Date(2027, 0, 1, 0))[0], 'b');
        assert.equal(buildIdPrefix(new Date(2028, 0, 1, 0))[0], 'c');
        assert.equal(buildIdPrefix(new Date(2035, 0, 1, 0))[0], 'j');
    });

    test('the last representable year 2051 encodes as "z"', () => {
        assert.equal(ID_PREFIX_LAST_YEAR, 2051);
        assert.equal(buildIdPrefix(new Date(2051, 0, 1, 0))[0], 'z');
    });

    test('years outside the a–z window are rejected rather than silently wrapped', () => {
        assert.equal(ID_PREFIX_FIRST_YEAR, 2026);
        assert.throws(() => buildIdPrefix(new Date(2025, 0, 1, 0)), /2025/);
        assert.throws(() => buildIdPrefix(new Date(2052, 0, 1, 0)), /2052/);
    });
});

// ---------------------------------------------------------------------------
// Position 2 — month
// ---------------------------------------------------------------------------

describe('buildIdPrefix — month letter', () => {
    test('January is "a" and December is "l"', () => {
        assert.equal(buildIdPrefix(new Date(2026, 0, 1, 0))[1], 'a');
        assert.equal(buildIdPrefix(new Date(2026, 11, 1, 0))[1], 'l');
    });

    test('every month maps to its ordinal letter', () => {
        const expected = 'abcdefghijkl';
        for (let month = 0; month < 12; month++) {
            assert.equal(
                buildIdPrefix(new Date(2026, month, 1, 0))[1],
                expected[month],
                `month index ${month}`,
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Position 3 — day of month (the interesting one: 27–31 use non-ASCII letters)
// ---------------------------------------------------------------------------

describe('buildIdPrefix — day letter', () => {
    test('days 1–26 map onto a–z', () => {
        const expected = 'abcdefghijklmnopqrstuvwxyz';
        for (let day = 1; day <= 26; day++) {
            assert.equal(
                buildIdPrefix(new Date(2026, 0, day, 0))[2],
                expected[day - 1],
                `day ${day}`,
            );
        }
    });

    test('days 27–31 use the extended letters ä ñ ö ß ü', () => {
        // January has 31 days, so all five extended cases are reachable.
        assert.equal(buildIdPrefix(new Date(2026, 0, 27, 0))[2], 'ä');
        assert.equal(buildIdPrefix(new Date(2026, 0, 28, 0))[2], 'ñ');
        assert.equal(buildIdPrefix(new Date(2026, 0, 29, 0))[2], 'ö');
        assert.equal(buildIdPrefix(new Date(2026, 0, 30, 0))[2], 'ß');
        assert.equal(buildIdPrefix(new Date(2026, 0, 31, 0))[2], 'ü');
    });

    test('each extended letter is a single UTF-16 unit so the code stays 4 chars', () => {
        assert.equal(buildIdPrefix(new Date(2026, 0, 30, 0)).length, 4);
    });
});

// ---------------------------------------------------------------------------
// Position 4 — hour
// ---------------------------------------------------------------------------

describe('buildIdPrefix — hour letter', () => {
    test('midnight is "a" and 23:00 is "x"', () => {
        assert.equal(buildIdPrefix(new Date(2026, 0, 1, 0))[3], 'a');
        assert.equal(buildIdPrefix(new Date(2026, 0, 1, 23))[3], 'x');
    });

    test('every hour of the 24h clock maps to its ordinal letter', () => {
        const expected = 'abcdefghijklmnopqrstuvwx';
        for (let hour = 0; hour < 24; hour++) {
            assert.equal(
                buildIdPrefix(new Date(2026, 0, 1, hour))[3],
                expected[hour],
                `hour ${hour}`,
            );
        }
    });

    test('minutes and seconds do not affect the code', () => {
        const onTheHour = buildIdPrefix(new Date(2026, 6, 27, 14, 0, 0));
        const lateInHour = buildIdPrefix(new Date(2026, 6, 27, 14, 59, 59));
        assert.equal(onTheHour, lateInHour);
    });
});

// ---------------------------------------------------------------------------
// Whole-code behaviour
// ---------------------------------------------------------------------------

describe('buildIdPrefix — whole code', () => {
    test('the first representable instant encodes as "aaaa"', () => {
        assert.equal(buildIdPrefix(new Date(2026, 0, 1, 0)), 'aaaa');
    });

    test('a worked example: 2026-07-27 14:00 → "agäo"', () => {
        // year 2026 → a, July (7th month) → g, day 27 → ä, hour 14 → o
        assert.equal(buildIdPrefix(new Date(2026, 6, 27, 14)), 'agäo');
    });

    test('is deterministic — the same hour always yields the same code', () => {
        const first = buildIdPrefix(new Date(2026, 6, 27, 14, 5));
        const second = buildIdPrefix(new Date(2026, 6, 27, 14, 42));
        assert.equal(first, second);
    });

    test('distinguishes adjacent hours, days, months and years', () => {
        const base = buildIdPrefix(new Date(2026, 6, 27, 14));
        assert.notEqual(base, buildIdPrefix(new Date(2026, 6, 27, 15)));
        assert.notEqual(base, buildIdPrefix(new Date(2026, 6, 28, 14)));
        assert.notEqual(base, buildIdPrefix(new Date(2026, 7, 27, 14)));
        assert.notEqual(base, buildIdPrefix(new Date(2027, 6, 27, 14)));
    });

    test('always returns exactly four letters and no digits', () => {
        for (const date of [
            new Date(2026, 0, 1, 0),
            new Date(2030, 5, 15, 9),
            new Date(2051, 11, 31, 23),
        ]) {
            const code = buildIdPrefix(date);
            assert.equal(code.length, 4);
            assert.match(code, /^[a-zäñößü]{4}$/u);
        }
    });

    test('rejects an invalid Date instead of emitting "NaN" letters', () => {
        assert.throws(() => buildIdPrefix(new Date(NaN)), /valid Date/i);
    });
});

// ---------------------------------------------------------------------------
// Reported parts — what the tool echoes back alongside the code
// ---------------------------------------------------------------------------

describe('describeIdPrefixParts', () => {
    test('reports the calendar fields that produced each letter', () => {
        const parts = describeIdPrefixParts(new Date(2026, 6, 27, 14));
        assert.deepEqual(parts, {
            year: 2026,
            month: 7,
            day: 27,
            hour: 14,
            yearLetter: 'a',
            monthLetter: 'g',
            dayLetter: 'ä',
            hourLetter: 'o',
        });
    });

    test('the concatenated letters equal the code', () => {
        const date = new Date(2033, 2, 9, 21);
        const parts = describeIdPrefixParts(date);
        assert.equal(
            parts.yearLetter + parts.monthLetter + parts.dayLetter + parts.hourLetter,
            buildIdPrefix(date),
        );
    });
});

// ---------------------------------------------------------------------------
// Tool surface — the JSON envelope the model actually receives
// ---------------------------------------------------------------------------

describe('tomAi_generateIdPrefix', () => {
    test('typical call returns the code plus its parts and a worked example', async () => {
        const raw = await withTiming('tomAi_generateIdPrefix:typical', async () =>
            generateIdPrefixImpl(new Date(2026, 6, 27, 14)));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.prefix, 'agäo');
        assert.equal(r.parts.day, 27);
        assert.equal(r.parts.dayLetter, 'ä');
        assert.match(r.usage, /<baseId>_agäo-/);
        assert.equal(r.example, 'vex1_agäo-add-retry-backoff');
    });

    test('an unrepresentable year comes back as an error envelope, not a throw', async () => {
        const r = JSON.parse(generateIdPrefixImpl(new Date(2052, 0, 1, 0)));
        assert.equal(r.ok, false);
        assert.match(r.error, /2052/);
    });

    test('the registered tool reads the live clock and is read-only', async () => {
        const r = JSON.parse(await GENERATE_ID_PREFIX_TOOL.execute({}));
        assert.equal(r.ok, true);
        assert.equal(r.prefix, buildIdPrefix(new Date()));
        assert.equal(GENERATE_ID_PREFIX_TOOL.readOnly, true);
        assert.equal(GENERATE_ID_PREFIX_TOOL.name, 'tomAi_generateIdPrefix');
    });
});

// ---------------------------------------------------------------------------
// Selectability — the tool must be reachable under BOTH profile shapes
// ---------------------------------------------------------------------------

/**
 * Being spread into `ALL_SHARED_TOOLS` only serves profiles with
 * `toolsEnabled !== false`. A profile that sets `toolsEnabled: false` receives
 * exactly the tools its `enabledTools` allow-list names, and that allow-list is
 * built by ticking boxes in the status-page picker / profile editor / template
 * editors / MCP card — every one of which renders `AVAILABLE_LLM_TOOLS`.
 *
 * So a tool absent from that constant cannot be ticked anywhere, and under an
 * allow-list profile the workspace-wide "always call this before inventing an
 * id" rule would be impossible to satisfy. Neither list alone is sufficient
 * evidence that the tool is usable; assert both.
 */
describe('tomAi_generateIdPrefix — reachable from the picker UI', () => {
    test('is offered by the picker option set', () => {
        assert.ok(
            (AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_generateIdPrefix'),
            'tomAi_generateIdPrefix missing from AVAILABLE_LLM_TOOLS — allow-list profiles cannot enable it',
        );
    });

    test('is grouped rather than falling through to "Other"', () => {
        const groups = categorizeTools(['tomAi_generateIdPrefix']);
        assert.equal(groups.length, 1);
        assert.notEqual(
            groups[0].category,
            'Other',
            'tomAi_generateIdPrefix has no CATEGORY_MAP entry, so the picker buries it under "Other"',
        );
        assert.deepEqual(groups[0].tools.map((t) => t.value), ['tomAi_generateIdPrefix']);
    });
});
