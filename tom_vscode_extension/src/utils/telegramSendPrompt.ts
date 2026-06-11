/**
 * Pure helpers for the Telegram `send_prompt` command.
 *
 * Telegram settings are now **per workspace/quest** (each workspace's
 * `tom_vscode_extension.json` configures its own bot), so a prompt no longer
 * carries a quest selector: the window that polls the bot is the one that runs
 * the prompt. The whole message (everything after the `send_prompt` command
 * word) is therefore the prompt body, sent verbatim apart from boundary
 * trimming.
 *
 * Kept free of `vscode` / I/O so it is unit-testable; the command handler in
 * `telegram-cmd-handlers.ts` wires these to the Anthropic send path, and
 * {@link questMatches} is used by the live-conversation forwarder to filter
 * live-trail events down to this window's own quest.
 *
 *     send_prompt <prompt text…>
 */

/** Human-readable usage shown on a parse error and in the command help. */
export const SEND_PROMPT_USAGE =
    'Usage: send_prompt <prompt text>\n' +
    'Example: send_prompt Summarize the open bug in the queue path';

/** Successful parse: the verbatim prompt body. */
export interface SendPromptArgs {
    prompt: string;
}

/** Parse failure carrying a user-facing reason. */
export interface SendPromptParseError {
    error: string;
}

/** Type guard distinguishing a parse error from a successful parse. */
export function isSendPromptParseError(
    result: SendPromptArgs | SendPromptParseError,
): result is SendPromptParseError {
    return (result as SendPromptParseError).error !== undefined;
}

/**
 * Extract the prompt body from the raw `send_prompt` arguments, or return
 * `{ error }` when no prompt text is present. The prompt preserves its internal
 * formatting (newlines included) and is only trimmed at the boundaries.
 */
export function parseSendPromptArgs(rawArgs: string): SendPromptArgs | SendPromptParseError {
    const prompt = (rawArgs ?? '').trim();
    if (prompt.length === 0) {
        return { error: `No prompt text specified.\n${SEND_PROMPT_USAGE}` };
    }
    return { prompt };
}

/**
 * Whether a live-trail event whose quest is `eventQuest` belongs to the window
 * whose active quest is `currentQuest`. Comparison is trimmed and
 * case-insensitive so the writer's quest id matches the workspace filename
 * stem. Empty quests never match (a real quest must be named).
 */
export function questMatches(eventQuest: string, currentQuest: string): boolean {
    const a = (eventQuest ?? '').trim().toLowerCase();
    const b = (currentQuest ?? '').trim().toLowerCase();
    if (a.length === 0 || b.length === 0) { return false; }
    return a === b;
}
