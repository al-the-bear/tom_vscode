/**
 * The guideline choices one level keeps (gsel4; design
 * `role_and_guideline_selector.vscode_extension.md`, L-1..L-8, P-6): a map of
 * aspect → choice short name, or `remove`. An aspect the level does
 * not choose has no entry (*Don't add*: it inherits from the levels above).
 *
 * - {@link normalizeAspectChoices} reads a stored map (anything else is
 *   dropped: a level written by hand never breaks a send).
 * - {@link aspectChoicesRefusal} checks a map an agent or a panel gives
 *   against the store's sections: every section must exist and every value be
 *   one of its options or `remove`.
 * - {@link withSectionChoice} sets or drops one section (the all-windows
 *   change touches only its section).
 * - {@link choicesUpTo} cuts the levels to those up to one level: that level's
 *   effective selection.
 *
 * Pure: tested in `__tests__/aspectChoices.test.ts`.
 */

import { ASPECT_LEVELS, ASPECT_REMOVE, aspectValueText, formatAspectValue, isAspectName, parseAspectValue, type AspectChoiceValue, type AspectLevel, type AspectLevelChoices, type AspectSection } from './aspectGuidelines';

/** One level's choices: aspect id → a choice, `remove`, or a list of choices (replacing; `+` on every entry: adding). */
export type AspectChoices = Record<string, AspectChoiceValue>;

/** The levels a level choice may name, the section default excluded. */
export type AspectChoiceLevel = Exclude<AspectLevel, 'sectionDefault'>;

/**
 * `value` as one level's choices: the entries whose key and value are names
 * (utils/aspectGuidelines.ts isAspectName); others are dropped. Undefined
 * when nothing is left (no choices: the level adds nothing).
 */
export function normalizeAspectChoices(value: unknown): AspectChoices | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { return undefined; }
    const out: AspectChoices = {};
    for (const [section, option] of Object.entries(value as Record<string, unknown>)) {
        const entry = isAspectName(section) ? parseAspectValue(option) : undefined;
        if (entry) { out[section] = formatAspectValue(entry); }
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Why `value` cannot be stored as a level's choices with the sections
 * `sections`; undefined when it can. `{}` and `null` are fine (they clear the
 * level).
 */
export function aspectChoicesRefusal(value: unknown, sections: readonly AspectSection[]): string | undefined {
    if (value === null || value === undefined) { return undefined; }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return '`guidelines` must be an object mapping an aspect to a choice name, a list of choice names (replacing the levels below; each entry with a leading "+": added to them) or "remove".';
    }
    const problems: string[] = [];
    const byId = new Map(sections.map((s) => [s.id, s]));
    for (const [section, option] of Object.entries(value as Record<string, unknown>)) {
        const known = byId.get(section);
        if (!known) {
            problems.push(`"${section}" is no guideline aspect (aspects: ${sections.map((s) => s.id).join(', ') || 'none — _ai/aspect_guidelines/ has none'})`);
            continue;
        }
        const entry = parseAspectValue(option);
        if (!entry) {
            problems.push(`"${section}" must map to a choice name, a list of choice names (all with "+" to add) or "${ASPECT_REMOVE}"`);
            continue;
        }
        if (entry.kind === 'remove') { continue; }
        for (const c of entry.choices) {
            if (!known.options.some((o) => o.name === c)) {
                problems.push(`"${c}" is no choice of "${section}" (choices: ${[...known.options.map((o) => o.name), ASPECT_REMOVE].join(', ')})`);
            }
        }
    }
    return problems.length ? `Unknown guideline choices: ${problems.join('; ')}.` : undefined;
}

/**
 * `choices` with `section` set to `value` (a choice, `remove`, or a list), or
 * without it when `value` is undefined, `''` (*Don't add*) or no valid value.
 * Undefined when nothing is left.
 */
export function withSectionChoice(choices: AspectChoices | undefined, section: string, value: AspectChoiceValue | undefined): AspectChoices | undefined {
    const out: AspectChoices = { ...(choices ?? {}) };
    const entry = value === undefined || value === '' ? undefined : parseAspectValue(value);
    if (entry) { out[section] = formatAspectValue(entry); } else { delete out[section]; }
    return Object.keys(out).length ? out : undefined;
}

/** A section as the guideline picker shows it: everything but the option texts. */
export interface AspectCatalogueSection {
    id: string;
    name: string;
    label: string;
    defaultOption?: string;
    options: string[];
    /** Per choice, the file its text comes from (own text or a guideline file, gsel17), as shown. */
    files?: Record<string, string>;
    /** Per conditional choice, its condition (gsel20). */
    when?: Record<string, string>;
    /** The aspect's `remove_when`. */
    removeWhen?: string;
    /**
     * Whether each condition holds for a prompt of a kind (`chat` / `queue` /
     * `todo`), evaluated by the host (aspectPickerState); `error` when it cannot
     * be evaluated. `removeWhen` under the key `''`.
     */
    holds?: Record<string, Record<string, boolean | 'error'>>;
}

/** The sections the guideline picker offers (media/shared/aspectPicker.js), and the problems reading them. */
export interface AspectCatalogue {
    sections: AspectCatalogueSection[];
    problems?: string[];
}

/** The picker's catalogue of `sections`: names, labels, option names and defaults, in their order. */
export function aspectCatalogueOf(sections: readonly AspectSection[]): AspectCatalogue {
    return {
        sections: sections.map((s) => ({
            id: s.id,
            name: s.name,
            label: s.label,
            ...(s.defaultOption ? { defaultOption: s.defaultOption } : {}),
            options: s.options.map((o) => o.name),
            ...(s.options.some((o) => o.source) ? { files: Object.fromEntries(s.options.filter((o) => o.source).map((o) => [o.name, o.source!.display])) } : {}),
            ...(s.options.some((o) => o.when !== undefined) ? { when: Object.fromEntries(s.options.filter((o) => o.when !== undefined).map((o) => [o.name, o.when!])) } : {}),
            ...(s.removeWhen !== undefined ? { removeWhen: s.removeWhen } : {}),
        })),
    };
}

/** The levels of `choices` up to and including `level` (in the order of ASPECT_LEVELS): what that level resolves to. */
export function choicesUpTo(choices: AspectLevelChoices, level: AspectLevel): AspectLevelChoices {
    const last = ASPECT_LEVELS.indexOf(level);
    const out: AspectLevelChoices = {};
    for (const [key, value] of Object.entries(choices) as Array<[AspectChoiceLevel, AspectChoices | undefined]>) {
        if (value && ASPECT_LEVELS.indexOf(key) <= last) { out[key] = value; }
    }
    return out;
}

/** `explicit`'s levels over `base`'s: a level `explicit` names replaces `base`'s (an empty map clears it). */
export function overrideLevels(base: AspectLevelChoices, explicit: AspectLevelChoices | undefined): AspectLevelChoices {
    const out: AspectLevelChoices = { ...base };
    for (const [key, value] of Object.entries(explicit ?? {}) as Array<[AspectChoiceLevel, AspectChoices | undefined]>) {
        if (value === undefined) { continue; }
        if (Object.keys(value).length) { out[key] = value; } else { delete out[key]; }
    }
    return out;
}

/** Whether two levels' choices are the same (absent and `{}` alike). */
export function sameAspectChoices(a: AspectChoices | undefined, b: AspectChoices | undefined): boolean {
    const ka = Object.keys(a ?? {}).sort();
    const kb = Object.keys(b ?? {}).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && aspectValueText(a![k]) === aspectValueText(b![k]) && Array.isArray(a![k]) === Array.isArray(b![k]));
}
