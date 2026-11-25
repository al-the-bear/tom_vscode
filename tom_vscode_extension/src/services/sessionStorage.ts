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
 *             tool_results/t<n>.json                        its tool results,
 *             current_prompt.<source>.<variant>.md          and the last prompt it sent
 *
 * `<host>` is {@link hostSlugOf}. The prompt/answer turns of all the host's
 * sessions go to the host's compact trail `history/trail.<host>.md`
 * (src/services/hostTrail.ts).
 *
 * OLD PLACE (until the `_ai` format migration moves them): a session folder
 * `history/sessions/<name>/` that exists is read and written there; a folder
 * at the new place wins; a folder that exists at neither is made at the new
 * place ({@link sessionRoot}). The listing ({@link sessionsWithStorage}) names
 * the sessions of both places.
 *
 * The quest memory has no session level (`_ai/quests/<quest>/memory/`,
 * src/services/questMemoryFiles.ts). OLD PLACE: a session's memory folder
 * `_ai/memory/<quest>/<name>/` is still removed with the session, and the
 * moves below still carry it.
 *
 * {@link migrateQuestToSessionStorage} moves a quest's files from the layout
 * before (one set per quest, chat and queue together) into the
 * `default@default` session's folder of the old place, once per quest;
 * {@link migrateDefaultSessionName} moves what an older build kept under the
 * bare name `default` there (vscimpb151). The path functions read a bare
 * `default` as `default@default`, so a name an older entry still carries
 * reaches the same files.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { hostSlugOf } from '../utils/hostSlug';
import { DEFAULT_RUN_SESSION, LEGACY_DEFAULT_SESSION, canonicalSessionName } from '../utils/runSessions';

export const SESSIONS_FOLDER = 'sessions';
export const SESSION_TRAIL_FOLDER = 'trail';
export const SESSION_LIVE_TRAIL_FILE = 'live-trail.md';
export const TOOL_RESULTS_FOLDER = 'tool_results';
/** The session the files of the per-quest layout became (decision: the queue's): the default run's default session. */
export const MIGRATION_TARGET_SESSION = DEFAULT_RUN_SESSION;
/** Written into `history/sessions/` once a quest's files were migrated. */
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

/** OLD PLACE: the storage root of session `name` before sessions were per host, `history/sessions/<name>/`. */
export function legacySessionRoot(historyRoot: string, name: string): string {
    return path.join(historyRoot, SESSIONS_FOLDER, canonicalSessionName(name));
}

/**
 * The storage root of session `name`; `historyRoot` is the quest's `history/`
 * folder. The new place when its folder exists, else the old place when its
 * folder exists (OLD PLACE: read and written there until the migration moves
 * it), else the new place.
 */
