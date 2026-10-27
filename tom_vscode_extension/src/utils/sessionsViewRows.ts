/**
 * The rows of the SESSIONS view (src/handlers/sessionsView-handler.ts) — pure.
 *
 * Every `<name>.session.json` of the quest's history folder, plus the two
 * sessions that exist without a file: `default` (the prompt queue's) and
 * `chat` (the ANTHROPIC panel's), marked as such and listed first. Per row:
 * base, lifetime (when not `continue`), profile and model, whether it has a
 * conversation yet, when it was last used, and the sessions based on it
 * (which is why it cannot be deleted).
 */

import type { SessionRecord } from './agentSdkSessions';
import { isTemporarySessionName } from './questInbox';

/** The sessions every quest has, with what uses them. */
export const IMPLICIT_SESSIONS: ReadonlyArray<{ name: string; usedBy: string }> = [
    { name: 'default', usedBy: 'the prompt queue' },
    { name: 'chat', usedBy: 'the ANTHROPIC panel' },
];

export interface SessionRow {
    name: string;
    /** What uses an implicit session (`default`, `chat`). */
    usedBy?: string;
    /** A `.session.json` exists (Reset and Delete act on it). */
    hasFile: boolean;
    basedOn?: string;
    /** `per prompt` / `per iteration`; absent for `continue`. */
    lifetime?: string;
    profileId?: string;
    model?: string;
    hasConversation: boolean;
    /** ISO time of the last write (creation or the last saved conversation id). */
    lastUse?: string;
    /** The sessions based on this one: while there are any, it cannot be deleted. */
    dependents: string[];
    /** A temporary session of an item another quest sent: deleted once the item is done. */
    temporary?: boolean;
}

export function sessionRows(records: readonly SessionRecord[]): SessionRow[] {
    const byName = new Map(records.map((r) => [r.name, r]));
    const row = (name: string, usedBy?: string): SessionRow => {
        const r = byName.get(name);
        const lifetime = r?.mode === 'per-prompt' ? 'per prompt' : r?.mode === 'per-iteration' ? 'per iteration' : undefined;
        return {
            name,
            ...(usedBy ? { usedBy } : {}),
            hasFile: !!r,
            ...(r?.basedOn ? { basedOn: r.basedOn } : {}),
            ...(lifetime ? { lifetime } : {}),
            ...(r?.profileId ? { profileId: r.profileId } : {}),
            ...(r?.model ? { model: r.model } : {}),
            hasConversation: !!(r?.sessionId || r?.iteration?.sessionId),
            ...(r?.updatedAt ?? r?.createdAt ? { lastUse: r?.updatedAt ?? r?.createdAt } : {}),
            dependents: records.filter((x) => x.basedOn === name).map((x) => x.name).sort(),
            ...(isTemporarySessionName(name) ? { temporary: true } : {}),
        };
    };
    const implicit = IMPLICIT_SESSIONS.map((s) => row(s.name, s.usedBy));
    const named = records
        .filter((r) => !IMPLICIT_SESSIONS.some((s) => s.name === r.name))
        .map((r) => r.name)
        // Temporary sessions last: they go away with their item.
        .sort((a, b) => Number(isTemporarySessionName(a)) - Number(isTemporarySessionName(b)) || a.localeCompare(b))
        .map((n) => row(n));
    return [...implicit, ...named];
}
