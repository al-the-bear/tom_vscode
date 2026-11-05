/**
 * The tool-trail retention step of the direct transport's tool loop: what
 * happens to the `tool_result` blocks of `messages[]` after each round.
 *
 * Without extended thinking, a result is cut to the inline length when it
 * arrives, and older rounds' results become a one-line stub naming the replay
 * key, so a long tool loop does not resend every full result each round.
 *
 * When stubbing happens depends on the conversation cache. Without caching,
 * every round past the newest `keepRounds` is stubbed at once. With caching
 * (the direct API caches the conversation up to the newest turn; a read costs
 * 0.1× the input price, a write 1.25×), stubbing an old round rewrites a
 * message inside the cached prefix, so the next request reads the cache only
 * up to it and writes everything after it again. So with caching, earlier
 * rounds stay exactly as sent until a collapse threshold — more than
 * `collapseRounds` rounds kept whole, or more than `collapseChars` characters
 * of results in them — and then every round but the newest `keepRounds` is
 * stubbed in one go: the prefix changes once per batch, not once per round.
 *
 * Once the conversation holds a thinking block, an earlier message must
 * never change: a `thinking` (or `redacted_thinking`) block's signature
 * covers the conversation as it was when it was produced, and the API
 * rejects a request whose earlier messages no longer match ("Invalid
 * `signature` in `thinking` block. The block is bound to a different
 * conversation") — a 400 no retry can fix. Dropping the blocks is no way out
 * either: an assistant message that ends in `tool_use` must keep them. So only
 * the round just added is touched — its results are cut to the inline length
 * once, before any assistant turn follows them — and older rounds stay as
 * they were sent. They are not carried into the next prompt anyway: the
 * history between prompts is text only.
 *
 * The conversation decides, not the profile: a model may think without a
 * `thinking` request parameter (Opus 5.5 does, measured 2026-10-27 with a
 * profile whose `thinkingEnabled` is false).
 *
 * vscode-free.
 */

import { PAST_TOOL_CALL_STUB_PREFIX, type ToolTrail, type ToolTrailEntry } from './tool-trail';

/** A message of the tool loop, as far as this step reads it. */
export interface RetentionMessage {
    role: string;
    content: unknown;
}

export interface RetentionOptions {
    /** Rounds kept whole after a collapse (and, without caching, at any time). */
    keepRounds: number;
    /** A result is cut to this many characters when it arrives. */
    inlineMaxChars: number;
    /** The request caches the conversation: collapse in batches. Default false. */
    cachingEnabled?: boolean;
    /** With caching: collapse once more than this many rounds are kept whole. */
    collapseRounds?: number;
    /** With caching: collapse once the whole rounds' results exceed this many characters. */
    collapseChars?: number;
}

/** The retention caps, as the `compaction` section and a configuration state them. */
export interface RetentionCaps {
    toolTrailMaxResultChars: number;
    toolTrailKeepRounds: number;
    toolTrailCollapseRounds: number;
    toolTrailCollapseChars: number;
}

/** The defaults when neither the `compaction` section nor the configuration states a cap. */
export const RETENTION_DEFAULTS: Readonly<RetentionCaps> = {
    toolTrailMaxResultChars: 30_000,
    toolTrailKeepRounds: 2,
    toolTrailCollapseRounds: 30,
    toolTrailCollapseChars: 300_000,
};

/** The retention keys a configuration may override. */
export const RETENTION_KEYS = Object.keys(RETENTION_DEFAULTS) as Array<keyof RetentionCaps>;

/** Each cap: the configuration's own value, else the `compaction` section's, else the default. */
export function resolveRetentionCaps(
    section: Partial<Record<keyof RetentionCaps, unknown>> | undefined,
    configuration: Partial<Record<keyof RetentionCaps, unknown>> | undefined,
): RetentionCaps {
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const caps = { ...RETENTION_DEFAULTS };
    for (const key of RETENTION_KEYS) {
        caps[key] = num(configuration?.[key]) ?? num(section?.[key]) ?? RETENTION_DEFAULTS[key];
    }
    return caps;
}

const SIGNED_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Does an assistant turn of `messages` carry a signed thinking block? Then no earlier message may change. */
export function conversationHasThinking(messages: readonly RetentionMessage[]): boolean {
    return messages.some((m) => m.role === 'assistant' && Array.isArray(m.content)
        && (m.content as Array<{ type?: unknown }>).some((b) => SIGNED_BLOCK_TYPES.has(String(b?.type))));
}

/** The parts of a ToolTrail this step uses. */
export type RetentionTrail = Pick<ToolTrail, 'truncateInline' | 'renderStub'> & { inlineMaxChars: number; keepRounds: number };

function flattenContent(content: unknown): string {
    if (typeof content === 'string') { return content; }
    if (Array.isArray(content)) {
        return content
            .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
            .join('');
    }
    return '';
}

/**
 * Apply the retention step to `messages` in place. `entryFor` maps a
 * `tool_use_id` to its trail entry (undefined when the trail does not know it).
 */
export function applyToolTrailRetention(
    messages: RetentionMessage[],
    trail: RetentionTrail,
    entryFor: (toolUseId: string) => ToolTrailEntry | undefined,
    options: RetentionOptions,
): void {
    trail.inlineMaxChars = Math.max(100, options.inlineMaxChars);
    trail.keepRounds = Math.max(0, options.keepRounds);
    const freezeEarlierRounds = conversationHasThinking(messages);

    // The rounds, newest first: each user turn that carries tool results.
    const rounds: Array<Array<Record<string, unknown>>> = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user' || !Array.isArray(msg.content)) { continue; }
        const blocks = (msg.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result');
        if (blocks.length > 0) { rounds.push(blocks); }
    }
    if (rounds.length === 0) { return; }

    const cut = (block: Record<string, unknown>): void => {
        const entry = entryFor(String(block.tool_use_id ?? ''));
        if (!entry) { return; }
        block.content = trail.truncateInline(entry.key, entry.toolName, entry.inputSummary, flattenContent(block.content));
    };
    const stub = (block: Record<string, unknown>): void => {
        const id = String(block.tool_use_id ?? '');
        const entry = entryFor(id);
        // The block stays, so its tool_use stays paired.
        block.content = entry
            ? trail.renderStub(entry)
            : `${PAST_TOOL_CALL_STUB_PREFIX}(id=${id}) — full body persisted at _ai/trail/anthropic/<quest>/tool_results/. Use tomAi_listPastToolCalls to enumerate.]`;
    };
    const isStubbed = (round: Array<Record<string, unknown>>): boolean =>
        round.every((b) => flattenContent(b.content).startsWith(PAST_TOOL_CALL_STUB_PREFIX));

    // The round just added is cut once, before the model sees it.
    rounds[0].forEach(cut);
    // Signed thinking blocks cover every earlier message: none may change.
    if (freezeEarlierRounds) { return; }

    // The rounds still whole, newest first: up to the first stubbed one.
    let whole = 0;
    let wholeChars = 0;
    while (whole < rounds.length && !isStubbed(rounds[whole])) {
        wholeChars += rounds[whole].reduce((n, b) => n + flattenContent(b.content).length, 0);
        whole += 1;
    }
    const keep = trail.keepRounds;
    const collapse = options.cachingEnabled
        ? whole > Math.max(keep, options.collapseRounds ?? RETENTION_DEFAULTS.toolTrailCollapseRounds)
            || wholeChars > (options.collapseChars ?? RETENTION_DEFAULTS.toolTrailCollapseChars)
        : whole > keep;
    if (!collapse) { return; }
    for (let r = keep; r < whole; r++) { rounds[r].forEach(stub); }
}
