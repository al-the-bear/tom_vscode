/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (tool_use_id, error_code, ...) */
/**
 * Server tool uses on the direct transport: the calls the API runs itself
 * (tool search, web search / fetch, code execution, advisor) and their result
 * blocks.
 *
 * A response may hold a `server_tool_use` without its result block:
 *
 * - with `stop_reason: 'tool_use'`, next to a client `tool_use`: the API runs
 *   the server tool when the round goes on and puts its result at the start of
 *   the next response — but only when the user message after it holds the
 *   tool results alone. A text block there (the parallel-calls reminder) makes
 *   the API refuse the request with a 400 (`… tool use with id … was found
 *   without a corresponding …_tool_result block`). So such a round sends its
 *   tool results without the reminder ({@link hasPendingServerToolUse});
 * - with `stop_reason: 'pause_turn'`: the API paused a long turn; the request
 *   is sent again with the assistant content as the last message and no user
 *   message, and the response goes on in that message
 *   ({@link appendAssistantContent});
 * - anywhere else (a Stop hook or background command going on with a user
 *   text, a refused request): the call gets an error result right after it
 *   ({@link repairServerToolUses}, {@link repairConversation}), which the API
 *   accepts next to a signed thinking block. Thinking blocks are never touched.
 *
 * vscode-free.
 */

/** A content block, as far as this module reads it. */
export interface ContentBlockLike {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    content?: unknown;
}

/** A message of the conversation, as far as this module reads it. */
export interface MessageLike {
    role: string;
    content: unknown;
}

/** The result block type and its error type, per server tool name. */
const RESULT_TYPES: Readonly<Record<string, { result: string; error: string }>> = {
    tool_search_tool_bm25: { result: 'tool_search_tool_result', error: 'tool_search_tool_result_error' },
    tool_search_tool_regex: { result: 'tool_search_tool_result', error: 'tool_search_tool_result_error' },
    web_search: { result: 'web_search_tool_result', error: 'web_search_tool_result_error' },
    web_fetch: { result: 'web_fetch_tool_result', error: 'web_fetch_tool_result_error' },
    code_execution: { result: 'code_execution_tool_result', error: 'code_execution_tool_result_error' },
    bash_code_execution: { result: 'bash_code_execution_tool_result', error: 'bash_code_execution_tool_result_error' },
    text_editor_code_execution: { result: 'text_editor_code_execution_tool_result', error: 'text_editor_code_execution_tool_result_error' },
    advisor: { result: 'advisor_tool_result', error: 'advisor_tool_result_error' },
};

/** The error result block the repair puts after an unmatched server tool use (every type takes `unavailable`). */
export function serverToolErrorResult(use: ContentBlockLike): Record<string, unknown> {
    const name = String(use.name ?? '');
    const types = RESULT_TYPES[name] ?? { result: `${name}_tool_result`, error: `${name}_tool_result_error` };
    return { type: types.result, tool_use_id: use.id, content: { type: types.error, error_code: 'unavailable' } };
}

function blocksOf(content: unknown): ContentBlockLike[] {
    return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

/** A server tool's result block (any `*_tool_result` carrying a `tool_use_id`, not a client `tool_result`). */
export function isServerToolResult(block: ContentBlockLike): boolean {
    return typeof block?.type === 'string' && block.type !== 'tool_result' && block.type.endsWith('_tool_result') && typeof block.tool_use_id === 'string';
}

/** The ids of the server tool results among the blocks. */
function resultIds(blocks: readonly ContentBlockLike[]): Set<string> {
    return new Set(blocks.filter(isServerToolResult).map((b) => String(b.tool_use_id)));
}

/** The server tool uses of `content` that have no result block in it. */
export function unmatchedServerToolUses(content: unknown): ContentBlockLike[] {
    const blocks = blocksOf(content);
    const results = resultIds(blocks);
    return blocks.filter((b) => b?.type === 'server_tool_use' && !results.has(String(b.id)));
}

/** True when `content` holds a server tool use the API has not answered yet. */
export function hasPendingServerToolUse(content: unknown): boolean {
    return unmatchedServerToolUses(content).length > 0;
}

/**
 * `content` with an error result right after every server tool use that has
 * none in `content` nor among `answered` (ids answered elsewhere in the
 * conversation). Every other block, thinking blocks included, is kept as it
 * is. Returns a new array and the ids repaired; `content` itself is not changed.
 */
export function repairServerToolUses<T extends ContentBlockLike>(content: readonly T[], answered: ReadonlySet<string> = new Set()): { content: T[]; repaired: string[] } {
    const results = resultIds(content);
    const out: T[] = [];
    const repaired: string[] = [];
    for (const block of content) {
        out.push(block);
        if (block?.type === 'server_tool_use' && !results.has(String(block.id)) && !answered.has(String(block.id))) {
            out.push(serverToolErrorResult(block) as T);
            repaired.push(String(block.id));
        }
    }
    return { content: out, repaired };
}

/**
 * Repair every assistant message of the conversation in place: a server tool
 * use whose result is nowhere in the conversation (a later response may carry
 * it, the API's own continuation) gets an error result after it. Returns the
 * ids repaired.
 */
export function repairConversation(messages: MessageLike[]): string[] {
    const answered = new Set<string>();
    for (const m of messages) { for (const id of resultIds(blocksOf(m.content))) { answered.add(id); } }
    const repaired: string[] = [];
    for (const m of messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) { continue; }
        const fixed = repairServerToolUses(m.content as ContentBlockLike[], answered);
        if (fixed.repaired.length > 0) {
            m.content = fixed.content;
            repaired.push(...fixed.repaired);
        }
    }
    return repaired;
}

