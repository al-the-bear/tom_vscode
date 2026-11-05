/**
 * The format version of the `_ai` files: which formats the files of this
 * machine's `_ai` clone are in, and whether this build understands them.
 *
 * `npm run migrate:ai-formats -- --apply` (src/utils/aiFormatMigration.ts)
 * writes `_ai/format-version.yaml` — the version it migrated to and the date —
 * once nothing is left to migrate. The file is tracked, so a reconcile carries
 * it to every machine with the files it describes. At start the extension
 * compares it with the version it was built for:
 *
 *   - the files are NEWER: another machine migrated them with a newer build,
 *     and this build may misread them — install the newer build;
 *   - the files are OLDER, or carry no stamp: the migration has not run for
 *     them — run it.
 *
 * A todo that changes an `_ai` format raises AI_FORMAT_VERSION, adds the step
 * to the migration, and so makes every older stamp a warning until the
 * migration ran. vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse, stringify } from 'yaml';

/**
 * The `_ai` format version this build reads and writes.
 *   1  the stamp itself
 *   2  process state as a stack of levels
 */
export const AI_FORMAT_VERSION = 2;

/** The stamp's file, in the `_ai` folder. */
export const AI_FORMAT_FILE = 'format-version.yaml';

/** What the migration has to be run with, named in the warnings. */
export const AI_FORMAT_MIGRATE_COMMAND = 'npm run migrate:ai-formats -- --apply (in tom_ai/vscode/tom_vscode_extension, after npm run compile)';

export interface AiFormatStamp {
    version: number;
    /** YYYY-MM-DD the migration wrote it. */
    date: string;
}

export type AiFormatCheck =
    | { kind: 'current'; stamp: AiFormatStamp }
    | { kind: 'newer' | 'older' | 'missing' | 'unreadable'; stamp?: AiFormatStamp; message: string };

/** The stamp, undefined when there is none; `null` when the file is there but holds no version. */
export function readAiFormatStamp(aiRoot: string): AiFormatStamp | undefined | null {
    const file = path.join(aiRoot, AI_FORMAT_FILE);
    if (!fs.existsSync(file)) { return undefined; }
    try {
        const doc = parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; date?: unknown } | null;
        const version = Number(doc?.version);
        if (!Number.isInteger(version) || version < 1) { return null; }
        return { version, date: typeof doc?.date === 'string' ? doc.date : String(doc?.date ?? '') };
    } catch {
        return null;
    }
}

/** The stamp's text. */
export function aiFormatStampText(stamp: AiFormatStamp): string {
    return '# The format version of the _ai files, written by npm run migrate:ai-formats\n'
        + '# (tom_vscode_extension/src/utils/aiFormatVersion.ts). Do not edit by hand.\n'
        + stringify({ version: stamp.version, date: stamp.date });
}

/** Write the stamp. */
export function writeAiFormatStamp(aiRoot: string, stamp: AiFormatStamp): void {
    fs.writeFileSync(path.join(aiRoot, AI_FORMAT_FILE), aiFormatStampText(stamp), 'utf8');
}

/** Today as YYYY-MM-DD, local time. */
export function localDate(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Compare the stamp of `aiRoot` with the version this build understands (`known`). */
export function checkAiFormatVersion(aiRoot: string, known = AI_FORMAT_VERSION): AiFormatCheck {
    const stamp = readAiFormatStamp(aiRoot);
    const where = path.join(aiRoot, AI_FORMAT_FILE);
    if (stamp === undefined) {
        return { kind: 'missing', message: `The _ai files carry no format version (${where}): the format migration has not run for them. Run ${AI_FORMAT_MIGRATE_COMMAND}.` };
    }
    if (stamp === null) {
        return { kind: 'unreadable', message: `${where} holds no format version. Run ${AI_FORMAT_MIGRATE_COMMAND} to write it again.` };
    }
    if (stamp.version > known) {
        return { kind: 'newer', stamp, message: `The _ai files are in format version ${stamp.version} (migrated ${stamp.date}); this Tom AI build understands version ${known} and may misread them. Install the newer build (compile_and_install.sh) and reload the window.` };
    }
    if (stamp.version < known) {
        return { kind: 'older', stamp, message: `The _ai files are in format version ${stamp.version} (migrated ${stamp.date}); this Tom AI build expects version ${known}. Run ${AI_FORMAT_MIGRATE_COMMAND}.` };
    }
    return { kind: 'current', stamp };
}
