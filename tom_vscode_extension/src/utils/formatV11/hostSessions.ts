/**
 * Format version 11, step module `hostSessions` (see context.ts): a quest's sessions belong to the host that
 * runs them (ai_format_migration.md § 3.2, CQ-7, CQ-14, CQ-18). Per quest of `ctx.quests`, in this order:
 *
 *   - **host-trail**: every summary trail pair of an Anthropic session — `<q>.anthropic.prompts.md` /
 *     `.answers.md` in a session's storage (`history/sessions/<s>/`, `history/<host>/sessions/<s>/`) and in
 *     `history/` itself (the queue's session `default@default`) — becomes turn blocks of this host's trail
 *     `history/trail.<host>.md` (src/services/hostTrail.ts): one turn per prompt, paired with its answer by
 *     request id, of this host and the storage's session, merged with the trail by turn id and sorted by time;
 *     over `trail.compact.maxEntries` only covered turns are trimmed. Then the pair is deleted. The pairs are
 *     gitignored, so every host converts its own.
 *   - **host-sessions**: every session definition `history/<s>.session.json` moves to
 *     `history/<host>/<s>.session.json` (`contributesToTrailAndMemory: true` when absent; a bare `default`
 *     is `default@default`, also as a `basedOn`); a target that exists wins, the old file goes when it says
 *     the same, else it is a problem. Every working storage `history/sessions/<s>/` moves, file by file, to
 *     `history/<host>/sessions/<s>/` (a file there already: identical → the old one goes; the rolling tail,
 *     accumulator and iteration marker → the newer wins; the live trail → the `ai-trail` merge; a tool
 *     result whose number is taken → the next free number; anything else → a problem), except the old
 *     session history `compacted_history.md`, `history.json`, `history.md`, which stays for the quest
 *     history's first build (it reads them while the quest has no history, then deletes them; CQ-19).
 *     Every `trail/current_prompt.*.md` of a session storage is deleted, and the storage marker
 *     `history/sessions/.storage-version`. A host whose definitions another host moved already (they came
 *     with a reconcile): a storage of this host whose session has no definition at the old place gets a copy
 *     of another host's definition, without its conversation (`sessionId`, `iteration`, the model the last
 *     send reported); with none anywhere the storage moves alone (the session's next prompt writes its
 *     definition, as for a session that has storage only).
 *
 * And last of the whole migration, {@link untrackIgnoredV11} (step `untrack`). vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type { V11Context } from './context';
import { coveredByWatermark, formatHostTrailTurn, hostTrailFile, parseHostTrail, readWatermarkHosts, type HostTrailTurn } from '../../services/hostTrail';
import {
    MIGRATION_MARKER_FILE,
    SESSIONS_FOLDER,
    SESSION_LIVE_TRAIL_FILE,
    SESSION_TRAIL_FOLDER,
    TOOL_RESULTS_FOLDER,
    nextFreeToolResultIndex,
} from '../../services/sessionStorage';
import { readTrailFile } from '../../tools/prompt-history-utils';
import { compactTrailMaxEntries, hostTrailTurnsToKeep } from '../compactTrailTrim';
import { canonicalSessionName, DEFAULT_RUN_SESSION } from '../runSessions';
import { makeBuiltinMerger } from '../aiMergeDrivers';

const SESSION_SUFFIX = '.session.json';
/** The old session history: stays in `history/sessions/<s>/` for the quest history's first build. */
const OLD_HISTORY_FILES = new Set(['compacted_history.md', 'history.json', 'history.md']);
/** Machine-local scratch files: the newer copy wins. */
const SCRATCH_FILES = new Set(['rawTurns.json', 'compaction_rounds.json', 'iteration.json']);

function entries(folder: string): fs.Dirent[] {
    try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
}

/** Every file below `folder`, relative to it. */
function filesBelow(folder: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of entries(path.join(folder, rel))) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) { out.push(...filesBelow(folder, r)); } else if (e.isFile()) { out.push(r); }
    }
    return out;
}

function removeEmptyDirs(folder: string): void {
    for (const e of entries(folder)) {
        if (e.isDirectory()) { removeEmptyDirs(path.join(folder, e.name)); }
    }
    try { if (fs.readdirSync(folder).length === 0) { fs.rmdirSync(folder); } } catch { /* gone or not empty */ }
}

