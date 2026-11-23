/**
 * The **workspace** level of the aspect guidelines (gsel19; guideline_sectioning.md
 * D-14, D-19, D-27): between the aspect's default and the quest default.
 *
 * - **Its files**, in the Tom root and optionally in each workspace folder
 *   down to the window's: `workspace_aspects.md`, whose lines that hold only
 *   `@<path>` (relative to the file; outside fenced code) each name one choice
 *   file — `@_agent_guidelines/aspects/<aspect>/<choice>.md` or
 *   `@_ai/aspect_guidelines/<aspect>/<choice>.md` —, every other line free
 *   text; and `workspace_aspects.yaml` beside it, `remove: [<aspect> …]` (schema
 *   `workspace-aspects.schema.json`, generated into `.tom/json-schema/aspect-guidelines/`).
 * - **The order**: the root's folder first, then each workspace folder on the
 *   way to the window's, a nearer folder's entry replacing a farther one's per
 *   aspect — unless the nearer folder adds (`add: [<aspect> …]` in its yaml):
 *   then its choices join the farther ones'. Several `@` lines of one aspect
 *   are several choices (gsel20). In one folder a `remove` wins over a choice
 *   of the same aspect (reported).
 * - **Problems**: a path that names no file, or a file that is no choice file,
 *   chooses nothing and is reported (the Aspect Guidelines editor, the Status
 *   Page, tomAi_getAspectGuidelines).
 * - **Writing**: {@link writeWorkspaceAspects} writes the window workspace
 *   folder's two files from a set of choices (the window's: *Set as workspace
 *   default*), keeping the free text and the yaml's other keys;
 *   {@link clearWorkspaceAspects} empties them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { ASPECT_REMOVE, combineAspectEntries, formatAspectValue, isAspectName, parseAspectValue, type AspectChoiceValue, type AspectSection } from '../utils/aspectGuidelines';
import type { AspectChoices } from '../utils/aspectChoices';
import { aspectFileLayers, layerFolder } from '../utils/aspectChoiceFiles';
import { FENCE, IMPORT_LINE } from '../utils/lineImports';
import { schemaRefFromFile } from '../utils/generatedSchemas';

export const WORKSPACE_ASPECTS_MD = 'workspace_aspects.md';
export const WORKSPACE_ASPECTS_YAML = 'workspace_aspects.yaml';
/** The schema of `workspace_aspects.yaml` below the top `.tom`. */
export const WORKSPACE_ASPECTS_SCHEMA_REL = 'json-schema/aspect-guidelines/workspace-aspects.schema.json';

/** One folder's workspace files as read. */
export interface WorkspaceAspectsFolder {
    /** The folder, absolute. */
    folder: string;
    /** Relative to the Tom root, `/`-separated; `.` for the root. */
    rel: string;
    /** The files that exist (absolute). */
    md?: string;
    yaml?: string;
    /** Its entries: aspect → choice or `remove`. */
    choices: AspectChoices;
    /** Where each entry is: `<file>:<line>` as shown. */
    sources: Record<string, string>;
    problems: string[];
}

/** The workspace level: every folder's files and the merged entries. */
export interface WorkspaceAspectsLevel {
    folders: WorkspaceAspectsFolder[];
    /** aspect → choice or `remove`, the nearer folder winning. */
    choices: AspectChoices;
    /** Where each merged entry comes from (`<file>:<line>` as shown). */
    sources: Record<string, string>;
    problems: string[];
}

const shown = (rel: string, file: string): string => (rel === '.' ? file : `${rel}/${file}`);
const toPosix = (p: string): string => p.split(path.sep).join('/');

