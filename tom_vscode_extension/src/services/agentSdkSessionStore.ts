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
 * Forget the conversation of `name` (the panel's "clear session"). A file that
 * is only a stored id (the panel's and the queue's own buckets) is removed; a
 * session someone created — by name, with a base, a lifetime or a profile —
 * keeps its definition (and its profile and configured model) and starts again
 * from it.
 */
export function clearSessionId(folder: string, name: string): void {
    const existing = readSession(folder, name);
    const file = fileOf(folder, name);
    if (!existing || (!existing.basedOn && existing.mode === 'continue' && !existing.createdAt && !existing.profileId)) {
        if (fs.existsSync(file)) { fs.unlinkSync(file); }
        return;
    }
    const { sessionId: _dropped, iteration: _iteration, ...rest } = existing;
    // The model the last send reported goes with the conversation; a profile's configured model stays.
    const kept = rest.profileId ? rest : (({ model: _model, ...noModel }) => noModel)(rest);
    write(folder, { ...kept, updatedAt: new Date().toISOString() });
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