/** `trail.compact.maxEntries` of the workspace configuration, else the default. */
function trailMaxEntries(ctx: V11Context): number {
    let trail: unknown;
    if (ctx.workspaceConfigPath) {
        try { trail = (JSON.parse(fs.readFileSync(ctx.workspaceConfigPath, 'utf8')) as { trail?: unknown }).trail; } catch { /* the default */ }
    }
    return compactTrailMaxEntries(trail);
}

/** Whether `name` is the Anthropic summary pair of quest `quest`. */
function isAnthropicPair(name: string, quest: string): boolean {
    return name === `${quest}.anthropic.prompts.md` || name === `${quest}.anthropic.answers.md`;
}

/** A trail's current-prompt file (`trail/current_prompt.<source>.<variant>.md`), relative to the storage root. */
function isCurrentPrompt(rel: string): boolean {
    const parts = rel.split(path.sep);
    return parts.length === 2 && parts[0] === SESSION_TRAIL_FOLDER && parts[1].startsWith('current_prompt.') && parts[1].endsWith('.md');
}

/** The turns of one summary pair: a turn per prompt, its answer by request id, oldest first. */
export function pairTurns(promptsFile: string, answersFile: string, host: string, session: string): HostTrailTurn[] {
    const prompts = readTrailFile(promptsFile).filter((e) => e.kind === 'PROMPT');
    const answers = readTrailFile(answersFile).filter((e) => e.kind === 'ANSWER');
    const answerById = new Map<string, string>();
    for (const a of answers) { if (!answerById.has(a.requestId)) { answerById.set(a.requestId, a.body); } }
    const seen = new Set<string>();
    const turns: HostTrailTurn[] = [];
    for (const p of prompts) {
        if (seen.has(p.requestId)) { continue; }
        seen.add(p.requestId);
        turns.push({
            id: p.requestId, time: p.timestamp, host, session, profile: '', model: '',
            prompt: p.body, answer: answerById.get(p.requestId) ?? '',
        });
    }
    return sortByTime(turns);
}

/** Sorted by time, oldest first; turns of the same time keep their order. */
function sortByTime(turns: HostTrailTurn[]): HostTrailTurn[] {
    const at = (t: HostTrailTurn): number => { const n = Date.parse(t.time); return Number.isFinite(n) ? n : 0; };
    return turns.map((t, i) => ({ t, i })).sort((a, b) => at(a.t) - at(b.t) || a.i - b.i).map((x) => x.t);
}

// ---------------------------------------------------------------------------
// host-trail
// ---------------------------------------------------------------------------

/** One summary pair to convert: its session and files (either may be missing). */
interface PairSource { session: string; prompts: string; answers: string }

function pairSources(ctx: V11Context, quest: string): PairSource[] {
    const history = path.join(ctx.aiRoot, 'quests', quest, 'history');
    const out: PairSource[] = [];
    const add = (session: string, folder: string): void => {
        const prompts = path.join(folder, `${quest}.anthropic.prompts.md`);
        const answers = path.join(folder, `${quest}.anthropic.answers.md`);
        if (fs.existsSync(prompts) || fs.existsSync(answers)) { out.push({ session: canonicalSessionName(session), prompts, answers }); }
    };
    add(DEFAULT_RUN_SESSION, history);
    for (const base of [path.join(history, SESSIONS_FOLDER), path.join(history, ctx.hostSlug, SESSIONS_FOLDER)]) {
        for (const e of entries(base)) { if (e.isDirectory()) { add(e.name, path.join(base, e.name)); } }
    }
    return out;
}

function migrateHostTrail(ctx: V11Context, quest: string, maxEntries: number): void {
    const sources = pairSources(ctx, quest);
    if (sources.length === 0) { return; }
    const questFolder = path.join(ctx.aiRoot, 'quests', quest);
    const trailFile = hostTrailFile(questFolder, ctx.hostSlug);
    let existingText = '';
    try { existingText = fs.readFileSync(trailFile, 'utf8'); } catch { /* no trail yet */ }
    const turns = parseHostTrail(existingText);
    const ids = new Set(turns.map((t) => t.id));
    let added = 0;
    for (const src of sources) {
        let fresh = 0;
        for (const t of pairTurns(src.prompts, src.answers, ctx.hostSlug, src.session)) {
            if (ids.has(t.id)) { continue; }
            ids.add(t.id);
            turns.push(t);
            fresh++;
        }
        added += fresh;
        const files = [src.prompts, src.answers].filter((f) => fs.existsSync(f));
        ctx.change(quest, 'host-trail', `${files.map((f) => ctx.rel(f)).join(' + ')}: ${fresh} turn(s) of session ${src.session} into ${ctx.rel(trailFile)}; the pair deleted`);
    }
    if (!ctx.apply) { return; }
    if (added > 0) {
        const hosts = readWatermarkHosts(questFolder);
        const kept = hostTrailTurnsToKeep(sortByTime(turns), maxEntries, (t) => coveredByWatermark(t, hosts));
        fs.mkdirSync(path.dirname(trailFile), { recursive: true });
        fs.writeFileSync(trailFile, kept.map(formatHostTrailTurn).join(''), 'utf8');
    }
    for (const src of sources) {
        for (const f of [src.prompts, src.answers]) { fs.rmSync(f, { force: true }); }
    }
}

