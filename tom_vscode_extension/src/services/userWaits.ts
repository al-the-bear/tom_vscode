/**
 * Prompts waiting for the user: a question (tomAi_askUser, tomAi_askUserPicker,
 * tomAi_askInMdBrowser, the Agent SDK's AskUserQuestion) or a tool approval
 * that is open until the user answers.
 *
 * Each wait records the queue item whose dispatch it belongs to: the prompt
 * queue runs an item's Anthropic dispatch inside {@link runAsQueueItem}, an
 * `AsyncLocalStorage` context that the tool calls of that dispatch run in, so
 * the queue editor can show *that* item as waiting for a reply. A wait opened
 * outside any item names none; a chat send runs as its chat item.
 *
 * Each wait also records the process run its turn works in (vscimpb81): the
 * user's interactions are one open per RUN, not per window, so asks of
 * different runs stand side by side and an answer reaches the run that asked.
 * The run is the item's (the queue passes it with the item id), else the
 * process position the code runs as (`currentProcessRun`), else `default`.
 *
 * Pure: imports neither `vscode` nor the queue.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { currentProcessRun } from './processRunContext';

/** What a prompt waits for. */
export type UserWaitKind = 'question' | 'approval' | 'plan' | 'mdBrowser';

interface UserWait {
    kind: UserWaitKind;
    queueItemId?: string;
    run: string;
}

interface ItemContext {
    itemId: string;
    run?: string;
}

const itemContext = new AsyncLocalStorage<ItemContext>();
const waits = new Map<number, UserWait>();
const listeners = new Set<() => void>();
let nextId = 1;

/** Run `fn` as the dispatch of queue item `itemId` (its waits are that item's), of process run `run`. */
export function runAsQueueItem<T>(itemId: string | undefined, fn: () => Promise<T>, run?: string): Promise<T> {
    return itemId ? itemContext.run({ itemId, ...(run ? { run } : {}) }, fn) : fn();
}

/** The queue item whose dispatch this code runs in, if any. */
export function currentQueueItemId(): string | undefined {
    return itemContext.getStore()?.itemId;
}

/**
 * The process run the calling turn works in: its queue item's run, else the
 * process position it runs as, else `default` (the quest's own position, and
 * every caller outside a run). One open interaction per run is keyed by it.
 */
export function currentInteractionRun(): string {
    return itemContext.getStore()?.run || currentProcessRun()?.run || 'default';
}

function changed(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* a listener must not break the wait */ }
    }
}

/** Open a wait; answers the function that closes it (idempotent). */
export function beginUserWait(kind: UserWaitKind): () => void {
    const id = nextId++;
    waits.set(id, { kind, run: currentInteractionRun(), ...(currentQueueItemId() ? { queueItemId: currentQueueItemId() } : {}) });
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

/** The open waits by queue item: each item's waits with their run. */
export function queueItemWaits(): Map<string, Array<{ kind: UserWaitKind; run: string }>> {
    const out = new Map<string, Array<{ kind: UserWaitKind; run: string }>>();
    for (const w of waits.values()) {
        if (!w.queueItemId) { continue; }
        const list = out.get(w.queueItemId) ?? [];
        list.push({ kind: w.kind, run: w.run });
        out.set(w.queueItemId, list);
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
