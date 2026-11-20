/**
 * The schemas of the files the extension writes, as generated copies in the
 * top `.tom` (workspace layout DP-part-extension-6 (a) / -7 (a), TD-17 (a)).
 *
 * The extension ships them (`out/config/`, `resources/schemas/`) and writes
 * each set into its folder of the top `.tom` — the root's in a root, a
 * standalone workspace folder's own otherwise:
 *
 * | Folder                    | Files                                           |
 * | ------------------------- | ----------------------------------------------- |
 * | `json-schema/panels/`     | the panel YAML schemas (queue, timed, chatvars, prompt, panels) |
 * | `json-schema/roles/`      | `role-config.schema.json`, `role-type.schema.json` |
 * | `json-schema/processes/`  | `process.schema.json`                           |
 * | `json-schema/extension/`  | `tom_vscode_extension.schema.json`              |
 * | `json-schema/aspect-guidelines/` | `aspect-guideline-section.schema.json` (`_ai/aspect_guidelines/<section>/section.yaml`) |
 *
 * Each folder written gets a `.generated-by` file (extension id, version,
 * build) telling a generated copy apart from a schema under development:
 * - a stamped folder is brought up to date when a file differs or the build
 *   changed — never by an older build than the one that stamped it;
 * - a folder that is missing (or empty) is written;
 * - an unstamped folder whose files are byte-identical to the shipped ones
 *   is adopted (stamped); one that differs is left alone and reported.
 *
 * A workspace folder's `.tom` that holds a stamped copy while a root exists
 * above it (a standalone folder moved into a root) is a stale copy: reported,
 * removed only after the user confirms.
 *
 * Every path is compared by its real path: a workspace folder's
 * `.tom/json-schema` may be a link onto the root's.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { realPathOf, samePath } from './pathCompare';

/** The stamp file of a generated folder. */
export const GENERATED_BY_FILE = '.generated-by';

/** One generated folder: where it goes below the top `.tom`, and its files' sources below the extension. */
export interface GeneratedSchemaSet {
    folder: string;
    files: Array<{ name: string; source: string }>;
}

const PANEL_SCHEMAS = ['chatvars', 'panels', 'prompt', 'queue', 'timed'];

/** The five sets (TD-17 (a), gsel2); sources relative to the extension folder. */
export const GENERATED_SCHEMA_SETS: readonly GeneratedSchemaSet[] = [
    { folder: 'json-schema/panels', files: PANEL_SCHEMAS.map((n) => ({ name: `${n}.schema.json`, source: `resources/schemas/panels/${n}.schema.json` })) },
    { folder: 'json-schema/roles', files: ['role-config', 'role-type'].map((n) => ({ name: `${n}.schema.json`, source: `out/config/${n}.schema.json` })) },
    { folder: 'json-schema/processes', files: [{ name: 'process.schema.json', source: 'out/config/process.schema.json' }] },
    { folder: 'json-schema/extension', files: [{ name: 'tom_vscode_extension.schema.json', source: 'out/config/tom_vscode_extension.schema.json' }] },
    { folder: 'json-schema/aspect-guidelines', files: [{ name: 'aspect-guideline-section.schema.json', source: 'out/config/aspect-guideline-section.schema.json' }] },
];

/** Who wrote a generated folder. */
export interface GeneratedByStamp {
    generatedBy: string;
    version: string;
    build?: { commit?: string; dirty?: boolean; builtAt?: string };
    files: string[];
}

export type SchemaSetOutcome = 'written' | 'updated' | 'adopted' | 'current' | 'differs' | 'unavailable';

export interface SchemaSetResult {
    folder: string;
    /** The folder's real path. */
    path: string;
    outcome: SchemaSetOutcome;
    /** With `differs`: the shipped files the unstamped folder holds differently (or lacks). */
    differing?: string[];
    /** With `unavailable`: why. */
    reason?: string;
}

