/**
 * The live quest-todo store as a {@link TodoUnblockPort}: the todos of a
 * quest's live files with their block conditions (`blocked_by`, and
 * `blocked_until`, which the todo model carries as an unknown field), and a
 * status write supplied by the caller (the queue passes its claim's write).
 *
 * questTodoManager is loaded lazily, as elsewhere in the queue, so the
 * manager stays out of the queue's import graph.
 */

import type { BlockableTodo, TodoUnblockPort } from './queueStep3Utils';

export function questTodoUnblockPort(writeStatus: TodoUnblockPort['writeStatus']): TodoUnblockPort {
    return {
        readTodos(questId: string): BlockableTodo[] {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { readAllTodos } = require('../managers/questTodoManager');
                // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's field name
                const todos = readAllTodos(questId) as Array<{ id: string; status?: string; blocked_by?: string[]; _extra?: Record<string, unknown> }>;
                return todos.map((t) => {
                    // An unknown field may come through as the YAML node itself.
                    const rawUntil = t._extra?.blocked_until as unknown;
                    const until = rawUntil && typeof rawUntil === 'object' && typeof (rawUntil as { toJSON?: unknown }).toJSON === 'function'
                        ? (rawUntil as { toJSON(): unknown }).toJSON()
                        : rawUntil;
                    return {
                        id: t.id,
                        status: t.status,
                        ...(t.blocked_by?.length ? { blockedBy: t.blocked_by } : {}),
                        ...(until !== undefined && until !== null
                            ? { blockedUntil: Array.isArray(until) ? until.map(String) : [String(until)] }
                            : {}),
                    };
                });
            } catch {
                return [];
            }
        },
        writeStatus,
    };
}