// ---------------------------------------------------------------------------
// host-sessions
// ---------------------------------------------------------------------------

type SessionData = Record<string, unknown>;

/** The definition as the new place keeps it: canonical base, `contributesToTrailAndMemory` set. */
function normalizedDefinition(data: SessionData): SessionData {
    const out: SessionData = { ...data };
    if (typeof out.basedOn === 'string') { out.basedOn = canonicalSessionName(out.basedOn); }
    if (typeof out.contributesToTrailAndMemory !== 'boolean') { out.contributesToTrailAndMemory = true; }
    return out;
}

function readJson(file: string): SessionData | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as SessionData : undefined;
    } catch {
        return undefined;
    }
}

function writeJson(file: string, data: SessionData): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Move the definitions of `history/`; answers the (canonical) names of those found there. */
function moveDefinitions(ctx: V11Context, quest: string, history: string, hostFolder: string): Set<string> {
    const names = new Set<string>();
    // A canonical name before its bare form, so `default@default.session.json` is moved before `default.session.json`.
    const files = entries(history).filter((e) => e.isFile()).map((e) => e.name)
        .sort((a, b) => Number(a === `default${SESSION_SUFFIX}`) - Number(b === `default${SESSION_SUFFIX}`) || a.localeCompare(b));
    for (const name of files) {
        const from = path.join(history, name);
        if (name.endsWith(`${SESSION_SUFFIX}.tmp`)) {
            ctx.change(quest, 'host-sessions', `remove ${ctx.rel(from)} (a write's leftover)`);
            if (ctx.apply) { fs.rmSync(from, { force: true }); }
            continue;
        }
        if (!name.endsWith(SESSION_SUFFIX)) { continue; }
        const session = canonicalSessionName(name.slice(0, -SESSION_SUFFIX.length));
        names.add(session);
        const data = readJson(from);
        if (!data) {
            ctx.problem(quest, 'host-sessions', `${ctx.rel(from)} is not readable JSON; left where it is`);
            continue;
        }
        const next = normalizedDefinition(data);
        const to = path.join(hostFolder, `${session}${SESSION_SUFFIX}`);
        if (fs.existsSync(to)) {
            const there = readJson(to);
            if (there && isDeepStrictEqual(normalizedDefinition(there), next)) {
                ctx.change(quest, 'host-sessions', `remove ${ctx.rel(from)} (the same as ${ctx.rel(to)})`);
                if (ctx.apply) { fs.rmSync(from, { force: true }); }
            } else {
                ctx.problem(quest, 'host-sessions', `${ctx.rel(from)}: ${ctx.rel(to)} exists with other content; both kept`);
            }
            continue;
        }
        ctx.change(quest, 'host-sessions', `move ${ctx.rel(from)} -> ${ctx.rel(to)}${data.contributesToTrailAndMemory === undefined ? ' (contributes to trail and memory)' : ''}`);
        if (ctx.apply) { writeJson(to, next); fs.rmSync(from, { force: true }); }
    }
    return names;
}

/**
 * Move or merge one file of a session storage. What cannot be merged stays (a problem). `next` counts the
 * next free tool-result number per folder across the files of one run.
 */
