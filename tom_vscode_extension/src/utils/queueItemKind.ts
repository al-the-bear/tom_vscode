/**
 * What a queue item holds (vscimpb127), persisted in its entry file as
 * `item-kind` and derived for an item written before it existed:
 *
 * - `todo` — one todo (a TODO item, repeat count `todo:<quest>/<id>`);
 * - `group` — a todo group's members (a GROUP item, `group:<quest>/<id>`);
 * - `prefix` — a `<prefix>*` walk;
 * - `iteration` — a repeated prompt (a number above 1, or a chat-variable name);
 * - `chat` — a chat send shown in the queue;
 * - `prompt` — a plain prompt.
 *
 * vscode-free and pure.
 */

import { parseTodoWalk } from './queueStep3Utils';

export type QueueItemKind = 'todo' | 'group' | 'prefix' | 'iteration' | 'chat' | 'prompt';

export const QUEUE_ITEM_KINDS: readonly QueueItemKind[] = ['todo', 'group', 'prefix', 'iteration', 'chat', 'prompt'];

/** The statuses of a chat send shown in the queue. */
const CHAT_STATUSES = new Set(['chat', 'chat-sent']);

/** The kind an item's own fields say. */
export function deriveQueueItemKind(item: { status?: string; repeatCount?: number | string; chatSource?: string }): QueueItemKind {
    if (CHAT_STATUSES.has(item.status ?? '') || !!item.chatSource) { return 'chat'; }
    const walk = parseTodoWalk(item.repeatCount);
    if (walk) { return walk.kind; }
    const rc = item.repeatCount;
    if (typeof rc === 'number') { return rc > 1 ? 'iteration' : 'prompt'; }
    if (typeof rc === 'string' && rc.trim()) {
        const n = Number(rc.trim());
        // A number above 1 repeats; a chat-variable name is resolved when it runs.
        return Number.isFinite(n) ? (n > 1 ? 'iteration' : 'prompt') : 'iteration';
    }
    return 'prompt';
}

/** A stored `item-kind`, when it is one. */
export function parseQueueItemKind(value: unknown): QueueItemKind | undefined {
    return typeof value === 'string' && (QUEUE_ITEM_KINDS as readonly string[]).includes(value) ? value as QueueItemKind : undefined;
}
