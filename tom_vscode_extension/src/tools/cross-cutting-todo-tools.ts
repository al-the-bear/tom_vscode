/**
 * Cross-cutting todo views — `tomAi_getCombinedTodos`,
 * `tomAi_listWorkspaceQuestTodos`, `tomAi_manageTodo`.
 *
 * Carved out for coverage entry #17. These three tools cross the
 * boundaries between the three different todo stores
 * (`SessionTodoStore`, `questTodoManager`, `ChatTodoSessionManager`):
 *
 *   - **`getCombinedTodos`**: one quest's YAML todos + the current
 *     window's session todos in a single response.
 *   - **`listWorkspaceQuestTodos`**: every `*.todo.yaml` across the
 *     workspace, regardless of quest.
 *   - **`manageTodo`**: the legacy unified API. Operates on a
 *     **third** store (`ChatTodoSessionManager`) that only exists
 *     inside Tom AI Chat panel sessions. New code should use the
 *     session-todo or quest-todo families — this one is kept for
 *     back-compat with prompts that depend on it.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Three narrow dep interfaces
 *     (`CombinedTodosSource`, `WorkspaceTodosSource`,
 *     `ChatTodoSession`); production wires the real stores in the
 *     bridge.
 *
 *   - **Deterministic sort order.** Both list-style tools now sort
 *     by `(quest, sourceFile, id)` so output is stable across runs.
 *     Previously came out in fs order (random across platforms).
 *
 *   - **Quest grouping on `listWorkspaceQuestTodos`**: the response
 *     now includes a `byQuest: {questId: count}` map so the model
 *     can pick which quest to drill into. Previously only
 *     `sourceFile` was surfaced, requiring the model to parse paths.
 *
 *   - **Pagination via `maxResults`** on both list-style tools.
 *     Default 200 for combined, 500 for workspace. Truncation
 *     surfaced via `truncated: true` (consistent with
 *     `listQuestTodos`).
 *
 *   - **Description includes the body** on combined output. The
 *     previous summary dropped `description` so the model had to
 *     re-fetch every todo to see what it was. Now both quest +
 *     session items include their description.
 *
 *   - **`manageTodo` description marked LEGACY** with a clear
 *     pointer at the session-todo + quest-todo families. The
 *     "No active todo manager" error now explains *why* and
 *     suggests the alternative tools, not just states the failure.
 *
 *   - **`listWorkspaceQuestTodos` status filter** now has a proper
 *     enum + correct values (`completed` not `done`).
 *
 *   - **JSON envelopes** on all three. `manageTodo` previously
 *     returned emoji-decorated markdown text; now `{ok, message,
 *     todos, ...}` so the model can react programmatically.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import type { QuestTodoStatus, QuestTodoPriority } from './quest-todo-tools';

// ===========================================================================
// Shared shapes
// ===========================================================================

export interface CombinedQuestTodo {
    id: string;
    title?: string;
    description: string;
    status: QuestTodoStatus;
    priority?: QuestTodoPriority;
    tags?: string[];
    sourceFile?: string;
}

export interface CombinedSessionTodo {
    id: string;
    title: string;
    details?: string;
    status: 'pending' | 'done';
    priority: 'low' | 'medium' | 'high' | 'critical';
    tags: string[];
    source: string;
}

export interface WorkspaceQuestTodo extends CombinedQuestTodo {
    /** Derived from sourceFile — `_ai/quests/<questId>/...` */
    questId: string;
}

// ===========================================================================
// Dep interfaces
// ===========================================================================

export interface CombinedTodosSource {
    questTodos(questId: string): CombinedQuestTodo[];
    /** Returns [] when no session store is active rather than throwing. */
    sessionTodos(): CombinedSessionTodo[];
}

export interface WorkspaceTodosSource {
    /** Every `*.todo.yaml` todo across every quest in the workspace, with `questId` populated. */
    listAll(): WorkspaceQuestTodo[];
}

export type LegacyTodoStatus = 'not-started' | 'in-progress' | 'completed';

export interface LegacyChatTodoItem {
    id: number;
    title: string;
    description?: string;
    status: LegacyTodoStatus;
}

export interface LegacyTodoResult {
    message: string;
    todos?: LegacyChatTodoItem[];
}

export interface ChatTodoSession {
    list(filter?: LegacyTodoStatus): Promise<LegacyTodoResult>;
    add(title: string, description: string): Promise<LegacyTodoResult>;
    update(id: number, updates: { title?: string; description?: string; status?: LegacyTodoStatus }): Promise<LegacyTodoResult>;
    remove(id: number): Promise<LegacyTodoResult>;
    clear(): Promise<LegacyTodoResult>;
}

export interface ChatTodoSessionResolver {
    /** Returns the active session, or null when not inside a Tom AI Chat panel. */
    current(): ChatTodoSession | null;
}

// ===========================================================================
// Sort helpers — stable across runs
// ===========================================================================