function placeFile(ctx: V11Context, quest: string, from: string, to: string, next: Map<string, number>): boolean {
    const { apply } = ctx;
    if (!fs.existsSync(to)) {
        ctx.change(quest, 'host-sessions', `move ${ctx.rel(from)} -> ${ctx.rel(to)}`);
        if (apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
        return true;
    }
    if (fs.readFileSync(from).equals(fs.readFileSync(to))) {
        ctx.change(quest, 'host-sessions', `remove ${ctx.rel(from)} (identical to ${ctx.rel(to)})`);
        if (apply) { fs.unlinkSync(from); }
        return true;
    }
    const name = path.basename(to);
    const folder = path.dirname(to);
    if (path.basename(folder) === TOOL_RESULTS_FOLDER && /^t\d+\.json$/.test(name)) {
        const n = next.get(folder) ?? nextFreeToolResultIndex(folder);
        next.set(folder, n + 1);
        const renamed = path.join(folder, `t${n}.json`);
        ctx.change(quest, 'host-sessions', `move ${ctx.rel(from)} -> ${ctx.rel(renamed)} (number taken)`);
        if (apply) { fs.renameSync(from, renamed); }
        return true;
    }
    if (SCRATCH_FILES.has(name) || name.endsWith('.tmp')) {
        const oldNewer = fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs;
        ctx.change(quest, 'host-sessions', oldNewer ? `replace ${ctx.rel(to)} with the newer ${ctx.rel(from)}` : `remove ${ctx.rel(from)} (${ctx.rel(to)} is newer)`);
        if (apply) { if (oldNewer) { fs.renameSync(from, to); } else { fs.unlinkSync(from); } }
        return true;
    }
    if (name === SESSION_LIVE_TRAIL_FILE) {
        const merged = makeBuiltinMerger()('ai-trail', to, from);
        if (merged === undefined) {
            ctx.problem(quest, 'host-sessions', `${ctx.rel(from)}: the ai-trail merge into ${ctx.rel(to)} failed; both kept`);
            return false;
        }
        ctx.change(quest, 'host-sessions', `merge ${ctx.rel(from)} into ${ctx.rel(to)} (ai-trail)`);
        if (apply) { fs.writeFileSync(to, merged, 'utf8'); fs.unlinkSync(from); }
        return true;
    }
    ctx.problem(quest, 'host-sessions', `${ctx.rel(from)}: ${ctx.rel(to)} exists with other content, and no merge rule applies; both kept`);
    return false;
}

/** Another host's definition of `session` (the first host folder holding one), or undefined. */
function otherHostDefinition(history: string, host: string, session: string): string | undefined {
    for (const e of entries(history).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || e.name === host || e.name === SESSIONS_FOLDER) { continue; }
        const file = path.join(history, e.name, `${session}${SESSION_SUFFIX}`);
        if (fs.existsSync(file)) { return file; }
    }
    return undefined;
}

/** A definition without what belongs to the host that ran it: its conversation and the model its last send reported. */
export function definitionWithoutConversation(data: SessionData): SessionData {
    const { sessionId: _s, iteration: _i, ...rest } = data;
    const out: SessionData = typeof rest.profileId === 'string' && rest.profileId ? rest : (({ model: _m, ...noModel }) => noModel)(rest);
    return normalizedDefinition(out);
}

function moveStorages(ctx: V11Context, quest: string, history: string, hostFolder: string, definitions: Set<string>): void {
    const oldBase = path.join(history, SESSIONS_FOLDER);
    const newBase = path.join(hostFolder, SESSIONS_FOLDER);
    const next = new Map<string, number>();
    // A canonical name before its bare form (`default` merges into `default@default`).
    const folders = entries(oldBase).filter((e) => e.isDirectory()).map((e) => e.name)
        .sort((a, b) => Number(a === 'default') - Number(b === 'default') || a.localeCompare(b));
    for (const name of folders) {
        const session = canonicalSessionName(name);
        const from = path.join(oldBase, name);
        const to = path.join(newBase, session);
        let moved = false;
        for (const rel of filesBelow(from).sort()) {
            const file = path.join(from, rel);
            if (!rel.includes(path.sep) && (OLD_HISTORY_FILES.has(rel) || isAnthropicPair(rel, quest))) { continue; }
            if (isCurrentPrompt(rel)) {
                ctx.change(quest, 'host-sessions', `remove ${ctx.rel(file)} (nothing reads the current prompt)`);
                if (ctx.apply) { fs.rmSync(file, { force: true }); }
                continue;
            }
            moved = placeFile(ctx, quest, file, path.join(to, rel), next) || moved;
        }
        if (ctx.apply) { removeEmptyDirs(from); }
        // A later host: the definitions came with a reconcile into another host's folder.
        const own = path.join(hostFolder, `${session}${SESSION_SUFFIX}`);
        if (!moved || definitions.has(session) || fs.existsSync(own)) { continue; }
        const other = otherHostDefinition(history, ctx.hostSlug, session);
        const data = other ? readJson(other) : undefined;
        if (other && data) {
            ctx.change(quest, 'host-sessions', `copy ${ctx.rel(other)} -> ${ctx.rel(own)} (without its conversation)`);
            if (ctx.apply) { writeJson(own, definitionWithoutConversation(data)); }
        } else {
            ctx.change(quest, 'host-sessions', `storage of ${session} moved; no definition (its next prompt writes one)`);
        }
    }
    // The current prompt of a storage at the new place.
    for (const e of entries(newBase)) {
        if (!e.isDirectory()) { continue; }
        for (const f of entries(path.join(newBase, e.name, SESSION_TRAIL_FOLDER))) {
            const rel = path.join(SESSION_TRAIL_FOLDER, f.name);
            if (f.isFile() && isCurrentPrompt(rel)) {
                const file = path.join(newBase, e.name, rel);
                ctx.change(quest, 'host-sessions', `remove ${ctx.rel(file)} (nothing reads the current prompt)`);
                if (ctx.apply) { fs.rmSync(file, { force: true }); }
            }
        }
    }
    const marker = path.join(oldBase, MIGRATION_MARKER_FILE);
    if (fs.existsSync(marker)) {
        ctx.change(quest, 'host-sessions', `remove ${ctx.rel(marker)}`);
        if (ctx.apply) { fs.rmSync(marker, { force: true }); }
    }
    if (ctx.apply) {
        // The folder stays while the old session histories are there (the quest history's first build deletes them).
        try { if (fs.readdirSync(oldBase).length === 0) { fs.rmdirSync(oldBase); } } catch { /* gone or not empty */ }
    }
}

