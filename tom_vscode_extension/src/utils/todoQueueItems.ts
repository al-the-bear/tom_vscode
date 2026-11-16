/**
 * TODO and GROUP queue items (vscimpb127): what the todo panel's "Queue as todo
 * item" button and tomAi_addQueueItem's `todo` / `group` queue.
 *
 * A TODO item is a walk over one todo, a GROUP item a walk over a group todo's
 * members in `comprised_of` order (repeat count `todo:<quest>/<id>` /
 * `group:<quest>/<id>`, queueStep3Utils.parseTodoWalk). Both run like a
 * `<prefix>*` walk: the walk prompt with the todo's record appended, the claim
 * (in-progress) when sent, the completion check with its continuations, and
 * the walk's rules for which todo is sent (open, not blocked, not the user's,
 * decisions answered).
 *
 * vscode-free and pure.
 */

import { todoWalkValue } from './queueStep3Utils';

/** A todo as the spec reads it. */
export interface TodoForQueueItem {
    id: string;
    status?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's key
    comprised_of?: string[];
}

export type TodoQueueItemSpec =
    | { ok: true; kind: 'todo' | 'group'; quest: string; id: string; repeatCount: string; todoIdPattern: string }
    | { ok: false; error: string };

/** Is the todo a group (status `group`, or members listed)? */
export function isGroupTodo(todo: TodoForQueueItem | undefined): boolean {
    return !!todo && (todo.status === 'group' || (todo.comprised_of?.length ?? 0) > 0);
}

/**
 * The walk value and todo id pattern of a TODO / GROUP item for todo `askedId`
 * of `quest` (`todo` as read; undefined: there is none). Refused: no quest, an
 * unknown todo, a GROUP item for a todo that is no group. The id pattern names
 * the todos the item runs (the panel's queued marks): the todo, or the group
 * and its members of the quest.
 */
export function todoQueueItemSpec(kind: 'todo' | 'group', quest: string, askedId: string, todo: TodoForQueueItem | undefined): TodoQueueItemSpec {
    if (!quest || quest === 'default') {
        return { ok: false, error: 'A TODO or GROUP item walks the todos of a quest, and no quest is open.' };
    }
    if (!todo) {
        return { ok: false, error: `Quest "${quest}" has no todo "${askedId}". tomAi_listQuestTodos lists them.` };
    }
    if (kind === 'group' && !isGroupTodo(todo)) {
        return { ok: false, error: `"${todo.id}" is no todo group (status \`group\` with \`comprised_of\`); queue it with \`todo\` instead.` };
    }
    const members = kind === 'group'
        ? (todo.comprised_of ?? [])
            .map((ref) => {
                const slash = ref.indexOf('/');
                return slash < 0 ? ref : (ref.slice(0, slash) === quest ? ref.slice(slash + 1) : '');
            })
            .filter((id) => !!id && id !== todo.id)
        : [];
    return {
        ok: true,
        kind,
        quest,
        id: todo.id,
        repeatCount: todoWalkValue(kind, quest, todo.id),
        todoIdPattern: [...new Set([todo.id, ...members])].join(','),
    };
}

/**
 * The text of a TODO item queued from the todo panel: it names the todo, the
 * panel's Todo buttons template wraps it (as for the Queue button beside it),
 * and the walk appends the todo's record.
 */
export const TODO_ITEM_TEXT = 'Quest todo ${repeatTodoId} — ${repeatTodoTitle} (quest ${quest}). Its complete record is appended below.';

/** The prompt of a TODO item from the walk prompt (the group prompt): one todo, no "of this group walk". */
export function todoItemPromptText(walkPrompt: string): string {
    return walkPrompt.replace(/ \(todo \$\{repeatNumber\} of this group walk\)/g, '');
}
