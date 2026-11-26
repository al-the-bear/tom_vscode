/**
 * The session files of one quest's history folder: list, read, create, and
 * save a session id without losing what else the file says. The rules — what
 * a session's next prompt resumes — are in src/utils/agentSdkSessions.ts.
 *
 * Sessions belong to one machine: each host keeps its sessions' definition
 * and state in `_ai/quests/<quest>/history/<host>/<name>.session.json`
 * (tracked, written only by that host; `<host>` is hostSlugOf()). Every
 * function takes the quest's `history/` folder.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    contributesToTrailAndMemory,
    isValidSessionName,
    normalizeSessionMode,
    parseSessionRecord,
    planSessionStart,
    sortSessions,
    type SessionMode,
    type SessionRecord,
    type SessionStart,
} from '../utils/agentSdkSessions';
import type { SessionProfile, SessionSpec } from '../utils/sessionSpecs';
import { writeFileAtomic } from '../utils/atomicWrite';
import { hostSlugOf } from '../utils/hostSlug';
import { DEFAULT_RUN_SESSION, canonicalSessionName, runDefaultSession } from '../utils/runSessions';

const SUFFIX = '.session.json';

/** This host's folder of session files under the quest's `history/` folder. */
function hostFolder(folder: string): string {
    return path.join(folder, hostSlugOf());
}

/** The session file of `name`, read and written: `history/<host>/<name>.session.json`. */
export function sessionFilePath(folder: string, name: string): string {
    return path.join(hostFolder(folder), `${canonicalSessionName(name)}${SUFFIX}`);
}

function fileOf(folder: string, name: string): string {
    return sessionFilePath(folder, name);
}

export function readSession(folder: string, name: string): SessionRecord | undefined {
    const file = fileOf(folder, name);
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) { return undefined; }
        return parseSessionRecord(name, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
        return undefined;
    }
}

/** This host's sessions (`history/<host>/`), sorted by name; unreadable files are skipped. */
export function listSessions(folder: string): SessionRecord[] {
    const names = new Set<string>();
    let entries: string[] = [];
    try { entries = fs.readdirSync(hostFolder(folder)); } catch { /* no sessions yet */ }
    for (const f of entries) {
        if (f.endsWith(SUFFIX)) { names.add(f.slice(0, -SUFFIX.length)); }
    }
    const out: SessionRecord[] = [];
    for (const name of names) {
        const r = readSession(folder, name);
        if (r) { out.push(r); }
    }
    return sortSessions(out);
}

