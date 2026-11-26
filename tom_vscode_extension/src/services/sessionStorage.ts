/**
 * Where a session's conversation artefacts live — one folder per session,
 * per host: sessions belong to the machine they run on.
 *
 * Every named session of a quest, `chat` (the ANTHROPIC panel's) and
 * `default@default` (the default run's default session, the prompt queue's)
 * included, has its definition and state in
 * `_ai/quests/<quest>/history/<host>/<name>.session.json` (tracked, written
 * only by its host; src/services/agentSdkSessionStore.ts) and its working
 * storage, untracked, in
 *
 *     _ai/quests/<quest>/history/<host>/sessions/<name>/
 *         compacted_history.md, history.json, history.md   the compacted history and its snapshot
 *         rawTurns.json, compaction_rounds.json            the rolling tail and the accumulator
 *         iteration.json                                   a per-iteration session's iteration
 *         live-trail.md                                     its live trail
 *         session-todos.todo.yaml                           its session todos
 *         trail/                                            its raw per-call trail, with
 *             compaction/, memory/                          the compaction and memory categories,
 *             tool_results/t<n>.json                        and its tool results
 *
 * `<host>` is {@link hostSlugOf}. The prompt/answer turns of all the host's
 * sessions go to the host's compact trail `history/trail.<host>.md`
 * (src/services/hostTrail.ts).
 *
 * The quest memory has no session level (`_ai/quests/<quest>/memory/`,
 * src/services/questMemoryFiles.ts).
 *
 * The path functions read a bare `default` as `default@default`, so a name
 * an older entry still carries reaches the same files. The `_ai` format
 * migration (src/utils/aiFormatMigration.ts, formatV11/) brings older layouts
 * here before a window starts.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { hostSlugOf } from '../utils/hostSlug';
import { DEFAULT_RUN_SESSION, canonicalSessionName } from '../utils/runSessions';

export const SESSIONS_FOLDER = 'sessions';
export const SESSION_TRAIL_FOLDER = 'trail';
export const SESSION_LIVE_TRAIL_FILE = 'live-trail.md';
export const TOOL_RESULTS_FOLDER = 'tool_results';
/** The session the files of the per-quest layout became (decision: the queue's): the default run's default session. */
export const MIGRATION_TARGET_SESSION = DEFAULT_RUN_SESSION;
/** Written into this host's `history/<host>/sessions/` once a quest's files were migrated. */
export const MIGRATION_MARKER_FILE = '.storage-version';
export const STORAGE_VERSION = '2';

/** This host's folder of the quest's `history/`: its session files and its sessions' storage. */
export function hostHistoryFolder(historyRoot: string, host: string = hostSlugOf()): string {
    return path.join(historyRoot, host);
}

/** The storage root of session `name` at the new place, `history/<host>/sessions/<name>/`. */
export function hostSessionRoot(historyRoot: string, name: string, host: string = hostSlugOf()): string {
    return path.join(hostHistoryFolder(historyRoot, host), SESSIONS_FOLDER, canonicalSessionName(name));
}

/** The storage root of session `name` on this host; `historyRoot` is the quest's `history/` folder. */
export function sessionRoot(historyRoot: string, name: string): string {
    return hostSessionRoot(historyRoot, name);
}

/** The raw per-call trail of session `name`, or of one of its categories. */
export function sessionTrailFolder(historyRoot: string, name: string, category?: string): string {
    const base = path.join(sessionRoot(historyRoot, name), SESSION_TRAIL_FOLDER);
    return category ? path.join(base, category) : base;
}

/** Where session `name` keeps its tool results. */
export function sessionToolResultsFolder(historyRoot: string, name: string): string {
    return path.join(sessionTrailFolder(historyRoot, name), TOOL_RESULTS_FOLDER);
}

/** The live trail of session `name`. */
export function sessionLiveTrailFile(historyRoot: string, name: string): string {
    return path.join(sessionRoot(historyRoot, name), SESSION_LIVE_TRAIL_FILE);
}

