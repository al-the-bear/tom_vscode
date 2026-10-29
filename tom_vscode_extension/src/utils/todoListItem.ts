/**
 * One row of the todo panel's list: the fields a list row, its filters and
 * its sort read (media/questTodoPanel/main.js qtRenderTodoRow and the filter
 * and sort beside it). The detail form reads the full todo separately.
 *
 * Every list the panel shows is built here, so a field the list needs is added
 * once: the list was once built by six hand-written copies, none of which
 * carried `user_action`, and no row ever showed its 👤 mark.
 *
 * vscode-free.
 */

// The snake_case names are the todo files' own field names (todo.schema.json),
// which the webview reads as they are.
/* eslint-disable @typescript-eslint/naming-convention */

/** What a list row is built from: a todo as the todo manager reads it. */
export interface TodoListSource {
    id: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    tags?: string[];
    created?: string;
    updated?: string;
    completed_date?: string;
    user_action?: boolean;
    blocking?: string[];
}

export interface TodoListItem {
    id: string;
    title?: string;
    status?: string;
    priority?: string;
    tags?: string[];
    created?: string;
    updated?: string;
    completed_date?: string;
    /** Present, and true, only for the user's own todos. */
    user_action?: true;
    /** The todos this one blocks (the reverse of their `blocked_by`); present only when there are any. */
    blocking?: string[];
    sourceFile: string;
}

/** Title shown when a todo has none: the start of its description. */
const TITLE_FALLBACK_LENGTH = 60;

/**
 * The list row of `todo`, read from `sourceFile`. `id` replaces the todo's own
 * id where the list shows a composed one (session todos).
 */
export function todoListItem(todo: TodoListSource, sourceFile: string, id: string = todo.id): TodoListItem {
    const row: TodoListItem = {
        id,
        title: todo.title ?? todo.description?.substring(0, TITLE_FALLBACK_LENGTH),
        status: todo.status,
        priority: todo.priority,
        tags: todo.tags,
        created: todo.created,
        updated: todo.updated,
        sourceFile,
    };
    if (todo.completed_date) { row.completed_date = todo.completed_date; }
    if (todo.user_action === true) { row.user_action = true; }
    if (todo.blocking && todo.blocking.length) { row.blocking = todo.blocking; }
    return row;
}
