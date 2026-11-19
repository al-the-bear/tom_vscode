/**
 * The live quest-todo store as a {@link TodoUnblockPort}: the todos of a
 * quest's live files with their block conditions (`blocked_by` and
 * `blocked_until`), and a status write supplied by the caller (the queue
 * passes its claim's write).
 *
 * questTodoManager is loaded lazily, as elsewhere in the queue, so the
 * manager stays out of the queue's import graph.
 */

import type { BlockableTodo, TodoUnblockPort } from './queueStep3Utils';
import { questStatusIndex } from './todoBlockingCascade';
import { todoQuestsRoot } from './todoBlockingSync';
import { WsPaths } from './workspacePaths';

export function questTodoUnblockPort(writeStatus: TodoUnblockPort['writeStatus']): TodoUnblockPort {
    return {
        readTodos(questId: string): BlockableTodo[] {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { readAllTodos } = require('../managers/questTodoManager');
                // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's field names
                const todos = readAllTodos(questId) as Array<{ id: string; status?: string; blocked_by?: string[]; blocked_until?: string[]; comprised_of?: string[] }>;
                return todos.map((t) => ({
                    id: t.id,
                    status: t.status,
                    // A GROUP item's walk releases the blocked members of its group (vscimpb127).
                    ...(t.comprised_of?.length ? { comprisedOf: t.comprised_of } : {}),
                    ...(t.blocked_by?.length ? { blockedBy: t.blocked_by } : {}),
                    ...(t.blocked_until?.length ? { blockedUntil: t.blocked_until } : {}),
                }));
            } catch {
                return [];
            }
        },
        writeStatus,
        archivedStatus(questId: string, todoId: string): string | undefined {
            // The writers' quests folder, else the workspace's (nothing was written yet in this window).
            const root = todoQuestsRoot() ?? WsPaths.ai('quests');
            return root ? questStatusIndex(root).statusOf(questId, todoId) : undefined;
        },
    };
}