function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** The aspect and choice a choice file names: `…/_agent_guidelines/aspects/<a>/<c>.md` or `…/_ai/aspect_guidelines/<a>/<c>.md`. */
export function choiceOfFile(file: string): { aspect: string; choice: string } | undefined {
    const seg = toPosix(file).split('/');
    const n = seg.length;
    if (n < 4 || !seg[n - 1].endsWith('.md')) { return undefined; }
    const kind = `${seg[n - 4]}/${seg[n - 3]}`;
    if (kind !== '_agent_guidelines/aspects' && kind !== '_ai/aspect_guidelines') { return undefined; }
    const aspect = seg[n - 2];
    const choice = seg[n - 1].slice(0, -3);
    return isAspectName(aspect) && isAspectName(choice) && choice !== ASPECT_REMOVE ? { aspect, choice } : undefined;
}

/** The `@<path>` lines of a `workspace_aspects.md` (outside fenced code), with their line numbers (1-based). */
export function importLinesOf(text: string): Array<{ line: number; path: string }> {
    const out: Array<{ line: number; path: string }> = [];
    let fenced = false;
    text.split('\n').forEach((line, i) => {
        if (FENCE.test(line)) { fenced = !fenced; return; }
        const m = fenced ? null : IMPORT_LINE.exec(line);
        if (m) { out.push({ line: i + 1, path: m[1] }); }
    });
    return out;
}

/** One folder's `workspace_aspects.md` and `.yaml`. */
export function readWorkspaceAspectsFolder(folder: string, rel: string): WorkspaceAspectsFolder {
    const out: WorkspaceAspectsFolder = { folder, rel, choices: {}, sources: {}, problems: [] };
    const picked: Record<string, string[]> = {};
    const md = path.join(folder, WORKSPACE_ASPECTS_MD);
    const yaml = path.join(folder, WORKSPACE_ASPECTS_YAML);
    if (isFile(md)) {
        out.md = md;
        const name = shown(rel, WORKSPACE_ASPECTS_MD);
        for (const entry of importLinesOf(fs.readFileSync(md, 'utf8'))) {
            const where = `${name}:${entry.line}`;
            const target = path.isAbsolute(entry.path) ? entry.path : path.resolve(folder, entry.path);
            if (!isFile(target)) { out.problems.push(`${where}: @${entry.path} names no file; it chooses nothing`); continue; }
            const named = choiceOfFile(target);
            if (!named) { out.problems.push(`${where}: @${entry.path} is no choice file (_agent_guidelines/aspects/<aspect>/<choice>.md or _ai/aspect_guidelines/<aspect>/<choice>.md); it chooses nothing`); continue; }
            // Several lines of one aspect: several choices (gsel20).
            const list = (picked[named.aspect] ??= []);
            if (!list.includes(named.choice)) { list.push(named.choice); }
            out.sources[named.aspect] = out.sources[named.aspect] ? `${out.sources[named.aspect]}, ${entry.line}` : where;
        }
    }
    let adds: string[] = [];
    if (isFile(yaml)) {
        out.yaml = yaml;
        const name = shown(rel, WORKSPACE_ASPECTS_YAML);
        const doc = parseDocument(fs.readFileSync(yaml, 'utf8'));
        if (doc.errors.length) {
            out.problems.push(`${name}: does not read: ${doc.errors[0].message}`);
        } else {
            const add = (doc.toJS() as { add?: unknown } | null)?.add;
            if (add !== undefined && add !== null) {
                if (!Array.isArray(add)) { out.problems.push(`${name}: add must be a list of aspect names`); }
                else {
                    adds = add.filter((a): a is string => typeof a === 'string' && isAspectName(a));
                    for (const a of add) { if (!adds.includes(a as string)) { out.problems.push(`${name}: add: "${String(a)}" is no aspect name`); } }
                    for (const a of adds) { if (!picked[a]) { out.problems.push(`${name}: add: ${a} has no choice in ${shown(rel, WORKSPACE_ASPECTS_MD)}; nothing is added`); } }
                }
            }
            const remove = (doc.toJS() as { remove?: unknown } | null)?.remove;
            if (remove !== undefined && remove !== null) {
                if (!Array.isArray(remove)) {
                    out.problems.push(`${name}: remove must be a list of aspect names`);
                } else {
                    for (const aspect of remove) {
                        if (typeof aspect !== 'string' || !isAspectName(aspect)) { out.problems.push(`${name}: remove: "${String(aspect)}" is no aspect name`); continue; }
                        if (picked[aspect]) {
                            out.problems.push(`${name}: ${aspect} is removed and chosen (${out.sources[aspect]}); remove wins`);
                            delete picked[aspect];
                        }
                        out.choices[aspect] = ASPECT_REMOVE;
                        out.sources[aspect] = `${name} remove`;
                    }
                }
            }
        }
    }
    for (const [aspect, choices] of Object.entries(picked)) {
        out.choices[aspect] = formatAspectValue({ kind: adds.includes(aspect) ? 'add' : 'replace', choices });
    }
    return out;
}