function migrateSessions(ctx: V11Context, quest: string): void {
    const history = path.join(ctx.aiRoot, 'quests', quest, 'history');
    if (!fs.existsSync(history)) { return; }
    const hostFolder = path.join(history, ctx.hostSlug);
    const definitions = moveDefinitions(ctx, quest, history, hostFolder);
    moveStorages(ctx, quest, history, hostFolder, definitions);
}

export function migrateV11HostSessions(ctx: V11Context): void {
    const maxEntries = trailMaxEntries(ctx);
    for (const quest of ctx.quests) {
        migrateHostTrail(ctx, quest, maxEntries);
        migrateSessions(ctx, quest);
    }
}

// ---------------------------------------------------------------------------
// untrack
// ---------------------------------------------------------------------------

/** Whether a tracked, ignored path (relative to `_ai`) is of the D / C kinds of § 3.2 this step untracks. */
export function isUntrackedKind(rel: string): boolean {
    const p = rel.split(path.sep).join('/');
    if (!p.startsWith('quests/')) { return false; }
    if (p.endsWith('/live-trail.md') || p === 'live-trail.md') { return true; }
    const parts = p.split('/');
    // quests/<q>/quest_refresh.*.md
    if (parts.length === 3 && /^quest_refresh\..+\.md$/.test(parts[2])) { return true; }
    if (parts.length < 4 || parts[2] !== 'history') { return false; }
    // quests/<q>/history/<file>
    if (parts.length === 4) { return ['compacted_history.md', 'history.json', 'history.md', 'history.watermark.json'].includes(parts[3]); }
    // quests/<q>/history/<host>/sessions/…
    return parts.length >= 6 && parts[3] !== SESSIONS_FOLDER && parts[4] === SESSIONS_FOLDER;
}

/** Last step of format version 11: untrack the tracked files `_ai`'s ignore rules now cover. */
export function untrackIgnoredV11(ctx: V11Context): void {
    // Without git there is nothing to untrack, and nothing to report (a second run lists nothing).
    if (!ctx.trackedIgnored) { return; }
    const listed = ctx.trackedIgnored();
    if (listed === undefined) {
        ctx.problem('(workspace)', 'untrack', 'the tracked files the ignore rules cover could not be listed (git ls-files failed)');
        return;
    }
    const paths = listed.filter(isUntrackedKind).sort();
    if (paths.length === 0) { return; }
    const shown = paths.slice(0, 20).join(', ') + (paths.length > 20 ? `, … (${paths.length - 20} more)` : '');
    if (!ctx.apply) {
        ctx.change('(workspace)', 'untrack', `untrack ${paths.length} file(s) the ignore rules cover (git rm --cached): ${shown}`);
        return;
    }
    if (!ctx.untrack) {
        ctx.problem('(workspace)', 'untrack', `${paths.length} file(s) to untrack, but git rm --cached is not available: ${shown}`);
        return;
    }
    const error = ctx.untrack(paths);
    if (error) {
        ctx.problem('(workspace)', 'untrack', `git rm --cached failed: ${error}`);
        return;
    }
    ctx.change('(workspace)', 'untrack', `untracked ${paths.length} file(s) the ignore rules cover (git rm --cached): ${shown}`);
}
