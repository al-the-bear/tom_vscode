/**
 * Editing the aspect guideline store, `_ai/aspect_guidelines/<aspect>/`
 * (gsel7, gsel16; design role_and_guideline_selector.vscode_extension.md
 * P-4): what the Aspect Guidelines editor page
 * (handlers/aspectSectionEditor-handler.ts) reads and writes. vscode-free.
 *
 * - {@link readSectionsForEdit}: every aspect folder as the page edits it —
 *   name, short label as written, placement, default choice and the choices in
 *   their order with their texts —, a folder that does not build an aspect
 *   included with its problems, so it can be repaired.
 * - {@link saveAspectSection}: one aspect as a whole: `aspect.yaml` (with the
 *   schema line) and one `<choice>.md` per choice; a choice file no longer
 *   listed is deleted (a choice renamed is its old file deleted and the new
 *   one written).
 * - Choice files (gsel17, utils/aspectChoiceFiles.ts): a choice is **Own
 *   text** (`<choice>.md` in the aspect's folder) or a **Guideline file**
 *   (`_agent_guidelines/aspects/<aspect>/<choice>.md` of one of the window's
 *   guideline layers). The page gets each choice's own text and its copies in
 *   the layers; a save writes a Guideline file choice's text into the file of
 *   the layer it names (`fileBase`: the file it edits in place, or the window
 *   workspace folder's layer for its own copy), drops the own text of a choice
 *   switched to Guideline file, and deletes the file a Guideline file choice
 *   removed or renamed in the draft had. Switching to Own text keeps the file.
 * - {@link createAspectSection}, {@link renameAspectSection},
 *   {@link deleteAspectSection}: the aspect folders.
 *
 * The rules are utils/aspectGuidelines.ts's (`isAspectName`, `remove` is no
 * choice name, a default names a choice) and the schema
 * `aspect-guideline.schema.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { schemaRefFromFile } from '../utils/generatedSchemas';
import { layerLabel, type AspectFileLayer } from '../utils/aspectChoiceFiles';
import { orphanGuidelineAspects, readAspectChoiceTexts } from './aspectGuidelinesStore';
import {
    ASPECT_REMOVE,
    buildAspectSection,
    conditionProblem,
    isAspectName,
    type AspectPlacement,
    type AspectSectionYaml,
    ASPECT_FILE,
    LEGACY_ASPECT_FILE,
} from '../utils/aspectGuidelines';

/** The schema of `aspect.yaml` below the top `.tom`. */
export const ASPECT_SECTION_SCHEMA_REL = 'json-schema/aspect-guidelines/aspect-guideline.schema.json';

/** One option as the page edits it. */
export interface AspectOptionEdit {
    name: string;
    /** The text in the choice's mode: its own text, or the guideline file's of `fileBase`. */
    text: string;
    /** Own text (the default) or a guideline file (gsel17). */
    mode?: 'own' | 'file';
    /** A guideline file choice: the layer (its `base`) whose file it edits and writes. */
    fileBase?: string;
    /** As read: the own text, when the choice has one. */
    ownText?: string;
    /** As read: the choice's guideline files, nearest layer first. */
    files?: Array<{ base: string; text: string }>;
    /** Its condition (gsel20): sent only while it holds; '' or unset: always. */
    when?: string;
}

/** A guideline layer as the page shows it. */
export interface AspectLayerEdit {
    base: string;
    level: 'root' | 'workspace';
    folder: string;
    /** The window's own workspace folder's layer. */
    own: boolean;
    /** `the root's`, `workspace <folder>`. */
    label: string;
}

/** The layers as the page shows them. */
export function layersForEdit(layers: readonly AspectFileLayer[]): AspectLayerEdit[] {
    return layers.map((l) => ({ base: l.base, level: l.level, folder: l.folder, own: l.own, label: layerLabel(l) }));
}

/** One section as the page edits it. */
export interface AspectSectionEdit {
    /** The folder name: the id every level's choices name. */
    id: string;
    name: string;
    /** The short label as written; '' when the file has none (the name is shown). */
    label: string;
    placement: AspectPlacement;
    /** The default option; '' for none. */
    defaultOption: string;
    options: AspectOptionEdit[];
    /** While it holds, the aspect sends nothing (gsel20); '' or unset: never. */
    removeWhen?: string;
    /** What is wrong with the folder as it is on disk. */
    problems: string[];
}

