/**
 * Aspect guidelines: the guideline aspects a prompt is given, one choice per
 * aspect (design: `_ai/quests/vscode_extension/role_and_guideline_selector.vscode_extension.md`,
 * A-1..A-4, L-1, L-2, AS-2; the words aspect and choice: guideline_sectioning.md D-26).
 *
 * - **The store** is `_ai/aspect_guidelines/<aspect>/`: `aspect.yaml` (name,
 *   short label, placement, default choice, the choices' order) and one
 *   `<choice>.md` per choice, its file name the choice's short name
 *   (services/aspectGuidelinesStore.ts reads it; the schema is
 *   `src/config/aspect-guideline.schema.json`). `section.yaml` with `options:`
 *   is the format before version 10: the `_ai` format migration renames it.
 * - **The levels**, lowest winning per aspect: aspect default < workspace
 *   (`workspace_aspects.md` / `.yaml` of the Tom root and the workspace
 *   folders, services/workspaceAspects.ts) < quest default < window < run < role type < role < item < todo. On each level an
 *   aspect is absent (*Don't add*: inherit), `remove` (nothing for the
 *   aspect, whatever is above, the default included) or a choice.
 * - **The text**: each effective choice's text (placeholders resolved by the
 *   caller), the `system` aspects as one segment of the system prompt, the
 *   `user` aspects before the prompt text. Copilot has no system prompt of
 *   its own: there both go before the prompt text.
 *
 * Code identifiers keep their older names (`AspectSection`, `options`,
 * `sectionDefault`): they are not user-visible; the stored field
 * `guidelines:` stays too.
 *
 * - **Choice files** (gsel17, utils/aspectChoiceFiles.ts): a choice's text is
 *   its own text in the aspect's folder or a guideline file
 *   `_agent_guidelines/aspects/<aspect>/<choice>.md` of the root or a
 *   workspace folder; the store passes the texts and their sources in.
 *
 * Pure (no `vscode`, no `fs`): tested in `__tests__/aspectGuidelines.test.ts`.
 */

import type { AspectChoiceSource } from './aspectChoiceFiles';
import { parseExpression } from './templateExpression';

