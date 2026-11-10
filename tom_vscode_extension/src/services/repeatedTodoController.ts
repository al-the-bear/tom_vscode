/**
 * The repeated-todo controller: the check the Timed Requests list's
 * "Repeated todos" entry runs (TimerEngine, kind `repeated-todos`). Every
 * `waiting-for-repeat` todo of every quest whose `next_repeat` has come goes
 * back to `not-started` (utils/todoRepeat.ts). A manual rule has no moment and
 * is left alone: it is repeated by hand.
 *
 * With the `_ai` folder shared across machines, two machines may release the
 * same todo; the result is the same, so nothing is locked.
 */

import { isRepeatDue, type RepeatedTodo } from '../utils/todoRepeat';

/** What the check reads and writes; the live one is the quest todo manager. */
export interface RepeatedTodoPort {
    listQuestIds(): string[];
    readTodos(questId: string): Array<RepeatedTodo & { id: string }>;
    setStatus(questId: string, todoId: string, status: 'not-started'): boolean;
}

/** One todo the check released. */
export interface ReleasedRepeat {
    questId: string;
    todoId: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    next_repeat: string;
}

/** Release every due repeated todo at `now`; answers what it released and what failed. */
export function releaseDueRepeatedTodos(port: RepeatedTodoPort, now: Date = new Date()): { released: ReleasedRepeat[]; failed: string[] } {
    const released: ReleasedRepeat[] = [];
    const failed: string[] = [];
    for (const questId of port.listQuestIds()) {
        let todos: Array<RepeatedTodo & { id: string }>;
        try { todos = port.readTodos(questId); } catch { continue; }
        for (const todo of todos) {
            if (!isRepeatDue(todo, now)) { continue; }
            if (port.setStatus(questId, todo.id, 'not-started')) {
                released.push({ questId, todoId: todo.id, next_repeat: todo.next_repeat ?? '' });
            } else {
                failed.push(`${questId}/${todo.id}`);
            }
        }
    }
    return { released, failed };
}

/** The live port: the quest todo manager (loaded lazily: it pulls in the vscode-dependent stores). */
export function liveRepeatedTodoPort(): RepeatedTodoPort {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manager = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
    return {
        listQuestIds: () => manager.listQuestIds(),
        readTodos: (questId) => manager.readAllTodos(questId),
        setStatus: (questId, todoId, status) => {
            try { return manager.updateTodo(questId, todoId, { status }) !== undefined; } catch { return false; }
        },
    };
}
