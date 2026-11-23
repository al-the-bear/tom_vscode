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
import {
    ASPECT_REMOVE,
    buildAspectSection,
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
    text: string;
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
    /** What is wrong with the folder as it is on disk. */
    problems: string[];
}

function sectionFolder(dir: string, id: string): string {
    if (!isAspectName(id) || id === '.' || id === '..' || id.includes('\\')) { throw new Error(`"${id}" is not an aspect name.`); }
    return path.join(dir, id);
}

/** The option files of a section folder: name → text. */
function optionFiles(folder: string): Record<string, string> {
    const files: Record<string, string> = {};
    let names: string[] = [];
    try { names = fs.readdirSync(folder); } catch { return files; }
    for (const f of names) {
        if (!f.endsWith('.md') || f.startsWith('.')) { continue; }
        try { files[f.slice(0, -3)] = fs.readFileSync(path.join(folder, f), 'utf8'); } catch { /* gone meanwhile */ }
    }
    return files;
}

/** Every section folder of `dir`, by folder name, as the page edits it. */
export function readSectionsForEdit(dir: string | undefined): AspectSectionEdit[] {
    if (!dir) { return []; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
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
        const files = optionFiles(folder);
        const built = buildAspectSection(e.name, yaml, files);
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
                options: s.options.map((o) => ({ name: o.name, text: o.text })),
                problems: [...new Set(problems)],
            });
        } else {
            // Not a usable aspect: shown as far as it reads, to be repaired by a save.
            const order = Array.isArray(raw.choices) ? raw.choices.filter((o): o is string => typeof o === 'string' && o in files) : [];
            for (const n of Object.keys(files).sort()) { if (!order.includes(n)) { order.push(n); } }
            out.push({
                id: e.name,
                name: typeof raw.name === 'string' ? raw.name : '',
                label: typeof raw.label === 'string' ? raw.label : '',
                placement: raw.placement === 'user' ? 'user' : 'system',
                defaultOption: typeof raw.default === 'string' && order.includes(raw.default) ? raw.default : '',
                options: order.map((name) => ({ name, text: files[name] })),
                problems: [...new Set(problems)],
            });
        }
    }
    return out;
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
        if (seen.has(o.name)) { return `The choice "${o.name}" is there twice.`; }
        seen.add(o.name);
    }
    if (section.defaultOption && !seen.has(section.defaultOption)) { return `The default "${section.defaultOption}" is no choice of the aspect.`; }
    return undefined;
}

/** The text of `aspect.yaml` for `section`, with the schema line when `topTom` is known. */
export function sectionYamlText(section: Omit<AspectSectionEdit, 'problems'>, schemaRef?: string): string {
    const doc: Record<string, unknown> = { name: section.name.trim() };
    if (section.label && section.label.trim()) { doc.label = section.label.trim(); }
    doc.placement = section.placement;
    if (section.defaultOption) { doc.default = section.defaultOption; }
    if (section.options.length) { doc.choices = section.options.map((o) => o.name); }
    return (schemaRef ? `# yaml-language-server: $schema=${schemaRef}\n` : '') + stringifyYaml(doc);
}

/**
 * Write `section` as a whole into its folder of `dir` (which must exist):
 * `aspect.yaml`, each choice's `<name>.md`, and the choice files no longer
 * listed deleted (a leftover `section.yaml` too). Throws with the reason when
 * it cannot be saved.
 */
export function saveAspectSection(dir: string, section: Omit<AspectSectionEdit, 'problems'>, topTom?: string): void {
    const folder = sectionFolder(dir, section.id);
    if (!fs.existsSync(folder)) { throw new Error(`The aspect ${section.id} does not exist (any more).`); }
    const refusal = aspectSectionRefusal(section);
    if (refusal) { throw new Error(refusal); }
    const file = path.join(folder, ASPECT_FILE);
    const keep = new Set(section.options.map((o) => `${o.name}.md`));
    for (const o of section.options) {
        const target = path.join(folder, `${o.name}.md`);
        const text = o.text ?? '';
        let before: string | undefined;
        try { before = fs.readFileSync(target, 'utf8'); } catch { /* new */ }
        if (before !== text) { fs.writeFileSync(target, text, 'utf8'); }
    }
    for (const f of fs.readdirSync(folder)) {
        if (f.endsWith('.md') && !f.startsWith('.') && !keep.has(f)) { fs.unlinkSync(path.join(folder, f)); }
    }
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

/** The folder `from` of `dir` renamed to `to` (its id: choices naming `from` no longer apply). */
export function renameAspectSection(dir: string, from: string, to: string, topTom?: string): void {
    const source = sectionFolder(dir, from);
    const target = sectionFolder(dir, to);
    if (!fs.existsSync(source)) { throw new Error(`The aspect ${from} does not exist (any more).`); }
    if (fs.existsSync(target)) { throw new Error(`An aspect ${to} exists already.`); }
    fs.renameSync(source, target);
    // The schema line is relative to the folder: the same depth, written again only to stay exact.
    const file = path.join(target, ASPECT_FILE);
    if (topTom && fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const line = `# yaml-language-server: $schema=${schemaRefFromFile(file, topTom, ASPECT_SECTION_SCHEMA_REL)}`;
        const next = /^# yaml-language-server: \$schema=.*$/m.test(text) ? text.replace(/^# yaml-language-server: \$schema=.*$/m, line) : `${line}\n${text}`;
        if (next !== text) { fs.writeFileSync(file, next, 'utf8'); }
    }
}

/** The aspect folder `id` of `dir` deleted with its choices. */
export function deleteAspectSection(dir: string, id: string): void {
    // sectionFolder refuses "/", "\", "." and "..": the folder is always a direct child of dir.
    const folder = sectionFolder(dir, id);
    if (!fs.existsSync(folder)) { return; }
    fs.rmSync(folder, { recursive: true, force: true });
}
