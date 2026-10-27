/**
 * The tool-trail retention step of the direct transport's tool loop: what
 * happens to the `tool_result` blocks of `messages[]` after each round.
 *
 * Without extended thinking, the newest `keepRounds` rounds keep their
 * results inline (cut to the trail's inline length) and every older round's
 * results become a one-line stub naming the replay key, so a long tool loop
 * does not resend every full result each round.
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

import type { ToolTrail, ToolTrailEntry } from './tool-trail';

/** A message of the tool loop, as far as this step reads it. */
export interface RetentionMessage {
    role: string;
    content: unknown;
}

export interface RetentionOptions {
    keepRounds: number;
    inlineMaxChars: number;
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
    // Walk newest-first, counting the user turns that carry tool results: one per round.
    let roundsSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user' || !Array.isArray(msg.content)) { continue; }
        const blocks = msg.content as Array<Record<string, unknown>>;
        if (!blocks.some((b) => b.type === 'tool_result')) { continue; }
        roundsSeen += 1;
        if (freezeEarlierRounds && roundsSeen > 1) { return; }
        const inline = freezeEarlierRounds || roundsSeen <= trail.keepRounds;
        for (const block of blocks) {
            if (block.type !== 'tool_result') { continue; }
            const id = String(block.tool_use_id ?? '');
            const entry = entryFor(id);
            if (inline) {
                // Inside the inline window: cut the body, keep it readable; the marker says where the rest is.
                if (!entry) { continue; }
                block.content = trail.truncateInline(entry.key, entry.toolName, entry.inputSummary, flattenContent(block.content));
            } else {
                // Beyond it: a stub. The block stays, so its tool_use stays paired.
                block.content = entry
                    ? trail.renderStub(entry)
                    : `[Past tool call (id=${id}) — full body persisted at _ai/trail/anthropic/<quest>/tool_results/. Use tomAi_listPastToolCalls to enumerate.]`;
            }
        }
    }
}
