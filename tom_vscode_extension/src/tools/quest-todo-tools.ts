/**
 * Quest-todo tools — 6 tools that read/write per-quest todo YAML
 * files (`todos.<quest>.todo.yaml` etc.).
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #16.
 *
 * **Quest todos are NOT session todos.** Different store
 * (`questTodoManager` fs/YAML free functions vs `SessionTodoStore`
 * singleton), different lifetime (persist across sessions vs
 * per-window-ephemeral), different id space (model-invented vs
 * `wt-N` monotonic). Every description here mirrors the entry #15
 * pattern — opens with the distinction.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Impls take a narrow
 *     `QuestTodoStoreAccess` dep. The bridge in
 *     `chat-enhancement-tools.ts` wires the real `questTodoManager.*`
 *     free functions.
 *
 *   - **JSON envelopes everywhere.** `getQuestTodo`,
 *     `updateQuestTodo`, `moveQuestTodo` previously returned
 *     free-form strings on not-found while `deleteQuestTodo`
 *     returned JSON — now all six use `{ok, ...}` consistently
 *     with `{ok: false, error: "..."}` on failure.
 *
 *   - **Auto-id myth corrected.** Description states explicitly that
 *     there are **no auto-id rules** for quest todos — the model
 *     must invent an id (lowercase, starts with a letter, hyphen-
 *     separated words by convention).
 *
 *   - **Cross-quest move clarified.** `moveQuestTodo` operates
 *     within a single quest only; the description now says so
 *     explicitly and points at "delete + recreate" as the
 *     cross-quest workflow.
 *
 *   - **`listQuestTodos` `file: "all"` documented.** The magic
 *     string isn't in the schema enum (any filename works), but
 *     the description spells out the `"all"` shortcut.
 *
 *   - **Returned-field subset noted** on `listQuestTodos`: only the
 *     summary fields are returned (id/title/description/status/
 *     priority/tags/sourceFile) — call `getQuestTodo` for the full
 *     record including `scope`, `references`, `dependencies`,
 *     `blocked_by`, `notes`, and timestamps.
 *
 *   - **Update-preserves-unknown-fields contract documented**.
 *     YAML round-trip preserves fields the update schema doesn't
 *     list (`scope`, `references`, etc.) — important so the model
 *     doesn't fear it'll lose them by calling update.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Shape — what tools surface to the model
// ===========================================================================

export type QuestTodoStatus = 'not-started' | 'in-progress' | 'blocked' | 'completed' | 'cancelled';
export type QuestTodoPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Full quest-todo as surfaced by `getQuestTodo`. Mirrors the YAML
 * on-disk schema but uses optional fields where the YAML would just
 * omit them.
 */
export interface QuestTodoFull {
    id: string;
    title?: string;
    description: string;
    status: QuestTodoStatus;
    priority?: QuestTodoPriority;
    tags?: string[];
    scope?: { project?: string; projects?: string[]; module?: string; area?: string; files?: string[] };
    references?: Array<{ type?: string; path?: string; url?: string; description?: string; lines?: string }>;
    dependencies?: string[];
    blocked_by?: string[];
    notes?: string;
    created?: string;
    updated?: string;
    completed_date?: string;
    completed_by?: string;
    /** Runtime: which file the item was loaded from. */
    sourceFile?: string;
}

/** Compact summary surfaced by `listQuestTodos`. */
export interface QuestTodoSummary {
    id: string;
    title?: string;
    description: string;
    status: QuestTodoStatus;
    priority?: QuestTodoPriority;
    tags?: string[];
    sourceFile?: string;
}

// ===========================================================================
// Narrow dep — what the impls actually need from questTodoManager
// ===========================================================================

export interface QuestTodoStoreAccess {
    listFiles(questId: string): string[];
    listTodos(questId: string, file?: string): QuestTodoSummary[];
    findById(questId: string, todoId: string): QuestTodoFull | undefined;
    create(questId: string, todo: Omit<QuestTodoFull, 'sourceFile'>, file?: string): QuestTodoFull;
    update(questId: string, todoId: string, updates: Partial<Omit<QuestTodoFull, 'id' | 'sourceFile'>>): QuestTodoFull | undefined;
    move(questId: string, todoId: string, targetFile: string): QuestTodoFull | undefined;
    delete(questId: string, todoId: string, sourceFile?: string): boolean;
}

export interface QuestTodoToolsDeps {
    store: QuestTodoStoreAccess;
    onMutate?(): void;
}

// ===========================================================================
// listQuestTodos
// ===========================================================================

export interface ListQuestTodosInput {
    questId: string;
    status?: QuestTodoStatus;
    /** Specific YAML file name, or `"all"` (default) to aggregate across all files in the quest folder. */
    file?: string;
    tags?: string[];
}

