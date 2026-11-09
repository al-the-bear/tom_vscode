/**
 * Prompts waiting for the user: a question (tomAi_askUser, tomAi_askUserPicker,
 * tomAi_askInMdBrowser, the Agent SDK's AskUserQuestion) or a tool approval
 * that is open until the user answers.
 *
 * Each wait records the queue item whose dispatch it belongs to: the prompt
 * queue runs an item's Anthropic dispatch inside {@link runAsQueueItem}, an
 * `AsyncLocalStorage` context that the tool calls of that dispatch run in, so
 * the queue editor can show *that* item as waiting for a reply. A wait opened
 * outside any item (a chat send) names none.
 *
 * Pure: imports neither `vscode` nor the queue.
 */

import { AsyncLocalStorage } from 'async_hooks';

/** What a prompt waits for. */
export type UserWaitKind = 'question' | 'approval';

interface UserWait {
    kind: UserWaitKind;
    queueItemId?: string;
}

const itemContext = new AsyncLocalStorage<string>();
const waits = new Map<number, UserWait>();
const listeners = new Set<() => void>();
let nextId = 1;

/** Run `fn` as the dispatch of queue item `itemId` (its waits are that item's). */
export function runAsQueueItem<T>(itemId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return itemId ? itemContext.run(itemId, fn) : fn();
}

/** The queue item whose dispatch this code runs in, if any. */
export function currentQueueItemId(): string | undefined {
    return itemContext.getStore();
}

function changed(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* a listener must not break the wait */ }
    }
}

/** Open a wait; answers the function that closes it (idempotent). */
export function beginUserWait(kind: UserWaitKind): () => void {
    const id = nextId++;
    waits.set(id, { kind, ...(currentQueueItemId() ? { queueItemId: currentQueueItemId() } : {}) });
    changed();
    return () => {
        if (waits.delete(id)) { changed(); }
    };
}

/** Run `fn` as a wait for the user: open while it runs. */
export async function whileWaitingForUser<T>(kind: UserWaitKind, fn: () => Promise<T>): Promise<T> {
    const end = beginUserWait(kind);
    try {
        return await fn();
    } finally {
        end();
    }
}

/** The open waits by queue item: each item's kinds, in the order opened. */
export function queueItemsWaitingForUser(): Map<string, UserWaitKind[]> {
    const out = new Map<string, UserWaitKind[]>();
    for (const w of waits.values()) {
        if (!w.queueItemId) { continue; }
        const kinds = out.get(w.queueItemId) ?? [];
        if (!kinds.includes(w.kind)) { kinds.push(w.kind); }
        out.set(w.queueItemId, kinds);
    }
    return out;
}

/** Whether any wait is open, the queue's or not. */
export function hasUserWaits(): boolean {
    return waits.size > 0;
}

/** Be told when a wait opens or closes; answers the unsubscribe. */
export function onUserWaitsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
