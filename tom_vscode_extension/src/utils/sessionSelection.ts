/**
 * Choosing sessions for an action that works on a quest's conversation
 * storage — rebuild, recreate, clear, open, the history / trail / memory
 * tools — pure.
 *
 * - The UI: a multi-select of the quest's sessions (the SESSIONS view's rows,
 *   src/utils/sessionsViewRows.ts: `default`, `chat`, then the session files,
 *   temporary ones marked) with **All sessions** on top and the current
 *   session preselected ({@link sessionSelectionItems}, {@link chosenSessions}).
 *   A destructive action confirms with the names chosen
 *   ({@link confirmationText}).
 * - The tools: an optional `sessions` parameter — a name, a list of names or
 *   `"all"`; without it the caller's own session ({@link resolveSessionsArg}).
 */

import type { SessionRow } from './sessionsViewRows';

/** One entry of the multi-select. */
export interface SessionSelectionItem {
    label: string;
    description: string;
    /** Preselected. */
    picked: boolean;
    /** The session this entry stands for; absent on "All sessions". */
    session?: string;
    /** The "All sessions" entry. */
    all?: true;
}

export const ALL_SESSIONS_LABEL = 'All sessions';

function describeRow(row: SessionRow): string {
    const parts: string[] = [];
    if (row.usedBy) { parts.push(row.usedBy); }
    if (row.temporary) { parts.push('temporary'); }
    if (row.basedOn) { parts.push(`based on ${row.basedOn}`); }
    if (row.lifetime) { parts.push(row.lifetime); }
    if (row.model ?? row.profileId) { parts.push(String(row.model ?? row.profileId)); }
    if (!row.hasConversation) { parts.push('no conversation yet'); }
    return parts.join(' · ');
}

/**
 * The multi-select's entries: "All sessions" first, then one per session in
 * the SESSIONS view's order; `current` (the panel's or the caller's session)
 * preselected. `extra` adds names that have storage but no row (a session
 * whose file was deleted), so their storage can still be chosen.
 */
export function sessionSelectionItems(rows: readonly SessionRow[], current: string | undefined, extra: readonly string[] = []): SessionSelectionItem[] {
    const known = new Set(rows.map((r) => r.name));
    const items: SessionSelectionItem[] = [
        { label: ALL_SESSIONS_LABEL, description: `${rows.length + extra.filter((n) => !known.has(n)).length} sessions`, picked: false, all: true },
        ...rows.map((row) => ({ label: row.name, description: describeRow(row), picked: row.name === current, session: row.name })),
        ...extra.filter((n) => !known.has(n)).sort().map((name) => ({ label: name, description: 'storage only (no session file)', picked: name === current, session: name })),
    ];
    return items;
}

/** The session names the user chose; "All sessions" means every session listed. */
export function chosenSessions(chosen: readonly SessionSelectionItem[], items: readonly SessionSelectionItem[]): string[] {
    const source = chosen.some((i) => i.all) ? items : chosen;
    const names: string[] = [];
    for (const item of source) {
        if (item.session && !names.includes(item.session)) { names.push(item.session); }
    }
    return names;
}

/** The confirmation of a destructive action: what is done, to which sessions. */
export function confirmationText(action: string, names: readonly string[], all: number): string {
    if (names.length === all && all > 1) { return `${action} for ALL ${all} sessions (${names.join(', ')})?`; }
    if (names.length === 1) { return `${action} for the session "${names[0]}"?`; }
    return `${action} for ${names.length} sessions: ${names.join(', ')}?`;
}

export type SessionsArgResult = { ok: true; sessions: string[] } | { ok: false; code: 'invalidSessions' | 'unknownSession'; error: string; sessions: string[] };

/**
 * A tool's `sessions` parameter: absent → the caller's own session; `"all"` →
 * every known session; a name or a list of names → those, each checked
 * against `known` (an unknown one is refused, naming the sessions there are).
 */
export function resolveSessionsArg(raw: unknown, known: readonly string[], own: string): SessionsArgResult {
    if (raw === undefined || raw === null || raw === '') { return { ok: true, sessions: [own] }; }
    if (raw === 'all') { return { ok: true, sessions: [...known] }; }
    const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined;
    if (!list || list.length === 0 || list.some((n) => typeof n !== 'string' || n.trim() === '')) {
        return { ok: false, code: 'invalidSessions', error: '`sessions` is a session name, a list of names, or "all".', sessions: [...known] };
    }
    const names = [...new Set(list.map((n) => (n as string).trim()))];
    const unknown = names.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
        return { ok: false, code: 'unknownSession', error: `No session ${unknown.map((n) => `"${n}"`).join(', ')} in this quest.`, sessions: [...known] };
    }
    return { ok: true, sessions: names };
}

/** The JSON schema of the tools' `sessions` parameter. */
export const SESSIONS_PARAM_SCHEMA = {
    description: 'The sessions to work on: a session name, a list of names, or "all". Default: the session the caller runs in.',
    anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
    ],
};

/** What Delete in the SESSIONS view removes, for its confirmation. */
export function deleteSessionDetail(quest: string, name: string): string {
    return `Removed: the session file (if any) and its whole storage — history/sessions/${name}/ (history, `
        + `prompts/answers trail, live trail, raw trail, tool results) and its quest memory _ai/memory/${quest}/${name}/. `
        + 'This cannot be undone.';
}

/** Whether a prompt-history subsystem (`anthropic:<session>` for a session's pair) belongs to the chosen sessions; other subsystems have none and always do. */
export function subsystemInSessions(subsystem: string, sessions: readonly string[] | undefined): boolean {
    if (!sessions || !subsystem.startsWith('anthropic:')) { return true; }
    return sessions.includes(subsystem.slice('anthropic:'.length));
}
