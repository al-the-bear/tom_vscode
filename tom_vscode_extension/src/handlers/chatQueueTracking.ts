/**
 * Show a chat send in the prompt queue while it runs (status `chat`) and with
 * its answer once it ended (`chat-sent`): src/utils/chatQueueItems.ts. Both
 * chat send paths wrap their send in trackChatSend — the panel's Send
 * (chatPanel-handler) and runAnthropicSend (the editor's Send to Anthropic/LLM,
 * a todo's Send and Guide me, Telegram).
 *
 * A send ends one of three ways, and its item becomes `chat-sent` each time:
 * - its result (or its error) comes back;
 * - no result within the queue's response timeout (the queue editor's
 *   *Timeout*, default 60 minutes): the send is cancelled and ends with
 *   {@link chatTimeoutError};
 * - the user removes its item from the queue (abandonChatSend): the send is
 *   cancelled and ends with {@link CHAT_REMOVED_ERROR}.
 * In each case trackChatSend returns (or throws), so the caller's `finally`
 * frees the chat send slot — a send that never reported back cannot hold it.
 *
 * The queue is only a display here: when it is not available the send runs
 * the same, unrecorded.
 */

import type { LiveTrailTokenCounts } from '../services/live-trail';
import { runAsQueueItem } from '../services/userWaits';

export interface TrackedChatSend {
    text: string;
    profileId?: string;
    session: string;
    /** Where the send came from: `panel`, `editor`, `todo panel`, … */
    source: string;
    /** The process run it ran in (the queue editor shows it in that run's tab); unset: `default`. */
    run?: string;
}

/** Whether chat item `id`'s send is running in this window (its approvals belong to it). */
export function isRunningChatItem(id: string | undefined): boolean {
    return !!id && running.has(id);
}

/** The error a chat send ends with when its item was removed while it ran. */
export const CHAT_REMOVED_ERROR = 'stopped: its entry was removed from the prompt queue';

/** The error a chat send ends with when it gets no result in time. */
export function chatTimeoutError(minutes: number): string {
    return `no result within ${minutes} minute${minutes === 1 ? '' : 's'} (the prompt queue's response timeout): the send was stopped`;
}

/** The chat sends of this window that are running: item id → how to end them. */
const running = new Map<string, (error: string) => void>();

/** Whether the chat send of item `id` runs in this window. */
export function isChatSendActive(id: string): boolean {
    return running.has(id);
}

/** End the running chat send of item `id` (its entry was removed): answers whether one ran. */
export function abandonChatSend(id: string): boolean {
    const end = running.get(id);
    if (!end) { return false; }
    end(CHAT_REMOVED_ERROR);
    return true;
}

interface ChatQueue {
    addChatItem(o: TrackedChatSend): string;
    completeChatItem(id: string, r: { answerText?: string; error?: string; usage?: LiveTrailTokenCounts }): void;
    readonly responseFileTimeoutMinutes: number;
}

export async function trackChatSend<T extends { text?: string; usage?: LiveTrailTokenCounts }>(
    send: TrackedChatSend,
    run: () => Promise<T>,
    opts?: {
        /** Cancel the send (the panel's Stop): called when it is ended by timeout or removal, with its chat item id. */
        cancel?: (chatItemId?: string) => void;
        /** Instead of the queue's response timeout (tests). */
        timeoutMs?: number;
    },
): Promise<T> {
    let queue: ChatQueue | undefined;
    let id: string | undefined;
    try {
        queue = (await import('../managers/promptQueueManager.js')).PromptQueueManager.instance as unknown as ChatQueue;
        id = queue.addChatItem(send);
    } catch {
        queue = undefined;
    }
    const minutes = queue ? Math.max(1, Math.round(queue.responseFileTimeoutMinutes || 60)) : 60;
    const timeoutMs = opts?.timeoutMs ?? minutes * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Ended from outside: by the timeout or by removing the entry.
    const ended = new Promise<never>((_, reject) => {
        const end = (error: string): void => {
            try { opts?.cancel?.(id); } catch { /* the send is abandoned either way */ }
            reject(new Error(error));
        };
        timer = setTimeout(() => end(chatTimeoutError(opts?.timeoutMs !== undefined ? Math.max(1, Math.round(timeoutMs / 60_000)) : minutes)), timeoutMs);
        if (id) { running.set(id, end); }
    });
    ended.catch(() => undefined);
    try {
        // The send runs as its chat item, in its run: a question or approval it waits for shows on the item and
        // is keyed by the run (vscimpb81).
        const result = await Promise.race([runAsQueueItem(id, run, send.run || 'default'), ended]);
        if (queue && id) { queue.completeChatItem(id, { answerText: result.text, usage: result.usage }); }
        return result;
    } catch (e) {
        if (queue && id) { queue.completeChatItem(id, { error: e instanceof Error ? e.message : String(e) }); }
        throw e;
    } finally {
        if (timer) { clearTimeout(timer); }
        if (id) { running.delete(id); }
    }
}
