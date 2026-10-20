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
 * - `fork-from-base`: every prompt starts from the base's history (through
 *   bases that are themselves forks) and nothing is written back.
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
    /** Whether the send writes its exchange back (false for fork-from-base). */
    persist: boolean;
    /** Seed `own`'s history from this session's once, while `own` has none. */
    seedFrom?: string;
}

/**
 * The session whose history a fork of `name` starts from: `name` itself, or —
 * for a fork-from-base session, which never has one of its own — its base's,
 * recursively.
 */
function historyOwnerOf(name: string, read: (n: string) => SessionRecord | undefined, seen: Set<string>): string {
    if (seen.has(name)) { throw new Error(`Session "${name}" is part of a cycle of base sessions (${[...seen, name].join(' → ')}).`); }
    seen.add(name);
    const r = read(name);
    if (r?.mode !== 'fork-from-base') { return name; }
    if (!r.basedOn) { throw new Error(`Session "${name}" is re-created from its base for every prompt but names no base.`); }
    return historyOwnerOf(r.basedOn, read, seen);
}

/** The plan for a send in session `name`. Throws for a cycle or a fork-from-base session without a base. */
export function planDirectHistory(name: string, read: (n: string) => SessionRecord | undefined): DirectHistoryPlan {
    const r = read(name);
    if (r?.mode === 'fork-from-base') {
        if (!r.basedOn) { throw new Error(`Session "${name}" is re-created from its base for every prompt but names no base.`); }
        return { own: name, readFrom: historyOwnerOf(r.basedOn, read, new Set([name])), persist: false };
    }
    if (r?.basedOn) {
        return { own: name, readFrom: name, persist: true, seedFrom: historyOwnerOf(r.basedOn, read, new Set([name])) };
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
    /** Changes whenever another history is to be loaded: quest, folder, persisting. */
    key: string;
    questId: string;
    session: string;
    /** The folder the history is read from (and written to when `persist`). */
    folder: string;
    persist: boolean;
    /** The quest's own history (the chat panel's and the queue's). */
    shared: boolean;
    /** What happened that the log should say (a seed from a base, a base without history). */
    note?: string;
}

/**
 * The history a send in session `name` of quest `questId` uses; `root` is the
 * quest's history folder, where the session files are too. Seeds a based
 * session from its base on its first use.
 */
export function resolveHistoryScope(questId: string, root: string, name: string): HistoryScope {
    const plan = planDirectHistory(name, (n) => readSession(root, n));
    const folder = sessionHistoryFolder(root, plan.readFrom);
    let note: string | undefined;
    if (plan.seedFrom) {
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
    if (!plan.persist && !hasSessionHistory(folder)) {
        note = `the base session "${plan.readFrom}" has no history yet: this prompt starts fresh`;
    }
    return {
        key: `${questId}\u0000${folder}\u0000${plan.persist ? 'rw' : 'ro'}`,
        questId,
        session: name,
        folder,
        persist: plan.persist,
        shared: SHARED_HISTORY_SESSIONS.includes(plan.readFrom),
        ...(note ? { note } : {}),
    };
}
