/**
 * The NOTIFICATIONS events (vscimpb124) the queue and the todo writers emit,
 * built from what they change: a queue item queued or deleted, a todo filed,
 * edited or with its status changed. Who did it comes from the call's context
 * (services/notificationLog.ts), except where the item itself says: an item
 * another quest sent (`from`), a timed request, a reminder, a done
 * notification or a reload prompt (the extension on its own).
 *
 * vscode-free and pure.
 */

import type { NotificationDraft } from '../services/notificationLog';
import { changedTodoFields, previewValue, todoUpdateType, type NotificationWho } from './notificationEvents';
import { itemRun } from './queueLanes';

/** A queue item, as far as its event reads it. */
export interface DraftQueueItem {
    id: string;
    status: string;
    type?: string;
    run?: string;
    processRun?: { run?: string };
    processMove?: unknown;
    originalText?: string;
    from?: { quest: string; run?: string; session?: string };
    notificationOf?: string;
    reloadPrompt?: unknown;
}

/** Who queued `item`, when the item says so itself; undefined: the call's context. */
export function itemOwnWho(item: DraftQueueItem): NotificationWho | undefined {
    if (item.from) { return { kind: 'agent', fromQuest: item.from.quest, ...(item.from.session ? { session: item.from.session } : {}) }; }
    if (item.notificationOf) { return { kind: 'extension', label: `done notification of ${item.notificationOf}` }; }
    if (item.type === 'timed') { return { kind: 'extension', label: 'timed request' }; }
    if (item.type === 'reminder') { return { kind: 'extension', label: 'reminder' }; }
    if (item.reloadPrompt) { return { kind: 'extension', label: 'reload prompt' }; }
    return undefined;
}

/** The event of `item` queued or deleted. */
export function queueItemDraft(type: 'itemQueued' | 'itemDeleted', item: DraftQueueItem, who?: NotificationWho): NotificationDraft {
    const run = itemRun({ id: item.id, status: item.status, run: item.run, processRun: item.processRun });
    const own = type === 'itemQueued' ? itemOwnWho(item) : undefined;
    return {
        type,
        run,
        item: {
            id: item.id,
            run,
            kind: item.processMove ? 'process-move marker' : (item.type || 'normal'),
            preview: previewValue(item.originalText, 60) ?? item.id,
        },
        ...((who ?? own) ? { who: who ?? own } : {}),
    };
}

/** A todo record, as far as its event reads it. */
export interface DraftTodo {
    id: string;
    title?: string;
    description?: string;
    [key: string]: unknown;
}

/** The title an event shows: the todo's title, else its description's first line. */
function titleOf(todo: DraftTodo): string | undefined {
    return previewValue(todo.title ?? todo.description, 70);
}

/** The event of a todo filed in `quest`. */
export function todoCreatedDraft(quest: string, todo: DraftTodo, who?: NotificationWho): NotificationDraft {
    const status = previewValue(todo.status);
    return {
        type: 'todoCreated',
        todo: { id: todo.id, quest, ...(titleOf(todo) ? { title: titleOf(todo) } : {}), fields: status ? [{ field: 'status', new: status }] : [] },
        ...(who ? { who } : {}),
    };
}

/** The event of a todo updated from `before` to `after` (a status change, else an edit); undefined when nothing changed. */
export function todoUpdateDraft(quest: string, before: DraftTodo, after: DraftTodo, who?: NotificationWho): NotificationDraft | undefined {
    const fields = changedTodoFields(before, after);
    const type = todoUpdateType(fields);
    if (!type) { return undefined; }
    return {
        type,
        todo: { id: after.id, quest, ...(titleOf(after) ? { title: titleOf(after) } : {}), fields },
        ...(who ? { who } : {}),
    };
}
