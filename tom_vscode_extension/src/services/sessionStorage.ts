/**
 * Where a session's conversation artefacts live — one folder per session.
 *
 * Every named session of a quest, `chat` (the ANTHROPIC panel's) and
 * `default` (the prompt queue's) included, has its own storage root:
 *
 *     _ai/quests/<quest>/history/sessions/<name>/
 *         compacted_history.md, history.json, history.md   the compacted history and its snapshot (tracked)
 *         rawTurns.json, compaction_rounds.json            the rolling tail and the accumulator (ignored)
 *         iteration.json                                   a per-iteration session's iteration (ignored)
 *         <quest>.anthropic.prompts.md / .answers.md       its summary trail pair (ignored)
 *         live-trail.md                                     its live trail (tracked)
 *         trail/                                            its raw per-call trail (ignored), with
 *             compaction/, memory/                          the compaction and memory categories,
 *             tool_results/t<n>.json                        its tool results,
 *             current_prompt.<source>.<variant>.md          and the last prompt it sent
 *
 * and its own quest memory, `_ai/memory/<quest>/<name>/`. Shared memory
 * (`_ai/memory/shared/`) stays one set of files. The session's
 * `<name>.session.json` stays beside the `sessions/` folder.
 *
 * {@link migrateQuestToSessionStorage} moves a quest's files from the layout
 * before (one set per quest, chat and queue together) into the `default`
 * session, once per quest.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

export const SESSIONS_FOLDER = 'sessions';
export const SESSION_TRAIL_FOLDER = 'trail';
export const SESSION_LIVE_TRAIL_FILE = 'live-trail.md';
export const TOOL_RESULTS_FOLDER = 'tool_results';
/** The session the files of the per-quest layout became (decision: the queue's). */
export const MIGRATION_TARGET_SESSION = 'default';
/** Written into `history/sessions/` once a quest's files were migrated. */
export const MIGRATION_MARKER_FILE = '.storage-version';
const STORAGE_VERSION = '2';

