/**
 * Unpacking the workspace template into a folder ("Setup New Workspace Folder",
 * handlers/setupWorkspaceFolder-handler.ts). No vscode here: the question asked
 * for a file that already exists is passed in, so the whole flow is testable.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ZipEntry } from './zipArchive';

/** The answer for one file of the template that already exists in the folder. */
export type ExistingFileChoice = 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll' | 'cancel';

export interface UnpackResult {
    /** New files, template paths (`/`-separated), in archive order. */
    written: string[];
    /** Files that existed and were replaced. */
    overwritten: string[];
    /** Files that existed and were kept. */
    skipped: string[];
    /** The user cancelled: the files after the one asked about were not unpacked. */
    cancelled: boolean;
}

/** The token the template's workspace part names its root by (scripts/build-workspace-template.cjs). */
export const TEMPLATE_ROOT_TOKEN = '{{root}}';

/** Whether the template is the two-part one (`root/`, `workspace/`, template version 2). */
export function isTwoPartTemplate(entries: readonly ZipEntry[]): boolean {
    return entries.some((e) => e.path.startsWith('root/')) && entries.some((e) => e.path.startsWith('workspace/'));
}

/**
 * The entries of a two-part template as one standalone folder gets them: the
 * root part and the workspace part together (a file both carry — CLAUDE.md,
 * AGENTS.md — taken from the workspace part), without `tom_root.yaml` (a
 * standalone folder is no root), the root token written as `.`, folder entries
 * dropped. A template of one part is answered as it is.
 */
export function standaloneEntries(entries: readonly ZipEntry[]): ZipEntry[] {
    if (!isTwoPartTemplate(entries)) { return [...entries]; }
    const byPath = new Map<string, ZipEntry>();
    const take = (prefix: string, rewrite: boolean): void => {
        for (const e of entries) {
            if (!e.path.startsWith(prefix) || e.path.endsWith('/')) { continue; }
            const rel = e.path.slice(prefix.length);
            if (rel === '.tom/tom_root.yaml') { continue; }
            const data = rewrite && rel.endsWith('.md') && e.data.includes(TEMPLATE_ROOT_TOKEN)
                ? Buffer.from(e.data.toString('utf8').split(TEMPLATE_ROOT_TOKEN).join('.'), 'utf8')
                : e.data;
            byPath.set(rel, { ...e, path: rel, data });
        }
    };
    take('root/', false);
    take('workspace/', true);
    return [...byPath.values()];
}

/** The three setups of a two-part template (02_wslayout-10, workspace layout BP-22 (a)). */
export type SetupKind = 'root' | 'workspace' | 'standalone';

/**
 * The entries of one part of a two-part template, its prefix taken off: the
 * workspace part with the root token written as `rootToken` (the path from the
 * workspace folder to its root, `/`-separated) in its Markdown. Folder entries
 * (`.tom/`) are kept.
 */
export function partEntries(entries: readonly ZipEntry[], part: 'root' | 'workspace', rootToken = '.'): ZipEntry[] {
    const prefix = `${part}/`;
    return entries.filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length).map((e) => {
        const rel = e.path.slice(prefix.length);
        const data = part === 'workspace' && rel.endsWith('.md') && e.data.includes(TEMPLATE_ROOT_TOKEN)
            ? Buffer.from(e.data.toString('utf8').split(TEMPLATE_ROOT_TOKEN).join(rootToken), 'utf8')
            : e.data;
        return { ...e, path: rel, data };
    });
}

/** The root token for a workspace folder `ws` below the root `root`: the relative path, `/`-separated (`..` for a direct subfolder). */
export function rootTokenFor(ws: string, root: string): string {
    const rel = path.relative(ws, root);
    return rel ? rel.split(path.sep).join('/') : '.';
}

/** The nearest folder strictly above `dir` with `.tom/tom_root.yaml`, or undefined. */
export function findRootAbove(dir: string): string | undefined {
    for (let d = path.dirname(path.resolve(dir)); ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, '.tom', 'tom_root.yaml'))) { return d; }
        if (path.dirname(d) === d) { return undefined; }
    }
}

