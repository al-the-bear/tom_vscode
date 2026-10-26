/**
 * Named sessions for the direct API transport: which history a send reads
 * and writes.
 *
 * The Agent SDK path keeps a session's conversation in the SDK and only its
 * id in `<name>.session.json`. The direct transport sends its own history —
 * the compacted blocks, the rolling tail of raw turns and the compaction
 * accumulator — so a named session needs a history of its own:
 *
 * - `chat` (the panel) and `default` (the prompt queue) keep sharing the
 *   quest's history in `history/` — the history the direct transport always
 *   had;
 * - any other session has its own folder, `history/sessions/<name>/`, with the
 *   same files;
 * - `continue` with a base: the session's folder is seeded once from its
 *   base's history (on its first prompt), and continues on its own;
 * - `per-prompt`: every prompt starts from the base's history (through bases
 *   that keep no lasting history of their own), or with no history without a
 *   base, and nothing is written back;
 * - `per-iteration`: the session's folder holds the current queue iteration's
 *   history. When a send names another iteration (its iteration key) the
 *   folder is emptied and seeded from the base again; the key is kept in the
 *   folder's `iteration.json`. A send without an iteration key (the chat
 *   panel) is its own iteration: it runs as `per-prompt`.
 *
 * The session files and their rules are those of the Agent SDK path
 * (src/utils/agentSdkSessions.ts, src/services/agentSdkSessionStore.ts).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { readSession } from './agentSdkSessionStore';
import { COMPACTED_HISTORY_FILENAME } from './compacted-history';
import { RAW_TURNS_FILENAME } from './raw-turns-store';
import type { SessionRecord } from '../utils/agentSdkSessions';
import { conversationKindOf, transportMismatch, type SessionProfile } from '../utils/sessionSpecs';

/** The sessions that share the quest's history: the chat panel's and the prompt queue's. */
export const SHARED_HISTORY_SESSIONS: readonly string[] = ['chat', 'default'];

/** The compaction accumulator's file (compaction-rounds.ts; named here to keep this module vscode-free). */
const COMPACTION_ROUNDS_FILE = 'compaction_rounds.json';

/** The files a direct-transport history consists of. */
const HISTORY_FILES: readonly string[] = [COMPACTED_HISTORY_FILENAME, RAW_TURNS_FILENAME, COMPACTION_ROUNDS_FILE, 'history.json', 'history.md'];

/** Which history a send in session `own` uses. */
export interface DirectHistoryPlan {
    own: string;
    /** The session whose history is read (and, when `persist`, written). */
    readFrom: string;
    /** Whether the send writes its exchange back (false for per-prompt). */
    persist: boolean;
    /** Seed `own`'s history from this session's once, while `own` has none (or, per iteration, when the iteration changes). */
    seedFrom?: string;
    /** Start with no history at all (per-prompt without a base, or a base chain that has none). */
    fresh?: true;
    /** Per-iteration: the iteration the folder holds; another one empties and re-seeds it. */
    iterationKey?: string;
}

/**
 * The session whose history a fork of `name` starts from: `name` itself, or —
 * for a per-prompt / per-iteration session, which keeps no lasting history of
 * its own — its base's, recursively. Undefined when the chain ends without a
 * history (a per-prompt session without a base).
 */
function historyOwnerOf(name: string, read: (n: string) => SessionRecord | undefined, seen: Set<string>): string | undefined {
    if (seen.has(name)) { throw new Error(`Session "${name}" is part of a cycle of base sessions (${[...seen, name].join(' → ')}).`); }
    seen.add(name);
    const r = read(name);
    if (!r || r.mode === 'continue') { return name; }
    return r.basedOn ? historyOwnerOf(r.basedOn, read, seen) : undefined;
}

/** The plan for a send in session `name`; `iterationKey` names the queue iteration. Throws for a cycle of bases. */
export function planDirectHistory(name: string, read: (n: string) => SessionRecord | undefined, iterationKey?: string): DirectHistoryPlan {
    const r = read(name);
    const baseOwner = r?.basedOn ? historyOwnerOf(r.basedOn, read, new Set([name])) : undefined;
    if (r && (r.mode === 'per-prompt' || (r.mode === 'per-iteration' && !iterationKey))) {
        return baseOwner
            ? { own: name, readFrom: baseOwner, persist: false }
            : { own: name, readFrom: name, persist: false, fresh: true };
    }
    if (r?.mode === 'per-iteration') {
        return { own: name, readFrom: name, persist: true, ...(baseOwner ? { seedFrom: baseOwner } : {}), iterationKey };
    }
    if (baseOwner) {
        return { own: name, readFrom: name, persist: true, seedFrom: baseOwner };
    }
    return { own: name, readFrom: name, persist: true };
}

/** The history folder of session `name` in the quest's history folder `root`. */
export function sessionHistoryFolder(root: string, name: string): string {
    return SHARED_HISTORY_SESSIONS.includes(name) ? root : path.join(root, 'sessions', name);
}