/** The levels, the highest (overridden by every other) first. */
export const ASPECT_LEVELS = ['sectionDefault', 'workspace', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo'] as const;
export type AspectLevel = typeof ASPECT_LEVELS[number];

/** The value of a level's entry that sends nothing for its aspect. */
export const ASPECT_REMOVE = 'remove';

/** An aspect's definition file in its folder. */
export const ASPECT_FILE = 'aspect.yaml';

/** The definition file before format version 10; the migration renames it to {@link ASPECT_FILE}. */
export const LEGACY_ASPECT_FILE = 'section.yaml';

/** Where a section's text goes. */
export type AspectPlacement = 'system' | 'user';

/** One option: its short name (the file name without `.md`), its text and where the text comes from. */
export interface AspectOption {
    name: string;
    text: string;
    /** Own text or a guideline file (gsel17); unset when the caller did not say. */
    source?: AspectChoiceSource;
    /** Its condition (gsel20): an expression of the template expression language; the choice is sent only while it holds. */
    when?: string;
}

/** One section as the store holds it. */
export interface AspectSection {
    /** The folder name under `_ai/aspect_guidelines/`: the id the levels name. */
    id: string;
    /** The section's name (`Answer mode`). */
    name: string;
    /** The short label shown in the button's hover help (`Answer`); the name when not given. */
    label: string;
    placement: AspectPlacement;
    /** The option chosen when no level chooses; undefined: nothing. */
    defaultOption?: string;
    /** The options in their order. */
    options: AspectOption[];
    /** While this expression holds the aspect sends nothing, whatever was chosen (gsel20). */
    removeWhen?: string;
    /** Where the aspect's text goes among the aspects, lowest first (gsel26); unset: after those with one, by id. */
    order?: number;
}

/**
 * One level's value for an aspect (gsel20, guideline_sectioning.md D-28): a
 * choice, `remove`, or a list of choices. A list (or a single choice)
 * **replaces** the choices of the levels below; a list whose entries all start
 * with `+` (or a single `+choice`) is **added** to them. A single string is the
 * form every store wrote before, and stays valid.
 */
export type AspectChoiceValue = string | string[];

/** The prefix that marks a choice added to the levels below. */
export const ASPECT_ADD_PREFIX = '+';

/** A level's value read: remove, or the choices it replaces with or adds. */
export type AspectLevelEntry = { kind: 'remove' } | { kind: 'replace' | 'add'; choices: string[] };

/** A choice name as a level stores it: a name, not `remove`, not starting with `+`. */
export function isChoiceName(name: string): boolean {
    return isAspectName(name) && name !== ASPECT_REMOVE && !name.startsWith(ASPECT_ADD_PREFIX);
}

/** A level's value read (undefined: no valid value — a list mixing `+` and plain entries, a name that is none). */
export function parseAspectValue(value: unknown): AspectLevelEntry | undefined {
    if (typeof value === 'string') {
        if (value === ASPECT_REMOVE) { return { kind: 'remove' }; }
        if (value.startsWith(ASPECT_ADD_PREFIX)) {
            const name = value.slice(ASPECT_ADD_PREFIX.length);
            return isChoiceName(name) ? { kind: 'add', choices: [name] } : undefined;
        }
        return isChoiceName(value) ? { kind: 'replace', choices: [value] } : undefined;
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) { return undefined; }
    const adds = (value as string[]).filter((v) => v.startsWith(ASPECT_ADD_PREFIX)).length;
    if (adds && adds !== value.length) { return undefined; }
    const names = (value as string[]).map((v) => (adds ? v.slice(ASPECT_ADD_PREFIX.length) : v));
    if (!names.every(isChoiceName)) { return undefined; }
    return { kind: adds ? 'add' : 'replace', choices: [...new Set(names)] };
}

/** A level's entry in its stored form: `remove`, one choice as a string, else a list (`+` on every entry that adds). */
export function formatAspectValue(entry: AspectLevelEntry): AspectChoiceValue {
    if (entry.kind === 'remove') { return ASPECT_REMOVE; }
    if (entry.kind === 'replace') { return entry.choices.length === 1 ? entry.choices[0] : [...entry.choices]; }
    return entry.choices.map((c) => `${ASPECT_ADD_PREFIX}${c}`);
}

/**
 * Two levels' entries for one aspect, `upper` over `lower`, as one entry: a
 * remove or a replacing entry decides; an adding one adds to what is below it
 * (to a remove: the choices alone, replacing).
 */
export function combineAspectEntries(lower: AspectLevelEntry | undefined, upper: AspectLevelEntry): AspectLevelEntry {
    if (upper.kind !== 'add' || !lower) { return upper; }
    if (lower.kind === 'remove') { return { kind: 'replace', choices: [...upper.choices] }; }
    return { kind: lower.kind, choices: [...new Set([...lower.choices, ...upper.choices])] };
}

/** A value as one line of text (`brief`, `brief, long`, `+react`), for messages and hover help. */
export function aspectValueText(value: AspectChoiceValue): string {
    return Array.isArray(value) ? value.join(', ') : value;
}

/** The choices of the levels below the section default: section id → a choice, `remove`, or a list (replace / add). */
export type AspectLevelChoices = Partial<Record<Exclude<AspectLevel, 'sectionDefault'>, Record<string, AspectChoiceValue>>>;

/**
 * A name a section folder or an option file may have: not empty, no `/`, no
 * line break, no space at either end — the rule tom_todo_model's
 * `TomItemWorkflow.guidelines` applies to the names a todo stores.
 */
export function isAspectName(name: string): boolean {
    return name.length > 0 && name.trim() === name && !/[/\n\r]/.test(name);
}

/** The `aspect.yaml` content as read, before it is checked. */
export interface AspectSectionYaml {
    name?: unknown;
    label?: unknown;
    placement?: unknown;
    default?: unknown;
    /** The choices' order; an entry is a name, or `{name, when}` with the choice's condition (gsel20). */
    choices?: unknown;
    /** While it holds the aspect sends nothing (gsel20). */
    remove_when?: unknown;
    /** Its place among the aspects, lowest first (gsel26). */
    order?: unknown;
    /** The key before format version 10: refused, the migration renames it to `choices`. */
    options?: unknown;
}

/** Why `expression` is no valid condition (the parser's message with its position); undefined when it is. */
export function conditionProblem(expression: string): string | undefined {
    if (!expression.trim()) { return 'the condition is empty'; }
    try {
        parseExpression(expression);
        return undefined;
    } catch (err) {
        const pos = (err as { position?: number }).position;
        return `${(err as Error).message}${typeof pos === 'number' ? ` (at position ${pos + 1})` : ''}`;
    }
}

/**
 * Builds an aspect from its folder name, its `aspect.yaml` and its choice
 * texts (`name` → text, in any order: own texts and guideline files alike;
 * `sources` says where each comes from). Answers the aspect and the problems
 * found; an aspect that cannot be used (no name, a bad placement, a folder
 * name that is no name) is answered as `undefined` with its problems.
 *
 * - The choices are `choices` (the order) first — names without a file are
 *   problems and left out —, then the other files by name.
 * - A choice named `remove` is a problem and left out: the name is the
 *   levels' Remove.
 * - A `default` that names no choice is a problem and dropped.
 * - The older key `options` is a problem (the migration renames it).
 */
export function buildAspectSection(
    id: string,
    yaml: AspectSectionYaml | undefined,
    files: Readonly<Record<string, string>>,
    sources?: Readonly<Record<string, AspectChoiceSource>>,
): { section?: AspectSection; problems: string[] } {
    const problems: string[] = [];
    if (!isAspectName(id)) { return { problems: [`aspect folder "${id}": not an aspect name`] }; }
    if (!yaml || typeof yaml !== 'object') { return { problems: [`${id}: no ${ASPECT_FILE}`] }; }
    if (typeof yaml.name !== 'string' || !yaml.name.trim()) { return { problems: [`${id}: ${ASPECT_FILE} has no name`] }; }
    const placement = yaml.placement ?? 'system';
    if (placement !== 'system' && placement !== 'user') {
        return { problems: [`${id}: placement must be system or user, not "${String(placement)}"`] };
    }
    const label = typeof yaml.label === 'string' && yaml.label.trim() ? yaml.label.trim() : yaml.name.trim();
    const usable = Object.keys(files).filter((n) => {
        if (n === ASPECT_REMOVE) { problems.push(`${id}: a choice may not be named "${ASPECT_REMOVE}" (the levels' Remove)`); return false; }
        if (n.startsWith(ASPECT_ADD_PREFIX)) { problems.push(`${id}: choice file "${n}.md": a choice name may not start with "${ASPECT_ADD_PREFIX}" (it marks an added choice)`); return false; }
        if (!isAspectName(n)) { problems.push(`${id}: choice file "${n}.md": not a choice name`); return false; }
        return true;
    });
    const order: string[] = [];
    const conditions: Record<string, string> = {};
    if (yaml.options !== undefined) {
        problems.push(`${id}: \`options\` is the key before format version 10; it is \`choices\` now (Upgrade the workspace renames it)`);
    }
    if (yaml.choices !== undefined) {
        if (!Array.isArray(yaml.choices)) {
            problems.push(`${id}: choices must be a list of choice names`);
        } else {
            for (const entry of yaml.choices) {
                const o = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as { name?: unknown }).name : entry;
                if (typeof o !== 'string' || !usable.includes(o)) { problems.push(`${id}: choice "${String(o)}" has no ${String(o)}.md (own text or guideline file)`); continue; }
                if (!order.includes(o)) { order.push(o); }
                if (entry !== o) {
                    const when = (entry as { when?: unknown }).when;
                    if (when !== undefined && when !== null) {
                        if (typeof when !== 'string') { problems.push(`${id}: choice "${o}": when must be an expression (text)`); continue; }
                        const bad = conditionProblem(when);
                        if (bad) { problems.push(`${id}: choice "${o}": when: ${bad}; the choice is never sent`); }
                        conditions[o] = when;
                    }
                }
            }
        }
    }
    for (const n of [...usable].sort()) { if (!order.includes(n)) { order.push(n); } }
    let removeWhen: string | undefined;
    if (yaml.remove_when !== undefined && yaml.remove_when !== null) {
        if (typeof yaml.remove_when !== 'string') {
            problems.push(`${id}: remove_when must be an expression (text)`);
        } else {
            const bad = conditionProblem(yaml.remove_when);
            if (bad) { problems.push(`${id}: remove_when: ${bad}; it removes nothing`); }
            removeWhen = yaml.remove_when;
        }
    }
    let order_: number | undefined;
    if (yaml.order !== undefined && yaml.order !== null) {
        if (typeof yaml.order === 'number' && Number.isFinite(yaml.order)) { order_ = yaml.order; } else { problems.push(`${id}: order must be a number`); }
    }
    let defaultOption: string | undefined;
    if (yaml.default !== undefined && yaml.default !== null) {
        if (typeof yaml.default === 'string' && order.includes(yaml.default)) {
            defaultOption = yaml.default;
        } else {
            problems.push(`${id}: default "${String(yaml.default)}" is no choice of the aspect`);
        }
    }
    return {
        section: {
            id, name: yaml.name.trim(), label, placement, defaultOption,
            options: order.map((name) => ({ name, text: files[name], ...(sources?.[name] ? { source: sources[name] } : {}), ...(conditions[name] !== undefined ? { when: conditions[name] } : {}) })),
            ...(removeWhen !== undefined ? { removeWhen } : {}),
            ...(order_ !== undefined ? { order: order_ } : {}),
        },
        problems,
    };
}

