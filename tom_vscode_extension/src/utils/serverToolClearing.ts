/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (context_management, clear_at_least, ...) */
/**
 * Server-side clearing of old tool results on the direct transport (DA-1 (b),
 * DA-15 (a)): the API's context editing (`clear_tool_uses_20250919`, beta
 * `context-management-2025-06-27`) clears old tool results before the model
 * sees them, while what we send stays append-only — the prompt cache and the
 * signed thinking blocks of thinking models (Opus 5.5, Fable 5.1) stay valid,
 * since server-side clearing does not count as a history edit.
 *
 * Used once the conversation holds a thinking block — the conversations the
 * client-side collapse (src/services/toolTrailRetention.ts) may no longer
 * rewrite; models that do not think keep the client-side collapse.
 *
 * Driven by the four retention settings (defaults, per-configuration
 * overrides):
 *  - `trigger`: the tool results pass `toolTrailCollapseChars` — the API counts
 *    the whole prompt, so the trigger is the send's first prompt (system,
 *    tools, first message) plus `toolTrailCollapseChars` in tokens;
 *  - `keep`: the tool uses of the newest `toolTrailKeepRounds` rounds;
 *  - `clear_at_least`: the batch the collapse would clear when it fires,
 *    `toolTrailCollapseChars` less the kept rounds' inline results
 *    (`toolTrailKeepRounds` × `toolTrailMaxResultChars`), in tokens;
 *  - `exclude_tools`: tomAi_readPastToolResult, the recovery path.
 *
 * vscode-free.
 */

import type Anthropic from '@anthropic-ai/sdk';

import type { RetentionCaps } from '../services/toolTrailRetention';

/** The beta header of context editing. */
export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
/** The edit that clears old tool results. */
export const CLEAR_TOOL_USES_EDIT = 'clear_tool_uses_20250919';
/** Characters per token for the conversion of the character settings (the usual estimate for English and code). */
export const CHARS_PER_TOKEN = 4;
/** The tools whose uses are never cleared. */
export const NEVER_CLEARED_TOOLS: readonly string[] = ['tomAi_readPastToolResult'];

type ClearToolUsesEdit = Anthropic.Beta.Messages.BetaClearToolUses20250919Edit;

/** Characters as tokens, rounded up. */
export function charsToTokens(chars: number): number {
    return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** The whole prompt of a response, in tokens: uncached input, cache reads and cache writes. */
export function promptTokensOf(usage: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined): number {
    if (!usage) { return 0; }
    const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

/** The tool uses of the newest `keepRounds` assistant turns that called tools. */
export function toolUsesOfNewestRounds(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>, keepRounds: number): number {
    let rounds = 0;
    let uses = 0;
    for (let i = messages.length - 1; i >= 0 && rounds < keepRounds; i--) {
        const m = messages[i];
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
        const calls = (m.content as Array<{ type?: unknown }>).filter((b) => b?.type === 'tool_use').length;
        if (calls === 0) { continue; }
        rounds += 1;
        uses += calls;
    }
    return uses;
}

/** The clearing edit for a request: the settings mapped as described above. */
export function clearToolUsesEdit(caps: RetentionCaps, firstPromptTokens: number, messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): ClearToolUsesEdit {
    const keepRounds = Math.max(0, Math.floor(caps.toolTrailKeepRounds));
    const batchChars = caps.toolTrailCollapseChars - keepRounds * caps.toolTrailMaxResultChars;
    return {
        type: CLEAR_TOOL_USES_EDIT,
        trigger: { type: 'input_tokens', value: Math.max(1, firstPromptTokens) + charsToTokens(caps.toolTrailCollapseChars) },
        keep: { type: 'tool_uses', value: toolUsesOfNewestRounds(messages, keepRounds) },
        clear_at_least: { type: 'input_tokens', value: Math.max(1, charsToTokens(batchChars)) },
        exclude_tools: [...NEVER_CLEARED_TOOLS],
    };
}

/**
 * What a request adds for server-side clearing, or undefined when it adds
 * nothing: the conversation holds no thinking block (the client-side collapse
 * keeps it small), or the send's first prompt is not known yet (round one has
 * no tool results to clear).
 */
export function serverToolClearing(
    messages: ReadonlyArray<{ role?: unknown; content?: unknown }>,
    caps: RetentionCaps,
    firstPromptTokens: number | undefined,
    hasThinking: boolean,
): { betas: string[]; context_management: { edits: ClearToolUsesEdit[] } } | undefined {
    if (!hasThinking || firstPromptTokens === undefined) { return undefined; }
    return {
        betas: [CONTEXT_MANAGEMENT_BETA],
        context_management: { edits: [clearToolUsesEdit(caps, firstPromptTokens, messages)] },
    };
}

/** The live-trail notice for what the server cleared in a response, or undefined when it cleared nothing. */
export function appliedClearingNotice(contextManagement: unknown): string | undefined {
    const edits = (contextManagement as { applied_edits?: unknown })?.applied_edits;
    if (!Array.isArray(edits)) { return undefined; }
    const parts = (edits as Array<{ type?: unknown; cleared_tool_uses?: unknown; cleared_input_tokens?: unknown }>)
        .filter((e) => e?.type === CLEAR_TOOL_USES_EDIT && typeof e.cleared_tool_uses === 'number' && e.cleared_tool_uses > 0)
        .map((e) => `${e.cleared_tool_uses} tool uses (${Number(e.cleared_input_tokens ?? 0).toLocaleString('en-US')} tokens)`);
    return parts.length > 0 ? `The API cleared ${parts.join(', ')} of old tool results before this round (server-side context editing).` : undefined;
}
