/**
 * Turn a *final LLM answer* into the chat-variable updates the prompt queue
 * applies after every completed exchange.
 *
 * Both transports funnel their final answer through here so a repeating or
 * multi-stage queue item propagates responseValues for EVERY stage — each
 * pre-prompt, the main prompt, every repeat, and every follow-up — rather than
 * only the last one:
 *
 *   - **Copilot** — `PromptQueueManager.onAnswerFileChanged` reads the answer
 *     file's structured `responseValues` and calls `propagateAnswerResponseValues`
 *     once per answer file.
 *   - **Anthropic** — `PromptQueueManager.dispatchStage` extracts responseValues
 *     from the direct answer text ({@link analyzeAnswerText}) and propagates them
 *     once per direct send.
 *
 * The built-in / custom split lives here (rather than inline in the queue) so it
 * is unit-testable and identical for both transports.
 */

import { extractResponseValuesFromText } from './responseValues';

/**
 * Keys that name a *built-in* chat variable. They are still exposed through the
 * `${chat.KEY}` response-value store, but must not be written as user-defined
 * custom variables (they have dedicated setters + provenance).
 */
export const BUILTIN_CHAT_VARIABLE_KEYS: readonly string[] = [
    'quest',
    'role',
    'activeProjects',
    'todo',
    'todoFile',
];

/** Chat-variable updates derived from one answer. */
export interface AnswerResponseValueUpdates {
    /** Every normalized response value — feeds the `${chat.KEY}` store. */
    chatResponseValues: Record<string, string>;
    /**
     * Non-built-in response values, with any leading `custom.` prefix stripped —
     * feeds `ChatVariablesStore.setCustomBulk`.
     */
    customValues: Record<string, string>;
}

/**
 * Coerce a raw response-value record to `Record<string, string>`: stringify
 * values, drop `null`/`undefined` values and empty keys.
 */
export function normalizeResponseValues(
    rv: Record<string, unknown> | undefined,
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!rv || typeof rv !== 'object') { return out; }
    for (const [k, v] of Object.entries(rv)) {
        if (!k) { continue; }
        if (v === undefined || v === null) { continue; }
        out[k] = String(v);
    }
    return out;
}

/**
 * Split normalized response values into the `${chat.KEY}` store payload (all of
 * them) and the custom-variable payload (built-ins removed, `custom.` prefix
 * stripped).
 */
export function splitResponseValues(
    normalized: Record<string, string>,
): AnswerResponseValueUpdates {
    const builtIn = new Set(BUILTIN_CHAT_VARIABLE_KEYS);
    const customValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(normalized)) {
        if (builtIn.has(k)) { continue; }
        const key = k.startsWith('custom.') ? k.substring('custom.'.length) : k;
        if (!key) { continue; }
        customValues[key] = v;
    }
    return { chatResponseValues: { ...normalized }, customValues };
}

/**
 * Full pipeline for a direct (Anthropic) answer: parse responseValues out of the
 * free-form answer text, then split them for the two stores.
 */
export function analyzeAnswerText(text: string): AnswerResponseValueUpdates {
    return splitResponseValues(normalizeResponseValues(extractResponseValuesFromText(text)));
}