/** A chosen choice: the level that chose it and, when it has one, its condition and whether it held. */
export interface ResolvedChoice {
    option: string;
    from: AspectLevel;
    when?: string;
    /** Whether `when` held (set when conditions were evaluated). */
    holds?: boolean;
    /** The condition could not be evaluated: the choice is not sent. */
    error?: string;
}

/** An aspect's effective choices and where they come from. */
export interface ResolvedAspect {
    section: string;
    /** The choices sent, in the aspect's choice order, their conditions applied. */
    options: string[];
    /** The first of `options` (one choice per aspect before gsel20). */
    option?: string;
    /** Every chosen choice, in the aspect's choice order, before the conditions. */
    chosen: ResolvedChoice[];
    /** A level chose `remove`, or `remove_when` held: nothing is sent. */
    removed: boolean;
    /** The highest level with an entry for the aspect; `sectionDefault` when only the default applies; undefined when nothing does. */
    from?: AspectLevel;
    /** The aspect's `remove_when`, when it was evaluated. */
    removeWhen?: { expression: string; holds: boolean; error?: string };
    /** A condition decided something: a chosen choice's `when` failed (or could not be evaluated), or `remove_when` held. */
    conditional: boolean;
}

/** The resolution of every section: per section its choice, and the entries no option matched. */
export interface AspectResolution {
    sections: ResolvedAspect[];
    /** Level entries naming a choice the aspect does not have (or an aspect there is not), or no valid value: skipped. */
    ignored: Array<{ level: AspectLevel; section: string; option: string }>;
}

