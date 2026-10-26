/**
 * The Agent SDK session files of one history folder
 * (`_ai/quests/<quest>/history/<name>.session.json`, machine-local): list,
 * read, create, and save a session id without losing what else the file says.
 * The rules — what a session's next prompt resumes — are in
 * src/utils/agentSdkSessions.ts.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
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

const SUFFIX = '.session.json';

function fileOf(folder: string, name: string): string {
    return path.join(folder, `${name}${SUFFIX}`);
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

/** Every session of the folder, sorted by name; unreadable files are skipped. */
export function listSessions(folder: string): SessionRecord[] {
    if (!fs.existsSync(folder)) { return []; }
    const out: SessionRecord[] = [];
    for (const f of fs.readdirSync(folder)) {
        if (!f.endsWith(SUFFIX)) { continue; }
        const r = readSession(folder, f.slice(0, -SUFFIX.length));
        if (r) { out.push(r); }
    }
    return sortSessions(out);
}

function write(folder: string, record: SessionRecord): void {
    fs.mkdirSync(folder, { recursive: true });
    const { name: _name, ...body } = record;
    const file = fileOf(folder, record.name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
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
    const now = new Date().toISOString();
    const session: SessionRecord = {
        name,
        mode,
        ...(opts.basedOn ? { basedOn: opts.basedOn } : {}),
        ...(profileId ? { profileId } : {}),
        createdAt: now,
        updatedAt: now,
        ...(model ? { model } : {}),
    };
    write(folder, session);
    return { ok: true, session };
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
    });
    if (!made.ok) { return made; }
    created.push(spec.name);
    return { ok: true, created };
}
