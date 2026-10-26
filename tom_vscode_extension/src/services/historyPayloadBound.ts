/**
 * The conversation history a request carries, bounded.
 *
 * The handler keeps two round lists: the compaction accumulator (every round
 * since the last compaction, cleared when a compaction succeeds) and the
 * rolling tail (the last `rawTurnsKept` rounds). A request carries their
 * union, so nothing between two compactions is lost. With compaction switched
 * off nothing ever clears the accumulator: the union grows with every round
 * and a request eventually exceeds the model's context window. So:
 *
 * - compaction off: the request carries the rolling tail only;
 * - always: the newest rounds that fit `maxHistoryTokens` (estimated at four
 *   characters a token), as a contiguous suffix — a round that does not fit
 *   ends the history there, older rounds are not stitched past it.
 *
 * vscode-free.
 */

import type { ConversationMessage } from './history-compaction';

/** Rough token count of a text: four characters a token. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function roundTokens(round: ConversationMessage[]): number {
    return round.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : String(m.content ?? '')), 0);
}

export interface PayloadHistoryInput {
    /** Accumulator ∪ rolling tail, deduplicated, oldest first. */
    union: ConversationMessage[][];
    /** The last `rawTurnsKept` rounds, oldest first. */
    rollingTail: ConversationMessage[][];
    compactionDisabled: boolean;
    /** Token cap for the history; 0 or not finite: no cap. */
    maxHistoryTokens: number;
}

/** The flat `[user, assistant, …]` history a request carries. */
export function boundPayloadHistory(input: PayloadHistoryInput): ConversationMessage[] {
    const rounds = input.compactionDisabled ? input.rollingTail : input.union;
    const cap = input.maxHistoryTokens;
    let kept = rounds;
    if (Number.isFinite(cap) && cap > 0) {
        let total = 0;
        let start = rounds.length;
        for (let i = rounds.length - 1; i >= 0; i--) {
            const t = roundTokens(rounds[i]);
            if (total + t > cap) { break; }
            total += t;
            start = i;
        }
        kept = rounds.slice(start);
    }
    return kept.flat();
}