/** How conditions are decided while resolving: `evaluate` answers whether an expression holds (throws when it is invalid). */
export interface AspectResolveOptions {
    evaluate?: (expression: string) => boolean;
}

/**
 * Resolves every aspect over the levels, from the aspect's default up to the
 * todo (gsel20): a level's entry `remove` clears the set, a replacing entry
 * sets it to its choices, an adding entry adds its choices to it. A choice an
 * aspect does not have is skipped (listed in `ignored`); an entry with no
 * choice the aspect has is skipped whole (the levels below decide). The set is
 * sent in the aspect's choice order.
 *
 * With `opts.evaluate`, the conditions: `remove_when` holding sends nothing;
 * each chosen choice with `when` is sent only while it holds — nothing steps in
 * for one that does not. An expression that cannot be evaluated counts as not
 * holding (the choice is not sent; an invalid `remove_when` removes nothing).
 */
export function resolveAspects(sections: readonly AspectSection[], choices: AspectLevelChoices = {}, opts: AspectResolveOptions = {}): AspectResolution {
    const ignored: AspectResolution['ignored'] = [];
    const known = new Set(sections.map((s) => s.id));
    for (const level of ASPECT_LEVELS) {
        if (level === 'sectionDefault') { continue; }
        for (const [section, value] of Object.entries(choices[level] ?? {})) {
            if (!known.has(section)) { ignored.push({ level, section, option: aspectValueText(value) }); }
        }
    }
    const check = (expression: string): { holds: boolean; error?: string } => {
        try { return { holds: opts.evaluate!(expression) }; } catch (err) { return { holds: false, error: (err as Error).message }; }
    };
    const resolved = sections.map((s): ResolvedAspect => {
        let set = new Map<string, AspectLevel>();
        let removed = false;
        let from: AspectLevel | undefined;
        if (s.defaultOption) { set.set(s.defaultOption, 'sectionDefault'); from = 'sectionDefault'; }
        for (const level of ASPECT_LEVELS) {
            if (level === 'sectionDefault') { continue; }
            const raw = choices[level]?.[s.id];
            if (raw === undefined) { continue; }
            const entry = parseAspectValue(raw);
            if (!entry) { ignored.push({ level, section: s.id, option: aspectValueText(raw as AspectChoiceValue) }); continue; }
            if (entry.kind === 'remove') { set = new Map(); removed = true; from = level; continue; }
            const usable = entry.choices.filter((c) => s.options.some((o) => o.name === c));
            for (const c of entry.choices) { if (!usable.includes(c)) { ignored.push({ level, section: s.id, option: c }); } }
            if (!usable.length && entry.choices.length) { continue; }
            if (entry.kind === 'replace') { set = new Map(usable.map((c) => [c, level])); } else { for (const c of usable) { if (!set.has(c)) { set.set(c, level); } } }
            removed = false;
            from = level;
        }
        const chosen: ResolvedChoice[] = s.options.filter((o) => set.has(o.name)).map((o) => ({ option: o.name, from: set.get(o.name)!, ...(o.when !== undefined ? { when: o.when } : {}) }));
        let conditional = false;
        let removeWhen: ResolvedAspect['removeWhen'];
        if (opts.evaluate) {
            if (s.removeWhen !== undefined) {
                removeWhen = { expression: s.removeWhen, ...check(s.removeWhen) };
                if (removeWhen.holds) { removed = true; conditional = true; }
            }
            for (const c of chosen) {
                if (c.when === undefined) { continue; }
                Object.assign(c, check(c.when));
                if (!c.holds) { conditional = true; }
            }
        }
        const options = removeWhen?.holds ? [] : chosen.filter((c) => c.holds !== false).map((c) => c.option);
        return {
            section: s.id, options, ...(options.length ? { option: options[0] } : {}), chosen, removed,
            ...(from ? { from } : {}), ...(removeWhen ? { removeWhen } : {}), conditional,
        };
    });
    return { sections: resolved, ignored };
}

