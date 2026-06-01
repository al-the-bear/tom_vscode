/**
 * Uncompacted-rounds accumulator persistence.
 *
 * A "round" is one user→assistant exchange (2 messages by the
 * Anthropic-handler convention: one `role:'user'` + one
 * `role:'assistant'`). The accumulator is the list of rounds that
 * have happened since the last successful compaction pass.
 *
 * **Semantics (post block-format redesign)**:
 *
 *   - On every successful compaction, the accumulator **CLEARS
 *     ENTIRELY**. The freshly produced summary now absorbs every
 *     round that was in the accumulator at trigger time.
 *   - The rolling tail of "last N rounds verbatim" — useful for
 *     continuity between compaction firings — is owned by
 *     `raw-turns-store.ts` (`rawTurns.json`), not this file. The two
 *     used to be one before the redesign; splitting them lets the
 *     accumulator be a strict "consumed on compaction" queue without
 *     also having to be a rolling tail.
 *
 * Storage: `_ai/quests/<quest>/history/compaction_rounds.json`. The
 * file is **gitignored** — every machine maintains its own cadence,
 * independent of what's currently checked in on another machine.
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
    /** Ordered oldest → newest. Each inner array is one round. */
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
 * half-finished exchange that the caller hasn't completed.
 *
 * Kept here for backward compatibility — new code should import from
 * `raw-turns-store.ts` instead, which owns the helper now.
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
 * shape the rest of the codebase consumes. Kept for back-compat.
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
 * the validator rejects.
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
 * renames to defend against a crash mid-write leaving a partial file.
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
 * Clear the accumulator on successful compaction. Writes an empty
 * rounds array (NOT a delete) so a subsequent load returns a clean
 * empty payload rather than `undefined` — that's the signal to the
 * handler that "yes, we have compacted, the accumulator is empty by
 * design" vs "no file exists, may need to rebuild from trail".
 */
export function clearCompactionRounds(questId?: string): void {
    saveCompactionRounds([], questId);
}