function write(folder: string, record: SessionRecord): void {
    const { name: _name, ...body } = record;
    const file = fileOf(folder, record.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
    notifySessionsChanged(folder);
}

type SessionsListener = (folder: string) => void;
const sessionsListeners = new Set<SessionsListener>();

/**
 * Be told whenever a session file of any folder is written or removed through
 * this store (the SESSIONS view refreshes on it; its file watcher catches the
 * writes of other windows). Returns the unsubscribe function.
 */
export function onSessionsChanged(listener: SessionsListener): () => void {
    sessionsListeners.add(listener);
    return () => { sessionsListeners.delete(listener); };
}

function notifySessionsChanged(folder: string): void {
    for (const l of [...sessionsListeners]) {
        try { l(folder); } catch { /* a listener's failure is its own */ }
    }
}

export type CreateSessionResult = { ok: true; session: SessionRecord } | { ok: false; error: string };

/** What a new session starts with besides its name. */
export interface CreateSessionOptions {
    basedOn?: string;
    /** A lifetime; the legacy `fork-from-base` reads as `per-prompt`. Default `continue`. */
    mode?: SessionMode | 'fork-from-base';
    /**
     * The Anthropic profile the session runs with, and that profile's configured
     * model. Unset: the base's, if any; `null`: none, even when the base has one.
     */
    profile?: { id: string; model?: string } | null;
    /**
     * Whether the session's turns go into the host trail, memory and the
     * history. Unset: the base's setting, without a base `true`.
     */
    contributesToTrailAndMemory?: boolean;
}

/**
 * Create a session, fresh or based on another one; nothing is overwritten. A
 * based session without its own profile takes its base's.
 */
export function createSession(folder: string, name: string, opts: CreateSessionOptions): CreateSessionResult {
    if (!isValidSessionName(name)) {
        return { ok: false, error: `"${name}" is not a session name: letters, digits, "_" and "-" only, starting with a letter or digit.` };
    }
    if (readSession(folder, name) || fs.existsSync(fileOf(folder, name))) {
        return { ok: false, error: `The session "${name}" already exists.` };
    }
    const mode = opts.mode === undefined ? 'continue' : normalizeSessionMode(opts.mode);
    if (!mode) {
        return { ok: false, error: `"${String(opts.mode)}" is not a session lifetime: continue, per-prompt or per-iteration.` };
    }
    const base = opts.basedOn ? readSession(folder, opts.basedOn) : undefined;
    if (opts.basedOn && !base) {
        return { ok: false, error: `There is no session "${opts.basedOn}" to base "${name}" on.` };
    }
    const inherit = opts.profile === undefined;
    const profileId = opts.profile ? opts.profile.id : inherit ? base?.profileId : undefined;
    const model = opts.profile ? opts.profile.model : inherit ? base?.model : undefined;
    const contributes = opts.contributesToTrailAndMemory ?? contributesToTrailAndMemory(base);
    const now = new Date().toISOString();
    const session: SessionRecord = {
        name,
        mode,
        ...(opts.basedOn ? { basedOn: opts.basedOn } : {}),
        ...(profileId ? { profileId } : {}),
        createdAt: now,
        updatedAt: now,
        ...(model ? { model } : {}),
        contributesToTrailAndMemory: contributes,
    };
    write(folder, session);
    return { ok: true, session };
}

/**
 * Turn session `name`'s trail and memory contribution on or off, keeping the
 * file's other fields. False when there is no session file.
 */
export function setContributesToTrailAndMemory(folder: string, name: string, value: boolean): boolean {
    const existing = readSession(folder, name);
    if (!existing) { return false; }
    write(folder, { ...existing, contributesToTrailAndMemory: value, updatedAt: new Date().toISOString() });
    return true;
}

/** Whether session `name`'s turns go into the host trail and memory: its setting, on without a file. */
export function sessionContributesToTrailAndMemory(folder: string, name: string): boolean {
    return contributesToTrailAndMemory(readSession(folder, name));
}

/**
 * Save the SDK session id `name` continues, keeping the file's other fields.
 * With `iterationKey` the id is the conversation of that iteration (a
 * per-iteration session), replacing the previous iteration's.
 */
export function saveSessionId(folder: string, name: string, sessionId: string, model?: string, iterationKey?: string): void {
    if (!sessionId) { return; }
    const existing = readSession(folder, name);
    if (iterationKey) {
        if (existing?.iteration?.key === iterationKey && existing.iteration.sessionId === sessionId) { return; }
        write(folder, {
            ...(existing ?? { name, mode: 'per-iteration' as const }),
            name,
            iteration: { key: iterationKey, sessionId },
            updatedAt: new Date().toISOString(),
            ...(model ? { model } : {}),
        });
        return;
    }
    if (existing?.sessionId === sessionId) { return; }
    write(folder, {
        ...(existing ?? { name, mode: 'continue' as const }),
        name,
        sessionId,
        updatedAt: new Date().toISOString(),
        ...(model ? { model } : {}),
    });
}

/**
 * Forget the conversation of `name` (the panel's "clear session", the
 * SESSIONS view's Reset): the stored session id, the current iteration's and
 * the model the last send reported go; the name, base, lifetime, profile and
 * the profile's configured model stay, so the next prompt starts a new
 * conversation — a based session re-forked from the same base. The file is
 * kept, so the session stays listed; nothing is written when there is no file.
 * Only the `.session.json` is touched: a direct-API history folder stays.
 */
export function clearSessionId(folder: string, name: string): void {
    const existing = readSession(folder, name);
    if (!existing) { return; }
    const { sessionId: _dropped, iteration: _iteration, ...rest } = existing;
    // The model the last send reported goes with the conversation; a profile's configured model stays.
    const kept = rest.profileId ? rest : (({ model: _model, ...noModel }) => noModel)(rest);
    write(folder, { ...kept, updatedAt: new Date().toISOString() });
}

/**
 * Forget the SDK session id `sessionId` wherever a session of `folder` holds
 * it — as its own conversation, as the current iteration's, or (for the
 * sessions based on it) as the base it forks from: each such session is reset
 * like {@link clearSessionId}. For a conversation Claude Code no longer has
 * ("No conversation found with session ID"): the next prompt starts a new one
 * instead of failing the same way. Answers the sessions it reset.
 */
export function forgetSessionId(folder: string, sessionId: string): string[] {
    if (!sessionId) { return []; }
    const holders = listSessions(folder).filter((r) => r.sessionId === sessionId || r.iteration?.sessionId === sessionId);
    for (const r of holders) { clearSessionId(folder, r.name); }
    return holders.map((r) => r.name);
}

/** The sessions that are based on `name`. */
export function sessionsBasedOn(folder: string, name: string): string[] {
    return listSessions(folder).filter((s) => s.basedOn === name).map((s) => s.name);
}

export type DeleteSessionResult = { ok: true; deleted: boolean } | { ok: false; error: string; dependents: string[] };

/**
 * Remove the `.session.json` of `name`. Refused while another session is
 * based on it (naming them). Only the file goes: a direct-API history folder
 * (`sessions/<name>/`) stays. `deleted: false` when there was no file.
 */
export function deleteSession(folder: string, name: string): DeleteSessionResult {
    const dependents = sessionsBasedOn(folder, name);
    if (dependents.length > 0) {
        return {
            ok: false,
            dependents,
            error: `The session "${name}" is the base of ${dependents.map((d) => `"${d}"`).join(', ')}; delete or re-create those first.`,
        };
    }
    const file = fileOf(folder, name);
    if (!fs.existsSync(file)) { return { ok: true, deleted: false }; }
    fs.unlinkSync(file);
    notifySessionsChanged(folder);
    return { ok: true, deleted: true };
}

/** How the next prompt in session `name` starts, from the folder's files. */
export function planSessionStartIn(folder: string, name: string, iterationKey?: string): SessionStart {
    return planSessionStart(name, (n) => readSession(folder, n), iterationKey);
}

export type EnsureSessionResult = { ok: true; created: string[] } | { ok: false; error: string };

/**
 * Make sure the session `spec` names exists: created from the spec when it is
 * missing — its base first, plainly, when that is missing too — and left as
 * it is when it exists. The profile is the spec's, else `fallbackProfileId`
 * (a queue item's own profile), else the base's; `profileOf` resolves an id to
 * the profile and its model, and an unknown spec profile is refused. Answers
 * the sessions it created.
 */
/**
 * The default session of run `run`, `default@<run>` (vscimpb151), created when missing: for the `default` run
 * `default@default` fresh, for another run based on `default@default` (made first when missing). Answers the
 * sessions it created.
 */
export function ensureRunDefaultSession(folder: string, run: string | undefined): string[] {
    const name = runDefaultSession(run);
    if (readSession(folder, name)) { return []; }
    const created: string[] = [];
    const baseThere = (): boolean => !!readSession(folder, DEFAULT_RUN_SESSION);
    if (name !== DEFAULT_RUN_SESSION && !baseThere()) {
        const base = createSession(folder, DEFAULT_RUN_SESSION, {});
        if (base.ok) { created.push(DEFAULT_RUN_SESSION); }
    }
    const made = createSession(folder, name, name === DEFAULT_RUN_SESSION ? {} : { basedOn: DEFAULT_RUN_SESSION });
    if (made.ok) { created.push(name); }
    return created;
}

export function ensureSession(
    folder: string,
    spec: SessionSpec,
    profileOf: (id: string) => SessionProfile | undefined,
    fallbackProfileId?: string,
): EnsureSessionResult {
    if (readSession(folder, spec.name)) { return { ok: true, created: [] }; }
    let profile: SessionProfile | undefined;
    if (spec.profile) {
        profile = profileOf(spec.profile);
        if (!profile) { return { ok: false, error: `Session "${spec.name}": there is no Anthropic profile "${spec.profile}".` }; }
    } else if (fallbackProfileId) {
        profile = profileOf(fallbackProfileId);
    }
    const created: string[] = [];
    if (spec.basedOn && !readSession(folder, spec.basedOn)) {
        const base = createSession(folder, spec.basedOn, {});
        if (!base.ok) { return base; }
        created.push(spec.basedOn);
    }
    const made = createSession(folder, spec.name, {
        basedOn: spec.basedOn,
        mode: spec.mode,
        ...(profile ? { profile: { id: profile.id, model: profile.model } } : {}),
        ...(spec.contributesToTrailAndMemory !== undefined ? { contributesToTrailAndMemory: spec.contributesToTrailAndMemory } : {}),
    });
    if (!made.ok) { return made; }
    created.push(spec.name);
    return { ok: true, created };
}