/** The workspace level over `folders` (the root's first, the window's last): a nearer folder's entry wins per aspect. */
export function readWorkspaceAspects(folders: ReadonlyArray<{ folder: string; rel: string }>): WorkspaceAspectsLevel {
    const level: WorkspaceAspectsLevel = { folders: [], choices: {}, sources: {}, problems: [] };
    for (const f of folders) {
        const read = readWorkspaceAspectsFolder(f.folder, f.rel);
        level.folders.push(read);
        for (const [aspect, value] of Object.entries(read.choices)) {
            const upper = parseAspectValue(value);
            if (!upper) { continue; }
            const lower = level.choices[aspect] !== undefined ? parseAspectValue(level.choices[aspect]) : undefined;
            const merged = combineAspectEntries(lower, upper);
            level.choices[aspect] = formatAspectValue(merged);
            level.sources[aspect] = upper.kind === 'add' && lower ? `${level.sources[aspect]}; ${read.sources[aspect]}` : read.sources[aspect];
        }
        level.problems.push(...read.problems);
    }
    return level;
}

/** The window's folders of the workspace level: the Tom root, the workspace folders down to the window's. */
export function workspaceAspectFolders(root: string, workspaceFolder: string, isWorkspaceFolder: (dir: string) => boolean): Array<{ folder: string; rel: string }> {
    return aspectFileLayers(root, workspaceFolder, isWorkspaceFolder).map((l) => ({ folder: layerFolder(l), rel: l.folder }));
}

const DEFAULT_MD_HEAD = [
    '# Workspace aspects',
    '',
    'The aspect guideline choices of this workspace (the workspace level, between each aspect\'s default and the quest default).',
    'Each line that holds only `@<path>` names one choice file; the Prompt Queue editor\'s workspace buttons write these lines.',
    'An aspect this workspace sends nothing for is listed under `remove:` in workspace_aspects.yaml.',
].join('\n');

/** `text` without its `@<path>` lines (outside fenced code), trailing blank lines dropped. */
function freeTextOf(text: string): string {
    const drop = new Set(importLinesOf(text).map((e) => e.line));
    return text.split('\n').filter((_, i) => !drop.has(i + 1)).join('\n').replace(/\s+$/, '');
}

/**
 * The `@<path>` a choice is written with from `folder`: an own text as
 * `_ai/aspect_guidelines/<aspect>/<choice>.md` when the folder's `_ai` reaches
 * the same file (it is a link onto the one `_ai` clone), else the file
 * relative to the folder, `/`-separated.
 */
export function choiceLinePath(folder: string, file: string): string {
    const named = choiceOfFile(file);
    if (named && toPosix(file).includes('/_ai/aspect_guidelines/')) {
        const viaFolder = path.join(folder, '_ai', 'aspect_guidelines', named.aspect, `${named.choice}.md`);
        try {
            if (fs.realpathSync(viaFolder) === fs.realpathSync(file)) { return `_ai/aspect_guidelines/${named.aspect}/${named.choice}.md`; }
        } catch { /* not reachable that way */ }
    }
    return toPosix(path.relative(folder, file));
}

