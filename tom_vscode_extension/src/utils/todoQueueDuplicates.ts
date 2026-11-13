/**
 * One todo, one queue item (vscimpb77): an item whose todo id pattern (a
 * todo's id, `<prefix>*` for a walk, or several comma-separated) equals that
 * of an item still waiting or running — staged, pending or sending — is not
 * added again. The prompt queue refuses it with {@link TodoAlreadyQueuedError};
 * the todo views and the queue tool show the notice. A deliberate repeat
 * passes `allowDuplicateTodo`.
 *
 * vscode-free.
 */

import { todoIdPatternOf } from './todoQueueMarks';

/** The statuses of an item that still waits or runs. */
export const WAITING_OR_RUNNING: ReadonlySet<string> = new Set(['staged', 'pending', 'sending']);

/** What this module reads of a queue item. */
export interface QueueItemForDuplicates {
    id: string;
    status: string;
    todoIdPattern?: string;
    repeatCount?: number | string;
}

/** The pattern as compared: trimmed, the comma-separated parts without spaces around them. */
export function normalizedTodoPattern(pattern: string | undefined): string | undefined {
    const parts = (pattern ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
    return parts.length ? parts.join(',') : undefined;
}

/** The item still waiting or running that runs `pattern`, if any. */
export function queuedItemForTodoPattern<T extends QueueItemForDuplicates>(items: readonly T[], pattern: string | undefined): T | undefined {
    const wanted = normalizedTodoPattern(pattern);
    if (!wanted) { return undefined; }
    return items.find((i) => WAITING_OR_RUNNING.has(i.status) && normalizedTodoPattern(todoIdPatternOf(i)) === wanted);
}

/** The notice for a refused enqueue. */
export function todoAlreadyQueuedNotice(pattern: string, existing: { id: string; status: string }): string {
    const what = pattern.endsWith('*') && !pattern.includes(',') ? `The walk over ${pattern}` : `Todo ${pattern}`;
    return `${what} is already in the prompt queue (${existing.status}, item ${existing.id.slice(0, 8)}): not added again.`;
}

/** Thrown by the prompt queue's enqueue for a todo that is already queued. */
export class TodoAlreadyQueuedError extends Error {
    constructor(readonly todoIdPattern: string, readonly existingId: string, readonly existingStatus: string) {
        super(todoAlreadyQueuedNotice(todoIdPattern, { id: existingId, status: existingStatus }));
        this.name = 'TodoAlreadyQueuedError';
    }
}

/** Whether `e` is the refusal (also across module copies: by name). */
export function isTodoAlreadyQueued(e: unknown): e is TodoAlreadyQueuedError {
    return e instanceof TodoAlreadyQueuedError || (e instanceof Error && e.name === 'TodoAlreadyQueuedError');
}
