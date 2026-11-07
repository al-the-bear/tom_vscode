/**
 * Show a chat send in the prompt queue while it runs (status `chat`) and with
 * its answer once it ended (`chat-sent`): src/utils/chatQueueItems.ts. Both
 * chat send paths wrap their send in trackChatSend — the panel's Send
 * (chatPanel-handler) and runAnthropicSend (the editor's Send to Anthropic/LLM,
 * a todo's Send and Guide me, Telegram).
 *
 * The queue is only a display here: when it is not available the send runs
 * the same, unrecorded.
 */

import type { LiveTrailTokenCounts } from '../services/live-trail';

export interface TrackedChatSend {
    text: string;
    profileId?: string;
    session: string;
    /** Where the send came from: `panel`, `editor`, `todo panel`, … */
    source: string;
}

export async function trackChatSend<T extends { text?: string; usage?: LiveTrailTokenCounts }>(
    send: TrackedChatSend,
    run: () => Promise<T>,
): Promise<T> {
    let queue: { addChatItem(o: TrackedChatSend): string; completeChatItem(id: string, r: { answerText?: string; error?: string; usage?: LiveTrailTokenCounts }): void } | undefined;
    let id: string | undefined;
    try {
        queue = (await import('../managers/promptQueueManager.js')).PromptQueueManager.instance;
        id = queue.addChatItem(send);
    } catch {
        queue = undefined;
    }
    try {
        const result = await run();
        if (queue && id) { queue.completeChatItem(id, { answerText: result.text, usage: result.usage }); }
        return result;
    } catch (e) {
        if (queue && id) { queue.completeChatItem(id, { error: e instanceof Error ? e.message : String(e) }); }
        throw e;
    }
}