/**
 * Write `folder`'s workspace files from `entries` (aspect → the choice's file,
 * or `remove`): the `@<path>` lines of `workspace_aspects.md` (its free text
 * kept; a new file gets a short head) and `remove:` of `workspace_aspects.yaml`
 * (its other keys kept, the schema line written; no file when nothing is
 * left). Answers the files written.
 */
export function writeWorkspaceAspects(folder: string, entries: Record<string, WorkspaceAspectEntry>, topTom?: string): { md: string; yaml?: string } {
    const md = path.join(folder, WORKSPACE_ASPECTS_MD);
    const yaml = path.join(folder, WORKSPACE_ASPECTS_YAML);
    const aspects = Object.keys(entries).sort();
    const filesOf = (e: WorkspaceAspectEntry): string[] => (e === 'remove' ? [] : 'files' in e ? e.files : [e.file]);
    const lines = aspects.flatMap((a) => filesOf(entries[a]).map((f) => `@${choiceLinePath(folder, f)}`));
    const adds = aspects.filter((a) => entries[a] !== 'remove' && (entries[a] as { add?: boolean }).add);
    const head = isFile(md) ? freeTextOf(fs.readFileSync(md, 'utf8')) : DEFAULT_MD_HEAD;
    fs.writeFileSync(md, `${[head, lines.join('\n')].filter(Boolean).join('\n\n')}\n`, 'utf8');
    const removes = aspects.filter((a) => entries[a] === 'remove');
    return { md, ...(writeRemoveList(yaml, removes, topTom, adds) ? { yaml } : {}) };
}

/** One aspect's entry to write: its choice files (`add`: added to the levels below), or `remove`. */
export type WorkspaceAspectEntry = { file: string } | { files: string[]; add?: boolean } | 'remove';

/** `remove:` of a `workspace_aspects.yaml` set (none: the key dropped; the file deleted when nothing is left). Answers whether the file exists after. */
function writeRemoveList(yaml: string, removes: string[], topTom?: string, adds: string[] = []): boolean {
    const doc = isFile(yaml) ? parseDocument(fs.readFileSync(yaml, 'utf8')) : parseDocument('{}');
    if (doc.errors.length) { throw new Error(`${yaml} does not read: ${doc.errors[0].message}`); }
    if (removes.length) { doc.set('remove', removes); } else { doc.delete('remove'); }
    if (adds.length) { doc.set('add', adds); } else { doc.delete('add'); }
    const left = doc.toJS() as Record<string, unknown> | null;
    if (!left || !Object.keys(left).length) {
        if (isFile(yaml)) { fs.unlinkSync(yaml); }
        return false;
    }
    let text = doc.toString();
    if (topTom && !/^# yaml-language-server: \$schema=/m.test(text)) {
        text = `# yaml-language-server: $schema=${schemaRefFromFile(yaml, topTom, WORKSPACE_ASPECTS_SCHEMA_REL)}\n${text}`;
    }
    fs.writeFileSync(yaml, text, 'utf8');
    return true;
}

/** *Clear workspace default*: `folder`'s `workspace_aspects.md` keeps only its free text, `remove:` and `add:` go from the yaml. */
export function clearWorkspaceAspects(folder: string): void {
    const md = path.join(folder, WORKSPACE_ASPECTS_MD);
    if (isFile(md)) { fs.writeFileSync(md, `${freeTextOf(fs.readFileSync(md, 'utf8'))}\n`, 'utf8'); }
    writeRemoveList(path.join(folder, WORKSPACE_ASPECTS_YAML), []);
}

/**
 * The entries {@link writeWorkspaceAspects} writes for `choices` (a level's
 * aspect → choice or `remove`) over the aspects `sections`: each choice's
 * file (its own text or guideline file). A choice the aspects do not have is
 * left out and named in `skipped`.
 */
