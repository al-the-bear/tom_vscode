/**
 * Session specs and session profiles — pure rules, no IO.
 *
 * A queue item, a process definition, a tool call or the picker can name a
 * session by a bare name or by a spec `{name, basedOn?, mode?, profile?}`: the
 * spec says how to create the session when it does not exist yet (its base,
 * its lifetime, the Anthropic profile it is made for). {@link parseSessionSpec}
 * reads and checks one; the store's `ensureSession` creates it.
 *
 * A session's profile (`profileId` in its file) is the Anthropic profile its
 * prompts run with unless the prompt names its own; a session without one
 * runs with the queue default — item -> session -> queue default
 * ({@link effectiveProfileId}).
 *
 * A conversation lives in one place: an Agent SDK session (a profile whose
 * history mode is `sdk-managed`) or our own history files (every other
 * profile). A profile of the other kind cannot continue it
 * ({@link transportMismatch}).
 */

import { isValidSessionName, normalizeSessionMode, type SessionMode, type SessionRecord } from './agentSdkSessions';

/** How to create a session when it is missing. */
export interface SessionSpec {
    name: string;
    basedOn?: string;
    mode?: SessionMode;
    /** Anthropic profile id the session is made for. */
    profile?: string;
}

/** A session as written by a caller: a name or a spec. */
export type SessionSpecInput = string | { name?: unknown; basedOn?: unknown; mode?: unknown; profile?: unknown };

export type SessionSpecResult = { ok: true; spec: SessionSpec } | { ok: false; error: string };

const SPEC_KEYS = ['name', 'basedOn', 'mode', 'profile'];
const NAME_RULE = 'letters, digits, "_" and "-", starting with a letter or digit';

/**
 * Read a session given as a name or a spec. Refuses an unknown key, a bad
 * name or base, a base equal to the name, an unknown lifetime (the legacy
 * `fork-from-base` reads as `per-prompt`) and an empty profile. Lifetimes
 * other than `continue` need no base.
 */
export function parseSessionSpec(raw: unknown): SessionSpecResult {
    if (typeof raw === 'string') {
        const name = raw.trim();
        return isValidSessionName(name) ? { ok: true, spec: { name } } : { ok: false, error: `Session name "${raw}": ${NAME_RULE}.` };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, error: 'A session is a name or {name, basedOn?, mode?, profile?}.' };
    }
    const r = raw as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => !SPEC_KEYS.includes(k));
    if (unknown.length > 0) { return { ok: false, error: `Session spec: unknown key(s) ${unknown.join(', ')} (allowed: ${SPEC_KEYS.join(', ')}).` }; }
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!isValidSessionName(name)) { return { ok: false, error: `Session spec: name is required (${NAME_RULE}).` }; }
    const spec: SessionSpec = { name };
    if (r.basedOn !== undefined && r.basedOn !== '') {
        const basedOn = typeof r.basedOn === 'string' ? r.basedOn.trim() : '';
        if (!isValidSessionName(basedOn)) { return { ok: false, error: `Session spec "${name}": basedOn must be a session name (${NAME_RULE}).` }; }
        if (basedOn === name) { return { ok: false, error: `Session spec "${name}": a session cannot be based on itself.` }; }
        spec.basedOn = basedOn;
    }
    if (r.mode !== undefined && r.mode !== '') {
        const mode = normalizeSessionMode(r.mode);
        if (!mode) { return { ok: false, error: `Session spec "${name}": mode "${String(r.mode)}" is not continue, per-prompt or per-iteration.` }; }
        spec.mode = mode;
    }
    if (r.profile !== undefined && r.profile !== '') {
        if (typeof r.profile !== 'string' || r.profile.trim() === '') { return { ok: false, error: `Session spec "${name}": profile must be a profile id.` }; }
        spec.profile = r.profile.trim();
    }
    return { ok: true, spec };
}

/** The spec's fields beyond its name; undefined when it is a bare name. */
export function specExtras(spec: SessionSpec): Omit<SessionSpec, 'name'> | undefined {
    const { name: _name, ...rest } = spec;
    return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Where a conversation lives: an Agent SDK session, or our own history files. */
export type ConversationKind = 'sdk' | 'history';

/** A profile as the session rules see it. */
export interface SessionProfile {
    id: string;
    /** The model of its configuration (absent for a Local LLM or unresolved configuration). */
    model?: string;
    /** Where its prompts keep their conversation. */
    continuity: ConversationKind;
}

/** The fields of `config.anthropic` the lookup reads. */
export interface ProfileSection {
    profiles?: Array<{ id?: string; configurationId?: string } | null | undefined>;
    configurations?: Array<{ id?: string; model?: string; transport?: string; historyMode?: string } | null | undefined>;
}

/**
 * The profile `id` names, exactly (no fallback to the default: a session's
 * profile must exist); undefined when there is none. Its continuity follows
 * its configuration's history mode as the handler resolves it: `sdk-managed`
 * (stated, or the Agent SDK transport's default) keeps an SDK session.
 */
export function lookupProfile(section: ProfileSection | undefined, id: string | undefined): SessionProfile | undefined {
    if (!id) { return undefined; }
    const profile = (section?.profiles ?? []).find((p) => p?.id === id);
    if (!profile) { return undefined; }
    const configuration = (section?.configurations ?? []).find((c) => !!c && c.id === profile.configurationId);
    const transport = configuration?.transport ?? 'direct';
    const mode = configuration?.historyMode ?? (transport === 'agentSdk' ? 'sdk-managed' : 'trim_and_summary');
    return {
        id,
        ...(configuration?.model ? { model: configuration.model } : {}),
        continuity: mode === 'sdk-managed' ? 'sdk' : 'history',
    };
}

/** The profile a prompt runs with: the item's own, else its session's, else the queue default. */
export function effectiveProfileId(item: string | undefined, session: string | undefined, queueDefault: string | undefined): string | undefined {
    return item || session || queueDefault || undefined;
}

/** Where a session's conversation is, if it has one: an SDK session id, or its own history files. */
export function conversationKindOf(record: SessionRecord | undefined, hasOwnHistory: boolean): ConversationKind | undefined {
    if (record?.sessionId || record?.iteration?.sessionId) { return 'sdk'; }
    return hasOwnHistory ? 'history' : undefined;
}

/** Why `profile` cannot continue session `name`'s conversation; undefined when it can. */
export function transportMismatch(name: string, kind: ConversationKind | undefined, profile: SessionProfile | undefined): string | undefined {
    if (!kind || !profile || kind === profile.continuity) { return undefined; }
    const where = (k: ConversationKind): string => (k === 'sdk' ? 'an Agent SDK session (history mode sdk-managed)' : 'our own history files (direct API, or an Agent SDK profile with our history)');
    return `Session "${name}" has a conversation in ${where(kind)}; profile "${profile.id}" keeps its conversation in ${where(profile.continuity)} and cannot continue it. `
        + 'Use a profile of the same kind, or another session.';
}