function sectionFolder(dir: string, id: string): string {
    if (!isAspectName(id) || id === '.' || id === '..' || id.includes('\\')) { throw new Error(`"${id}" is not an aspect name.`); }
    return path.join(dir, id);
}

/** A choice as the page edits it, from the texts read (own text and guideline files). */
function optionForEdit(name: string, read: ReturnType<typeof readAspectChoiceTexts>, when?: string): AspectOptionEdit {
    const files = [...read.layerFiles].reverse().filter((l) => name in l.files).map((l) => ({ base: l.layer.base, text: l.files[name] }));
    const own = name in read.own;
    return {
        name,
        text: own ? read.own[name] : (files[0]?.text ?? ''),
        mode: own ? 'own' : 'file',
        ...(files.length ? { fileBase: files[0].base, files } : {}),
        ...(own ? { ownText: read.own[name] } : {}),
        ...(when !== undefined ? { when } : {}),
    };
}

/** The conditions `choices:` gives (`{name, when}` entries), by choice name. */
function conditionsOf(raw: AspectSectionYaml): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of Array.isArray(raw.choices) ? raw.choices : []) {
        if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string' && typeof (e as { when?: unknown }).when === 'string') {
            out[(e as { name: string }).name] = (e as { when: string }).when;
        }
    }
    return out;
}

/**
 * Every aspect folder of `dir`, by folder name, as the page edits it; with
 * `layers`, each choice's guideline files too, and the aspect folders of the
 * layers that `dir` does not define (with their problem, repaired by a save).
 */
