/**
 * Pure helpers for the Telegram prompt-queue commands.
 *
 * These parse the textual arguments of the queue-control commands into typed
 * values; the wiring in `telegram-cmd-handlers.ts` / `telegram-commands.ts`
 * applies them to the {@link PromptQueueManager}. Kept free of `vscode` / I/O so
 * they are unit-testable.
 *
 *   queue_prompt [count] [next] <prompt text…>
 *   queue_delete <index>
 *   queue_list
 *   queue_pause
 *
 * `count` (a positive integer) and the literal `next` are *optional leading*
 * tokens, in either order; everything after them is the prompt body, verbatim
 * apart from boundary trimming. `next` queues the prompt at the **top** (so it
 * is dispatched next); `count` repeats it. Because the count/`next` tokens are
 * peeled greedily, a prompt whose body is literally a bare number or the word
 * `next` cannot be expressed — an acceptable trade-off for the convenience.
 */

/** Usage shown on a parse error and in command help. */
export const QUEUE_PROMPT_USAGE =
    'Usage: queue_prompt [count] [next] <prompt text>\n' +
    'Examples:\n' +
    '  queue_prompt Run the analyzer on tom_core\n' +
    '  queue_prompt 3 Retry the failing test\n' +
    '  queue_prompt next Fix the build first';

/** Usage shown on a queue_delete parse error and in command help. */
export const QUEUE_DELETE_USAGE =
    'Usage: queue_delete <index>\n' +
    'The index is the number shown by queue_list.';

/** Successful parse of `queue_prompt`. */
export interface QueuePromptArgs {
    /** Verbatim prompt body. */
    prompt: string;
    /** Repetition count when a leading positive integer was supplied. */
    repeatCount?: number;
    /** True when the literal `next` was supplied — queue at the top. */
    next: boolean;
}

/** Parse failure carrying a user-facing reason. */
export interface QueueCommandParseError {
    error: string;
}

/** Type guard distinguishing a parse error from a successful parse. */
export function isQueueCommandParseError(
    result: unknown,
): result is QueueCommandParseError {
    return !!result && typeof (result as QueueCommandParseError).error === 'string';
}

/**
 * Parse `queue_prompt` arguments: peel an optional leading positive-integer
 * repetition count and/or the literal `next` (either order), then take the rest
 * as the prompt body. Returns `{ error }` when no prompt text remains.
 */
export function parseQueuePromptArgs(
    rawArgs: string,
): QueuePromptArgs | QueueCommandParseError {
    let rest = (rawArgs ?? '').replace(/^\s+/, '');
    let repeatCount: number | undefined;
    let next = false;

    for (;;) {
        const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
        if (!m) { break; }
        const token = m[1];
        const remainder = (m[2] ?? '').replace(/^\s+/, '');

        if (repeatCount === undefined && /^[0-9]+$/.test(token)) {
            const n = parseInt(token, 10);
            if (n >= 1) { repeatCount = n; rest = remainder; continue; }
        }
        if (!next && token.toLowerCase() === 'next') {
            next = true; rest = remainder; continue;
        }
        break;
    }

    const prompt = rest.trim();
    if (prompt.length === 0) {
        return { error: `No prompt text specified.\n${QUEUE_PROMPT_USAGE}` };
    }
    return { prompt, ...(repeatCount !== undefined ? { repeatCount } : {}), next };
}

/**
 * Parse `queue_delete` arguments into a 1-based index, or `{ error }` when the
 * argument is missing / not a positive integer.
 */
export function parseQueueDeleteArg(
    rawArgs: string,
): number | QueueCommandParseError {
    const t = (rawArgs ?? '').trim();
    if (!/^[0-9]+$/.test(t)) {
        return { error: `Specify the queue index to delete.\n${QUEUE_DELETE_USAGE}` };
    }
    const n = parseInt(t, 10);
    if (n < 1) {
        return { error: `Index must be 1 or greater.\n${QUEUE_DELETE_USAGE}` };
    }
    return n;
}
