/**
 * Named sessions — pure rules, no IO.
 *
 * A session is a file `<name>.session.json` in the quest's history folder
 * (`_ai/quests/<quest>/history/`): the Agent SDK session id it continues,
 * optionally the session it is based on, its lifetime, and the Anthropic
 * profile (and so the model) it runs with. The chat panel uses `chat`, the
 * prompt queue `default` unless another session is chosen; any other name is
 * a session the user (or an agent) created.
 *
 * Lifetimes (`mode`), each with or without a base (`basedOn`):
 *
 * - `continue` (the default): one conversation. A session based on another
 *   starts as a fork of the base's conversation on its first prompt and
 *   continues on its own from there.
 * - `per-prompt`: every prompt starts again — fresh without a base, re-forked
 *   from the base's current conversation with one — and nothing is saved, so
 *   the base can hold preparatory context while the prompts do not change the
 *   context of the ones after them. The legacy name `fork-from-base` reads as
 *   `per-prompt` (it always had a base).
 * - `per-iteration`: one conversation per iteration of a queue item (each
 *   repeat-count round, each todo of a `<prefix>*` walk), fresh or forked from
 *   the base when the iteration starts; the iteration's pre-prompts, main
 *   prompt and follow-ups continue it. The queue names the iteration with an
 *   iteration key; a prompt sent without one (the chat panel) is its own
 *   iteration, i.e. per prompt.
 *
 * Profile: `profileId` is the Anthropic profile the session was made for and
 * `model` its model (the configured one at creation, then the one the first
 * send reports). A queue item's own profile overrides it; a session without a
 * profile runs with the queue default (item -> session -> queue default).
 *
 * On the Agent SDK transport in sdk-managed history mode the session holds the
 * SDK conversation; on the direct API transport the same names and lifetimes
 * choose the history a send reads and writes (src/services/directSessionHistory.ts).
 */

export type SessionMode = 'continue' | 'per-prompt' | 'per-iteration';

export const SESSION_MODES: readonly SessionMode[] = ['continue', 'per-prompt', 'per-iteration'];

/** A mode as written in a file, a spec or a tool call; the legacy `fork-from-base` is `per-prompt`. Undefined for anything else. */
export function normalizeSessionMode(raw: unknown): SessionMode | undefined {
    if (raw === 'fork-from-base') { return 'per-prompt'; }
    return SESSION_MODES.includes(raw as SessionMode) ? raw as SessionMode : undefined;
}

/** The conversation of the current iteration of a per-iteration session. */
export interface SessionIteration {
    key: string;
    sessionId?: string;
}

export interface SessionRecord {
    name: string;
    /** The Agent SDK session this session continues; absent until its first prompt. */
    sessionId?: string;
    mode: SessionMode;
    /** The session this one is based on. */
    basedOn?: string;
    /** The Anthropic profile the session runs with, unless a queue item names its own. */
    profileId?: string;
    createdAt?: string;
    updatedAt?: string;
    model?: string;
    /** Per-iteration sessions: the current iteration's conversation. */
    iteration?: SessionIteration;
}

/** How a prompt starts in a session. */
export interface SessionStart {
    /** The SDK session id to resume; absent for a fresh session. */
    resume?: string;
    /** Resume as a fork (`forkSession`): the resumed session is not changed. */
    fork: boolean;
    /** Save the session id the SDK reports. */
    persist: boolean;
    /** When set, the id is saved as this iteration's conversation, not as the session's own. */
    iterationKey?: string;
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
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    // Keep the documented key order (name, sessionId, mode, basedOn, profileId, …) stable for deepEqual and the file.
    const out = { name } as SessionRecord;
    const sessionId = str(r.sessionId);
    if (sessionId) { out.sessionId = sessionId; }
    out.mode = normalizeSessionMode(r.mode) ?? 'continue';
    for (const k of ['basedOn', 'profileId', 'createdAt', 'updatedAt', 'model'] as const) {
        const v = str(r[k]);
        if (v !== undefined) { out[k] = v; }
    }
    const it = r.iteration;
    if (typeof it === 'object' && it !== null && !Array.isArray(it) && str((it as Record<string, unknown>).key)) {
        const i = it as Record<string, unknown>;
        out.iteration = { key: str(i.key)!, ...(str(i.sessionId) ? { sessionId: str(i.sessionId) } : {}) };
    }
    return out as SessionRecord;
}

/**
 * The conversation a fork of `name` starts from: its own id, or — for a
 * per-prompt / per-iteration session, which keeps no lasting conversation of
 * its own — its base's, recursively. Undefined when there is none yet.
 */
function conversationOf(name: string, read: (n: string) => SessionRecord | undefined, seen: Set<string>): string | undefined {
    if (seen.has(name)) { throw new Error(`Session "${name}" is part of a cycle of base sessions (${[...seen, name].join(' → ')}).`); }
    seen.add(name);
    const r = read(name);
    if (!r) { return undefined; }
    if (r.mode !== 'continue') {
        return r.basedOn ? conversationOf(r.basedOn, read, seen) : undefined;
    }
    return r.sessionId;
}

/** A fresh or base-forked start that saves nothing (a per-prompt session). */
function startFromBase(name: string, r: SessionRecord, read: (n: string) => SessionRecord | undefined, persist: boolean, iterationKey?: string): SessionStart {
    const extra = iterationKey ? { iterationKey } : {};
    if (!r.basedOn) { return { fork: false, persist, ...extra }; }
    const base = conversationOf(r.basedOn, read, new Set([name]));
    return base
        ? { resume: base, fork: true, persist, ...extra }
        : { fork: false, persist, ...extra, note: `The base session "${r.basedOn}" has no conversation yet: this ${iterationKey ? 'iteration' : 'prompt'} starts fresh.` };
}

/**
 * How a prompt in session `name` starts. `iterationKey` names the queue
 * iteration the prompt belongs to (per-iteration sessions). Throws for a cycle
 * of base sessions.
 */
export function planSessionStart(name: string, read: (n: string) => SessionRecord | undefined, iterationKey?: string): SessionStart {
    const r = read(name);
    if (!r) { return { fork: false, persist: true }; }
    if (r.mode === 'per-prompt' || (r.mode === 'per-iteration' && !iterationKey)) {
        return startFromBase(name, r, read, false);
    }
    if (r.mode === 'per-iteration') {
        const it = r.iteration;
        if (it && it.key === iterationKey && it.sessionId) {
            return { resume: it.sessionId, fork: false, persist: true, iterationKey };
        }
        return startFromBase(name, r, read, true, iterationKey);
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

/** The lifetime in words. */
export function describeSessionMode(mode: SessionMode, basedOn?: string): string {
    if (mode === 'per-prompt') { return basedOn ? `fresh from "${basedOn}" for every prompt` : 'fresh for every prompt'; }
    if (mode === 'per-iteration') { return basedOn ? `fresh from "${basedOn}" for every iteration` : 'fresh for every iteration'; }
    return basedOn ? `continues; started from "${basedOn}"` : 'continues';
}

/** One line for the picker: the lifetime, the base, and the profile / model when the session has one. */
export function describeSession(r: SessionRecord): string {
    let text = describeSessionMode(r.mode, r.basedOn);
    if (r.mode === 'continue' && !r.basedOn && !r.sessionId) { text = 'continues (not started yet)'; }
    const runsWith = r.model ?? r.profileId;
    return runsWith ? `${text} · ${runsWith}` : text;
}