function readText(file: string): string | undefined {
    try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** The stamp of the folder `dir`, or undefined when it has none (or it does not parse). */
export function readGeneratedBy(dir: string): GeneratedByStamp | undefined {
    const raw = readText(path.join(dir, GENERATED_BY_FILE));
    if (raw === undefined) { return undefined; }
    try { return JSON.parse(raw) as GeneratedByStamp; } catch { return { generatedBy: '?', version: '?', files: [] }; }
}

function stampText(stamp: Omit<GeneratedByStamp, 'files'>, files: string[]): string {
    return `${JSON.stringify({ ...stamp, files }, null, 2)}\n`;
}

/** Whether two stamps name the same writer, version and build. */
function sameBuild(a: GeneratedByStamp | undefined, b: Omit<GeneratedByStamp, 'files'>): boolean {
    return !!a && a.generatedBy === b.generatedBy && a.version === b.version
        && JSON.stringify(a.build ?? {}) === JSON.stringify(b.build ?? {});
}

/** Whether the stamp `a` was written by a build later than `b`'s. */
function isNewerBuild(a: GeneratedByStamp, b: Omit<GeneratedByStamp, 'files'>): boolean {
    const at = a.build?.builtAt;
    const bt = b.build?.builtAt;
    return !!at && !!bt && at > bt;
}

/**
 * Write the generated sets into the top `.tom` at `topTom` (see the module
 * comment for what is written, adopted or left alone). `stamp` names this
 * build. Never throws for one set: a set that cannot be written answers
 * `unavailable`.
 */
export function syncGeneratedSchemas(
    topTom: string,
    extensionPath: string,
    stamp: Omit<GeneratedByStamp, 'files'>,
    sets: readonly GeneratedSchemaSet[] = GENERATED_SCHEMA_SETS,
): SchemaSetResult[] {
    const results: SchemaSetResult[] = [];
    const tom = realPathOf(topTom);
    for (const set of sets) {
        const dir = path.join(tom, ...set.folder.split('/'));
        const real = realPathOf(dir);
        try {
            const shipped = set.files.map((f) => ({ name: f.name, text: readText(path.join(extensionPath, ...f.source.split('/'))) }));
            const missingSource = shipped.find((f) => f.text === undefined);
            if (missingSource) {
                results.push({ folder: set.folder, path: real, outcome: 'unavailable', reason: `the extension does not ship ${missingSource.name}` });
                continue;
            }
            const names = shipped.map((f) => f.name);
            const onDisk = shipped.map((f) => ({ ...f, disk: readText(path.join(real, f.name)) }));
            const existing = readGeneratedBy(real);
            let entries: string[] = [];
            try { entries = fs.readdirSync(real); } catch { entries = []; }
            const writeAll = (): void => {
                fs.mkdirSync(real, { recursive: true });
                for (const f of onDisk) { if (f.disk !== f.text) { writeFileAtomic(path.join(real, f.name), f.text!); } }
                writeFileAtomic(path.join(real, GENERATED_BY_FILE), stampText(stamp, names));
            };
            if (existing) {
                const current = onDisk.every((f) => f.disk === f.text) && sameBuild(existing, stamp);
                // A window on an older build never writes over what a newer build wrote.
                if (current || isNewerBuild(existing, stamp)) { results.push({ folder: set.folder, path: real, outcome: 'current' }); continue; }
                writeAll();
                results.push({ folder: set.folder, path: real, outcome: 'updated' });
            } else if (entries.length === 0) {
                writeAll();
                results.push({ folder: set.folder, path: real, outcome: 'written' });
            } else {
                const differing = onDisk.filter((f) => f.disk !== f.text).map((f) => f.name);
                if (differing.length === 0) {
                    writeFileAtomic(path.join(real, GENERATED_BY_FILE), stampText(stamp, names));
                    results.push({ folder: set.folder, path: real, outcome: 'adopted' });
                } else {
                    results.push({ folder: set.folder, path: real, outcome: 'differs', differing });
                }
            }
        } catch (err) {
            results.push({ folder: set.folder, path: real, outcome: 'unavailable', reason: (err as Error).message });
        }
    }
    return results;
}

/** A sentence for the status page's Configuration Errors about an unstamped folder that differs. */
export function describeDifferingSet(r: SchemaSetResult): string {
    return `${r.path} is not a generated copy (no ${GENERATED_BY_FILE}) and differs from the schemas this extension ships `
        + `(${(r.differing ?? []).join(', ')}); it is left as it is. Remove the folder to have the extension write its copy.`;
}

/**
 * The stale generated copies of a layout: the workspace folder's `.tom` folders
 * that are stamped while a root above it has its own top `.tom` (another real
 * folder). None in a standalone layout.
 */
export function findStaleGeneratedCopies(
    layout: { root: string; workspaceFolder: string; standalone?: boolean },
    configFolder = '.tom',
    sets: readonly GeneratedSchemaSet[] = GENERATED_SCHEMA_SETS,
): string[] {
    if (layout.standalone || samePath(layout.root, layout.workspaceFolder)) { return []; }
    const stale: string[] = [];
    for (const set of sets) {
        const parts = set.folder.split('/');
        const inWs = path.join(layout.workspaceFolder, configFolder, ...parts);
        const atRoot = path.join(layout.root, configFolder, ...parts);
        if (!readGeneratedBy(inWs)) { continue; }
        if (samePath(inWs, atRoot)) { continue; } // a link onto the root's copy
        stale.push(realPathOf(inWs));
    }
    return stale;
}

/** A sentence for Configuration Errors about stale copies. */
export function describeStaleCopies(stale: string[]): string {
    return `Generated schema copies below the root are stale (the root's .tom holds the current ones): ${stale.join(', ')}. `
        + 'Use "Remove stale schema copies…" to delete them.';
}

/** Delete the stale copies (only stamped folders; anything else is refused). Answers the removed folders. */
export function removeStaleGeneratedCopies(stale: string[]): string[] {
    const removed: string[] = [];
    for (const dir of stale) {
        if (!readGeneratedBy(dir)) { continue; }
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
    }
    return removed;
}

/**
 * The relative `$schema` reference from a file at `filePath` to `schemaRel`
 * below the top `.tom` (`json-schema/panels/queue.schema.json`): computed from
 * the file's real folder to the real top `.tom`, posix form. A file reached
 * through a workspace folder's `_ai` link points the way its real folder does.
 */
export function schemaRefFromFile(filePath: string, topTom: string, schemaRel: string): string {
    const from = realPathOf(path.dirname(filePath));
    const to = path.join(realPathOf(topTom), ...schemaRel.split('/'));
    return path.relative(from, to).split(path.sep).join('/');
}