/** One aspect's text as it is sent: its choices' texts, in the aspect's choice order. */
export interface AssembledAspect {
    section: string;
    name: string;
    /** The choices sent, joined with `, ` (the heading's text). */
    option: string;
    options: string[];
    placement: AspectPlacement;
    from: AspectLevel;
    text: string;
}

/** The text a prompt gets: the system part, the user part, and the sections in them. */
export interface AssembledAspects {
    system: string;
    user: string;
    sections: AssembledAspect[];
}

/** The heading the aspect text opens with, in the system prompt and before the prompt. */
export const ASPECT_HEADING = '## Aspect guidelines';

function renderPart(parts: readonly AssembledAspect[]): string {
    if (parts.length === 0) { return ''; }
    return [ASPECT_HEADING, ...parts.map((p) => `### ${p.name}: ${p.option}\n\n${p.text.trim()}`)].join('\n\n');
}

/**
 * The text of the effective options, in the sections' order: each option's
 * text through `resolve` (the caller's placeholder resolution, recursive),
 * the `system` ones in `system`, the `user` ones in `user`, each part under
 * {@link ASPECT_HEADING} with a `### <section>: <option>` heading per
 * section. An option whose text resolves to nothing is left out.
 */
export function assembleAspects(
    sections: readonly AspectSection[],
    resolution: AspectResolution,
    resolve: (text: string) => string = (t) => t,
): AssembledAspects {
    const out: AssembledAspect[] = [];
    for (const r of resolution.sections) {
        if (!r.options.length || !r.from) { continue; }
        const s = sections.find((x) => x.id === r.section);
        if (!s) { continue; }
        const parts = r.options
            .map((name) => s.options.find((x) => x.name === name))
            .filter((o): o is AspectOption => !!o)
            .map((o) => ({ name: o.name, text: resolve(o.text) }))
            .filter((p) => p.text.trim());
        if (!parts.length) { continue; }
        out.push({
            section: s.id, name: s.name, option: parts.map((p) => p.name).join(', '), options: parts.map((p) => p.name),
            placement: s.placement, from: r.from, text: parts.map((p) => p.text.trim()).join('\n\n'),
        });
    }
    return {
        system: renderPart(out.filter((p) => p.placement === 'system')),
        user: renderPart(out.filter((p) => p.placement === 'user')),
        sections: out,
    };
}

