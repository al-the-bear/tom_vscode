/**
 * Rolling-tail persistence for the Anthropic handler's raw turns.
 *
 * Background:
 *
 *   The handler ships two parallel stores into every outgoing API call:
 *
 *     - `compactedHistoryBlocks` — block-formatted distilled state
 *       (`compacted_history.md`, committed to git). Shared across
 *       machines via the repo.
 *     - `rawTurns`               — the last N user/assistant rounds
 *       verbatim, for fresh detail the compacted blocks haven't yet
 *       absorbed.
 *
 *   `rawTurns` is **per-machine** (gitignored). Two reasons:
 *
 *     - Cadence differs by machine. Each install runs compaction on
 *       its own schedule; baking the rolling tail into the repo would
 *       force every machine to converge to the same tail size.
 *     - Privacy / size. Raw turns contain the literal user text; the
 *       block summary is the redacted, shareable view.
 *
 *   Schema:
 *
 *   ```json
 *   {
 *     "rounds": [
 *       [
 *         { "role": "user",      "content": "…" },
 *         { "role": "assistant", "content": "…" }
 *       ],
 *       …
 *     ],
 *     "savedAt": "2026-06-01T08:45:07.182Z"
 *   }
 *   ```
 *
 *   Each inner array is one round (Anthropic-handler convention: one
 *   `role:'user'` + one `role:'assistant'`).
 *
 * Relationship to `compaction-rounds.ts`:
 *
 *   `compaction_rounds.json` is the **accumulator** — rounds that have
 *   happened since the last successful compaction; it CLEARS on every
 *   compaction success. `rawTurns.json` is the **rolling tail** — a
 *   ring buffer of the most recent N rounds regardless of compaction
 *   firings; it never clears, just rotates. They were one file before
 *   the block-format redesign; splitting them lets compaction "consume
 *   the accumulator" without nuking the recent-turn detail the API
 *   call still needs for continuity between compactions.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ConversationMessage } from './history-compaction';

/** Filename inside the quest's `history/` folder. */
export const RAW_TURNS_FILENAME = 'rawTurns.json';

export interface RawTurnsPayload {
    /** Ordered oldest → newest. One round per inner array (`[user, assistant]`). */
    rounds: ConversationMessage[][];
    /** ISO-8601 timestamp of the last write — informational only. */
    savedAt: string;
}

/** Absolute path to `rawTurns.json` inside the given history folder. */
export function rawTurnsPath(historyFolder: string): string {
    return path.join(historyFolder, RAW_TURNS_FILENAME);
}

/**
 * Read `rawTurns.json` from disk. Returns `undefined` when the file is
 * missing, unreadable, or has a shape the validator rejects — callers
 * treat that as "no rolling tail yet" and may fall back to the
 * accumulator file's contents.
 */
export function load(historyFolder: string): RawTurnsPayload | undefined {
    const target = rawTurnsPath(historyFolder);
    if (!fs.existsSync(target)) { return undefined; }
    try {
        const raw = fs.readFileSync(target, 'utf-8');
        const parsed = JSON.parse(raw) as RawTurnsPayload | unknown;
        if (!parsed || typeof parsed !== 'object') { return undefined; }
        const payload = parsed as RawTurnsPayload;
        if (!Array.isArray(payload.rounds)) { return undefined; }
        const cleaned = payload.rounds.filter(
            (round): round is ConversationMessage[] => Array.isArray(round),
        );
        return {
            rounds: cleaned,
            savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : '',
        };
    } catch {
        return undefined;
    }
}

/**
 * Atomic-ish write of the rolling tail. Writes to `*.tmp` first then
 * renames so a crash mid-write leaves either the old file or the new
 * file — never a half-written file that fails to parse on the next
 * session start.
 *
 * No-ops silently on I/O error. The rolling tail is recoverable from
 * the trail files (via the rebuild path) so a failed write is not
 * worth surfacing to the user.
 */
export function save(historyFolder: string, rounds: ConversationMessage[][]): void {
    try {
        if (!fs.existsSync(historyFolder)) {
            fs.mkdirSync(historyFolder, { recursive: true });
        }
        const target = rawTurnsPath(historyFolder);
        const tmp = target + '.tmp';
        const payload: RawTurnsPayload = {
            rounds,
            savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
        fs.renameSync(tmp, target);
    } catch {
        // best-effort — see doc comment
    }
}

/**
 * Append `round` to the rolling tail, capped at `rawTurnsKept` rounds.
 * When the cap is exceeded, the oldest rounds are dropped — classic
 * ring-buffer semantics. Returns the resulting `rounds` array so
 * callers can mirror the on-disk state into memory without an extra
 * load.
 *
 * `rawTurnsKept = 0` honestly means "keep nothing"; the call still
 * persists an empty rounds array so a stale file is overwritten.
 */
export function pushAndCap(
    historyFolder: string,
    round: ConversationMessage[],
    rawTurnsKept: number,
): ConversationMessage[][] {
    const cap = Math.max(0, rawTurnsKept);
    const existing = load(historyFolder)?.rounds ?? [];
    const next = [...existing, round];
    const trimmed = cap === 0 ? [] : next.slice(-cap);
    save(historyFolder, trimmed);
    return trimmed;
}

/** Delete `rawTurns.json`. Best-effort — silently no-ops on error. */
export function clear(historyFolder: string): void {
    try {
        const target = rawTurnsPath(historyFolder);
        if (fs.existsSync(target)) { fs.unlinkSync(target); }
    } catch {
        // best-effort
    }
}

/**
 * Pair a flat `[user, assistant, user, assistant, ...]` message array
 * into rounds. Stray odd-length tails are dropped — they represent a
 * half-finished exchange that the caller hasn't completed, and
 * shipping a half-round on the wire would confuse the next API call.
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
 * shape the rest of the codebase consumes.
 */
export function roundsToRawTurns(rounds: ConversationMessage[][]): ConversationMessage[] {
    return rounds.reduce<ConversationMessage[]>((acc, round) => {
        for (const msg of round) { acc.push(msg); }
        return acc;
    }, []);
}