/**
 * Put a response's content into the conversation: after a paused turn (the
 * last message is the assistant's) it goes on in that message, else it is a
 * new assistant message.
 */
export function appendAssistantContent(messages: MessageLike[], content: readonly unknown[]): void {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
        last.content = [...blocksOf(last.content), ...content];
        return;
    }
    messages.push({ role: 'assistant', content: [...content] });
}

/** The 400 the API answers for a server tool use without its result block. */
const UNMATCHED_400 = /tool use with id\s+`?[\w-]+`?\s+was found without a corresponding\s+`?\w+_tool_result`?/i;

/** True for the API's refusal of a server tool use without its result block. */
export function isUnmatchedServerToolUseError(err: unknown): boolean {
    const status = (err as { status?: unknown } | null)?.status;
    if (status !== undefined && status !== 400) { return false; }
    const text = err instanceof Error ? err.message : String(err);
    return UNMATCHED_400.test(text);
}

export interface SendWithServerToolRepairOptions<T> {
    /** The conversation the round is sent over; repaired in place before the retry. */
    messages: MessageLike[];
    /** Sends the round over `messages` as they are now. */
    send: () => Promise<T>;
    /** Told when the round is sent again: the ids repaired and the refusal's text. */
    onRepair?: (repaired: string[], errorText: string) => void;
}

/**
 * Send the round; when the API refuses it for a server tool use without its
 * result, repair the conversation and send it once more. Any other error, a
 * refusal with nothing to repair, or the second refusal is thrown.
 */
export async function sendWithServerToolRepair<T>(opts: SendWithServerToolRepairOptions<T>): Promise<T> {
    try {
        return await opts.send();
    } catch (err) {
        if (!isUnmatchedServerToolUseError(err)) { throw err; }
        const repaired = repairConversation(opts.messages);
        if (repaired.length === 0) { throw err; }
        opts.onRepair?.(repaired, err instanceof Error ? err.message : String(err));
        return opts.send();
    }
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What a server tool's result says, in a line or two for the live trail: the tools found, the pages, or the error. */
export function describeServerToolResult(result: ContentBlockLike): string {
    const content = result.content as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(content)) {
        // web search: the pages found.
        const titles = content.map((r) => String((r as { title?: unknown; url?: unknown }).title ?? (r as { url?: unknown }).url ?? '')).filter(Boolean);
        return clip(`${content.length} result(s)${titles.length ? `: ${titles.join('; ')}` : ''}`, 600);
    }
    if (!content || typeof content !== 'object') { return '(no content)'; }
    const type = String(content.type ?? '');
    if (type.endsWith('_error')) {
        const message = typeof content.error_message === 'string' && content.error_message ? ` — ${content.error_message}` : '';
        return `error: ${String(content.error_code ?? 'unknown')}${message}`;
    }
    if (Array.isArray(content.tool_references)) {
        const names = (content.tool_references as Array<{ tool_name?: unknown }>).map((r) => String(r.tool_name ?? '')).filter(Boolean);
        return names.length ? `tools found: ${names.join(', ')}` : 'no tools found';
    }
    if (typeof content.url === 'string') { return `fetched ${content.url}`; }
    if (typeof content.return_code === 'number') { return `return code ${content.return_code}`; }
    return clip(type || 'result', 300);
}