/**
 * `sections` in the order their texts are sent (gsel26): those with an
 * `order` by it, lowest first, then the others; each group by id.
 */
export function sortAspectSections<T extends { id: string; order?: number }>(sections: readonly T[]): T[] {
    return [...sections].sort((a, b) => {
        if (a.order !== undefined || b.order !== undefined) {
            if (a.order === undefined) { return 1; }
            if (b.order === undefined) { return -1; }
            if (a.order !== b.order) { return a.order - b.order; }
        }
        return a.id.localeCompare(b.id);
    });
}

/** The transports a prompt is sent on. */
export type AspectTransport = 'direct' | 'agentSdk' | 'vscodeLm' | 'localLlm' | 'copilot';

/**
 * Places the aspect text in a prompt. On the Anthropic transports (direct,
 * Agent SDK, VS Code LM, Local LLM) the system part is one more segment of
 * the system prompt and the user part goes before the user content. Copilot
 * has no system prompt of its own: the system part and then the user part go
 * before the prompt text. Nothing to add: the prompt unchanged.
 */
export function placeAspects(
    transport: AspectTransport,
    prompt: { systemSegments: readonly string[]; userContent: string },
    assembled: Pick<AssembledAspects, 'system' | 'user'>,
): { systemSegments: string[]; userContent: string } {
    const before = (parts: string[], text: string): string => {
        const head = parts.filter((p) => p).join('\n\n');
        return head ? `${head}\n\n---\n\n${text}` : text;
    };
    if (transport === 'copilot') {
        return { systemSegments: [...prompt.systemSegments], userContent: before([assembled.system, assembled.user], prompt.userContent) };
    }
    return {
        systemSegments: assembled.system ? [...prompt.systemSegments, assembled.system] : [...prompt.systemSegments],
        userContent: before([assembled.user], prompt.userContent),
    };
}
