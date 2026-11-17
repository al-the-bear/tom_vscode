/**
 * Running the `_ai` format migration (src/utils/aiFormatMigration.ts) from the
 * installed extension (vscimpb142) and from the command line alike, safely
 * across windows and machines:
 *
 *   - **The machine-local stamp** `_ai/local/format-version.<host>.yaml`: some
 *     migrated files are machine-local (`queue/`, `chat_variables/`, session
 *     files and scratch files are not versioned). The shared stamp
 *     `_ai/format-version.yaml` travels with a reconcile; the local one says
 *     this machine's own files were migrated too. A window needs a migration
 *     while either stamp is older than its build.
 *   - **The migration lock** `_ai/local/format-migration.lock.json`: one
 *     migration at a time on a machine; another window sees "migration is
 *     already running in another window". A lock whose window is gone, or
 *     older than 30 minutes, is taken over.
 *   - **The merger**: files a session already has are merged with the `_ai`
 *     merge drivers git has registered (`git config --global merge.<driver>.driver`).
 *   - **The report**: the changes per quest and step, as Markdown.
 *
 * vscode-free (the extension host and scripts/migrate-ai-formats.cjs use it).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parse, stringify } from 'yaml';

import { AI_FORMAT_VERSION, checkAiFormatVersion, type AiFormatCheck, type AiFormatStamp } from './aiFormatVersion';
import type { FormatMigrationResult, MergeDriver } from './aiFormatMigration';

/** The machine-local stamp's file, under `_ai/local/` (not versioned). */
export function localStampFile(aiRoot: string, host: string): string {
    return path.join(aiRoot, 'local', `format-version.${host}.yaml`);
}

/** This machine's stamp; undefined when there is none or it holds no version. */
export function readLocalStamp(aiRoot: string, host: string): AiFormatStamp | undefined {
    const file = localStampFile(aiRoot, host);
    if (!fs.existsSync(file)) { return undefined; }
    try {
        const doc = parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; date?: unknown } | null;
        const version = Number(doc?.version);
        return Number.isInteger(version) && version >= 1 ? { version, date: String(doc?.date ?? '') } : undefined;
    } catch {
        return undefined;
    }
}

/** Write this machine's stamp. */
export function writeLocalStamp(aiRoot: string, host: string, stamp: AiFormatStamp): void {
    const file = localStampFile(aiRoot, host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# The format version of this machine\'s own _ai files (queue, chat variables, sessions),\n'
        + '# written by the _ai format migration (tom_vscode_extension/src/utils/aiFormatMigrationRun.ts). Do not edit.\n'
        + stringify({ version: stamp.version, date: stamp.date }), 'utf8');
}

/** What this window has to do about the formats. */
export type MigrationNeed =
    | { kind: 'current' }
    /** The files are newer than this build: install the newer build (no downgrade). */
    | { kind: 'newer'; check: AiFormatCheck }
    /** Migrate: the shared stamp is missing or older (`shared`), or only this machine's own files are behind (`local`). */
    | { kind: 'migrate'; reason: 'shared' | 'local'; from?: number; to: number; check: AiFormatCheck };

/** Whether `aiRoot` needs the migration on this machine (`host`), for a build that knows `known`. */
export function migrationNeed(aiRoot: string, host: string, known = AI_FORMAT_VERSION): MigrationNeed {
    const check = checkAiFormatVersion(aiRoot, known);
    if (check.kind === 'newer') { return { kind: 'newer', check }; }
    if (check.kind !== 'current') { return { kind: 'migrate', reason: 'shared', from: check.stamp?.version, to: known, check }; }
    const local = readLocalStamp(aiRoot, host);
    if (!local || local.version < known) { return { kind: 'migrate', reason: 'local', from: local?.version, to: known, check }; }
    return { kind: 'current' };
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

export interface MigrationLock {
    windowId: string;
    host: string;
    pid: number;
    /** ISO time it was taken. */
    startedAt: string;
}

/** A lock older than this is taken over (a crashed migration). */
export const MIGRATION_LOCK_STALE_MS = 30 * 60_000;

export function migrationLockFile(aiRoot: string): string {
    return path.join(aiRoot, 'local', 'format-migration.lock.json');
}

export function readMigrationLock(aiRoot: string): MigrationLock | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(migrationLockFile(aiRoot), 'utf8')) as Partial<MigrationLock>;
        return raw && typeof raw.windowId === 'string' ? { windowId: raw.windowId, host: String(raw.host ?? ''), pid: Number(raw.pid ?? 0), startedAt: String(raw.startedAt ?? '') } : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a lock still holds: its window is alive (`isAlive`) and it is not older than the stale limit. */
export function lockHolds(lock: MigrationLock, now: Date, isAlive: (windowId: string) => boolean): boolean {
    const at = Date.parse(lock.startedAt);
    if (!Number.isFinite(at) || now.getTime() - at > MIGRATION_LOCK_STALE_MS) { return false; }
    return isAlive(lock.windowId);
}

/**
 * Take the lock for `me`; refused (with the holder) while another window holds it. A stale lock, or this
 * window's own, is taken over.
 */
