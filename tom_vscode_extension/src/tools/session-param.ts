/**
 * The `sessions` parameter of the tools that read or write a quest's
 * per-session storage (prompt history, past tool calls, quest memory).
 *
 * A session name, a list of names, or `"all"` (src/utils/sessionSelection.ts
 * resolveSessionsArg). Without it the tool works on the session the call runs
 * in — the active tool trail's session (the Anthropic transport sets it per
 * send). A caller that runs in no session (Copilot, Local LLM, an MCP client)
 * gets every session for a read and `default` for a write.
 *
 * vscode-free.
 */

import { listSessions } from '../services/agentSdkSessionStore';
import { sessionsWithStorage } from '../services/sessionStorage';
import { getActiveToolTrail } from '../services/tool-trail';
import { resolveSessionsArg, SESSIONS_PARAM_SCHEMA, subsystemInSessions } from '../utils/sessionSelection';
import { sessionRows } from '../utils/sessionsViewRows';

export { SESSIONS_PARAM_SCHEMA, subsystemInSessions };

/** Every session of the quest whose history folder is `historyRoot`: its files, `default`, `chat`, and any storage without a file. */
export function knownSessions(historyRoot: string): string[] {
    let names: string[] = [];
    try { names = sessionRows(listSessions(historyRoot)).map((r) => r.name); } catch { names = sessionRows([]).map((r) => r.name); }
    for (const n of sessionsWithStorage(historyRoot)) { if (!names.includes(n)) { names.push(n); } }
    return names;
}

/** The session the current tool call runs in, if any. */
export function callerSession(): string | undefined {
    try { return getActiveToolTrail()?.session || undefined; } catch { return undefined; }
}

export type ToolSessions = { ok: true; sessions: string[] } | { ok: false; error: string; code: string; sessions: string[] };

/**
 * The sessions a tool call works on. `forWrite`: without `sessions` and
 * without a caller session the write goes to `default`; a read then covers
 * every session.
 */
export function resolveToolSessions(raw: unknown, historyRoot: string, opts: { forWrite?: boolean; caller?: string } = {}): ToolSessions {
    const known = knownSessions(historyRoot);
    const own = opts.caller ?? callerSession();
    if ((raw === undefined || raw === null || raw === '') && !own) {
        return { ok: true, sessions: opts.forWrite ? ['default'] : known };
    }
    return resolveSessionsArg(raw, known, own ?? 'default');
}
