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

import { ASPECT_LEVELS, ASPECT_REMOVE, isAspectName, type AspectLevel, type AspectLevelChoices, type AspectSection } from './aspectGuidelines';

/** One level's choices: section id → option name or `remove`. */
export type AspectChoices = Record<string, string>;

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
        if (typeof option === 'string' && isAspectName(section) && isAspectName(option)) { out[section] = option; }
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
        return '`guidelines` must be an object mapping an aspect to a choice name or "remove".';
    }
    const problems: string[] = [];
    const byId = new Map(sections.map((s) => [s.id, s]));
    for (const [section, option] of Object.entries(value as Record<string, unknown>)) {
        const known = byId.get(section);
        if (!known) {
            problems.push(`"${section}" is no guideline aspect (aspects: ${sections.map((s) => s.id).join(', ') || 'none — _ai/aspect_guidelines/ has none'})`);
            continue;
        }
        if (typeof option !== 'string') {
            problems.push(`"${section}" must map to a choice name or "${ASPECT_REMOVE}"`);
            continue;
        }
        if (option !== ASPECT_REMOVE && !known.options.some((o) => o.name === option)) {
            problems.push(`"${option}" is no choice of "${section}" (choices: ${[...known.options.map((o) => o.name), ASPECT_REMOVE].join(', ')})`);
        }
    }
    return problems.length ? `Unknown guideline choices: ${problems.join('; ')}.` : undefined;
}

/**
 * `choices` with `section` set to `option` (an option name or `remove`), or
 * without it when `option` is undefined or `''` (*Don't add*). Undefined when
 * nothing is left.
 */
export function withSectionChoice(choices: AspectChoices | undefined, section: string, option: string | undefined): AspectChoices | undefined {
    const out: AspectChoices = { ...(choices ?? {}) };
    if (option) { out[section] = option; } else { delete out[section]; }
    return Object.keys(out).length ? out : undefined;
}

/** A section as the guideline picker shows it: everything but the option texts. */
export interface AspectCatalogueSection {
    id: string;
    name: string;
    label: string;
    defaultOption?: string;
    options: string[];
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
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a![k] === b![k]);
}