export function workspaceEntriesOf(choices: AspectChoices | undefined, sections: readonly AspectSection[]): { entries: Record<string, WorkspaceAspectEntry>; skipped: string[] } {
    const entries: Record<string, WorkspaceAspectEntry> = {};
    const skipped: string[] = [];
    for (const [aspect, value] of Object.entries(choices ?? {}) as Array<[string, AspectChoiceValue]>) {
        const entry = parseAspectValue(value);
        if (!entry) { skipped.push(`${aspect}: ${String(value)}`); continue; }
        if (entry.kind === 'remove') { entries[aspect] = 'remove'; continue; }
        const files: string[] = [];
        for (const choice of entry.choices) {
            const source = sections.find((s) => s.id === aspect)?.options.find((o) => o.name === choice)?.source;
            if (source) { files.push(source.path); } else { skipped.push(`${aspect}: ${choice}`); }
        }
        if (files.length) { entries[aspect] = { files, ...(entry.kind === 'add' ? { add: true } : {}) }; }
    }
    return { entries, skipped };
}

// ---------------------------------------------------------------- live

/* eslint-disable @typescript-eslint/no-require-imports */
/** The live window's folders of the workspace level (none without a layout). */
export function liveWorkspaceAspectFolders(): Array<{ folder: string; rel: string }> {
    const { getLayout } = require('../utils/workspaceLayout') as typeof import('../utils/workspaceLayout');
    const { isWorkspaceFolderDir } = require('../utils/workspaceRegistry') as typeof import('../utils/workspaceRegistry');
    const layout = getLayout();
    return layout ? workspaceAspectFolders(layout.root, layout.workspaceFolder, isWorkspaceFolderDir) : [];
}

/** The live workspace level. */
export function liveWorkspaceAspects(): WorkspaceAspectsLevel {
    return readWorkspaceAspects(liveWorkspaceAspectFolders());
}

/** *Set as workspace default*: the window's choices written into the window workspace folder's files. */
export function setWorkspaceFromWindow(): { folder: string; written: string[]; skipped: string[] } | undefined {
    const folders = liveWorkspaceAspectFolders();
    const own = folders[folders.length - 1];
    if (!own) { return undefined; }
    const { windowChoices } = require('./aspectChoiceLevels') as typeof import('./aspectChoiceLevels');
    const { readLiveAspectSections } = require('./aspectGuidelinesStore') as typeof import('./aspectGuidelinesStore');
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    const { entries, skipped } = workspaceEntriesOf(windowChoices(), readLiveAspectSections().sections);
    const written = writeWorkspaceAspects(own.folder, entries, WsPaths.topTom);
    return { folder: own.folder, written: [written.md, ...(written.yaml ? [written.yaml] : [])], skipped };
}

/** The window workspace folder's own entries of the workspace level (gsel22); null without a workspace folder. */
export function liveOwnWorkspaceChoices(): AspectChoices | null {
    const folders = liveWorkspaceAspectFolders();
    const own = folders[folders.length - 1];
    return own ? readWorkspaceAspectsFolder(own.folder, own.rel).choices : null;
}

/** The window workspace folder's files written with `choices` (gsel22: the workspace picker); its free text kept. */
export function setLiveOwnWorkspaceChoices(choices: AspectChoices | undefined): void {
    const folders = liveWorkspaceAspectFolders();
    const own = folders[folders.length - 1];
    if (!own) { throw new Error('this window has no Tom workspace folder'); }
    const { readLiveAspectSections } = require('./aspectGuidelinesStore') as typeof import('./aspectGuidelinesStore');
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    writeWorkspaceAspects(own.folder, workspaceEntriesOf(choices, readLiveAspectSections().sections).entries, WsPaths.topTom);
}

/** *Clear workspace default*: the window workspace folder's files emptied. */
export function clearLiveWorkspaceAspects(): string | undefined {
    const folders = liveWorkspaceAspectFolders();
    const own = folders[folders.length - 1];
    if (!own) { return undefined; }
    clearWorkspaceAspects(own.folder);
    return own.folder;
}
/* eslint-enable @typescript-eslint/no-require-imports */
