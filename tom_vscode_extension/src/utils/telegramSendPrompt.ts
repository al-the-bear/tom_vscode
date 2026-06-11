/**
 * Pure helpers for the Telegram `send_prompt` command — parsing the quest +
 * prompt out of the raw message and deciding whether *this* window should
 * process it.
 *
 * Kept free of `vscode` / I/O so it is unit-testable; the command handler in
 * `telegram-cmd-handlers.ts` wires these to `WsPaths.getWorkspaceQuestId()` and
 * the Anthropic send path.
 *
 * Message shape (everything after the `send_prompt` command word):
 *
 *     send_prompt <quest> <prompt text…>
 *
 * The first whitespace-delimited token is the quest id; the remainder (which may
 * span multiple lines) is the prompt, sent verbatim apart from boundary
 * trimming. A prompt cannot be sent without a quest — both parts are required.
 */

/** Human-readable usage shown on a parse error and in the command help. */
export const SEND_PROMPT_USAGE =
    'Usage: send_prompt <quest> <prompt text>\n' +
    'Example: send_prompt vscode_extension Summarize the open bug in the queue path';

/** Successful parse: the quest id and the verbatim prompt body. */
export interface SendPromptArgs {
    quest: string;
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
 * Split the raw `send_prompt` arguments into `{ quest, prompt }`, or return
 * `{ error }` when either part is missing. The prompt preserves its internal
 * formatting (newlines included) and is only trimmed at the boundaries.
 */
export function parseSendPromptArgs(rawArgs: string): SendPromptArgs | SendPromptParseError {
    const text = (rawArgs ?? '').replace(/^\s+/, '');
    if (text.length === 0) {
        return { error: `No quest specified.\n${SEND_PROMPT_USAGE}` };
    }
    // Quest = first whitespace-delimited token; prompt = the rest.
    const match = /^(\S+)(\s[\s\S]*)?$/.exec(text);
    // match always succeeds here since text is non-empty and starts non-space.
    const quest = match ? match[1] : text;
    const prompt = (match?.[2] ?? '').trim();
    if (prompt.length === 0) {
        return { error: `No prompt text specified for quest "${quest}".\n${SEND_PROMPT_USAGE}` };
    }
    return { quest, prompt };
}

/**
 * Whether a `send_prompt` targeting `requestedQuest` should be processed by a
 * window whose active quest is `currentQuest`. Comparison is trimmed and
 * case-insensitive so a hand-typed quest id matches the workspace filename
 * stem. Empty/`default` quests never match a request (a real quest must be
 * named).
 */
export function questMatches(requestedQuest: string, currentQuest: string): boolean {
    const a = (requestedQuest ?? '').trim().toLowerCase();
    const b = (currentQuest ?? '').trim().toLowerCase();
    if (a.length === 0 || b.length === 0) { return false; }
    return a === b;
}
