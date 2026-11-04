/**
 * Prompt caching on the direct Anthropic transport.
 *
 * Anthropic caches the request prefix up to each `cache_control` breakpoint,
 * in the order tools → system → messages. The system prompt has carried a
 * breakpoint for a long time (`AnthropicHandler.buildSystemParam`); this
 * module adds the other two, so a tool loop or a `<prefix>*` queue walk reads
 * its tool definitions and its whole conversation so far from the cache
 * instead of paying for them again every round:
 *
 *   - the last tool definition (caches every tool definition), and
 *   - the last cacheable content block of the last message (caches the
 *     conversation up to and including the newest turn; the next round's
 *     request starts with that same prefix and reads it back).
 *
 * With the system breakpoint that makes three, below Anthropic's limit of
 * {@link MAX_CACHE_BREAKPOINTS}.
 *
 * Nothing is mutated: the handler keeps pushing onto its message array round
 * after round, and a breakpoint written into it would still be there in the
 * next round, beside the new one — four rounds later the request would be
 * refused for carrying too many. So the marked tool and message are copies.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the Messages API's snake_case wire fields */

import type { LiveTrailTokenCounts } from '../services/live-trail';

/** Anthropic refuses a request with more `cache_control` breakpoints than this. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** The only cache type the Messages API knows (5-minute lifetime). */
export const EPHEMERAL_CACHE_CONTROL = Object.freeze({ type: 'ephemeral' as const });

type CacheControl = { type: 'ephemeral' };

/** A content block; only its type, text and `cache_control` matter here. */
interface Block {
    type?: string;
    text?: unknown;
    cache_control?: CacheControl | null;
}

/** A message param: role plus string or block-array content. */
export interface CacheableMessage {
    role: string;
    content: string | ReadonlyArray<unknown>;
}

/**
 * Block types the API refuses a `cache_control` on. Thinking blocks are cached
 * as part of the prefix but cannot carry a breakpoint themselves.
 */
const UNMARKABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

function isMarkable(block: unknown): boolean {
    if (!block || typeof block !== 'object') { return false; }
    const b = block as Block;
    if (typeof b.type !== 'string' || UNMARKABLE_BLOCK_TYPES.has(b.type)) { return false; }
    // An empty text block cannot carry cache_control either (the API refuses it).
    if (b.type === 'text' && (typeof b.text !== 'string' || b.text.length === 0)) { return false; }
    return true;
}

/** The tools with the last one marked as a breakpoint; a copy, never the input. */
export function withToolsCacheBreakpoint<T extends object>(tools: readonly T[]): T[] {
    if (tools.length === 0) { return []; }
    const copy = tools.slice();
    const last = copy.length - 1;
    copy[last] = { ...copy[last], cache_control: EPHEMERAL_CACHE_CONTROL } as T;
    return copy;
}

/**
 * The messages with a breakpoint on the last block that can carry one — the
 * last block of the last message as a rule; walking back past thinking and
 * empty text blocks, and to earlier messages only when the last holds nothing
 * markable. A string content becomes one text block. Returns a copy in which
 * only the marked message (and its content array) is new; when nothing can be
 * marked, the messages are returned unchanged (as a copy).
 */
export function withLastMessageCacheBreakpoint<M extends CacheableMessage>(messages: readonly M[]): M[] {
    const copy = messages.slice();
    for (let mi = copy.length - 1; mi >= 0; mi--) {
        const message = copy[mi];
        if (typeof message.content === 'string') {
            if (message.content.length === 0) { continue; }
            copy[mi] = {
                ...message,
                content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL_CACHE_CONTROL }],
            } as M;
            return copy;
        }
        const blocks = message.content;
        for (let bi = blocks.length - 1; bi >= 0; bi--) {
            if (!isMarkable(blocks[bi])) { continue; }
            const newBlocks = blocks.slice();
            newBlocks[bi] = { ...(blocks[bi] as object), cache_control: EPHEMERAL_CACHE_CONTROL };
            copy[mi] = { ...message, content: newBlocks } as M;
            return copy;
        }
    }
    return copy;
}

/**
 * The tools and messages of one request, with the tool and conversation
 * breakpoints when `enabled`; unchanged copies otherwise.
 */
export function applyPromptCaching<T extends object, M extends CacheableMessage>(
    params: { tools: readonly T[]; messages: readonly M[] },
    enabled: boolean,
): { tools: T[]; messages: M[] } {
    if (!enabled) {
        return { tools: params.tools.slice(), messages: params.messages.slice() };
    }
    return {
        tools: withToolsCacheBreakpoint(params.tools),
        messages: withLastMessageCacheBreakpoint(params.messages),
    };
}

/** How many `cache_control` breakpoints a request body carries (system, tools, messages). */
export function countCacheBreakpoints(body: {
    system?: unknown;
    tools?: readonly unknown[];
    messages?: readonly CacheableMessage[];
}): number {
    const marked = (x: unknown): number =>
        x && typeof x === 'object' && (x as Block).cache_control ? 1 : 0;
    let n = 0;
    if (Array.isArray(body.system)) {
        for (const block of body.system) { n += marked(block); }
    }
    for (const tool of body.tools ?? []) { n += marked(tool); }
    for (const message of body.messages ?? []) {
        if (typeof message.content === 'string') { continue; }
        for (const block of message.content) { n += marked(block); }
    }
    return n;
}

/** The `usage` block of a Messages API response (snake_case, nullable cache fields). */
export interface AnthropicResponseUsage {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
}

/**
 * Add one response's usage to the running totals of a send (all rounds of the
 * tool loop), in the live trail's vocabulary. A field the response leaves out
 * or reports as null counts as zero; the totals carry every field once any
 * round reported anything.
 */
export function addResponseUsage(
    totals: LiveTrailTokenCounts,
    usage: AnthropicResponseUsage | null | undefined,
): LiveTrailTokenCounts {
    if (!usage) { return totals; }
    const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
        inputTokens: (totals.inputTokens ?? 0) + n(usage.input_tokens),
        outputTokens: (totals.outputTokens ?? 0) + n(usage.output_tokens),
        cacheReadInputTokens: (totals.cacheReadInputTokens ?? 0) + n(usage.cache_read_input_tokens),
        cacheCreationInputTokens: (totals.cacheCreationInputTokens ?? 0) + n(usage.cache_creation_input_tokens),
    };
}
