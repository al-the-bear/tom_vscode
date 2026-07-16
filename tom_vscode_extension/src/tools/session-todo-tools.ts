/**
 * Session-todo tools — `tomAi_addSessionTodo`,
 * `tomAi_listSessionTodos`, `tomAi_getAllSessionTodos`,
 * `tomAi_updateSessionTodo`, `tomAi_deleteSessionTodo`.
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #15.
 *
 * **Session todos are NOT the same as quest todos.** Different store
 * (`SessionTodoStore` vs `QuestTodoStore`), different id space
 * (`wt-N` vs whatever-the-quest-uses), different lifetime (per-VS-Code-
 * window vs per-quest-folder-persisting-across-sessions). Every
 * description now opens with that distinction so the model doesn't
 * mix them up.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Impls take a narrow
 *     `SessionTodoStoreAccess` dep plus an optional `onMutate`
 *     callback for the panel-refresh side-effect (production wires
 *     `refreshSessionPanel`; tests no-op).
 *
 *   - **JSON envelopes everywhere.** `update`/`delete` previously
 *     returned the string `"Session todo \"X\" not found."` on miss
 *     while the success path returned JSON. Now both paths return
 *     JSON with `ok: false, error: ...` on miss.
 *
 *   - **Documented `listSessionTodos` vs `getAllSessionTodos`**: the
 *     filtered-list-returns-array vs full-snapshot-with-counts split
 *     is now explicit. Each description points at the sibling tool.
 *
 *   - **Id format documented** (`wt-N`, monotonic from 1, never
 *     re-used in a window).
 *
 *   - **Status enum spelled out**: `pending` (default after add) and
 *     `done` (terminal). Mapping to the on-disk YAML enum
 *     (`not-started` / `completed` / `cancelled`) is internal — model
 *     never sees those names.
 *
 *   - **Tags-not-updatable noted** in `updateSessionTodo` description
 *     so the model knows to delete-and-recreate when tags need to
 *     change. (Adding tag updates would require a store-side change
 *     beyond entry #15's scope.)
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

/** Subset of `SessionTodoItem` the tools surface — keeps types pure. */
export interface SessionTodoSnapshot {
    id: string;
    title: string;
    details?: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    tags: string[];
    status: 'pending' | 'done';
    createdAt: string;
    updatedAt: string;
}

export interface SessionTodoStoreAccess {
    add(input: {
        title: string;
        details?: string;
        priority?: 'low' | 'medium' | 'high';
        tags?: string[];
    }): SessionTodoSnapshot;

    list(filter?: { status?: 'pending' | 'done' | 'all'; tags?: string[] }): SessionTodoSnapshot[];

    getAll(): { todos: SessionTodoSnapshot[]; count: number; pendingCount: number };

    update(id: string, updates: {
        status?: 'pending' | 'done';
        title?: string;
        details?: string;
        priority?: 'low' | 'medium' | 'high';
    }): SessionTodoSnapshot | undefined;

    delete(id: string): boolean;
}

export interface SessionTodoToolsDeps {
    store: SessionTodoStoreAccess;
    /** Production wires `refreshSessionPanel`; tests can omit. */
    onMutate?(): void;
}

// ===========================================================================
// tomAi_addSessionTodo
// ===========================================================================

export interface SessionTodoAddInput {
    title: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
    tags?: string[];
}