export function sessionRoot(historyRoot: string, name: string): string {
    const fresh = hostSessionRoot(historyRoot, name);
    if (fs.existsSync(fresh)) { return fresh; }
    const old = legacySessionRoot(historyRoot, name);
    return fs.existsSync(old) ? old : fresh;
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

/**
 * OLD PLACE: the summary trail pair file of session `name`,
 * `history/sessions/<name>/<quest>.<subsystem>.<kind>.md`. Nothing writes it
 * (the turns go to the host trail, src/services/hostTrail.ts); the readers of
 * prompt/answer pairs read it for the turns older than the host trail's oldest.
 */
export function sessionSummaryFile(historyRoot: string, name: string, quest: string, subsystem: string, kind: 'prompts' | 'answers'): string {
    return path.join(legacySessionRoot(historyRoot, name), `${quest}.${subsystem}.${kind}.md`);
}

/** The live trail of session `name`. */
export function sessionLiveTrailFile(historyRoot: string, name: string): string {
    return path.join(sessionRoot(historyRoot, name), SESSION_LIVE_TRAIL_FILE);
}

/** OLD PLACE: the per-session memory folder of session `name`, `_ai/memory/<quest>/<name>/`; `memoryRoot` is `_ai/memory`. Read by the memory injection's interim rule, removed with the session; nothing writes it. */
export function sessionMemoryFolder(memoryRoot: string, quest: string, name: string): string {
    return path.join(memoryRoot, quest, canonicalSessionName(name));
}

/**
 * The sessions that have a storage root: a folder under this host's
 * `history/<host>/sessions/` or (OLD PLACE) under `history/sessions/`.
 */
export function sessionsWithStorage(historyRoot: string): string[] {
    const names = new Set<string>();
    for (const folder of [path.join(hostHistoryFolder(historyRoot), SESSIONS_FOLDER), path.join(historyRoot, SESSIONS_FOLDER)]) {
        try {
            for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
                if (e.isDirectory()) { names.add(e.name); }
            }
        } catch { /* no folder there */ }
    }
    return [...names].sort();
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

/** Remove everything session `name` stored: its storage root (at both places) and its memory folder of the old place. */
export function removeSessionStorage(historyRoot: string, memoryRoot: string, quest: string, name: string): void {
    fs.rmSync(hostSessionRoot(historyRoot, name), { recursive: true, force: true });
    // OLD PLACE: `history/sessions/<name>/`.
    fs.rmSync(legacySessionRoot(historyRoot, name), { recursive: true, force: true });
    // OLD PLACE: `_ai/memory/<quest>/<name>/`.
    fs.rmSync(sessionMemoryFolder(memoryRoot, quest, name), { recursive: true, force: true });
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
export function isLegacyHistoryFile(name: string): boolean {
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
    // OLD PLACE: this migration of an older layout fills the old place; the `_ai` format migration moves it on.
    const target = legacySessionRoot(layout.historyRoot, MIGRATION_TARGET_SESSION);

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
    // OLD PLACE: the flat files of `_ai/memory/<quest>/` go to `_ai/memory/<quest>/default@default/`.
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

// ---------------------------------------------------------------------------
// The bare `default` session becomes `default@default` (vscimpb151)
// ---------------------------------------------------------------------------

/** What {@link migrateDefaultSessionName} did. */
export interface DefaultSessionMigrationReport {
    /** False when nothing of the old name was there. */
    migrated: boolean;
    moved: string[];
    /** Files left where they were because the target already exists. */
    kept: string[];
    /** Session files whose `basedOn: "default"` now names `default@default`. */
    rebased: string[];
}

/** Move `from` (a file or a folder) to `to`; into an existing folder entry by entry, keeping what is there. */
function moveMerging(from: string, to: string, report: DefaultSessionMigrationReport): void {
    let st: fs.Stats;
    try { st = fs.statSync(from); } catch { return; }
    if (!fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        report.moved.push(`${from} -> ${to}`);
        return;
    }
    if (!st.isDirectory() || !fs.statSync(to).isDirectory()) { report.kept.push(from); return; }
    for (const e of fs.readdirSync(from)) { moveMerging(path.join(from, e), path.join(to, e), report); }
    try { if (fs.readdirSync(from).length === 0) { fs.rmdirSync(from); } } catch { /* kept entries stay */ }
}

/**
 * The bare `default` session of an older build becomes `default@default`, the
 * default run's default session (vscimpb151, decision (a)): its session file
 * (`history/default.session.json`), its storage root (`history/sessions/default/`)
 * and its quest memory (`_ai/memory/<quest>/default/`) move to the new name —
 * into what is already there entry by entry, an existing file kept (named in
 * `kept`) — and every other session file of the quest based on `default` is
 * based on `default@default`. Safe to run at every start: with nothing under
 * the old name it does nothing.
 */
export function migrateDefaultSessionName(layout: { quest: string; historyRoot: string; memoryRoot: string }): DefaultSessionMigrationReport {
    const report: DefaultSessionMigrationReport = { migrated: false, moved: [], kept: [], rebased: [] };
    const oldName = LEGACY_DEFAULT_SESSION;
    const newName = DEFAULT_RUN_SESSION;
    moveMerging(path.join(layout.historyRoot, `${oldName}.session.json`), path.join(layout.historyRoot, `${newName}.session.json`), report);
    moveMerging(path.join(layout.historyRoot, SESSIONS_FOLDER, oldName), path.join(layout.historyRoot, SESSIONS_FOLDER, newName), report);
    moveMerging(path.join(layout.memoryRoot, layout.quest, oldName), path.join(layout.memoryRoot, layout.quest, newName), report);
    let files: string[] = [];
    try { files = fs.readdirSync(layout.historyRoot).filter((f) => f.endsWith('.session.json')); } catch { /* no history yet */ }
    for (const f of files) {
        const file = path.join(layout.historyRoot, f);
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            if (raw && raw.basedOn === oldName) {
                raw.basedOn = newName;
                fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
                report.rebased.push(file);
            }
        } catch { /* not a session file we can read: left as it is */ }
    }
    report.migrated = report.moved.length > 0 || report.rebased.length > 0;
    return report;
}

/**
 * The rules `_ai/.gitignore` carries for session storage and the quest's
 * derived files (relative to the `_ai` root). Untracked: a host's session
 * storage `history/<host>/sessions/` (class D), the derived history of the
 * quest (`history/compacted_history.md`, `history.json`, `history.md`,
 * `history.watermark.json`; class C), the refresh notes and every live trail.
 * OLD PLACE: in `history/sessions/<name>/` the rolling tail and accumulator, a
 * per-iteration session's marker, the summary trail pair, the raw trail and
 * the migration marker (a machine pulling another's marker would never move
 * its own untracked files). Tracked: the session files
 * `history/<host>/<name>.session.json` and the host trails
 * `history/trail.<host>.md`. A file git already tracks stays tracked until
 * the `_ai` format migration removes it from the index.
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
    'quests/*/history/*/sessions/',
    'quests/*/history/compacted_history.md',
    'quests/*/history/history.json',
    'quests/*/history/history.md',
    'quests/*/history/history.watermark.json',
    'quests/*/quest_refresh.*.md',
    'quests/*/history/**/live-trail.md',
];