/** The sessions that have a storage root on this host: the folders under `history/<host>/sessions/`. */
export function sessionsWithStorage(historyRoot: string): string[] {
    try {
        return fs.readdirSync(path.join(hostHistoryFolder(historyRoot), SESSIONS_FOLDER), { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
        return [];
    }
}

/** One session's live trail, with when it was last written. */
export interface SessionLiveTrail {
    session: string;
    file: string;
    modified: Date;
}

/**
 * The live trails of the sessions written since `since` (every session with a
 * live trail when `since` is undefined), newest first — what a quest refresh,
 * and a new session start, read.
 */
export function sessionLiveTrailsSince(historyRoot: string, since?: Date): SessionLiveTrail[] {
    const trails: SessionLiveTrail[] = [];
    for (const session of sessionsWithStorage(historyRoot)) {
        const file = sessionLiveTrailFile(historyRoot, session);
        let modified: Date;
        try { modified = fs.statSync(file).mtime; } catch { continue; }
        if (since && modified.getTime() <= since.getTime()) { continue; }
        trails.push({ session, file, modified });
    }
    return trails.sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.session.localeCompare(b.session));
}

/** Remove everything session `name` stored: its storage root. */
export function removeSessionStorage(historyRoot: string, name: string): void {
    fs.rmSync(hostSessionRoot(historyRoot, name), { recursive: true, force: true });
}

/**
 * The next free tool-result key number in `folder` (`t<n>.json`): one past
 * the highest there, so a new ToolTrail (a reload, another session, a clear)
 * never overwrites a stored result.
 */
export function nextFreeToolResultIndex(folder: string): number {
    // Past what retention pruned too: a pruned key is never given out again.
    let max = readToolResultRetentionMarker(folder)?.prunedThrough ?? 0;
    try {
        for (const f of fs.readdirSync(folder)) {
            const m = /^t(\d+)\.json$/.exec(f);
            if (m) { max = Math.max(max, parseInt(m[1], 10)); }
        }
    } catch { /* no folder yet */ }
    return max + 1;
}

/** The file in a tool-results folder recording what retention pruned (services/tool-result-store.ts). */
export const TOOL_RESULT_RETENTION_MARKER = '.retention.json';

/** What retention pruned in a tool-results folder: every key up to `prunedThrough` is gone. */
export interface ToolResultRetentionMarker {
    prunedThrough: number;
    /** ISO time of the last prune. */
    prunedAt: string;
    /** The limits it ran with. */
    maxAgeDays: number;
    maxPerSession: number;
}

/** The retention marker of `folder`, if retention pruned anything there. */
export function readToolResultRetentionMarker(folder: string): ToolResultRetentionMarker | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(folder, TOOL_RESULT_RETENTION_MARKER), 'utf8')) as Partial<ToolResultRetentionMarker>;
        return Number.isInteger(raw.prunedThrough) && (raw.prunedThrough as number) > 0
            ? { prunedThrough: raw.prunedThrough as number, prunedAt: String(raw.prunedAt ?? ''), maxAgeDays: Number(raw.maxAgeDays ?? 0), maxPerSession: Number(raw.maxPerSession ?? 0) }
            : undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Migration of the per-quest layout
// ---------------------------------------------------------------------------

/**
 * The rules `_ai/.gitignore` carries for session storage and the quest's
 * derived files (relative to the `_ai` root). Untracked: a host's session
 * storage `history/<host>/sessions/` (class D), the derived history of the
 * quest (`history/compacted_history.md`, `history.json`, `history.md`,
 * `history.watermark.json`; class C), a host's history build lock
 * (`history/.build.<host>.lock`), the refresh notes and every live trail.
 * Tracked: the session files `history/<host>/<name>.session.json` and the
 * host trails `history/trail.<host>.md`. The `_ai` format migration removes
 * a tracked file of these kinds from the index (formatV11/hostSessions.ts).
 */
export const SESSION_STORAGE_GITIGNORE_RULES: readonly string[] = [
    'quests/*/history/*/sessions/',
    'quests/*/history/compacted_history.md',
    'quests/*/history/history.json',
    'quests/*/history/history.md',
    'quests/*/history/history.watermark.json',
    'quests/*/history/.build.*.lock',
    'quests/*/quest_refresh.*.md',
    'quests/*/history/**/live-trail.md',
];
