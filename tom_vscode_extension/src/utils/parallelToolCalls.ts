/**
 * Parallel tool calls on the direct transport (DA-11): the reminder appended
 * after each round's tool results, and the share of assistant turns that made
 * more than one tool call — recorded in the send's usage block, so the
 * reminder's effect can be measured.
 *
 * vscode-free.
 */

import type { LiveTrailToolTurns } from '../services/live-trail';

/** The reminder when `anthropic.parallelToolCallsReminder` is not set. */
export const DEFAULT_PARALLEL_CALLS_REMINDER =
    'Reminder: when tool calls do not depend on each other\'s results, make them all in the same turn '
    + '(several tool_use blocks in one response) instead of one call per turn.';

/** The reminder a send appends: the setting's text, the default when unset, none when set to ''. */
export function parallelCallsReminder(setting: unknown): string {
    if (setting === undefined || setting === null) { return DEFAULT_PARALLEL_CALLS_REMINDER; }
    return typeof setting === 'string' ? setting.trim() : DEFAULT_PARALLEL_CALLS_REMINDER;
}

/**
 * The content of the user message that answers a round: the tool results, then
 * the reminder as a text block (the API takes text after the tool_result
 * blocks). A new array; the message of an earlier round is never touched, so
 * the conversation the cache and the signed thinking blocks cover stays as sent.
 */
export function roundResultContent<T>(toolResults: readonly T[], reminder: string): Array<T | { type: 'text'; text: string }> {
    return reminder ? [...toolResults, { type: 'text', text: reminder }] : [...toolResults];
}

/** No turns counted yet. */
export function emptyToolTurns(): LiveTrailToolTurns {
    return { assistantTurns: 0, toolTurns: 0, multiCallTurns: 0 };
}

/** The counts with one more assistant turn that made `toolCalls` tool calls. */
export function addAssistantTurn(turns: LiveTrailToolTurns, toolCalls: number): LiveTrailToolTurns {
    return {
        assistantTurns: turns.assistantTurns + 1,
        toolTurns: turns.toolTurns + (toolCalls > 0 ? 1 : 0),
        multiCallTurns: turns.multiCallTurns + (toolCalls > 1 ? 1 : 0),
    };
}

/** The share of assistant turns with more than one tool call (0 without turns). */
export function multiCallShare(turns: LiveTrailToolTurns): number {
    return turns.assistantTurns > 0 ? turns.multiCallTurns / turns.assistantTurns : 0;
}

/**
 * The counts of a conversation as the Messages API holds it (a request body's
 * `messages`, e.g. from a raw trail's payload file): every assistant message
 * is a turn, its tool_use blocks its calls. Measures a run made before the
 * usage block recorded the share.
 */
export function toolTurnsOfMessages(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): LiveTrailToolTurns {
    let turns = emptyToolTurns();
    for (const m of messages) {
        if (m?.role !== 'assistant') { continue; }
        const calls = Array.isArray(m.content)
            ? (m.content as Array<{ type?: unknown }>).filter((b) => b?.type === 'tool_use').length
            : 0;
        turns = addAssistantTurn(turns, calls);
    }
    return turns;
}