/** Why `name` cannot be a workspace folder's name (one path segment), or undefined. */
export function workspaceNameProblem(name: string): string | undefined {
    const n = name.trim();
    if (!n) { return 'Give the folder a name.'; }
    if (n === '.' || n === '..' || /[\\/:*?"<>|]/.test(n)) { return 'One folder name, without / \\ : * ? " < > |.'; }
    if (n === '_ai' || n.startsWith('.')) { return `${n} is a name the root uses itself.`; }
    return undefined;
}

/** What linking `<ws>/_ai` did. */
export interface AiLinkResult {
    link: string;
    /** `symlink`: a relative symbolic link; `junction`: a Windows junction (absolute), when a symbolic link may not be made; `exists`: there was one already. */
    kind: 'symlink' | 'junction' | 'exists';
    target: string;
}

/**
 * Link the workspace folder's `_ai` to the root's: a relative symbolic link;
 * on Windows, where creating one may need a privilege, a junction instead.
 * An `_ai` that is there already is left as it is. Throws when neither works.
 */
export function linkAi(
    ws: string,
    root: string,
    deps: { symlink?: (target: string, link: string, type?: 'dir' | 'junction') => void; platform?: NodeJS.Platform } = {},
): AiLinkResult {
    const symlink = deps.symlink ?? ((t, l, type) => fs.symlinkSync(t, l, type));
    const platform = deps.platform ?? process.platform;
    const link = path.join(ws, '_ai');
    const target = path.join(root, '_ai');
    try { fs.lstatSync(link); return { link, kind: 'exists', target }; } catch { /* not there: make it */ }
    const rel = path.relative(ws, target);
    try {
        symlink(rel, link, 'dir');
        return { link, kind: 'symlink', target: rel };
    } catch (err) {
        if (platform !== 'win32') { throw err; }
        symlink(target, link, 'junction');
        return { link, kind: 'junction', target };
    }
}

/** A quest's `.code-workspace`: the workspace folder three levels up (opened through its `_ai`), Copilot reading AGENTS.md. */
export function questCodeWorkspaceText(): string {
    return `${JSON.stringify({ folders: [{ path: '../../..' }], settings: { 'chat.useAgentsMdFile': true } }, null, '\t')}\n`;
}

/** What a folder holds at its top level (sorted by code unit, the same on every machine), `[]` for a missing folder. */
export function folderEntries(dir: string): string[] {
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir).sort();
}

/**
 * The file a template entry is written to, or undefined for an entry that is no
 * file (a folder entry) or would land outside the folder (an absolute path or `..`).
 */
export function entryTarget(targetDir: string, entryPath: string): string | undefined {
    if (entryPath.endsWith('/') || entryPath.includes('\\')) { return undefined; }
    const parts = entryPath.split('/');
    if (path.posix.isAbsolute(entryPath) || parts.some((p) => p === '..' || p === '' || /^[A-Za-z]:$/.test(p))) { return undefined; }
    return path.join(targetDir, ...parts);
}

/**
 * Write `entries` into `targetDir`. A file that does not exist is written; for
 * one that exists `askExisting` decides, until an "all" answer settles every
 * later one. Cancel stops at once: what was written stays and is in the result.
 */
export async function unpackTemplate(
    entries: ZipEntry[],
    targetDir: string,
    askExisting: (entryPath: string) => Promise<ExistingFileChoice>,
): Promise<UnpackResult> {
    const result: UnpackResult = { written: [], overwritten: [], skipped: [], cancelled: false };
    let forAll: 'overwrite' | 'skip' | undefined;
    for (const entry of entries) {
        // A folder entry (the workspace part's empty `.tom/`) is created, nothing asked.
        if (entry.path.endsWith('/')) {
            const folder = entryTarget(targetDir, entry.path.replace(/\/+$/, ''));
            if (folder) { fs.mkdirSync(folder, { recursive: true }); }
            continue;
        }
        const file = entryTarget(targetDir, entry.path);
        if (!file) { continue; }
        if (fs.existsSync(file)) {
            let choice: ExistingFileChoice = forAll ?? await askExisting(entry.path);
            if (choice === 'cancel') { result.cancelled = true; break; }
            if (choice === 'overwriteAll') { forAll = 'overwrite'; choice = 'overwrite'; }
            if (choice === 'skipAll') { forAll = 'skip'; choice = 'skip'; }
            if (choice === 'skip') { result.skipped.push(entry.path); continue; }
            fs.writeFileSync(file, entry.data);
            result.overwritten.push(entry.path);
            continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, entry.data);
        result.written.push(entry.path);
    }
    return result;
}

/** One line: how many files were written, overwritten and skipped, and whether it was cancelled. */
export function unpackSummary(result: UnpackResult): string {
    const counts = `${result.written.length} written, ${result.overwritten.length} overwritten, ${result.skipped.length} skipped`;
    return result.cancelled ? `Setup cancelled: ${counts}. The files written so far stay.` : `Workspace template unpacked: ${counts}.`;
}

/** The full report as Markdown: the three lists, each file on its own line. */
export function unpackReport(result: UnpackResult, targetDir: string): string {
    const list = (title: string, files: string[]): string =>
        `## ${title} (${files.length})\n\n${files.length > 0 ? files.map((f) => `- \`${f}\``).join('\n') : '(none)'}\n`;
    return [
        '# Workspace setup',
        '',
        `Folder: \`${targetDir}\``,
        '',
        unpackSummary(result),
        '',
        list('Written', result.written),
        list('Overwritten', result.overwritten),
        list('Skipped', result.skipped),
    ].join('\n');
}