function sortQuestSummaries<T extends { sourceFile?: string; id: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => {
        const sa = a.sourceFile ?? '';
        const sb = b.sourceFile ?? '';
        if (sa !== sb) { return sa < sb ? -1 : 1; }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function sortWorkspaceSummaries(items: WorkspaceQuestTodo[]): WorkspaceQuestTodo[] {
    return [...items].sort((a, b) => {
        if (a.questId !== b.questId) { return a.questId < b.questId ? -1 : 1; }
        const sa = a.sourceFile ?? '';
        const sb = b.sourceFile ?? '';
        if (sa !== sb) { return sa < sb ? -1 : 1; }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function clampMax(input: number | undefined, defaultMax: number, hardMax: number): number {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) { return defaultMax; }
    return Math.min(Math.floor(n), hardMax);
}

// ===========================================================================
// tomAi_getCombinedTodos
// ===========================================================================

export interface GetCombinedTodosInput {
    questId: string;
    maxResults?: number;
}

export async function getCombinedTodosImpl(deps: CombinedTodosSource, input: GetCombinedTodosInput): Promise<string> {
    try {
        if (!input.questId) {
            return JSON.stringify({ ok: false, error: '`questId` is required.' });
        }
        const cap = clampMax(input.maxResults, 200, 2000);
        const questItems = sortQuestSummaries(deps.questTodos(input.questId));
        // Session todos are window-scoped; sort by id for stability.
        const sessionItems = [...deps.sessionTodos()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        // Group quest items by sourceFile for the inventory hint.
        const sourceMap = new Map<string, number>();
        for (const t of questItems) {
            const src = t.sourceFile ?? 'unknown';
            sourceMap.set(src, (sourceMap.get(src) ?? 0) + 1);
        }

        // Cap the combined response. Quest first (usually the longer list);
        // session next; surface `truncated` when we had to clip.
        const totalAvailable = questItems.length + sessionItems.length;
        const questSlice = questItems.slice(0, cap);
        const sessionBudget = Math.max(0, cap - questSlice.length);
        const sessionSlice = sessionItems.slice(0, sessionBudget);

        return JSON.stringify({
            ok: true,
            questId: input.questId,
            questTodos: questSlice,
            sessionTodos: sessionSlice,
            sources: Array.from(sourceMap.entries()).map(([file, count]) => ({ file, count })),
            counts: {
                questTotal: questItems.length,
                sessionTotal: sessionItems.length,
                returned: questSlice.length + sessionSlice.length,
            },
            truncated: questSlice.length + sessionSlice.length < totalAvailable,
        }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const GET_COMBINED_TODOS_DESCRIPTION =
    'Get **one quest\'s YAML todos PLUS the current window\'s session todos** ' +
    'in a single response. Returns `{ok, questId, questTodos[], sessionTodos[], ' +
    'sources[], counts, truncated}`. `questTodos` items have `{id, title, ' +
    'description, status, priority, tags, sourceFile}`; `sessionTodos` items ' +
    'have `{id, title, details, status, priority, tags, source}`. **NOT a ' +
    'workspace-wide aggregator** — pass one `questId` at a time. For workspace- ' +
    'wide listing across every quest use `tomAi_listWorkspaceQuestTodos`. ' +
    'Output is sorted by `(sourceFile, id)` so it\'s stable across runs. ' +
    'Default cap 200 (quest first, then session); pass `maxResults` up to ' +
    '2000. `truncated: true` flags when the cap clipped.';

export const GET_COMBINED_TODOS_TOOL: SharedToolDefinition<GetCombinedTodosInput> = {
    name: 'tomAi_getCombinedTodos',
    displayName: 'Get Combined Todos',
    description: GET_COMBINED_TODOS_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId'],
        properties: {
            questId: { type: 'string' },
            maxResults: { type: 'number', description: 'Cap on combined items returned. Default 200, hard max 2000.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listWorkspaceQuestTodos
// ===========================================================================

export interface ListWorkspaceQuestTodosInput {
    status?: QuestTodoStatus;
    maxResults?: number;
}

export async function listWorkspaceQuestTodosImpl(deps: WorkspaceTodosSource, input: ListWorkspaceQuestTodosInput): Promise<string> {
    try {
        const cap = clampMax(input.maxResults, 500, 5000);
        let items = deps.listAll();
        if (input.status) {
            items = items.filter((t) => t.status === input.status);
        }
        items = sortWorkspaceSummaries(items);

        // Group by quest for the inventory hint.
        const byQuest = new Map<string, number>();
        for (const t of items) {
            byQuest.set(t.questId, (byQuest.get(t.questId) ?? 0) + 1);
        }

        const totalAvailable = items.length;
        const slice = items.slice(0, cap);

        return JSON.stringify({
            ok: true,
            count: slice.length,
            totalAvailable,
            truncated: slice.length < totalAvailable,
            byQuest: Object.fromEntries(Array.from(byQuest.entries()).sort()),
            items: slice,
        }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const LIST_WORKSPACE_QUEST_TODOS_DESCRIPTION =
    'List every `*.todo.yaml` todo across **the entire workspace** (all quests). ' +
    'Each item carries its `questId` (derived from the file path) so you can ' +
    'tell where it came from. Response is `{ok, count, totalAvailable, ' +
    'truncated, byQuest, items}` where `byQuest` is a `{questId: count}` map ' +
    'that lets you pick which quest to drill into (use `tomAi_listQuestTodos` ' +
    'or `tomAi_getCombinedTodos` for the deep view of one quest). Sorted by ' +
    '`(questId, sourceFile, id)` — stable across runs. Default cap 500, hard ' +
    'max 5000. Status filter accepts the same enum as the per-quest tools: ' +
    '`not-started` / `in-progress` / `blocked` / `completed` / `cancelled`.';

export const LIST_WORKSPACE_QUEST_TODOS_TOOL: SharedToolDefinition<ListWorkspaceQuestTodosInput> = {
    name: 'tomAi_listWorkspaceQuestTodos',
    displayName: 'List Workspace Todos',
    description: LIST_WORKSPACE_QUEST_TODOS_DESCRIPTION,
    tags: ['todo', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'] },
            maxResults: { type: 'number', description: 'Default 500, hard max 5000.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_manageTodo — LEGACY chat-session todo manager
// ===========================================================================

export interface ManageTodoInput {
    operation: 'list' | 'add' | 'update' | 'remove' | 'clear';
    id?: number;
    title?: string;
    description?: string;
    status?: LegacyTodoStatus;
    filterStatus?: LegacyTodoStatus;
}

export async function manageTodoImpl(deps: ChatTodoSessionResolver, input: ManageTodoInput): Promise<string> {
    try {
        const session = deps.current();
        if (!session) {
            return JSON.stringify({
                ok: false,
                error: 'No active Tom AI Chat session. `tomAi_manageTodo` is the legacy chat-session todo manager; it only works when called from inside a Tom AI Chat panel. For window-session todos use `tomAi_addSessionTodo`/etc.; for persistent quest todos use `tomAi_createQuestTodo`/etc.',
            });
        }
        let result: LegacyTodoResult;
        switch (input.operation) {
            case 'list':
                result = await session.list(input.filterStatus);
                break;
            case 'add':
                if (!input.title) {
                    return JSON.stringify({ ok: false, error: '`title` is required for `operation: "add"`.' });
                }
                result = await session.add(input.title, input.description || '');
                break;
            case 'update':
                if (input.id === undefined) {
                    return JSON.stringify({ ok: false, error: '`id` is required for `operation: "update"`.' });
                }
                result = await session.update(input.id, {
                    title: input.title,
                    description: input.description,
                    status: input.status,
                });
                break;
            case 'remove':
                if (input.id === undefined) {
                    return JSON.stringify({ ok: false, error: '`id` is required for `operation: "remove"`.' });
                }
                result = await session.remove(input.id);
                break;
            case 'clear':
                result = await session.clear();
                break;
            default:
                return JSON.stringify({
                    ok: false,
                    error: `Unknown operation: ${input.operation}. Use one of: list, add, update, remove, clear.`,
                });
        }
        return JSON.stringify({
            ok: true,
            operation: input.operation,
            message: result.message,
            todos: result.todos ?? [],
        }, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
    }
}

export const MANAGE_TODO_DESCRIPTION =
    '**LEGACY**: chat-session-scoped todo manager — only works inside Tom AI ' +
    'Chat panel sessions (errors clearly if called from anywhere else). ' +
    '**Prefer the newer tool families for new code**: `tomAi_addSessionTodo` ' +
    'family for per-window-session todos with string ids and rich metadata; ' +
    '`tomAi_createQuestTodo` family for persistent per-quest YAML todos with ' +
    'full schema. **This tool uses numeric ids, a 3-value status enum** ' +
    '(`not-started` / `in-progress` / `completed` — no `blocked` / ' +
    '`cancelled`), and a separate in-memory store from both others. ' +
    'Operations: `list` (with optional `filterStatus`), `add` (requires ' +
    '`title`), `update` (requires `id`), `remove` (requires `id`), `clear`. ' +
    'Response is JSON `{ok, operation, message, todos[]}`.';

export const MANAGE_TODO_TOOL: SharedToolDefinition<ManageTodoInput> = {
    name: 'tomAi_manageTodo',
    displayName: 'Manage Todo List (Legacy)',
    description: MANAGE_TODO_DESCRIPTION,
    tags: ['todo', 'task-management', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'clear'] },
            id: { type: 'number', description: 'Numeric id. Required for `update` and `remove`.' },
            title: { type: 'string', description: 'Required for `add`, optional for `update`.' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] },
            filterStatus: { type: 'string', enum: ['not-started', 'in-progress', 'completed'], description: 'Used with `operation: "list"`.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CROSS_CUTTING_TODO_TOOLS: SharedToolDefinition<any>[] = [
    GET_COMBINED_TODOS_TOOL,
    LIST_WORKSPACE_QUEST_TODOS_TOOL,
    MANAGE_TODO_TOOL,
];
