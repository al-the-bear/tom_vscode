/**
 * The agent answer of a todo: the newest answer in the quest's session trails
 * that reports the todo (`TODO=<ref>` among its response values), from a chat
 * send or a queue run alike, whatever the todo's status. The todo panel's
 * "Agent answer" row shows it; the stored `last_answer` (written by a
 * `<prefix>*` walk) is only the fallback when no trail answer names the todo.
 *
 * Pure over trail entries, so it is tested without reading trails.
 */

import { extractTodoRefsFromVariables, parseTodoRef } from './todoLogRefs';

/** What the lookup needs of a trail entry (trailEditor-handler's TrailEntry). */
export interface TodoAnswerEntry {
    type: string;
    /** Sortable timestamp (ISO-like). */
    timestamp: string;
    content: string;
    variables?: string;
}

/** The todo a ref must name. `sourceFile` narrows it when given (a file name, e.g. `todos.<quest>.todo.yaml`). */
export interface TodoAddressForAnswer {
    questId: string;
    todoId: string;
    sourceFile?: string;
}

/**
 * Does `ref` (`<path>/_ai/quests/<quest>/<file>.todo.yaml/<id>`) name the todo?
 * The id must match, the path must lie in the quest's folder, and the file must
 * be the todo's when that is known.
 */
export function refNamesTodo(ref: string, todo: TodoAddressForAnswer): boolean {
    const parsed = parseTodoRef(ref);
    if (parsed.id !== todo.todoId) { return false; }
    const file = parsed.file.replace(/\\/g, '/');
    if (todo.questId && !file.includes(`quests/${todo.questId}/`)) { return false; }
    const sourceName = todo.sourceFile ? todo.sourceFile.split(/[\\/]/).pop() : undefined;
    return !sourceName || parsed.fileName === sourceName;
}

/** The newest ANSWER entry that reports the todo, or undefined. */
export function latestTodoAnswer<E extends TodoAnswerEntry>(entries: Iterable<E>, todo: TodoAddressForAnswer): E | undefined {
    let best: E | undefined;
    for (const e of entries) {
        if (e.type !== 'ANSWER' || !e.content.trim()) { continue; }
        if (!extractTodoRefsFromVariables(e.variables).some((ref) => refNamesTodo(ref, todo))) { continue; }
        if (!best || e.timestamp.localeCompare(best.timestamp) > 0) { best = e; }
    }
    return best;
}
