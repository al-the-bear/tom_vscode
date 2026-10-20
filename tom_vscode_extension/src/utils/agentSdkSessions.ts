/**
 * Named Agent SDK sessions — pure rules, no IO.
 *
 * A session is a file `<name>.session.json` in the quest's history folder
 * (`_ai/quests/<quest>/history/`, machine-local, gitignored): the Agent SDK
 * session id it continues, and optionally the session it is based on and how.
 * The chat panel uses `chat`, the prompt queue `default` unless another session
 * is chosen; any other name is a session the user (or an agent) created.
 *
 * - `continue` (the default): prompts continue the session. A new session
 *   based on another one starts as a fork of the base's conversation on its
 *   first prompt and continues on its own from there.
 * - `fork-from-base`: every prompt starts again from the base session's current
 *   conversation (an SDK fork) and is never saved back, so the base can hold
 *   preparatory context while the prompts in this session do not change the
 *   context of the ones after them.
 *
 * Sessions apply to the Agent SDK transport in sdk-managed history mode; the
 * direct API transport keeps its single per-quest history.
 */

export type SessionMode = 'continue' | 'fork-from-base';

export interface SessionRecord {
    name: string;
    /** The Agent SDK session this session continues; absent until its first prompt. */
    sessionId?: string;
    mode: SessionMode;
    /** The session this one is based on. */
    basedOn?: string;
    createdAt?: string;
    updatedAt?: string;
    model?: string;
}

/** How a prompt starts in a session. */
export interface SessionStart {
    /** The SDK session id to resume; absent for a fresh session. */
    resume?: string;
    /** Resume as a fork (`forkSession`): the resumed session is not changed. */
    fork: boolean;
    /** Save the session id the SDK reports as this session's own. */
    persist: boolean;
    /** Why the start is not what the session asks for (e.g. a base with no conversation yet). */
    note?: string;
}

export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidSessionName(name: string): boolean {
    return SESSION_NAME_PATTERN.test(name);
}

/** A session file's JSON as a record; undefined when it is not an object. */
export function parseSessionRecord(name: string, raw: unknown): SessionRecord | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { return undefined; }
    const r = raw as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? r[k] as string : undefined);
    const out: SessionRecord = { name, mode: r.mode === 'fork-from-base' ? 'fork-from-base' : 'continue' };
    for (const k of ['sessionId', 'basedOn', 'createdAt', 'updatedAt', 'model'] as const) {
        const v = str(k);
        if (v !== undefined) { out[k] = v; }
    }
    // Keep the documented key order (name, sessionId, mode, basedOn, …) stable for deepEqual and the file.
    const ordered: SessionRecord = { name: out.name, ...(out.sessionId ? { sessionId: out.sessionId } : {}), mode: out.mode };
    for (const k of ['basedOn', 'createdAt', 'updatedAt', 'model'] as const) { if (out[k] !== undefined) { ordered[k] = out[k]; } }
    return ordered;
}

/**
 * The conversation a fork of `name` starts from: its own id, or — for a
 * fork-from-base session, which never has a conversation of its own — its
 * base's, recursively. Undefined when there is none yet.
 */
function conversationOf(name: string, read: (n: string) => SessionRecord | undefined, seen: Set<string>): string | undefined {
    if (seen.has(name)) { throw new Error(`Session "${name}" is part of a cycle of base sessions (${[...seen, name].join(' → ')}).`); }
    seen.add(name);
    const r = read(name);
    if (!r) { return undefined; }
    if (r.mode === 'fork-from-base') {
        if (!r.basedOn) { throw new Error(`Session "${name}" is re-created from its base for every prompt but names no base.`); }
        return conversationOf(r.basedOn, read, seen);
    }
    return r.sessionId;
}

/** How a prompt in session `name` starts. Throws for a cycle or a fork-from-base session without a base. */
export function planSessionStart(name: string, read: (n: string) => SessionRecord | undefined): SessionStart {
    const r = read(name);
    if (!r) { return { fork: false, persist: true }; }
    if (r.mode === 'fork-from-base') {
        if (!r.basedOn) { throw new Error(`Session "${name}" is re-created from its base for every prompt but names no base.`); }
        const base = conversationOf(r.basedOn, read, new Set([name]));
        return base
            ? { resume: base, fork: true, persist: false }
            : { fork: false, persist: false, note: `The base session "${r.basedOn}" has no conversation yet: this prompt starts fresh.` };
    }
    if (r.sessionId) { return { resume: r.sessionId, fork: false, persist: true }; }
    if (r.basedOn) {
        const base = conversationOf(r.basedOn, read, new Set([name]));
        if (base) { return { resume: base, fork: true, persist: true }; }
        return { fork: false, persist: true, note: `The base session "${r.basedOn}" has no conversation yet: "${name}" starts fresh.` };
    }
    return { fork: false, persist: true };
}

/**
 * Whether an attempt resumes as a fork: only when the session asks to fork and
 * the attempt resumes the ORIGINAL base id. A retry that resumes the fork the
 * first attempt produced continues that fork.
 */
export function shouldForkAttempt(fork: boolean | undefined, originalResume: string | undefined, attemptResume: string | undefined): boolean {
    return fork === true && attemptResume !== undefined && attemptResume === originalResume;
}

export function sortSessions(records: SessionRecord[]): SessionRecord[] {
    return [...records].sort((a, b) => a.name.localeCompare(b.name));
}

/** One line for the picker. */
export function describeSession(r: SessionRecord): string {
    if (r.mode === 'fork-from-base') { return `fresh from "${r.basedOn ?? '?'}" for every prompt`; }
    if (r.basedOn) { return `continues; started from "${r.basedOn}"`; }
    return r.sessionId ? 'continues' : 'continues (not started yet)';
}
