/**
 * A guideline section or option renamed (gsel7b): the stored choices that name
 * the old section id or option, carried over to the new name.
 *
 * The section editor (handlers/aspectSectionEditor-handler.ts) renames a
 * section's folder and an option's file; every level keeps its choices as a
 * map `section id → option` (utils/aspectChoices.ts), so a rename rewrites
 * those maps — in memory ({@link renameInChoices}) and in the YAML files they
 * are stored in ({@link renameInYamlChoiceMap}, {@link renameInGuidelinesNodes}),
 * formatting and comments kept. `remove` (the levels' Remove) is no option and
 * never rewritten.
 */

import { isMap, isScalar, isSeq, Scalar, visit, type Document, type YAMLMap } from 'yaml';

/** What was renamed: a section's id, or options of one section (old name → new name). */
export type AspectRename =
    | { kind: 'section'; from: string; to: string }
    | { kind: 'options'; section: string; options: Readonly<Record<string, string>> };

const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v === v.trim();

/** A rename as a window request or a page message carries it; undefined when it is none or renames nothing. */
export function parseAspectRename(value: unknown): AspectRename | undefined {
    if (typeof value !== 'object' || value === null) { return undefined; }
    const v = value as Record<string, unknown>;
    if (v.kind === 'section') {
        return isName(v.from) && isName(v.to) && v.from !== v.to ? { kind: 'section', from: v.from, to: v.to } : undefined;
    }
    if (v.kind === 'options' && isName(v.section) && typeof v.options === 'object' && v.options !== null) {
        const options: Record<string, string> = {};
        for (const [from, to] of Object.entries(v.options as Record<string, unknown>)) {
            if (isName(from) && isName(to) && from !== to && from !== 'remove' && to !== 'remove') { options[from] = to; }
        }
        return Object.keys(options).length ? { kind: 'options', section: v.section, options } : undefined;
    }
    return undefined;
}

/** The rename in words: `aspect night → mode`, `choices of night: on → yes, off → no`. */
export function aspectRenameText(rename: AspectRename): string {
    return rename.kind === 'section'
        ? `aspect ${rename.from} → ${rename.to}`
        : `choice${Object.keys(rename.options).length === 1 ? '' : 's'} of ${rename.section}: ${Object.entries(rename.options).map(([f, t]) => `${f} → ${t}`).join(', ')}`;
}

/**
 * `choices` with the rename applied; undefined when it names nothing renamed.
 * A section rename keeps the key's place; a choice already stored under the new
 * id (it named no section, so it applied nowhere) gives way to the carried one.
 */
export function renameInChoices(choices: Readonly<Record<string, string | string[]>> | undefined, rename: AspectRename): Record<string, string | string[]> | undefined {
    if (!choices) { return undefined; }
    if (rename.kind === 'section') {
        if (!Object.prototype.hasOwnProperty.call(choices, rename.from)) { return undefined; }
        const next: Record<string, string | string[]> = {};
        for (const [section, option] of Object.entries(choices)) {
            if (section === rename.to) { continue; }
            next[section === rename.from ? rename.to : section] = option;
        }
        return next;
    }
    const current = choices[rename.section];
    if (current === undefined) { return undefined; }
    const renamed = Array.isArray(current) ? current.map((c) => renamedChoice(c, rename.options)) : renamedChoice(current, rename.options);
    const changed = Array.isArray(current) ? current.some((c, i) => c !== (renamed as string[])[i]) : renamed !== current;
    return changed ? { ...choices, [rename.section]: renamed } : undefined;
}

/** One stored choice (`name`, `+name`; `remove` never) with a choice rename applied. */
function renamedChoice(stored: string, options: Readonly<Record<string, string>>): string {
    const add = stored.startsWith('+');
    const name = add ? stored.slice(1) : stored;
    return Object.prototype.hasOwnProperty.call(options, name) ? `${add ? '+' : ''}${options[name]}` : stored;
}

const scalarText = (node: unknown): string | undefined => (isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : undefined);

/** Apply the rename to one stored choice map of a YAML document in place; true when it changed. */
export function renameInYamlChoiceMap(map: YAMLMap, rename: AspectRename): boolean {
    if (rename.kind === 'section') {
        const pair = map.items.find((p) => scalarText(p.key) === rename.from);
        if (!pair) { return false; }
        map.items = map.items.filter((p) => p === pair || scalarText(p.key) !== rename.to);
        if (isScalar(pair.key)) { (pair.key as Scalar).value = rename.to; } else { pair.key = new Scalar(rename.to); }
        return true;
    }
    const pair = map.items.find((p) => scalarText(p.key) === rename.section);
    if (!pair) { return false; }
    // A list of choices (gsel20): each entry renamed in place, its `+` kept.
    const scalars = isSeq(pair.value) ? pair.value.items.filter(isScalar) : isScalar(pair.value) ? [pair.value] : [];
    let changed = false;
    for (const node of scalars) {
        const current = scalarText(node);
        if (current === undefined) { continue; }
        const next = renamedChoice(current, rename.options);
        if (next !== current) { (node as Scalar).value = next; changed = true; }
    }
    return changed;
}

/**
 * Apply the rename to every `guidelines:` map of a document — a queue entry's
 * items, a run's queue settings, a todo, a role or a role type — in place;
 * answers how many maps changed.
 */
export function renameInGuidelinesNodes(doc: Document, rename: AspectRename): number {
    let count = 0;
    visit(doc, {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the yaml visitor's node-type key
        Pair(_key, pair) {
            if (scalarText(pair.key) !== 'guidelines' || !isMap(pair.value)) { return undefined; }
            if (renameInYamlChoiceMap(pair.value, rename)) { count++; }
            return visit.SKIP;
        },
    });
    return count;
}