export function readSectionsForEdit(dir: string | undefined, layers: readonly AspectFileLayer[] = []): AspectSectionEdit[] {
    if (!dir) { return []; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    const out: AspectSectionEdit[] = [];
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        const folder = path.join(dir, e.name);
        const problems: string[] = [];
        let yaml: AspectSectionYaml | undefined;
        const file = path.join(folder, ASPECT_FILE);
        if (fs.existsSync(file)) {
            try { yaml = parseYaml(fs.readFileSync(file, 'utf8')) as AspectSectionYaml; } catch (err) {
                problems.push(`${ASPECT_FILE} does not read: ${(err as Error).message}`);
            }
        } else if (fs.existsSync(path.join(folder, LEGACY_ASPECT_FILE))) {
            problems.push(`it has ${LEGACY_ASPECT_FILE}, the definition file before format version 10: Upgrade the workspace renames it to ${ASPECT_FILE}`);
        } else {
            problems.push(`no ${ASPECT_FILE}`);
        }
        const read = readAspectChoiceTexts(dir, e.name, layers);
        const built = buildAspectSection(e.name, yaml, read.texts, read.sources);
        problems.push(...built.problems.map((p) => p.replace(new RegExp(`^${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), '')));
        const raw = (yaml && typeof yaml === 'object' ? yaml : {}) as AspectSectionYaml;
        if (built.section) {
            const s = built.section;
            out.push({
                id: e.name,
                name: s.name,
                label: typeof raw.label === 'string' ? raw.label : '',
                placement: s.placement,
                defaultOption: s.defaultOption ?? '',
                options: s.options.map((o) => optionForEdit(o.name, read, o.when)),
                ...(s.removeWhen !== undefined ? { removeWhen: s.removeWhen } : {}),
                problems: [...new Set(problems)],
            });
        } else {
            // Not a usable aspect: shown as far as it reads, to be repaired by a save.
            out.push(unusableForEdit(e.name, raw, read, problems));
        }
    }
    for (const o of orphanGuidelineAspects(dir, layers)) {
        const read = readAspectChoiceTexts(dir, o.id, layers);
        out.push(unusableForEdit(o.id, {}, read, [`no ${ASPECT_FILE} in _ai/aspect_guidelines/${o.id}/: only guideline files; Save creates it`]));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

function unusableForEdit(id: string, raw: AspectSectionYaml, read: ReturnType<typeof readAspectChoiceTexts>, problems: string[]): AspectSectionEdit {
    const named = (Array.isArray(raw.choices) ? raw.choices : []).map((o) => (o && typeof o === 'object' ? (o as { name?: unknown }).name : o));
    const order = named.filter((o): o is string => typeof o === 'string' && o in read.texts);
    const when = conditionsOf(raw);
    for (const n of Object.keys(read.texts).sort()) { if (!order.includes(n)) { order.push(n); } }
    return {
        id,
        name: typeof raw.name === 'string' ? raw.name : '',
        label: typeof raw.label === 'string' ? raw.label : '',
        placement: raw.placement === 'user' ? 'user' : 'system',
        defaultOption: typeof raw.default === 'string' && order.includes(raw.default) ? raw.default : '',
        options: order.map((name) => optionForEdit(name, read, when[name])),
        ...(typeof raw.remove_when === 'string' ? { removeWhen: raw.remove_when } : {}),
        problems: [...new Set(problems)],
    };
}

/** Why `section` cannot be saved; undefined when it can. */
export function aspectSectionRefusal(section: Omit<AspectSectionEdit, 'problems'>): string | undefined {
    if (!section.name || !section.name.trim()) { return 'The aspect needs a name.'; }
    if (section.placement !== 'system' && section.placement !== 'user') { return 'The placement is the system prompt or the user prompt.'; }
    const seen = new Set<string>();
    for (const o of section.options) {
        if (!isAspectName(o.name) || o.name.includes('\\') || o.name === '.' || o.name === '..') {
            return `"${o.name}" is not a choice short name: not empty, no "/", no line break, no space at either end.`;
        }
        if (o.name === ASPECT_REMOVE) { return `A choice may not be named "${ASPECT_REMOVE}": it is the levels' Remove.`; }
        if (o.name.startsWith('+')) { return `A choice name may not start with "+": it marks a choice added to the levels below.`; }
        const bad = o.when?.trim() ? conditionProblem(o.when) : undefined;
        if (bad) { return `The condition of "${o.name}" is no valid expression: ${bad}.`; }
        if (seen.has(o.name)) { return `The choice "${o.name}" is there twice.`; }
        seen.add(o.name);
    }
    if (section.defaultOption && !seen.has(section.defaultOption)) { return `The default "${section.defaultOption}" is no choice of the aspect.`; }
    const badRemove = section.removeWhen?.trim() ? conditionProblem(section.removeWhen) : undefined;
    if (badRemove) { return `Remove when is no valid expression: ${badRemove}.`; }
    return undefined;
}

/** The text of `aspect.yaml` for `section`, with the schema line when `topTom` is known. */
export function sectionYamlText(section: Omit<AspectSectionEdit, 'problems'>, schemaRef?: string): string {
    const doc: Record<string, unknown> = { name: section.name.trim() };
    if (section.label && section.label.trim()) { doc.label = section.label.trim(); }
    doc.placement = section.placement;
    if (section.defaultOption) { doc.default = section.defaultOption; }
    if (section.options.length) { doc.choices = section.options.map((o) => (o.when?.trim() ? { name: o.name, when: o.when.trim() } : o.name)); }
    if (section.removeWhen?.trim()) { doc.remove_when = section.removeWhen.trim(); }
    return (schemaRef ? `# yaml-language-server: $schema=${schemaRef}\n` : '') + stringifyYaml(doc);
}

/**
 * Write `section` as a whole into its folder of `dir`: `aspect.yaml`, each Own
 * text choice's `<name>.md`, each Guideline file choice's text into the file of
 * its layer (`fileBase`, one of `layers`; unset: the file it has, else the
 * root's layer), the own texts no longer listed as own deleted (a leftover
 * `section.yaml` too), and the guideline file of a Guideline file choice no
 * longer listed deleted. The folder must exist, or the aspect be one the
 * layers' files make (it is created). Throws with the reason when it cannot be
 * saved.
 */
export function saveAspectSection(dir: string, section: Omit<AspectSectionEdit, 'problems'>, topTom?: string, layers: readonly AspectFileLayer[] = []): void {
    const folder = sectionFolder(dir, section.id);
    if (!fs.existsSync(folder)) {
        if (!layers.some((l) => fs.existsSync(path.join(l.base, section.id)))) { throw new Error(`The aspect ${section.id} does not exist (any more).`); }
        fs.mkdirSync(folder, { recursive: true });
    }
    const refusal = aspectSectionRefusal(section);
    if (refusal) { throw new Error(refusal); }
    const prior = readAspectChoiceTexts(dir, section.id, layers);
    const writes: Array<{ target: string; text: string }> = [];
    for (const o of section.options) {
        if (o.mode !== 'file') { writes.push({ target: path.join(folder, `${o.name}.md`), text: o.text ?? '' }); continue; }
        const priorBase = prior.sources[o.name]?.kind === 'file' ? prior.sources[o.name].base : undefined;
        const base = o.fileBase ?? priorBase ?? layers[0]?.base;
        if (!base) { throw new Error(`The choice "${o.name}" is a guideline file, but this window has no guideline folder.`); }
        if (!layers.some((l) => l.base === base)) { throw new Error(`The choice "${o.name}": ${base} is no guideline folder of this window.`); }
        writes.push({ target: path.join(base, section.id, `${o.name}.md`), text: o.text ?? '' });
    }
    for (const w of writes) {
        let before: string | undefined;
        try { before = fs.readFileSync(w.target, 'utf8'); } catch { /* new */ }
        if (before !== w.text) {
            fs.mkdirSync(path.dirname(w.target), { recursive: true });
            fs.writeFileSync(w.target, w.text, 'utf8');
        }
    }
    const keep = new Set(section.options.filter((o) => o.mode !== 'file').map((o) => `${o.name}.md`));
    for (const f of fs.readdirSync(folder)) {
        if (f.endsWith('.md') && !f.startsWith('.') && !keep.has(f)) { fs.unlinkSync(path.join(folder, f)); }
    }
    // A Guideline file choice removed or renamed in the draft: the file it had goes.
    const names = new Set(section.options.map((o) => o.name));
    for (const [name, source] of Object.entries(prior.sources)) {
        if (source.kind === 'file' && !names.has(name) && fs.existsSync(source.path)) { fs.unlinkSync(source.path); }
    }
    const file = path.join(folder, ASPECT_FILE);
    fs.writeFileSync(file, sectionYamlText(section, topTom ? schemaRefFromFile(file, topTom, ASPECT_SECTION_SCHEMA_REL) : undefined), 'utf8');
    // The definition is aspect.yaml only: an older section.yaml beside it would be read by an older build only.
    const legacy = path.join(folder, LEGACY_ASPECT_FILE);
    if (fs.existsSync(legacy)) { fs.unlinkSync(legacy); }
}

/** A new aspect folder `id` of `dir` named `name`, without choices. */
export function createAspectSection(dir: string, id: string, name: string, topTom?: string): void {
    const folder = sectionFolder(dir, id);
    if (fs.existsSync(folder)) { throw new Error(`An aspect ${id} exists already.`); }
    fs.mkdirSync(folder, { recursive: true });
    saveAspectSection(dir, { id, name: name.trim() || id, label: '', placement: 'system', defaultOption: '', options: [] }, topTom);
}

/**
 * The folder `from` of `dir` renamed to `to` (its id: choices naming `from` no
 * longer apply), and the aspect's folder in every guideline layer with it.
 */
export function renameAspectSection(dir: string, from: string, to: string, topTom?: string, layers: readonly AspectFileLayer[] = []): void {
    const source = sectionFolder(dir, from);
    const target = sectionFolder(dir, to);
    if (!fs.existsSync(source)) { throw new Error(`The aspect ${from} does not exist (any more).`); }
    if (fs.existsSync(target)) { throw new Error(`An aspect ${to} exists already.`); }
    const moves = layers.map((l) => ({ from: path.join(l.base, from), to: path.join(l.base, to) })).filter((m) => fs.existsSync(m.from));
    const taken = moves.find((m) => fs.existsSync(m.to));
    if (taken) { throw new Error(`Guideline files of an aspect ${to} exist already: ${taken.to}.`); }
    fs.renameSync(source, target);
    for (const m of moves) { fs.renameSync(m.from, m.to); }
    // The schema line is relative to the folder: the same depth, written again only to stay exact.
    const file = path.join(target, ASPECT_FILE);
    if (topTom && fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const line = `# yaml-language-server: $schema=${schemaRefFromFile(file, topTom, ASPECT_SECTION_SCHEMA_REL)}`;
        const next = /^# yaml-language-server: \$schema=.*$/m.test(text) ? text.replace(/^# yaml-language-server: \$schema=.*$/m, line) : `${line}\n${text}`;
        if (next !== text) { fs.writeFileSync(file, next, 'utf8'); }
    }
}

/** The aspect folder `id` of `dir` deleted with its own texts; guideline files stay (they are listed as such then). */
export function deleteAspectSection(dir: string, id: string): void {
    // sectionFolder refuses "/", "\", "." and "..": the folder is always a direct child of dir.
    const folder = sectionFolder(dir, id);
    if (!fs.existsSync(folder)) { return; }
    fs.rmSync(folder, { recursive: true, force: true });
}