export async function listQuestTodosImpl(deps: QuestTodoToolsDeps, input: ListQuestTodosInput): Promise<string> {
    try {
        if (!input.questId) {
            return JSON.stringify({ ok: false, error: '`questId` is required.' });
        }
        let items = deps.store.listTodos(input.questId, input.file && input.file !== 'all' ? input.file : undefined);
        if (input.status) {
            items = items.filter((t) => t.status === input.status);
        }
        if (input.tags && input.tags.length > 0) {
            const tagSet = new Set(input.tags);
            items = items.filter((t) => (t.tags ?? []).some((tag) => tagSet.has(tag)));
        }
        return JSON.stringify({ ok: true, questId: input.questId, count: items.length, items }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const LIST_QUEST_TODOS_DESCRIPTION =
    'List **persistent quest todos** (YAML files in `_ai/quests/<questId>/`). ' +
    '**NOT session todos** — those are per-window-ephemeral; see ' +
    '`tomAi_listSessionTodos`. `file: "all"` (default) aggregates across ' +
    'every `*.todo.yaml` file in the quest folder; pass a specific file name ' +
    '(e.g. `"todos.vscode_extension.todo.yaml"`) to scope to one. **`status`** ' +
    '(`not-started` / `in-progress` / `blocked` / `completed` / `cancelled`) ' +
    'and **`tags`** (any-match) filter the result. Response is the **summary** ' +
    'shape (`id`, `title`, `description`, `status`, `priority`, `tags`, ' +
    '`sourceFile`) — call `tomAi_getQuestTodo` for the full record including ' +
    '`scope`, `references`, `dependencies`, `blocked_by`, `notes`, timestamps.';

export const LIST_QUEST_TODOS_TOOL: SharedToolDefinition<ListQuestTodosInput> = {
    name: 'tomAi_listQuestTodos',
    displayName: 'List Quest Todos',
    description: LIST_QUEST_TODOS_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId'],
        properties: {
            questId: { type: 'string', description: 'Quest folder name (e.g. `vscode_extension`).' },
            status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'] },
            file: { type: 'string', description: '`"all"` (default) or a specific `*.todo.yaml` filename.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Any-match tag filter.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// getQuestTodo
// ===========================================================================

export interface GetQuestTodoInput {
    questId: string;
    todoId: string;
}

export async function getQuestTodoImpl(deps: QuestTodoToolsDeps, input: GetQuestTodoInput): Promise<string> {
    try {
        if (!input.questId || !input.todoId) {
            return JSON.stringify({ ok: false, error: '`questId` and `todoId` are both required.' });
        }
        const todo = deps.store.findById(input.questId, input.todoId);
        if (!todo) {
            return JSON.stringify({
                ok: false,
                error: `Todo "${input.todoId}" not found in quest "${input.questId}". Use \`tomAi_listQuestTodos\` to see available ids.`,
            });
        }
        return JSON.stringify({ ok: true, todo }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const GET_QUEST_TODO_DESCRIPTION =
    'Get a single quest todo by id, returning every field on disk — ' +
    '`id`, `title`, `description`, `status`, `priority`, `tags`, `scope` ' +
    '(`project`/`projects`/`module`/`area`/`files`), `references[]`, ' +
    '`dependencies`/`blocked_by`, `notes`, `created`/`updated`/`completed_date`/' +
    '`completed_by` timestamps, and `sourceFile` (which YAML file holds the ' +
    'item). Use this when you need the full record; `tomAi_listQuestTodos` ' +
    'returns only the summary fields. Missing id surfaces structured ' +
    '`{ok: false, error: "..."}` with a pointer to `tomAi_listQuestTodos`.';

export const GET_QUEST_TODO_TOOL: SharedToolDefinition<GetQuestTodoInput> = {
    name: 'tomAi_getQuestTodo',
    displayName: 'Get Quest Todo',
    description: GET_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId'],
        properties: {
            questId: { type: 'string' },
            todoId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// createQuestTodo
// ===========================================================================

export interface CreateQuestTodoInput {
    questId: string;
    /** Target YAML file. Defaults to `todos.<questId>.todo.yaml` (the persistent file). */
    file?: string;
    todo: {
        id: string;
        description: string;
        status?: QuestTodoStatus;
        title?: string;
        priority?: QuestTodoPriority;
        tags?: string[];
        notes?: string;
        dependencies?: string[];
        scope?: QuestTodoFull['scope'];
        references?: QuestTodoFull['references'];
        blocked_by?: string[];
    };
}

export async function createQuestTodoImpl(deps: QuestTodoToolsDeps, input: CreateQuestTodoInput): Promise<string> {
    try {
        if (!input.questId) {
            return JSON.stringify({ ok: false, error: '`questId` is required.' });
        }
        if (!input.todo?.id) {
            return JSON.stringify({
                ok: false,
                error: '`todo.id` is required — there are NO auto-id rules for quest todos. Pick a stable lowercase id like `add-auth-flow`.',
            });
        }
        if (!input.todo?.description) {
            return JSON.stringify({ ok: false, error: '`todo.description` is required.' });
        }
        // Check for collision
        if (deps.store.findById(input.questId, input.todo.id)) {
            return JSON.stringify({
                ok: false,
                error: `Todo "${input.todo.id}" already exists in quest "${input.questId}". Pick a different id, or use \`tomAi_updateQuestTodo\` to modify it.`,
            });
        }
        const created = deps.store.create(input.questId, {
            ...input.todo,
            status: input.todo.status ?? 'not-started',
        }, input.file);
        deps.onMutate?.();
        return JSON.stringify({ ok: true, todo: created });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const CREATE_QUEST_TODO_DESCRIPTION =
    'Create a new persistent quest todo in a YAML file. **There are NO ' +
    'auto-id rules** — the model picks `todo.id` (convention: lowercase, ' +
    'hyphen-separated, starts with a letter, stable, e.g. `add-auth-flow`). ' +
    'Collisions are rejected with a pointer to `tomAi_updateQuestTodo`. ' +
    '`file` defaults to the persistent `todos.<questId>.todo.yaml`; pass a ' +
    'different `*.todo.yaml` filename to target a per-topic file. **Status ' +
    'enum**: `not-started` (default) / `in-progress` / `blocked` / `completed` ' +
    '/ `cancelled`. **Priority enum**: `low` / `medium` / `high` / `critical`. ' +
    'Optional fields (`scope`, `references`, `dependencies`, `blocked_by`, ' +
    '`notes`) are persisted verbatim. YAML formatting in existing files is ' +
    'preserved across the create.';

export const CREATE_QUEST_TODO_TOOL: SharedToolDefinition<CreateQuestTodoInput> = {
    name: 'tomAi_createQuestTodo',
    displayName: 'Create Quest Todo',
    description: CREATE_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todo'],
        properties: {
            questId: { type: 'string' },
            file: { type: 'string', description: 'Target `*.todo.yaml` filename. Default: `todos.<questId>.todo.yaml`.' },
            todo: {
                type: 'object',
                required: ['id', 'description'],
                properties: {
                    id: { type: 'string', description: 'Model-chosen stable id. Lowercase, hyphen-separated by convention.' },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'], description: 'Default `not-started`.' },
                    title: { type: 'string' },
                    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'string' },
                    dependencies: { type: 'array', items: { type: 'string' } },
                    blocked_by: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// updateQuestTodo
// ===========================================================================

export interface UpdateQuestTodoInput {
    questId: string;
    todoId: string;
    updates: {
        title?: string;
        description?: string;
        status?: QuestTodoStatus;
        priority?: QuestTodoPriority;
        tags?: string[];
        notes?: string;
        completed_date?: string;
        completed_by?: string;
        dependencies?: string[];
        blocked_by?: string[];
    };
}

export async function updateQuestTodoImpl(deps: QuestTodoToolsDeps, input: UpdateQuestTodoInput): Promise<string> {
    try {
        if (!input.questId || !input.todoId) {
            return JSON.stringify({ ok: false, error: '`questId` and `todoId` are both required.' });
        }
        const updated = deps.store.update(input.questId, input.todoId, input.updates ?? {});
        if (!updated) {
            return JSON.stringify({
                ok: false,
                error: `Todo "${input.todoId}" not found in quest "${input.questId}". Use \`tomAi_listQuestTodos\` to see available ids.`,
            });
        }
        deps.onMutate?.();
        return JSON.stringify({ ok: true, todo: updated });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const UPDATE_QUEST_TODO_DESCRIPTION =
    'Update fields of an existing quest todo. **YAML formatting is preserved**, ' +
    'and **fields NOT listed in `updates` are kept verbatim** — so `scope`, ' +
    '`references`, `created` timestamps, `_sourceFile`, and any unknown fields ' +
    'an earlier hand-edit added all survive the update. Pass only the fields ' +
    'you want to change. Status enum: `not-started`/`in-progress`/`blocked`/' +
    '`completed`/`cancelled`. Priority enum: `low`/`medium`/`high`/`critical`. ' +
    'Missing id surfaces structured `{ok: false, error: "..."}`. For id changes ' +
    'or moving across files, use `tomAi_moveQuestTodo` or delete+create.';

export const UPDATE_QUEST_TODO_TOOL: SharedToolDefinition<UpdateQuestTodoInput> = {
    name: 'tomAi_updateQuestTodo',
    displayName: 'Update Quest Todo',
    description: UPDATE_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId', 'updates'],
        properties: {
            questId: { type: 'string' },
            todoId: { type: 'string' },
            updates: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'] },
                    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'string' },
                    completed_date: { type: 'string' },
                    completed_by: { type: 'string' },
                    dependencies: { type: 'array', items: { type: 'string' } },
                    blocked_by: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// moveQuestTodo — within-quest only
// ===========================================================================

export interface MoveQuestTodoInput {
    questId: string;
    todoId: string;
    /** Target `*.todo.yaml` filename within the same quest folder. */
    targetFile: string;
}

export async function moveQuestTodoImpl(deps: QuestTodoToolsDeps, input: MoveQuestTodoInput): Promise<string> {
    try {
        if (!input.questId || !input.todoId || !input.targetFile) {
            return JSON.stringify({ ok: false, error: '`questId`, `todoId`, and `targetFile` are all required.' });
        }
        if (input.targetFile.includes('/') || input.targetFile.includes('\\')) {
            return JSON.stringify({
                ok: false,
                error: '`targetFile` must be a bare filename (no slashes). Cross-quest moves are NOT supported — delete from the source quest and re-create in the target quest instead.',
            });
        }
        const moved = deps.store.move(input.questId, input.todoId, input.targetFile);
        if (!moved) {
            return JSON.stringify({
                ok: false,
                error: `Todo "${input.todoId}" not found in quest "${input.questId}". Use \`tomAi_listQuestTodos\` to see available ids.`,
            });
        }
        deps.onMutate?.();
        return JSON.stringify({ ok: true, todo: moved });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const MOVE_QUEST_TODO_DESCRIPTION =
    'Move a todo from one `*.todo.yaml` file to another **within the same ' +
    'quest folder**. `targetFile` must be a bare filename (no slashes); ' +
    'cross-quest moves are NOT supported — use `tomAi_deleteQuestTodo` on ' +
    'the source and `tomAi_createQuestTodo` on the target if you need to ' +
    'move between quests. YAML formatting and unknown fields are preserved ' +
    'across the move (the impl rewrites both files in a single pass).';

export const MOVE_QUEST_TODO_TOOL: SharedToolDefinition<MoveQuestTodoInput> = {
    name: 'tomAi_moveQuestTodo',
    displayName: 'Move Quest Todo',
    description: MOVE_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId', 'targetFile'],
        properties: {
            questId: { type: 'string' },
            todoId: { type: 'string' },
            targetFile: { type: 'string', description: 'Bare filename, e.g. `todos.vscode_extension.todo.yaml`. No slashes.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// deleteQuestTodo
// ===========================================================================

export interface DeleteQuestTodoInput {
    questId: string;
    todoId: string;
    /** Optional source-file hint to skip the file scan when the model knows where the todo lives. */
    sourceFile?: string;
}

export async function deleteQuestTodoImpl(deps: QuestTodoToolsDeps, input: DeleteQuestTodoInput): Promise<string> {
    try {
        if (!input.questId || !input.todoId) {
            return JSON.stringify({ ok: false, error: '`questId` and `todoId` are both required.' });
        }
        const ok = deps.store.delete(input.questId, input.todoId, input.sourceFile);
        if (!ok) {
            return JSON.stringify({
                ok: false,
                error: `Todo "${input.todoId}" not found in quest "${input.questId}". Use \`tomAi_listQuestTodos\` to see available ids.`,
            });
        }
        deps.onMutate?.();
        return JSON.stringify({ ok: true, deletedId: input.todoId, questId: input.questId });
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const DELETE_QUEST_TODO_DESCRIPTION =
    'Delete a quest todo by id. Optional `sourceFile` hint skips the ' +
    'file-by-file scan when you already know which YAML file holds it ' +
    '(performance only — correctness is the same either way). YAML ' +
    'formatting in the file is preserved across the delete. Missing id ' +
    'returns `{ok: false, error: "..."}` rather than throwing. To mark a ' +
    'todo "completed" without removing it, use `tomAi_updateQuestTodo` ' +
    'with `status: completed`.';

export const DELETE_QUEST_TODO_TOOL: SharedToolDefinition<DeleteQuestTodoInput> = {
    name: 'tomAi_deleteQuestTodo',
    displayName: 'Delete Quest Todo',
    description: DELETE_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId'],
        properties: {
            questId: { type: 'string' },
            todoId: { type: 'string' },
            sourceFile: { type: 'string', description: 'Optional source-file hint (relative to quest folder).' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const QUEST_TODO_TOOLS: SharedToolDefinition<any>[] = [
    LIST_QUEST_TODOS_TOOL,
    GET_QUEST_TODO_TOOL,
    CREATE_QUEST_TODO_TOOL,
    UPDATE_QUEST_TODO_TOOL,
    MOVE_QUEST_TODO_TOOL,
    DELETE_QUEST_TODO_TOOL,
];
