/**
 * The reload overlay's list (vscimpb142b; handlers/reloadOverlay-handler.ts):
 * once another window migrated the workspace's `_ai` files, this window pauses
 * every run and shows the prompts that were still running — queue items
 * `sending` and this window's chat sends — each with its status and kind
 * label as the prompt queue shows it, its run, session and title. A listed
 * item stays in the list and shows when it is done: `sending` → `SENT …`; an
 * iteration item (a walk, a repeated prompt) whose iteration ended while its
 * run is paused → `PAUSED …` (it stays `sending` without a prompt in flight,
 * as the queue editor shows it), one back at `pending` → `PENDING … (PAUSED)`.
 *
 * vscode-free and pure.
 */

import { deriveQueueItemKind, type QueueItemKind } from './queueItemKind';
import { itemRun } from './queueLanes';
import { queueStatusKindLabel } from './queueStatusLabel';

/** The fields of a queue item the overlay reads. */
export interface OverlayQueueItem {
    id: string;
    status: string;
    originalText?: string;
    itemKind?: QueueItemKind;
    repeatCount?: number | string;
    chatSource?: string;
    chatWindowId?: string;
    session?: string;
    run?: string;
    processRun?: { run?: string };
    /** A `sending` item with a prompt in flight (the manager's flag; false between iterations). */
    awaitingAnswer?: boolean;
}

/** One row of the overlay. */
export interface ReloadOverlayRow {
    id: string;
    /** The prompt queue's label, e.g. `SENDING TODO`, `SENT CHAT`, `PENDING ITERATION (PAUSED)`. */
    label: string;
    /** Its class (`status-kind kind-<kind>`). */
    cls: string;
    run: string;
    session: string;
    title: string;
    /** Still running (sending, or this window's chat send). */
    running: boolean;
    /** The item is a chat send (interrupted through the chat send's cancel, not the queue). */
    chat: boolean;
    /** The item is no longer in the queue (removed). */
    gone?: boolean;
}

/**
 * Whether `item` runs a prompt in this window now: a chat send of this window, or a `sending` item — unless its
 * run is paused and no prompt of it is in flight (an iteration item between two iterations).
 */
export function isRunningInWindow(item: OverlayQueueItem, windowId: string, autoSend: (run: string) => boolean): boolean {
    if (item.status === 'sending') { return autoSend(itemRun(item)) || item.awaitingAnswer === true; }
    return item.status === 'chat' && (!item.chatWindowId || item.chatWindowId === windowId);
}

/** Add the ids of the items running now to `tracked` (in the order they are found); answers `tracked`. */
export function trackRunningItems(items: readonly OverlayQueueItem[], tracked: string[], windowId: string, autoSend: (run: string) => boolean): string[] {
    for (const item of items) {
        if (isRunningInWindow(item, windowId, autoSend) && !tracked.includes(item.id)) { tracked.push(item.id); }
    }
    return tracked;
}

/** The first line of a prompt, at most 120 characters. */
export function overlayTitle(text: string | undefined): string {
    const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return line.length > 120 ? `${line.slice(0, 119)}…` : line || '(empty prompt)';
}

/**
 * The rows for the tracked ids: each item as it is now. `autoSend(run)` says whether a run sends on its own;
 * a pending item of a run that does not reads `(PAUSED)`.
 */
export function reloadOverlayRows(
    items: readonly OverlayQueueItem[],
    tracked: readonly string[],
    windowId: string,
    autoSend: (run: string) => boolean,
): ReloadOverlayRow[] {
    return tracked.map((id) => {
        const item = items.find((i) => i.id === id);
        if (!item) {
            return { id, label: 'REMOVED', cls: 'status-kind kind-prompt', run: '', session: '', title: '', running: false, chat: false, gone: true };
        }
        const kind = item.itemKind ?? deriveQueueItemKind(item);
        const run = itemRun(item);
        const runs = autoSend(run);
        const running = isRunningInWindow(item, windowId, autoSend);
        // As the queue editor: a paused sending item between iterations reads PAUSED <KIND>, one in flight
        // SENDING <KIND> (PAUSED); a pending item of a paused run PENDING <KIND> (PAUSED).
        const idleSending = item.status === 'sending' && !running;
        const base = queueStatusKindLabel(idleSending ? 'paused' : item.status, kind);
        const paused = !runs && ((item.status === 'sending' && running) || item.status === 'pending');
        return {
            id,
            label: paused ? `${base.text} (PAUSED)` : base.text,
            cls: base.cls,
            run,
            session: item.session || (kind === 'chat' ? 'chat' : 'default'),
            title: overlayTitle(item.originalText),
            running,
            chat: kind === 'chat',
        };
    });
}

/** The overlay's headline text. */
export function reloadOverlayText(version: number): string {
    return `The workspace has been migrated to version ${version}, a reload is required. All runs have been paused. Let the currently running prompts finish, then reload.`;
}
