/**
 * Uncompacted-rounds accumulator persistence.
 *
 * A "round" is one user→assistant exchange (2 messages by the
 * Anthropic-handler convention: one `role:'user'` plus one
 * `role:'assistant'`). The accumulator is the list of rounds that
 * have happened since the last successful compaction pass — they're
 * still being sent verbatim alongside the compacted summary, and the
 * file ensures the list survives VS Code restarts and `extension host
 * restart` cycles without losing in-flight context.
 *
 * Storage: `_ai/quests/<quest>/history/compaction_rounds.json`, the
 * sibling of `history.json`. Crucially, the file is **gitignored**
 * (see `.gitignore` at workspace root) — every machine maintains its
 * own cadence, independent of what's currently checked in on another
 * machine. `history.json`'s `compactedSummary` is the *shared* truth
 * that travels with git; the accumulator is *local* truth that lives
 * only on the machine that produced it.
 *
 * Schema:
 * ```json
 * {
 *   "rounds": [
 *     [
 *       { "role": "user", "content": "..." },
 *       { "role": "assistant", "content": "..." }
 *     ],
 *     ...
 *   ],
 *   "savedAt": "2026-06-01T08:45:07.182Z"
 * }
 * ```
 *
 * The module is intentionally tiny and side-effect-free except for
 * the FS read/write. Callers own the in-memory state; this module
 * just turns it into / from disk.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ConversationMessage } from './history-compaction';
import { TwoTierMemoryService } from './memory-service';

/** Filename inside the quest's `history/` folder. */
export const COMPACTION_ROUNDS_FILENAME = 'compaction_rounds.json';

export interface CompactionRoundsPayload {
    /** Ordered oldest → newest. Each inner array is one round (the
     *  Anthropic-handler convention is 2 messages: user + assistant). */
    rounds: ConversationMessage[][];
    /** ISO-8601 timestamp of the last write — informational only. */
    savedAt: string;
}

/**
 * Resolve the absolute path of `compaction_rounds.json` for the
 * given quest (or the current quest when omitted).
 */
export function compactionRoundsPath(questId?: string): string {
    const folder = TwoTierMemoryService.instance.historyFolder(questId);
    return path.join(folder, COMPACTION_ROUNDS_FILENAME);
}

/**
 * Pair a flat `[user, assistant, user, assistant, ...]` message array
 * into rounds. Stray odd-length tails are dropped — they represent a
 * half-finished exchange that the caller hasn't completed, and
 * shipping a half-round on the wire would confuse the next API call.
 *
 * Used during migration (when the accumulator file is missing but
 * `history.json` already has a flat `rawTurns` array) and inside the
 * write path so the saved file is always whole rounds.
 */
export function rawTurnsToRounds(rawTurns: ConversationMessage[]): ConversationMessage[][] {
    const rounds: ConversationMessage[][] = [];
    const evenLength = rawTurns.length - (rawTurns.length % 2);
    for (let i = 0; i < evenLength; i += 2) {
        rounds.push([rawTurns[i], rawTurns[i + 1]]);
    }
    return rounds;
}

/**
 * Flatten rounds back into the contiguous `[user, assistant, ...]`
 * shape the rest of the codebase consumes (`rawTurns`, message-array
 * construction, history.json persistence).
 */
export function roundsToRawTurns(rounds: ConversationMessage[][]): ConversationMessage[] {
    return rounds.reduce<ConversationMessage[]>((acc, round) => {
        for (const msg of round) { acc.push(msg); }
        return acc;
    }, []);
}

/**
 * Read `compaction_rounds.json` from disk for `questId`. Returns
 * `undefined` when the file is missing, unreadable, or has a shape
 * the validator rejects (in which case the caller falls back to the
 * legacy migration path — see `loadOrMigrate()`).
 */
export function loadCompactionRounds(questId?: string): CompactionRoundsPayload | undefined {
    const target = compactionRoundsPath(questId);
    if (!fs.existsSync(target)) {
        return undefined;
    }
    try {
        const raw = fs.readFileSync(target, 'utf-8');
        const parsed = JSON.parse(raw) as CompactionRoundsPayload | unknown;
        if (!parsed || typeof parsed !== 'object') { return undefined; }
        const payload = parsed as CompactionRoundsPayload;
        if (!Array.isArray(payload.rounds)) { return undefined; }
        // Defensive: drop any round entries that aren't arrays of
        // messages — a corrupted write should degrade gracefully
        // instead of crashing the handler at session start.
        const cleaned = payload.rounds.filter((round): round is ConversationMessage[] => Array.isArray(round));
        return {
            rounds: cleaned,
            savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : '',
        };
    } catch {
        return undefined;
    }
}

/**
 * Atomic-ish write of the accumulator. Writes to `*.tmp` first then
 * renames to defend against a crash mid-write leaving a partial file
 * — the caller would otherwise see a JSON-parse failure on the next
 * load and silently lose all uncompacted rounds.
 *
 * No-ops silently on I/O error. The accumulator is recoverable from
 * the trail files (via the rebuild path) so a failed write is not
 * worth surfacing to the user.
 */
export function saveCompactionRounds(rounds: ConversationMessage[][], questId?: string): void {
    try {
        const target = compactionRoundsPath(questId);
        const folder = path.dirname(target);
        if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { recursive: true }); }
        const payload: CompactionRoundsPayload = {
            rounds,
            savedAt: new Date().toISOString(),
        };
        const json = JSON.stringify(payload, null, 2);
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, json, 'utf-8');
        fs.renameSync(tmp, target);
    } catch {
        // best-effort — see doc comment
    }
}

/**
 * Delete the accumulator file. Called by the "Recreate History"
 * command (after a successful trail rebuild rewrites the file from
 * scratch) and by tests; not part of the normal turn loop.
 */
export function clearCompactionRounds(questId?: string): void {
    try {
        const target = compactionRoundsPath(questId);
        if (fs.existsSync(target)) { fs.unlinkSync(target); }
    } catch {
        // best-effort
    }
}
