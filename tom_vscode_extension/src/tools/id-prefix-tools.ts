/**
 * Date-based id-prefix tool.
 *
 * Hand-authored ids (quest todos, session todos, issues, tests) used to collide:
 * two sessions — or two machines — inventing `vex1` on different days produced
 * the same id for unrelated work, and the `_ai` layer is shared fleet-wide, so
 * the collision surfaced only after a merge.
 *
 * This tool stamps a short, letters-only code derived from the current date so
 * a base id like `vex1` becomes `vex1_agäo`. The code is:
 *
 *   - **unique enough** — it changes every clock hour, so two ids authored in
 *     different hours can never collide even if the base number repeats;
 *   - **deterministic** — every call within the same hour returns the same
 *     code, so re-running a step reproduces the id instead of inventing a
 *     second one;
 *   - **letters only** — safe in filenames, YAML keys and anchors, and visually
 *     distinct from the numeric part of the base id.
 *
 * Positional encoding (each position independent):
 *
 *   | # | Field | Mapping                                             |
 *   |---|-------|-----------------------------------------------------|
 *   | 1 | year  | `a`=2026, `b`=2027, … `z`=2051                       |
 *   | 2 | month | `a`=January … `l`=December                           |
 *   | 3 | day   | `a`=1 … `z`=26, then `ä`=27, `ñ`=28, `ö`=29, `ß`=30, `ü`=31 |
 *   | 4 | hour  | `a`=0 … `x`=23 (24-hour clock)                       |
 *
 * Local calendar fields are used deliberately: someone generating an id at
 * 14:00 expects the 14:00 letter regardless of the machine's UTC offset.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Alphabets
// ===========================================================================

/** Year letters — one per year starting at {@link ID_PREFIX_FIRST_YEAR}. */
const YEAR_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Month letters — January … December. */
const MONTH_LETTERS = 'abcdefghijkl';

/**
 * Day letters — 1…31. The five extended letters cover the days past `z`;
 * each is a single UTF-16 code unit, which is what keeps the code exactly
 * four characters long and safe to index positionally.
 */
const DAY_LETTERS = 'abcdefghijklmnopqrstuvwxyzäñößü';

/** Hour letters — 0…23 on the 24-hour clock. */
const HOUR_LETTERS = 'abcdefghijklmnopqrstuvwx';

/** First year the encoding can represent (maps to `a`). */
export const ID_PREFIX_FIRST_YEAR = 2026;

/** Last year the encoding can represent (maps to `z`). */
export const ID_PREFIX_LAST_YEAR = ID_PREFIX_FIRST_YEAR + YEAR_LETTERS.length - 1;

// ===========================================================================
// Pure encoder
// ===========================================================================

/** The calendar fields behind a code, plus the letter each one produced. */
export interface IdPrefixParts {
    /** Full year, e.g. 2026. */
    year: number;
    /** Month, 1-based (1 = January) — the human-readable form, not `getMonth()`. */
    month: number;
    /** Day of month, 1–31. */
    day: number;
    /** Hour on the 24-hour clock, 0–23. */
    hour: number;
    yearLetter: string;
    monthLetter: string;
    dayLetter: string;
    hourLetter: string;
}

/**
 * Throw unless `date` is a usable Date. Without this an invalid Date would
 * index every alphabet with `NaN` and quietly yield `"undefinedundefined…"`.
 */
function assertUsableDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new Error('buildIdPrefix requires a valid Date.');
    }
    const year = date.getFullYear();
    if (year < ID_PREFIX_FIRST_YEAR || year > ID_PREFIX_LAST_YEAR) {
        throw new Error(
            `Year ${year} is outside the representable range ` +
            `${ID_PREFIX_FIRST_YEAR}–${ID_PREFIX_LAST_YEAR} (single letter a–z).`,
        );
    }
}

/**
 * Encode `date` as the 4-letter id prefix. Same hour → same code.
 *
 * @throws if the date is invalid or its year falls outside a–z.
 */
export function buildIdPrefix(date: Date): string {
    assertUsableDate(date);
    return (
        YEAR_LETTERS[date.getFullYear() - ID_PREFIX_FIRST_YEAR] +
        MONTH_LETTERS[date.getMonth()] +
        DAY_LETTERS[date.getDate() - 1] +
        HOUR_LETTERS[date.getHours()]
    );
}

/** Break `date` down into the fields and letters that make up its code. */
export function describeIdPrefixParts(date: Date): IdPrefixParts {
    assertUsableDate(date);
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        yearLetter: YEAR_LETTERS[date.getFullYear() - ID_PREFIX_FIRST_YEAR],
        monthLetter: MONTH_LETTERS[date.getMonth()],
        dayLetter: DAY_LETTERS[date.getDate() - 1],
        hourLetter: HOUR_LETTERS[date.getHours()],
    };
}

// ===========================================================================
// Tool surface
// ===========================================================================

/** `tomAi_generateIdPrefix` takes no input — the code comes from the clock. */
export type GenerateIdPrefixInput = Record<string, never>;

/** Build the tool's JSON response for `date`. Exported for testing. */
export function generateIdPrefixImpl(date: Date): string {
    try {
        const prefix = buildIdPrefix(date);
        const parts = describeIdPrefixParts(date);
        return JSON.stringify({
            ok: true,
            prefix,
            parts,
            usage:
                'Append the prefix to the base id the user gave you, separated ' +
                'by an underscore, then add any descriptive tail after a hyphen: ' +
                `<baseId>_${prefix}-<short-description>.`,
            example: `vex1_${prefix}-add-retry-backoff`,
        });
    } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
    }
}

export const GENERATE_ID_PREFIX_DESCRIPTION =
    'Generate the short, letters-only date code used to make hand-authored ids ' +
    'collision-free. **Always call this before inventing an id** for a quest ' +
    'todo, session todo, issue, test or any other id the user asks you to ' +
    'create — never guess the code, and never reuse one from earlier in the ' +
    'conversation. The user supplies a base id (e.g. `vex1`); you append the ' +
    'returned prefix after it: `vex1_<prefix>-optional-description`. ' +
    'The code is 4 letters derived from the current local date — ' +
    'position 1 = year (a=2026, b=2027, …), 2 = month (a=January … l=December), ' +
    '3 = day of month (a=1 … z=26, ä=27, ñ=28, ö=29, ß=30, ü=31), ' +
    '4 = hour (a=0 … x=23). It is deterministic within a clock hour, so two ' +
    'calls in the same hour return the same code by design. ' +
    'Response: `{ok, prefix, parts: {year, month, day, hour, yearLetter, ' +
    'monthLetter, dayLetter, hourLetter}, usage, example}`.';

export const GENERATE_ID_PREFIX_TOOL: SharedToolDefinition<GenerateIdPrefixInput> = {
    name: 'tomAi_generateIdPrefix',
    displayName: 'Generate Id Prefix',
    description: GENERATE_ID_PREFIX_DESCRIPTION,
    tags: ['ids', 'quest', 'todos', 'tom-ai-chat'],
    readOnly: true,
    canBeReferencedInPrompt: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => generateIdPrefixImpl(new Date()),
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ID_PREFIX_TOOLS: SharedToolDefinition<any>[] = [
    GENERATE_ID_PREFIX_TOOL,
];
