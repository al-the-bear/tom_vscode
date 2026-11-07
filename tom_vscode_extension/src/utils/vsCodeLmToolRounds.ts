/**
 * The VS Code LM tool loop's rounds, as the tool-trail retention step reads
 * them (CC-6). The loop keeps each round's results in Anthropic's shape here,
 * runs `applyToolTrailRetention` (src/services/toolTrailRetention.ts) over
 * {@link vsCodeLmRetentionView} — which mutates these very result objects —
 * and rebuilds the round's `LanguageModelToolResultPart`s from them. So the
 * direct loop and the VS Code LM loop trim old tool results by the same rule.
 *
 * vscode-free.
 */

import type { RetentionMessage } from '../services/toolTrailRetention';

/** One tool result of a round, in the shape the retention step reads. */
export interface VsCodeLmToolResult {
    type: 'tool_result';
    /** The VS Code LM call id (`LanguageModelToolCallPart.callId`). */
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the retention step's field name
    tool_use_id: string;
    content: string;
}

/** A round's results and the index of the User message in `chatMessages` that carries them. */
export interface VsCodeLmToolRound {
    messageIndex: number;
    results: VsCodeLmToolResult[];
}

/**
 * The rounds as retention messages, oldest first: one user turn per round,
 * holding the round's result objects themselves, so what the retention step
 * writes into them is what the loop sends next.
 */
export function vsCodeLmRetentionView(rounds: readonly VsCodeLmToolRound[]): RetentionMessage[] {
    return rounds.map((r) => ({ role: 'user', content: r.results }));
}