export async function addSessionTodoImpl(deps: SessionTodoToolsDeps, input: SessionTodoAddInput): Promise<string> {
    try {
        if (!input.title || !input.title.trim()) {
            return JSON.stringify({ ok: false, error: '`title` is required.' });
        }
        const item = deps.store.add({
            title: input.title,
            details: input.details,
            priority: input.priority,
            tags: input.tags,
        });
        deps.onMutate?.();
        return JSON.stringify({ ok: true, id: item.id, item });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const ADD_SESSION_TODO_DESCRIPTION =
    'Add a self-reminder todo to the **current VS Code window**\'s session ' +
    'todo list. **NOT the same as quest todos** — session todos are ' +
    'per-window-per-quest, ephemeral (gone when the window closes), and have ' +
    'ids like `wt-1`, `wt-2`. For persistent project-wide todos use the ' +
    '`tomAi_createQuestTodo` family. Default `priority: medium`, status starts ' +
    'as `pending`. Use to remember postponed tasks within a single session ' +
    '(e.g. "follow up on X after the build finishes"). Visible live in the ' +
    'Session Todos panel.';

export const ADD_SESSION_TODO_TOOL: SharedToolDefinition<SessionTodoAddInput> = {
    name: 'tomAi_addSessionTodo',
    displayName: 'Add Session Todo',
    description: ADD_SESSION_TODO_DESCRIPTION,
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
            title: { type: 'string', description: 'Short reminder text.' },
            details: { type: 'string', description: 'Optional extended notes.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default `medium`.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for filtering by `listSessionTodos`.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listSessionTodos (filtered) vs tomAi_getAllSessionTodos (snapshot)
// ===========================================================================

export interface SessionTodoListInput {
    status?: 'pending' | 'done' | 'all';
    tags?: string[];
}

export async function listSessionTodosImpl(deps: SessionTodoToolsDeps, input: SessionTodoListInput): Promise<string> {
    try {
        const items = deps.store.list({ status: input.status, tags: input.tags });
        return JSON.stringify({ ok: true, count: items.length, items }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const LIST_SESSION_TODOS_DESCRIPTION =
    'List **window-session** todos, optionally filtered by `status` ' +
    '(`pending` / `done` / `all` — default `all`) and/or `tags` (any-match). ' +
    'Returns `{ok, count, items: [...]}`. Use this when you want **filtered** ' +
    'results. For an unfiltered snapshot with counts (total + pending), use ' +
    '`tomAi_getAllSessionTodos` instead — that variant is shorter when you ' +
    'just need the overview. **Reminder**: session todos ≠ quest todos; see ' +
    '`tomAi_listQuestTodos` for the persistent quest list.';

export const LIST_SESSION_TODOS_TOOL: SharedToolDefinition<SessionTodoListInput> = {
    name: 'tomAi_listSessionTodos',
    displayName: 'List Session Todos',
    description: LIST_SESSION_TODOS_DESCRIPTION,
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['pending', 'done', 'all'], description: 'Default `all`.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Any-match filter — todo passes if it has at least one of these tags.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ---

export interface SessionTodoGetAllInput {
    // No params — that's the point.
    [k: string]: unknown;
}

export async function getAllSessionTodosImpl(deps: SessionTodoToolsDeps, _input: SessionTodoGetAllInput): Promise<string> {
    try {
        const all = deps.store.getAll();
        return JSON.stringify({ ok: true, ...all }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const GET_ALL_SESSION_TODOS_DESCRIPTION =
    'Snapshot of **every window-session todo** with summary counts — ' +
    'returns `{ok, todos: [...], count, pendingCount}` in one call. No ' +
    'filtering. Use this when you want the overview (e.g. "is the session ' +
    'list getting long?"); use `tomAi_listSessionTodos` when you want to ' +
    'filter by status or tags. **Reminder**: session todos ≠ quest todos.';

export const GET_ALL_SESSION_TODOS_TOOL: SharedToolDefinition<SessionTodoGetAllInput> = {
    name: 'tomAi_getAllSessionTodos',
    displayName: 'Get All Session Todos',
    description: GET_ALL_SESSION_TODOS_DESCRIPTION,
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updateSessionTodo
// ===========================================================================

export interface SessionTodoUpdateInput {
    id: string;
    status?: 'pending' | 'done';
    title?: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
}

export async function updateSessionTodoImpl(deps: SessionTodoToolsDeps, input: SessionTodoUpdateInput): Promise<string> {
    try {
        if (!input.id) {
            return JSON.stringify({ ok: false, error: '`id` is required.' });
        }
        const updated = deps.store.update(input.id, {
            status: input.status,
            title: input.title,
            details: input.details,
            priority: input.priority,
        });
        if (!updated) {
            return JSON.stringify({
                ok: false,
                error: `Session todo "${input.id}" not found. Use \`tomAi_listSessionTodos\` to see available ids.`,
            });
        }
        deps.onMutate?.();
        return JSON.stringify({ ok: true, item: updated });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const UPDATE_SESSION_TODO_DESCRIPTION =
    'Update a **window-session** todo by id. Status enum is `pending` (the ' +
    'default after `addSessionTodo`) and `done` (terminal — a `done` todo ' +
    'stays in the list until deleted). You can also change `title`, ' +
    '`details`, and `priority`. **`tags` are NOT updatable** — to change ' +
    'tags, delete the todo and re-add it. Missing id returns `{ok: false, ' +
    'error: ...}` with a pointer to `tomAi_listSessionTodos`. **Reminder**: ' +
    'session todos ≠ quest todos.';

export const UPDATE_SESSION_TODO_TOOL: SharedToolDefinition<SessionTodoUpdateInput> = {
    name: 'tomAi_updateSessionTodo',
    displayName: 'Update Session Todo',
    description: UPDATE_SESSION_TODO_DESCRIPTION,
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'Session todo id, e.g. `wt-3`.' },
            status: { type: 'string', enum: ['pending', 'done'] },
            title: { type: 'string' },
            details: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_deleteSessionTodo
// ===========================================================================

export interface SessionTodoDeleteInput {
    id: string;
}

export async function deleteSessionTodoImpl(deps: SessionTodoToolsDeps, input: SessionTodoDeleteInput): Promise<string> {
    try {
        if (!input.id) {
            return JSON.stringify({ ok: false, error: '`id` is required.' });
        }
        const ok = deps.store.delete(input.id);
        if (!ok) {
            return JSON.stringify({
                ok: false,
                error: `Session todo "${input.id}" not found. Use \`tomAi_listSessionTodos\` to see available ids.`,
            });
        }
        deps.onMutate?.();
        return JSON.stringify({ ok: true, deletedId: input.id });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const DELETE_SESSION_TODO_DESCRIPTION =
    'Delete a **window-session** todo by id. Production moves the todo to ' +
    'the `-deleted` (or `-archived`, when completed) sibling of the session ' +
    'todo file, so it stays recoverable. Missing id returns `{ok: false, error: ' +
    '...}`. To mark a todo "completed" without removing it from the list, ' +
    'use `tomAi_updateSessionTodo` with `status: done`. **Reminder**: ' +
    'session todos ≠ quest todos.';

export const DELETE_SESSION_TODO_TOOL: SharedToolDefinition<SessionTodoDeleteInput> = {
    name: 'tomAi_deleteSessionTodo',
    displayName: 'Delete Session Todo',
    description: DELETE_SESSION_TODO_DESCRIPTION,
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'Session todo id to delete.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SESSION_TODO_TOOLS: SharedToolDefinition<any>[] = [
    ADD_SESSION_TODO_TOOL,
    LIST_SESSION_TODOS_TOOL,
    GET_ALL_SESSION_TODOS_TOOL,
    UPDATE_SESSION_TODO_TOOL,
    DELETE_SESSION_TODO_TOOL,
];