/** The storage root of session `name`; `historyRoot` is the quest's `history/` folder. */
export function sessionRoot(historyRoot: string, name: string): string {
    return path.join(historyRoot, SESSIONS_FOLDER, name);
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

/** The summary trail file of session `name`: `<quest>.<subsystem>.<kind>.md`. */
export function sessionSummaryFile(historyRoot: string, name: string, quest: string, subsystem: string, kind: 'prompts' | 'answers'): string {
    return path.join(sessionRoot(historyRoot, name), `${quest}.${subsystem}.${kind}.md`);
}

/** The live trail of session `name`. */
export function sessionLiveTrailFile(historyRoot: string, name: string): string {
    return path.join(sessionRoot(historyRoot, name), SESSION_LIVE_TRAIL_FILE);
}

/** The quest memory of session `name`; `memoryRoot` is `_ai/memory`. */
export function sessionMemoryFolder(memoryRoot: string, quest: string, name: string): string {
    return path.join(memoryRoot, quest, name);
}

/** The sessions that have a storage root (a folder under `history/sessions/`). */
export function sessionsWithStorage(historyRoot: string): string[] {
    try {
        return fs.readdirSync(path.join(historyRoot, SESSIONS_FOLDER), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

/** Remove everything session `name` stored: its storage root and its quest memory. */
export function removeSessionStorage(historyRoot: string, memoryRoot: string, quest: string, name: string): void {
    fs.rmSync(sessionRoot(historyRoot, name), { recursive: true, force: true });
    fs.rmSync(sessionMemoryFolder(memoryRoot, quest, name), { recursive: true, force: true });
}

/**
 * The next free tool-result key number in `folder` (`t<n>.json`): one past
 * the highest there, so a new ToolTrail (a reload, another session, a clear)
 * never overwrites a stored result.
 */
export function nextFreeToolResultIndex(folder: string): number {
    let max = 0;
    try {
        for (const f of fs.readdirSync(folder)) {
            const m = /^t(\d+)\.json$/.exec(f);
            if (m) { max = Math.max(max, parseInt(m[1], 10)); }
        }
    } catch { /* no folder yet */ }
    return max + 1;
}

// ---------------------------------------------------------------------------
// Migration of the per-quest layout
// ---------------------------------------------------------------------------

/** The places of one quest's files in the layout before. */
export interface LegacyQuestLayout {
    quest: string;
    /** `_ai/quests/<quest>` */
    questFolder: string;
    /** `_ai/quests/<quest>/history` */
    historyRoot: string;
    /** `_ai/memory` */
    memoryRoot: string;
    /** The quest's raw Anthropic trail before, e.g. `_ai/trail/anthropic/<quest>`. */
    rawTrailFolder: string;
}

export interface MigrationReport {
    /** False when the quest had been migrated already (nothing was done). */
    migrated: boolean;
    /** What moved, `from -> to`, relative to the quest's `_ai` root where possible. */
    moved: string[];
    /** Files left where they were because the target already exists. */
    kept: string[];
}

/** The history files of the layout before that belong to the queue (the suffixed Local LLM snapshots stay). */
function isLegacyHistoryFile(name: string): boolean {
    return [
        'compacted_history.md',
        'rawTurns.json',
        'compaction_rounds.json',
        'history.json',
        'history.md',
    ].includes(name) || /^\d[\w-]*\.history\.(json|md)$/.test(name);
}

function move(from: string, to: string, report: MigrationReport): void {
    if (fs.existsSync(to)) { report.kept.push(from); return; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    report.moved.push(`${from} -> ${to}`);
}

/**
 * Move a quest's files from the per-quest layout into the `default`
 * session's storage, once: the history files and the Anthropic trail pair
 * from `history/`, the quest folder's `live-trail.md`, the raw Anthropic trail
 * (with its compaction / memory categories and tool results; the current-prompt
 * files and the last-request dump stay, the Logs tab reads them there) and the
 * quest memory files. A file whose target already exists is
 * left where it is (named in `kept`). Writes `history/sessions/.storage-version`
 * when done; a quest carrying it is not touched again.
 */
export function migrateQuestToSessionStorage(layout: LegacyQuestLayout): MigrationReport {
    const report: MigrationReport = { migrated: false, moved: [], kept: [] };
    const sessions = path.join(layout.historyRoot, SESSIONS_FOLDER);
    const marker = path.join(sessions, MIGRATION_MARKER_FILE);
    if (fs.existsSync(marker)) { return report; }
    const target = sessionRoot(layout.historyRoot, MIGRATION_TARGET_SESSION);

    const list = (folder: string): fs.Dirent[] => {
        try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
    };
    for (const e of list(layout.historyRoot)) {
        if (!e.isFile()) { continue; }
        const isPair = e.name === `${layout.quest}.anthropic.prompts.md` || e.name === `${layout.quest}.anthropic.answers.md`;
        if (isLegacyHistoryFile(e.name) || isPair) {
            move(path.join(layout.historyRoot, e.name), path.join(target, e.name), report);
        }
    }
    const liveTrail = path.join(layout.questFolder, SESSION_LIVE_TRAIL_FILE);
    if (fs.existsSync(liveTrail)) { move(liveTrail, path.join(target, SESSION_LIVE_TRAIL_FILE), report); }
    for (const e of list(layout.rawTrailFolder)) {
        // The current-prompt files and the last-request dump stay: the Logs tab reads them there.
        if (e.name.startsWith('current_prompt.') || e.name.startsWith('last_request')) { continue; }
        move(path.join(layout.rawTrailFolder, e.name), path.join(target, SESSION_TRAIL_FOLDER, e.name), report);
    }
    const questMemory = path.join(layout.memoryRoot, layout.quest);
    for (const e of list(questMemory)) {
        if (e.isFile() && e.name.endsWith('.md')) {
            move(path.join(questMemory, e.name), path.join(sessionMemoryFolder(layout.memoryRoot, layout.quest, MIGRATION_TARGET_SESSION), e.name), report);
        }
    }
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(marker, `${STORAGE_VERSION}\n`);
    report.migrated = true;
    return report;
}

/**
 * The rules `_ai/.gitignore` carries for per-session storage (relative to the
 * `_ai` root): tracked per session are the compacted history, its snapshot and
 * the live trail; machine-local are the rolling tail and accumulator, a
 * per-iteration session's marker, the summary trail pair, the raw trail and
 * the migration marker (a machine pulling another's marker would never move
 * its own untracked files).
 */
export const SESSION_STORAGE_GITIGNORE_RULES: readonly string[] = [
    'quests/*/history/sessions/*/rawTurns.json',
    'quests/*/history/sessions/*/rawTurns.json.tmp',
    'quests/*/history/sessions/*/compaction_rounds.json',
    'quests/*/history/sessions/*/compaction_rounds.json.tmp',
    'quests/*/history/sessions/*/iteration.json',
    'quests/*/history/sessions/*/*.prompts.md',
    'quests/*/history/sessions/*/*.answers.md',
    'quests/*/history/sessions/*/trail/',
    'quests/*/history/sessions/.storage-version',
];
