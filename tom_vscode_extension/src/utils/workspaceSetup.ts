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
