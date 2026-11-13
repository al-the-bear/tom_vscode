/**
 * Chat sends in the prompt queue.
 *
 * A send to the ANTHROPIC/LLM chat (the panel's Send, Send to Anthropic/LLM
 * from the editor, a todo's Send or Guide me) is shown in the prompt queue so
 * its progress and answer can be read there: an item with status `chat` while
 * it runs and `chat-sent` once it ended, carrying the answer (or the error).
 *
 * The queue ignores these items otherwise: they are never picked, sent,
 * retried or counted as pending — every queue path selects its own statuses,
 * and neither of these is among them. Only one chat send runs at a time (the
 * chat send slot), so at most one item is `chat`; a `chat` item left over from
 * a window that was reloaded mid-send is settled as `chat-sent` with a note.
 *
 * Pure: the queue manager calls these on its items.
 */

export const CHAT_STATUS = 'chat';
export const CHAT_SENT_STATUS = 'chat-sent';

/** The error a chat item gets when its send never reported back (a reload mid-send). */
export const CHAT_NOT_FINISHED_ERROR = 'not finished: the window was reloaded or closed while the chat send ran';

/** What the queue keeps of a chat send (a subset of QueuedPrompt). */
export interface ChatQueueItem {
    id: string;
    status: string;
    type: 'normal';
    transport: 'anthropic';
    template: string;
    originalText: string;
    expandedText: string;
    createdAt: string;
    sentAt?: string;
    anthropicProfileId?: string;
    session?: string;
    /** Where the send came from, e.g. `panel`, `editor`, `todo panel`. */
    chatSource?: string;
    /** The window that ran it (the queue folder is shared by every window of the quest). */
    chatWindowId?: string;
    /** The process run it ran in (the queue editor shows it in that run's tab); unset: `default`. */
    run?: string;
    answerText?: string;
    error?: string;
}

export function isChatStatus(status: string | undefined): boolean {
    return status === CHAT_STATUS || status === CHAT_SENT_STATUS;
}

/** A new running chat item. */
export function newChatItem(opts: {
    id: string;
    text: string;
    profileId?: string;
    session: string;
    source: string;
    windowId: string;
    now: Date;
    run?: string;
}): ChatQueueItem {
    return {
        id: opts.id,
        status: CHAT_STATUS,
        type: 'normal',
        transport: 'anthropic',
        template: '(none)',
        originalText: opts.text,
        expandedText: opts.text,
        createdAt: opts.now.toISOString(),
        sentAt: opts.now.toISOString(),
        ...(opts.profileId ? { anthropicProfileId: opts.profileId } : {}),
        session: opts.session,
        chatSource: opts.source,
        chatWindowId: opts.windowId,
        ...(opts.run && opts.run !== 'default' ? { run: opts.run } : {}),
    };
}

/** End a chat item with its answer, or the error the send ended with. */
export function finishChatItem(item: ChatQueueItem, result: { answerText?: string; error?: string }): void {
    item.status = CHAT_SENT_STATUS;
    if (result.answerText && result.answerText.trim()) { item.answerText = result.answerText; }
    if (result.error) { item.error = result.error; } else { delete item.error; }
}

/**
 * Add what happened after the turn to an ended chat item's answer (an assist's
 * closing answer step, vscimpb63): the note follows the answer under a rule, so
 * the queue entry shows the whole round, the answer written included.
 */
export function appendChatItemNote(item: ChatQueueItem, note: string): void {
    const text = note.trim();
    if (!text) { return; }
    item.answerText = item.answerText && item.answerText.trim() ? `${item.answerText.trimEnd()}\n\n---\n\n${text}` : text;
}

/**
 * Settle running chat items that can no longer report back as `chat-sent` with
 * CHAT_NOT_FINISHED_ERROR: those of this window other than `keepId` whose send
 * no longer runs (`isActive`: a window can run a send and updates to running
 * prompts at the same time), and those of a window that is not alive any more
 * (or of none). A send still running in another live window is left alone.
 * Answers how many it settled.
 */
export function settleRunningChatItems(
    items: Array<{ id?: string; status: string; error?: string; chatWindowId?: string }>,
    opts: { ownWindowId: string; liveWindowIds: ReadonlySet<string>; keepId?: string; isActive?: (id: string) => boolean },
): number {
    let n = 0;
    for (const item of items) {
        if (item.status !== CHAT_STATUS || (opts.keepId && item.id === opts.keepId)) { continue; }
        const win = item.chatWindowId;
        const own = !win || win === opts.ownWindowId;
        const stale = own ? !(item.id && opts.isActive?.(item.id)) : !opts.liveWindowIds.has(win);
        if (!stale) { continue; }
        item.status = CHAT_SENT_STATUS;
        item.error = item.error || CHAT_NOT_FINISHED_ERROR;
        n++;
    }
    return n;
}
