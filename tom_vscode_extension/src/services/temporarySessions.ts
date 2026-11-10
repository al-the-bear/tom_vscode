/**
 * One-prompt sessions: a temporary session (`tmp-<yymmdd-hhmmss>-<token>`)
 * based on another, run once and discarded — the ANTHROPIC panel's **Fresh**
 * send, and the assist runs (Grill me / Explain in detail on a question, the
 * decision helpers). It starts from the base session's conversation, so it
 * knows the context, and changes nothing in it; no follow-up can reach it.
 *
 * Discarding removes everything the session left: its session file, the
 * conversation the Anthropic handler keeps in memory for it, and its storage
 * (`history/sessions/<name>/`: trail, live trail, history; its quest memory) —
 * so it never shows in the SESSIONS view or the Logs session switch.
 */

import * as fs from 'fs';
import { temporarySessionName } from '../utils/questInbox';

/** What creating one needs: the quest's sessions. */
export interface TemporarySessionDeps {
    sessionsFolder(): string;
    hasSession(folder: string, name: string): boolean;
    createSession(folder: string, name: string, opts: { basedOn?: string }): { ok: boolean; error?: string };
}

export type TemporarySession = { ok: true; session: string; basedOn: string | null } | { ok: false; error: string };

/**
 * A new temporary session named after `token`, based on `base` when that has
 * a session file (the panel's `chat` and the queue's `default` may have none
 * yet: the new one then starts fresh).
 */
export function createTemporarySession(deps: TemporarySessionDeps, base: string, token: string, now: Date = new Date()): TemporarySession {
    const folder = deps.sessionsFolder();
    const basedOn = base && deps.hasSession(folder, base) ? base : null;
    const session = temporarySessionName(now, token);
    const made = deps.createSession(folder, session, basedOn ? { basedOn } : {});
    if (!made.ok) { return { ok: false, error: `the temporary session could not be created: ${made.error ?? 'unknown error'}` }; }
    return { ok: true, session, basedOn };
}

/* eslint-disable @typescript-eslint/no-require-imports -- the stores and the handler pull in the manager layer: loaded on use */
/**
 * Discard session `name` of the quest whose sessions are in `folder`: its
 * file, the handler's in-memory conversation, its storage and quest memory.
 * Every part is best effort — a part already gone is no failure. The
 * conversation is cleared before the storage goes: clearing writes the
 * session's (empty) history files, which the storage removal then takes.
 * `clearConversation` replaces the handler's step (a test has no handler).
 */
export function discardSessionCompletely(folder: string, quest: string, name: string, clearConversation?: (name: string) => void): void {
    try { (require('./agentSdkSessionStore.js') as typeof import('./agentSdkSessionStore')).deleteSession(folder, name); } catch { /* gone already */ }
    try {
        if (clearConversation) { clearConversation(name); }
        else { (require('../handlers/anthropic-handler.js') as typeof import('../handlers/anthropic-handler')).AnthropicHandler.instance.clearSession(name); }
    } catch { /* no handler in this process */ }
    const storage = require('./sessionStorage.js') as typeof import('./sessionStorage');
    let memoryRoot: string | undefined;
    try { memoryRoot = (require('./memory-service.js') as typeof import('./memory-service')).TwoTierMemoryService.instance.memoryRoot(); } catch { /* no memory service yet */ }
    try {
        if (memoryRoot) { storage.removeSessionStorage(folder, memoryRoot, quest, name); }
        else { fs.rmSync(storage.sessionRoot(folder, name), { recursive: true, force: true }); }
    } catch { /* nothing stored */ }
}
/* eslint-enable @typescript-eslint/no-require-imports */