/** Whether `folder` holds a history (any of its files, non-empty). */
export function hasSessionHistory(folder: string): boolean {
    return HISTORY_FILES.some((f) => {
        const file = path.join(folder, f);
        try { return fs.existsSync(file) && fs.statSync(file).size > 0; } catch { return false; }
    });
}

/** The file a per-iteration session's folder names its iteration in. */
export const ITERATION_MARKER_FILE = 'iteration.json';

function readIterationMarker(folder: string): string | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(folder, ITERATION_MARKER_FILE), 'utf8')) as { key?: unknown };
        return typeof raw.key === 'string' ? raw.key : undefined;
    } catch { return undefined; }
}

/** Remove the history files of `folder` (a per-iteration session's, when its iteration changes). */
function clearHistory(folder: string): void {
    for (const f of HISTORY_FILES) {
        try { fs.rmSync(path.join(folder, f), { force: true }); } catch { /* best-effort */ }
    }
}

/** Copy the history files of `from` into `to` (those that exist). */
function copyHistory(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const f of HISTORY_FILES) {
        const src = path.join(from, f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(to, f)); }
    }
}

/** What the handler loads and saves for a send. */
export interface HistoryScope {
    /** Changes whenever another history is to be loaded: quest, folder, persisting, iteration. */
    key: string;
    questId: string;
    session: string;
    /** The folder the history is read from (and written to when `persist`). */
    folder: string;
    persist: boolean;
    /** The send starts with no history: nothing is loaded from `folder`. */
    fresh?: true;
    /** The quest's own history (the chat panel's and the queue's). */
    shared: boolean;
    /** What happened that the log should say (a seed from a base, a base without history). */
    note?: string;
}

/**
 * The history a send in session `name` of quest `questId` uses; `root` is the
 * quest's history folder, where the session files are too. Seeds a based
 * session from its base on its first use; starts a per-iteration session's
 * folder over when `iterationKey` names another iteration.
 */
export function resolveHistoryScope(questId: string, root: string, name: string, iterationKey?: string): HistoryScope {
    const plan = planDirectHistory(name, (n) => readSession(root, n), iterationKey);
    const folder = sessionHistoryFolder(root, plan.readFrom);
    let note: string | undefined;
    if (plan.iterationKey !== undefined && readIterationMarker(folder) !== plan.iterationKey) {
        clearHistory(folder);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, ITERATION_MARKER_FILE), JSON.stringify({ key: plan.iterationKey }, null, 2) + '\n');
        note = `session "${plan.own}" starts iteration ${plan.iterationKey}`;
        if (plan.seedFrom) {
            const base = sessionHistoryFolder(root, plan.seedFrom);
            if (hasSessionHistory(base)) {
                copyHistory(base, folder);
                note += ` from "${plan.seedFrom}"'s history`;
            } else {
                note += ` fresh (the base session "${plan.seedFrom}" has no history yet)`;
            }
        }
    } else if (plan.seedFrom && plan.iterationKey === undefined) {
        const own = sessionHistoryFolder(root, plan.own);
        const base = sessionHistoryFolder(root, plan.seedFrom);
        if (!hasSessionHistory(own)) {
            if (hasSessionHistory(base)) {
                copyHistory(base, own);
                note = `session "${plan.own}" started from "${plan.seedFrom}"'s history`;
            } else {
                note = `the base session "${plan.seedFrom}" has no history yet: "${plan.own}" starts fresh`;
            }
        }
    }
    if (plan.fresh) {
        note = `session "${plan.own}" starts every prompt fresh`;
    } else if (!plan.persist && !hasSessionHistory(folder)) {
        note = `the base session "${plan.readFrom}" has no history yet: this prompt starts fresh`;
    }
    return {
        key: `${questId}\u0000${folder}\u0000${plan.persist ? 'rw' : 'ro'}\u0000${plan.fresh ? 'fresh' : ''}\u0000${plan.iterationKey ?? ''}`,
        questId,
        session: name,
        folder,
        persist: plan.persist,
        ...(plan.fresh ? { fresh: true as const } : {}),
        shared: SHARED_HISTORY_SESSIONS.includes(plan.readFrom),
        ...(note ? { note } : {}),
    };
}

/**
 * Why `profile` cannot run in session `name` of the history folder `root`:
 * the session's conversation is kept where that profile does not keep one
 * (an Agent SDK session continued by a profile with our own history, or the
 * reverse). The quest's shared sessions (`chat`, `default`) hold both and are
 * never refused; a session without a conversation yet takes any profile.
 */
export function sessionTransportMismatch(root: string, name: string, profile: SessionProfile | undefined): string | undefined {
    if (SHARED_HISTORY_SESSIONS.includes(name)) { return undefined; }
    const kind = conversationKindOf(readSession(root, name), hasSessionHistory(sessionHistoryFolder(root, name)));
    return transportMismatch(name, kind, profile);
}
