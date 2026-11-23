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
 * - **The levels**, lowest winning per aspect: aspect default < quest
 *   default < window < run < role type < role < item < todo. On each level an
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
 * Pure (no `vscode`, no `fs`): tested in `__tests__/aspectGuidelines.test.ts`.
 */

/** The levels, the highest (overridden by every other) first. */
export const ASPECT_LEVELS = ['sectionDefault', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo'] as const;
export type AspectLevel = typeof ASPECT_LEVELS[number];

/** The value of a level's entry that sends nothing for its aspect. */
export const ASPECT_REMOVE = 'remove';

/** An aspect's definition file in its folder. */
export const ASPECT_FILE = 'aspect.yaml';

/** The definition file before format version 10; the migration renames it to {@link ASPECT_FILE}. */
export const LEGACY_ASPECT_FILE = 'section.yaml';

/** Where a section's text goes. */
export type AspectPlacement = 'system' | 'user';

/** One option: its short name (the file name without `.md`) and its text. */
export interface AspectOption {
    name: string;
    text: string;
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
}

/** The choices of the levels below the section default: section id → option name or `remove`. */
export type AspectLevelChoices = Partial<Record<Exclude<AspectLevel, 'sectionDefault'>, Record<string, string>>>;

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
    choices?: unknown;
    /** The key before format version 10: refused, the migration renames it to `choices`. */
    options?: unknown;
}

/**
 * Builds an aspect from its folder name, its `aspect.yaml` and its choice
 * files (`name` → text, in any order). Answers the aspect and the problems
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
        if (!isAspectName(n)) { problems.push(`${id}: choice file "${n}.md": not a choice name`); return false; }
        return true;
    });
    const order: string[] = [];
    if (yaml.options !== undefined) {
        problems.push(`${id}: \`options\` is the key before format version 10; it is \`choices\` now (Upgrade the workspace renames it)`);
    }
    if (yaml.choices !== undefined) {
        if (!Array.isArray(yaml.choices)) {
            problems.push(`${id}: choices must be a list of choice names`);
        } else {
            for (const o of yaml.choices) {
                if (typeof o !== 'string' || !usable.includes(o)) { problems.push(`${id}: choice "${String(o)}" has no ${String(o)}.md`); continue; }
                if (!order.includes(o)) { order.push(o); }
            }
        }
    }
    for (const n of [...usable].sort()) { if (!order.includes(n)) { order.push(n); } }
    let defaultOption: string | undefined;
    if (yaml.default !== undefined && yaml.default !== null) {
        if (typeof yaml.default === 'string' && order.includes(yaml.default)) {
            defaultOption = yaml.default;
        } else {
            problems.push(`${id}: default "${String(yaml.default)}" is no choice of the aspect`);
        }
    }
    return {
        section: { id, name: yaml.name.trim(), label, placement, defaultOption, options: order.map((name) => ({ name, text: files[name] })) },
        problems,
    };
}

/** A section's effective choice and the level it comes from. */
export interface ResolvedAspect {
    section: string;
    /** The option sent; undefined when nothing is sent for the section. */
    option?: string;
    /** True when a level chose `remove`. */
    removed: boolean;
    /** The level that decided; undefined when no level chose and there is no default. */
    from?: AspectLevel;
}

/** The resolution of every section: per section its choice, and the entries no option matched. */
export interface AspectResolution {
    sections: ResolvedAspect[];
    /** Level entries naming an option the section does not have (or a section there is not): skipped. */
    ignored: Array<{ level: AspectLevel; section: string; option: string }>;
}

/**
 * Resolves every section over the levels: the lowest level with an entry for
 * the section decides — `remove` sends nothing, an option sends it. An entry
 * naming an option the section lacks is skipped (listed in `ignored`), so the
 * level above it decides. With no entry, the section's default; without one,
 * nothing.
 */
export function resolveAspects(sections: readonly AspectSection[], choices: AspectLevelChoices = {}): AspectResolution {
    const ignored: AspectResolution['ignored'] = [];
    const known = new Set(sections.map((s) => s.id));
    for (const level of ASPECT_LEVELS) {
        if (level === 'sectionDefault') { continue; }
        for (const [section, option] of Object.entries(choices[level] ?? {})) {
            if (!known.has(section)) { ignored.push({ level, section, option }); }
        }
    }
    const resolved = sections.map((s): ResolvedAspect => {
        for (let i = ASPECT_LEVELS.length - 1; i > 0; i--) {
            const level = ASPECT_LEVELS[i] as Exclude<AspectLevel, 'sectionDefault'>;
            const entry = choices[level]?.[s.id];
            if (entry === undefined) { continue; }
            if (entry === ASPECT_REMOVE) { return { section: s.id, removed: true, from: level }; }
            if (s.options.some((o) => o.name === entry)) { return { section: s.id, option: entry, removed: false, from: level }; }
            ignored.push({ level, section: s.id, option: entry });
        }
        return s.defaultOption
            ? { section: s.id, option: s.defaultOption, removed: false, from: 'sectionDefault' }
            : { section: s.id, removed: false };
    });
    return { sections: resolved, ignored };
}

/** One section's text as it is sent. */
export interface AssembledAspect {
    section: string;
    name: string;
    option: string;
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
        if (!r.option || !r.from) { continue; }
        const s = sections.find((x) => x.id === r.section);
        const o = s?.options.find((x) => x.name === r.option);
        if (!s || !o) { continue; }
        const text = resolve(o.text);
        if (!text.trim()) { continue; }
        out.push({ section: s.id, name: s.name, option: o.name, placement: s.placement, from: r.from, text });
    }
    return {
        system: renderPart(out.filter((p) => p.placement === 'system')),
        user: renderPart(out.filter((p) => p.placement === 'user')),
        sections: out,
    };
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