export function acquireMigrationLock(aiRoot: string, me: Omit<MigrationLock, 'startedAt'>, now: Date, isAlive: (windowId: string) => boolean): { ok: true } | { ok: false; holder: MigrationLock } {
    const file = migrationLockFile(aiRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const held = readMigrationLock(aiRoot);
    if (held && held.windowId !== me.windowId && lockHolds(held, now, isAlive)) { return { ok: false, holder: held }; }
    if (held) { fs.rmSync(file, { force: true }); }
    const lock: MigrationLock = { ...me, startedAt: now.toISOString() };
    try {
        fs.writeFileSync(file, JSON.stringify(lock, null, 2), { encoding: 'utf8', flag: 'wx' });
    } catch {
        // Another window took it in between.
        const other = readMigrationLock(aiRoot);
        if (other && other.windowId !== me.windowId) { return { ok: false, holder: other }; }
    }
    return { ok: true };
}

/** Release the lock when `windowId` holds it. */
export function releaseMigrationLock(aiRoot: string, windowId: string): void {
    const held = readMigrationLock(aiRoot);
    if (held && held.windowId === windowId) { fs.rmSync(migrationLockFile(aiRoot), { force: true }); }
}

// ---------------------------------------------------------------------------
// The merger and the report
// ---------------------------------------------------------------------------

/**
 * Merge with the `_ai` merge drivers git has registered (`git config --global merge.<driver>.driver`): the
 * merged text, or undefined when the driver is not registered or failed. Scratch files under `scratchRoot`.
 */
export function makeGitMerger(scratchRoot: string, run: (command: string) => string = (c) => execSync(c, { encoding: 'utf8', stdio: 'pipe' })): (driver: MergeDriver, target: string, legacy: string) => string | undefined {
    let n = 0;
    return (driver, target, legacy) => {
        let command: string;
        try { command = run(`git config --global --get merge.${driver}.driver`).trim(); } catch { command = ''; }
        if (!command) { return undefined; }
        const dir = path.join(scratchRoot, String(n++));
        fs.mkdirSync(dir, { recursive: true });
        const base = path.join(dir, 'base');
        const ours = path.join(dir, 'ours');
        fs.writeFileSync(base, '');
        fs.copyFileSync(target, ours);
        const q = (p: string): string => `"${p}"`;
        const line = command.replace('%O', q(base)).replace('%A', q(ours)).replace('%B', q(legacy))
            .replace('%L', '7').replace('%P', q(path.basename(target)));
        try {
            run(line);
            return fs.readFileSync(ours, 'utf8');
        } catch {
            return undefined;
        }
    };
}

/** The changes per quest and step, and the problems, as Markdown. */
export function migrationReportMarkdown(result: FormatMigrationResult, apply: boolean, when = new Date()): string {
    const lines = [`# _ai format migration (${apply ? 'applied' : 'dry run'}, ${when.toISOString()})`, ''];
    const byQuest = new Map<string, FormatMigrationResult['changes']>();
    for (const c of result.changes) {
        if (!byQuest.has(c.quest)) { byQuest.set(c.quest, []); }
        byQuest.get(c.quest)!.push(c);
    }
    if (!result.changes.length && !result.problems.length) { lines.push('Nothing to migrate: every file is in the current format.', ''); }
    for (const [quest, changes] of [...byQuest].sort((a, b) => a[0].localeCompare(b[0]))) {
        const counts: Record<string, number> = {};
        for (const c of changes) { counts[c.step] = (counts[c.step] || 0) + 1; }
        lines.push(`## ${quest}`, '', Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '), '');
        for (const c of changes.filter((x) => x.step !== 'storage' || !/ -> .*\/trail\//.test(x.detail)).slice(0, 40)) {
            lines.push(`- ${c.step}: ${c.detail}`);
        }
        const trailMoves = changes.filter((x) => x.step === 'storage' && / -> .*\/trail\//.test(x.detail)).length;
        if (trailMoves) { lines.push(`- storage: ${trailMoves} raw trail file(s) moved into the session's trail/`); }
        lines.push('');
    }
    if (result.problems.length) {
        lines.push('## Problems', '', 'These stay as they are; the format stamp is not written until they are solved.', '');
        for (const p of result.problems) { lines.push(`- ${p.quest} (${p.step}): ${p.detail}`); }
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * Run the migration (or, with `apply: false`, list it) and, when it applied without problems, write this
 * machine's stamp beside the shared one the migration writes.
 */
export function runAiFormatMigration(opts: import('./aiFormatMigration').FormatMigrationOptions): FormatMigrationResult {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrateAiFormats } = require('./aiFormatMigration') as typeof import('./aiFormatMigration');
    const result = migrateAiFormats(opts);
    if (opts.apply && result.problems.length === 0) {
        writeLocalStamp(opts.aiRoot, opts.hostSlug, { version: opts.formatVersion ?? AI_FORMAT_VERSION, date: opts.today ?? new Date().toISOString().slice(0, 10) });
    }
    return result;
}
