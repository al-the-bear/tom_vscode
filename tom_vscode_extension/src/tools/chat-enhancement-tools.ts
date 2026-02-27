/**
 * New LLM tool executors for the Chat Enhancements spec.
 *
 * Tools:
 *  - tomAi_notifyUser         §1.1
 *  - tomAi_getWorkspaceInfo   §1.2
 *  - tomAi_listTodos          §1.3
 *  - tomAi_getAllTodos         §1.3
 *  - tomAi_getTodo            §1.3
 *  - tomAi_createTodo         §1.3
 *  - tomAi_updateTodo         §1.3
 *  - tomAi_moveTodo           §1.3
 *  - tomAi_windowTodo_add     §1.4
 *  - tomAi_windowTodo_list    §1.4
 *  - tomAi_windowTodo_getAll  §1.4
 *  - tomAi_windowTodo_update  §1.4
 *  - tomAi_windowTodo_delete  §1.4
 *
 * Each tool follows the SharedToolDefinition pattern from shared-tool-registry.ts.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { ChatVariablesStore, ChangeSource } from '../managers/chatVariablesStore';
import { WindowSessionTodoStore } from '../managers/windowSessionTodoStore';
import * as questTodo from '../managers/questTodoManager';
import { loadSendToChatConfig, saveSendToChatConfig } from '../handlers/handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { ReminderSystem } from '../managers/reminderSystem';
import { refreshSessionPanel, backupSessionTodo } from '../handlers/questTodoPanel-handler';

// ============================================================================
// §1.1  Notify User (Telegram)
// ============================================================================

interface NotifyUserInput {
    message: string;
    urgency?: 'info' | 'warning' | 'error';
    title?: string;
}

async function executeNotifyUser(input: NotifyUserInput): Promise<string> {
    const urgency = input.urgency ?? 'info';
    const prefix = urgency === 'error' ? '🔴' : urgency === 'warning' ? '🟡' : 'ℹ️';
    const titleLine = input.title ? `**${input.title}**\n` : '';
    const text = `${prefix} ${titleLine}${input.message}`;

    // Try Telegram first
    const config = loadSendToChatConfig();
    const tg = (config as any)?.botConversation?.telegram;
    if (tg?.enabled && tg?.botTokenEnv) {
        const token = process.env[tg.botTokenEnv];
        const chatId = tg.defaultChatId;
        if (token && chatId) {
            try {
                const url = `https://api.telegram.org/bot${token}/sendMessage`;
                const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (resp.ok) {
                    return JSON.stringify({ sent: true, channel: 'telegram', timestamp: new Date().toISOString() });
                }
                // Fallback below
            } catch { /* fall through to VS Code notification */ }
        }
    }

    // VS Code fallback
    switch (urgency) {
        case 'error':  vscode.window.showErrorMessage(text); break;
        case 'warning': vscode.window.showWarningMessage(text); break;
        default:       vscode.window.showInformationMessage(text); break;
    }
    return JSON.stringify({ sent: true, channel: 'vscode', timestamp: new Date().toISOString() });
}

export const NOTIFY_USER_TOOL: SharedToolDefinition<NotifyUserInput> = {
    name: 'tomAi_notifyUser',
    displayName: 'Notify User',
    description:
        'Send a notification to the user via Telegram (if configured) or VS Code notification. ' +
        'Use when you need attention, complete a long task, or encounter a blocking issue.',
    tags: ['notification', 'telegram', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['message'],
        properties: {
            message: { type: 'string', description: 'The notification text.' },
            urgency: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Notification urgency level. Default: info.' },
            title: { type: 'string', description: 'Optional short title / subject line.' },
        },
    },
    execute: executeNotifyUser,
};

// ============================================================================
// §1.2  Get Workspace Info
// ============================================================================

interface GetWorkspaceInfoInput {
    // no parameters
}

async function executeGetWorkspaceInfo(_input: GetWorkspaceInfoInput): Promise<string> {
    const wsFile = vscode.workspace.workspaceFile;
    const wsName = vscode.workspace.name ?? '';
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

    let store: ChatVariablesStore | undefined;
    try { store = ChatVariablesStore.instance; } catch { /* not initialised yet */ }

    return JSON.stringify({
        workspaceName: wsName,
        workspaceFile: wsFile?.fsPath ?? '',
        workspaceFolders: folders,
        quest: store?.quest ?? '',
        role: store?.role ?? '',
        activeProjects: store?.activeProjects ?? [],
    }, null, 2);
}

export const GET_WORKSPACE_INFO_TOOL: SharedToolDefinition<GetWorkspaceInfoInput> = {
    name: 'tomAi_getWorkspaceInfo',
    displayName: 'Get Workspace Info',
    description:
        'Detect which workspace is open, current quest, role, and active projects. ' +
        'No parameters required.',
    tags: ['workspace', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: executeGetWorkspaceInfo,
};

// --- determineQuest ---------------------------------------------------------

interface DetermineQuestInput {
    // no parameters
}

function determineQuestFromWorkspaceFile(): string {
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    if (!wsFile) { return ''; }
    const base = path.basename(wsFile);
    return base.replace(/\.code-workspace$/i, '').trim();
}

function questFolderExists(questId: string): boolean {
    if (!questId) { return false; }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return false; }
    const questFolder = path.join(wsRoot, WsPaths.aiFolder, 'quests', questId);
    return fs.existsSync(questFolder) && fs.statSync(questFolder).isDirectory();
}

async function executeDetermineQuest(_input: DetermineQuestInput): Promise<string> {
    let quest = '';
    try {
        quest = ChatVariablesStore.instance.quest || '';
    } catch {
        quest = '';
    }

    if (!quest || !questFolderExists(quest)) {
        quest = determineQuestFromWorkspaceFile();
    }

    if (!quest || !questFolderExists(quest)) {
        return 'No quest set';
    }
    return quest;
}

export const DETERMINE_QUEST_TOOL: SharedToolDefinition<DetermineQuestInput> = {
    name: 'determineQuest',
    displayName: 'Determine Quest',
    description:
        'Determine the active quest ID. Returns the quest ID when set, otherwise returns "No quest set".',
    tags: ['workspace', 'context', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: executeDetermineQuest,
};

// ============================================================================
// §1.3  Quest Todo Tools
// ============================================================================

// --- listTodos ---------------------------------------------------------------

interface ListTodosInput {
    questId: string;
    status?: string;
    file?: string;
    tags?: string[];
}

async function executeListTodos(input: ListTodosInput): Promise<string> {
    let items: questTodo.QuestTodoItem[];
    if (input.file && input.file !== 'all') {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const filePath = require('path').join(folder, WsPaths.aiFolder, 'quests', input.questId, input.file);
        items = questTodo.readTodoFile(filePath);
    } else {
        items = questTodo.readAllTodos(input.questId);
    }

    // Apply filters
    if (input.status) {
        items = items.filter(t => t.status === input.status);
    }
    if (input.tags && input.tags.length > 0) {
        const tagSet = new Set(input.tags);
        items = items.filter(t => t.tags?.some(tag => tagSet.has(tag)));
    }

    return JSON.stringify(items.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        tags: t.tags,
        sourceFile: t._sourceFile,
    })), null, 2);
}

export const LIST_TODOS_TOOL: SharedToolDefinition<ListTodosInput> = {
    name: 'tomAi_listTodos',
    displayName: 'List Quest Todos',
    description:
        'List todos from a quest, optionally filtered by status, file, or tags.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId'],
        properties: {
            questId: { type: 'string', description: 'The quest ID (e.g. "vscode_extension").' },
            status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'], description: 'Filter by status.' },
            file: { type: 'string', description: 'Specific todo file name, or "all" to aggregate.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags.' },
        },
    },
    execute: executeListTodos,
};

// --- getAllTodos --------------------------------------------------------------

interface GetAllTodosInput {
    questId: string;
}

async function executeGetAllTodos(input: GetAllTodosInput): Promise<string> {
    const questItems = questTodo.readAllTodos(input.questId);

    let windowItems: any[] = [];
    try {
        const winStore = WindowSessionTodoStore.instance;
        windowItems = winStore.getAll().todos;
    } catch { /* not initialised */ }

    // Group quest todos by source file
    const sourceMap = new Map<string, number>();
    for (const t of questItems) {
        const src = t._sourceFile ?? 'unknown';
        sourceMap.set(src, (sourceMap.get(src) ?? 0) + 1);
    }

    return JSON.stringify({
        questTodos: questItems.map(t => ({
            id: t.id, title: t.title, status: t.status,
            priority: t.priority, sourceFile: t._sourceFile,
        })),
        windowTodos: windowItems.map(t => ({
            id: t.id, title: t.title, status: t.status,
            priority: t.priority, source: t.source,
        })),
        sources: Array.from(sourceMap.entries()).map(([file, count]) => ({ file, count })),
    }, null, 2);
}

export const GET_ALL_TODOS_TOOL: SharedToolDefinition<GetAllTodosInput> = {
    name: 'tomAi_getAllTodos',
    displayName: 'Get All Todos',
    description:
        'Get ALL todos from ALL sources in a single call: quest YAML files + window session. ' +
        'This is the preferred tool when you need a complete picture of all pending work.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
        },
    },
    execute: executeGetAllTodos,
};

// --- getTodo -----------------------------------------------------------------

interface GetTodoInput {
    questId: string;
    todoId: string;
}

async function executeGetTodo(input: GetTodoInput): Promise<string> {
    const todo = questTodo.findTodoById(input.questId, input.todoId);
    if (!todo) { return `Todo "${input.todoId}" not found in quest "${input.questId}".`; }
    return JSON.stringify(todo, null, 2);
}

export const GET_TODO_TOOL: SharedToolDefinition<GetTodoInput> = {
    name: 'tomAi_getTodo',
    displayName: 'Get Todo',
    description: 'Get a single todo by ID from a quest.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
            todoId: { type: 'string', description: 'The todo ID.' },
        },
    },
    execute: executeGetTodo,
};

// --- createTodo --------------------------------------------------------------

interface CreateTodoInput {
    questId: string;
    file?: string;
    todo: {
        id: string;
        description: string;
        status: string;
        title?: string;
        priority?: string;
        tags?: string[];
        notes?: string;
        dependencies?: string[];
    };
}

async function executeCreateTodo(input: CreateTodoInput): Promise<string> {
    try {
        const created = questTodo.createTodo(input.questId, {
            id: input.todo.id,
            description: input.todo.description,
            status: (input.todo.status as questTodo.QuestTodoItem['status']) ?? 'not-started',
            title: input.todo.title,
            priority: input.todo.priority as questTodo.QuestTodoItem['priority'],
            tags: input.todo.tags,
            notes: input.todo.notes,
            dependencies: input.todo.dependencies,
        }, input.file);
        return JSON.stringify({ success: true, todo: created });
    } catch (err: any) {
        return `Error creating todo: ${err.message ?? err}`;
    }
}

export const CREATE_TODO_TOOL: SharedToolDefinition<CreateTodoInput> = {
    name: 'tomAi_createTodo',
    displayName: 'Create Quest Todo',
    description:
        'Create a new todo item in a quest YAML file. YAML formatting is preserved.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todo'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
            file: { type: 'string', description: 'Target YAML file name within the quest folder. Defaults to persistent file.' },
            todo: {
                type: 'object',
                required: ['id', 'description', 'status'],
                properties: {
                    id: { type: 'string', description: 'Unique todo ID (lowercase, starts with letter).' },
                    description: { type: 'string', description: 'What needs to be done.' },
                    status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'completed', 'cancelled'] },
                    title: { type: 'string', description: 'Short title.' },
                    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    notes: { type: 'string' },
                    dependencies: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },
    execute: executeCreateTodo,
};

// --- updateTodo --------------------------------------------------------------

interface UpdateTodoInput {
    questId: string;
    todoId: string;
    updates: {
        title?: string;
        description?: string;
        status?: string;
        priority?: string;
        tags?: string[];
        notes?: string;
        completed_date?: string;
        completed_by?: string;
    };
}

async function executeUpdateTodo(input: UpdateTodoInput): Promise<string> {
    const updated = questTodo.updateTodo(input.questId, input.todoId, {
        title: input.updates.title,
        description: input.updates.description,
        status: input.updates.status as questTodo.QuestTodoItem['status'],
        priority: input.updates.priority as questTodo.QuestTodoItem['priority'],
        tags: input.updates.tags,
        notes: input.updates.notes,
        completed_date: input.updates.completed_date,
        completed_by: input.updates.completed_by,
    });
    if (!updated) { return `Todo "${input.todoId}" not found in quest "${input.questId}".`; }
    return JSON.stringify({ success: true, todo: updated });
}

export const UPDATE_TODO_TOOL: SharedToolDefinition<UpdateTodoInput> = {
    name: 'tomAi_updateTodo',
    displayName: 'Update Quest Todo',
    description: 'Update fields of an existing quest todo. YAML formatting is preserved.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId', 'updates'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
            todoId: { type: 'string', description: 'The todo ID to update.' },
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
                },
            },
        },
    },
    execute: executeUpdateTodo,
};

// --- moveTodo ----------------------------------------------------------------

interface MoveTodoInput {
    questId: string;
    todoId: string;
    targetFile: string;
}

async function executeMoveTodo(input: MoveTodoInput): Promise<string> {
    const moved = questTodo.moveTodo(input.questId, input.todoId, input.targetFile);
    if (!moved) { return `Todo "${input.todoId}" not found in quest "${input.questId}".`; }
    return JSON.stringify({ success: true, todo: moved });
}

export const MOVE_TODO_TOOL: SharedToolDefinition<MoveTodoInput> = {
    name: 'tomAi_moveTodo',
    displayName: 'Move Quest Todo',
    description: 'Move a todo from one YAML file to another within a quest folder.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId', 'targetFile'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
            todoId: { type: 'string', description: 'The todo ID to move.' },
            targetFile: { type: 'string', description: 'Target YAML file name (e.g. "todos.vscode_extension.todo.yaml").' },
        },
    },
    execute: executeMoveTodo,
};

// ============================================================================
// §1.4  Window Session Todo Tools
// ============================================================================

// --- windowTodo_add ----------------------------------------------------------

interface WindowTodoAddInput {
    title: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
    tags?: string[];
}

async function executeWindowTodoAdd(input: WindowTodoAddInput): Promise<string> {
    try {
        const store = WindowSessionTodoStore.instance;
        const item = store.add(input.title, 'copilot', {
            details: input.details,
            priority: input.priority,
            tags: input.tags,
        });
        // Auto-refresh session panel so the new todo appears immediately
        refreshSessionPanel();
        return JSON.stringify({ id: item.id, created: true });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const WINDOW_TODO_ADD_TOOL: SharedToolDefinition<WindowTodoAddInput> = {
    name: 'tomAi_windowTodo_add',
    displayName: 'Add Window Todo',
    description:
        'Add a self-reminder todo for this window session. Use to avoid forgetting ' +
        'postponed tasks, deferred decisions, or follow-up items.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
            title: { type: 'string', description: 'Short description of the reminder.' },
            details: { type: 'string', description: 'Extended context or notes.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority. Default: medium.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Categorization tags.' },
        },
    },
    execute: executeWindowTodoAdd,
};

// --- windowTodo_list ---------------------------------------------------------

interface WindowTodoListInput {
    status?: 'pending' | 'done' | 'all';
    tags?: string[];
}

async function executeWindowTodoList(input: WindowTodoListInput): Promise<string> {
    try {
        const store = WindowSessionTodoStore.instance;
        const items = store.list({ status: input.status, tags: input.tags });
        return JSON.stringify(items, null, 2);
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const WINDOW_TODO_LIST_TOOL: SharedToolDefinition<WindowTodoListInput> = {
    name: 'tomAi_windowTodo_list',
    displayName: 'List Window Todos',
    description: 'List window session todos, optionally filtered by status or tags.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['pending', 'done', 'all'], description: 'Filter. Default: all.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags.' },
        },
    },
    execute: executeWindowTodoList,
};

// --- windowTodo_getAll -------------------------------------------------------

interface WindowTodoGetAllInput {
    // no params
}

async function executeWindowTodoGetAll(_input: WindowTodoGetAllInput): Promise<string> {
    try {
        const store = WindowSessionTodoStore.instance;
        return JSON.stringify(store.getAll(), null, 2);
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const WINDOW_TODO_GET_ALL_TOOL: SharedToolDefinition<WindowTodoGetAllInput> = {
    name: 'tomAi_windowTodo_getAll',
    displayName: 'Get All Window Todos',
    description:
        'Get ALL window session todos in a single call with counts. No filtering.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: executeWindowTodoGetAll,
};

// --- windowTodo_update -------------------------------------------------------

interface WindowTodoUpdateInput {
    id: string;
    status?: 'pending' | 'done';
    title?: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
}

async function executeWindowTodoUpdate(input: WindowTodoUpdateInput): Promise<string> {
    try {
        const store = WindowSessionTodoStore.instance;
        const updated = store.update(input.id, {
            status: input.status,
            title: input.title,
            details: input.details,
            priority: input.priority,
        });
        if (!updated) { return `Window todo "${input.id}" not found.`; }
        refreshSessionPanel();
        return JSON.stringify({ success: true, todo: updated });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const WINDOW_TODO_UPDATE_TOOL: SharedToolDefinition<WindowTodoUpdateInput> = {
    name: 'tomAi_windowTodo_update',
    displayName: 'Update Window Todo',
    description: 'Update a window session todo (mark done, change title/priority).',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'The window todo ID (e.g. "wt-1").' },
            status: { type: 'string', enum: ['pending', 'done'], description: 'New status.' },
            title: { type: 'string', description: 'Updated title.' },
            details: { type: 'string', description: 'Updated details.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Updated priority.' },
        },
    },
    execute: executeWindowTodoUpdate,
};

// --- windowTodo_delete -------------------------------------------------------

interface WindowTodoDeleteInput {
    id: string;
}

async function executeWindowTodoDelete(input: WindowTodoDeleteInput): Promise<string> {
    try {
        const store = WindowSessionTodoStore.instance;
        // Backup before deleting
        backupSessionTodo(input.id);
        const ok = store.delete(input.id);
        if (!ok) { return `Window todo "${input.id}" not found.`; }
        refreshSessionPanel();
        return JSON.stringify({ success: true, deleted: input.id });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const WINDOW_TODO_DELETE_TOOL: SharedToolDefinition<WindowTodoDeleteInput> = {
    name: 'tomAi_windowTodo_delete',
    displayName: 'Delete Window Todo',
    description: 'Delete a window session todo.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'The window todo ID to delete.' },
        },
    },
    execute: executeWindowTodoDelete,
};

// ============================================================================
// Prompt Queue / Timed Request Tools
// ============================================================================

interface AddToPromptQueueInput {
    text: string;
    template?: string;
    answerWrapper?: boolean;
    position?: number;
    deferSend?: boolean;
    followUps?: Array<{ text: string; template?: string }>;
}

async function executeAddToPromptQueue(input: AddToPromptQueueInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const item = await queue.enqueue({
            originalText: input.text,
            template: input.template,
            answerWrapper: input.answerWrapper,
            position: input.position,
            deferSend: input.deferSend ?? true,
            followUps: (input.followUps || []).map(f => ({
                originalText: f.text,
                template: f.template,
            })),
        });
        return JSON.stringify({
            success: true,
            id: item.id,
            status: item.status,
            queueLength: queue.items.length,
            followUpCount: item.followUps?.length ?? 0,
        });
    } catch (err: any) {
        return `Error adding to prompt queue: ${err.message ?? err}`;
    }
}

export const ADD_TO_PROMPT_QUEUE_TOOL: SharedToolDefinition<AddToPromptQueueInput> = {
    name: 'addToPromptQueue',
    displayName: 'Add To Prompt Queue',
    description: 'Add a prompt to the prompt queue, optionally with template, answer wrapper, and follow-up prompts.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string', description: 'Initial prompt text.' },
            template: { type: 'string', description: 'Optional template name.' },
            answerWrapper: { type: 'boolean', description: 'Whether to wrap the initial prompt with answer wrapper.' },
            position: { type: 'number', description: 'Optional insert index. -1 means append.' },
            deferSend: { type: 'boolean', description: 'When true (default), prompt is staged and not sent immediately.' },
            followUps: {
                type: 'array',
                description: 'Optional follow-up prompts to run sequentially after each answer.',
                items: {
                    type: 'object',
                    required: ['text'],
                    properties: {
                        text: { type: 'string' },
                        template: { type: 'string' },
                    },
                },
            },
        },
    },
    execute: executeAddToPromptQueue,
};

interface SendQueuedPromptInput {
    queueItemId?: string;
    requestId?: string;
}

async function executeSendQueuedPrompt(input: SendQueuedPromptInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const sent = await queue.sendQueuedPrompt({
            id: input.queueItemId,
            requestId: input.requestId,
        });

        if (!sent) {
            return 'Error: no pending queued prompt matched. Provide queueItemId (preferred) or requestId of a pending queued item.';
        }

        return JSON.stringify({
            success: true,
            id: sent.id,
            status: sent.status,
            requestId: sent.requestId || null,
            followUpCount: sent.followUps?.length ?? 0,
        });
    } catch (err: any) {
        return `Error sending queued prompt: ${err.message ?? err}`;
    }
}

export const SEND_QUEUED_PROMPT_TOOL: SharedToolDefinition<SendQueuedPromptInput> = {
    name: 'sendQueuedPrompt',
    displayName: 'Send Queued Prompt',
    description:
        'Explicitly send one staged prompt from the Prompt Queue. ' +
        'Recommended workflow: (1) call addToPromptQueue with deferSend=true (default) to stage the initial prompt, ' +
        '(2) call addFollowUpPrompt one or more times to append follow-ups, then (3) call sendQueuedPrompt to start execution. ' +
        'After sendQueuedPrompt starts the item, the queue manager waits for the answer file, then automatically sends follow-up #1, waits again, sends follow-up #2, and so on until all follow-ups finish, finally marking the item as sent. ' +
        'All follow-up prompts are wrapped with the Answer Wrapper automatically. ' +
        'Target selection: pass queueItemId (preferred) for an exact item, or requestId when available; only pending items can be sent.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            queueItemId: { type: 'string', description: 'Queue item ID to send. Preferred selector.' },
            requestId: { type: 'string', description: 'Alternative selector using request ID (works when request ID is known).' },
        },
    },
    execute: executeSendQueuedPrompt,
};

interface AddFollowUpPromptInput {
    queueItemId?: string;
    requestId?: string;
    text: string;
    template?: string;
}

async function executeAddFollowUpPrompt(input: AddFollowUpPromptInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const item = input.queueItemId
            ? queue.getById(input.queueItemId)
            : (input.requestId ? queue.getByRequestId(input.requestId) : undefined);

        if (!item) {
            return 'Error: queue item not found. Provide queueItemId or requestId of an existing queued/sending item.';
        }

        const follow = queue.addFollowUpPrompt(item.id, {
            originalText: input.text,
            template: input.template,
        });

        if (!follow) {
            return 'Error: failed to add follow-up prompt.';
        }

        const updated = queue.getById(item.id);
        return JSON.stringify({
            success: true,
            queueItemId: item.id,
            followUpId: follow.id,
            followUpCount: updated?.followUps?.length ?? 0,
        });
    } catch (err: any) {
        return `Error adding follow-up prompt: ${err.message ?? err}`;
    }
}

export const ADD_FOLLOW_UP_PROMPT_TOOL: SharedToolDefinition<AddFollowUpPromptInput> = {
    name: 'addFollowUpPrompt',
    displayName: 'Add Follow-Up Prompt',
    description: 'Add a follow-up prompt to an existing queue item (located by queue item ID or request ID).',
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            queueItemId: { type: 'string', description: 'Target queue item ID.' },
            requestId: { type: 'string', description: 'Alternative target: request ID of the queued/sending item.' },
            text: { type: 'string', description: 'Follow-up prompt text.' },
            template: { type: 'string', description: 'Optional follow-up template name.' },
        },
    },
    execute: executeAddFollowUpPrompt,
};

interface AddTimedRequestInput {
    text: string;
    template?: string;
    answerWrapper?: boolean;
    enabled?: boolean;
    intervalMinutes?: number;
}

async function executeAddTimedRequest(input: AddTimedRequestInput): Promise<string> {
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        const timer = TimerEngine.instance;
        const entry = timer.addEntry({
            enabled: input.enabled ?? false,
            template: input.template || '(None)',
            answerWrapper: input.answerWrapper,
            originalText: input.text,
            scheduleMode: 'interval',
            intervalMinutes: Math.max(1, input.intervalMinutes ?? 30),
            scheduledTimes: [],
        });
        return JSON.stringify({
            success: true,
            id: entry.id,
            status: entry.status,
            intervalMinutes: entry.intervalMinutes,
            enabled: entry.enabled,
        });
    } catch (err: any) {
        return `Error adding timed request: ${err.message ?? err}`;
    }
}

export const ADD_TIMED_REQUEST_TOOL: SharedToolDefinition<AddTimedRequestInput> = {
    name: 'addTimedRequest',
    displayName: 'Add Timed Request',
    description: 'Add a timed request entry (interval mode) to the timed requests list.',
    tags: ['timed', 'queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string', description: 'Prompt text for the timed request.' },
            template: { type: 'string', description: 'Optional template name.' },
            answerWrapper: { type: 'boolean', description: 'Whether to wrap with answer wrapper.' },
            enabled: { type: 'boolean', description: 'Whether the entry starts enabled. Default false.' },
            intervalMinutes: { type: 'number', description: 'Interval in minutes (min 1). Default 30.' },
        },
    },
    execute: executeAddTimedRequest,
};

interface QueueListInput {
    includeSent?: boolean;
}

async function executeQueueList(input: QueueListInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const includeSent = !!input.includeSent;
        const items = queue.items
            .filter(i => includeSent || i.status !== 'sent')
            .map(i => ({
                id: i.id,
                status: i.status,
                type: i.type,
                template: i.template,
                answerWrapper: !!i.answerWrapper,
                requestId: i.requestId || null,
                expectedRequestId: i.expectedRequestId || null,
                createdAt: i.createdAt,
                sentAt: i.sentAt || null,
                reminderEnabled: !!i.reminderEnabled,
                reminderTemplateId: i.reminderTemplateId || null,
                reminderTimeoutMinutes: i.reminderTimeoutMinutes ?? null,
                reminderRepeat: !!i.reminderRepeat,
                followUpIndex: i.followUpIndex || 0,
                followUpCount: i.followUps?.length ?? 0,
                textPreview: String(i.originalText || '').slice(0, 160),
            }));

        return JSON.stringify({
            autoSendEnabled: queue.autoSendEnabled,
            responseTimeoutMinutes: queue.responseFileTimeoutMinutes,
            pendingCount: queue.pendingCount,
            totalCount: items.length,
            items,
        }, null, 2);
    } catch (err: any) {
        return `Error listing prompt queue: ${err.message ?? err}`;
    }
}

export const QUEUE_LIST_TOOL: SharedToolDefinition<QueueListInput> = {
    name: 'tom_queue_list',
    displayName: 'Queue List',
    description: 'List prompt queue items with status, IDs, reminder metadata, and follow-up counts.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeSent: { type: 'boolean', description: 'Include sent items in the result. Default false.' },
        },
    },
    execute: executeQueueList,
};

interface QueueUpdateItemInput {
    queueItemId: string;
    text?: string;
    template?: string;
    answerWrapper?: boolean;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
}

async function executeQueueUpdateItem(input: QueueUpdateItemInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const before = queue.getById(input.queueItemId);
        if (!before) {
            return `Error: queue item \"${input.queueItemId}\" not found.`;
        }

        if (input.text !== undefined) {
            await queue.updateText(input.queueItemId, input.text);
        }

        if (input.template !== undefined || input.answerWrapper !== undefined) {
            await queue.updateItemTemplateAndWrapper(input.queueItemId, {
                template: input.template,
                answerWrapper: input.answerWrapper,
            });
        }

        if (
            input.reminderEnabled !== undefined ||
            input.reminderTemplateId !== undefined ||
            input.reminderTimeoutMinutes !== undefined ||
            input.reminderRepeat !== undefined
        ) {
            queue.updateItemReminder(input.queueItemId, {
                reminderEnabled: input.reminderEnabled,
                reminderTemplateId: input.reminderTemplateId,
                reminderTimeoutMinutes: input.reminderTimeoutMinutes,
                reminderRepeat: input.reminderRepeat,
            });
        }

        const updated = queue.getById(input.queueItemId);
        return JSON.stringify({
            success: true,
            id: input.queueItemId,
            status: updated?.status,
            template: updated?.template,
            answerWrapper: !!updated?.answerWrapper,
            reminderEnabled: !!updated?.reminderEnabled,
        });
    } catch (err: any) {
        return `Error updating queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_UPDATE_ITEM_TOOL: SharedToolDefinition<QueueUpdateItemInput> = {
    name: 'tom_queue_update_item',
    displayName: 'Queue Update Item',
    description: 'Update an editable queue item text/template/answer-wrapper/reminder settings.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string', description: 'Queue item ID to update.' },
            text: { type: 'string', description: 'New prompt text.' },
            template: { type: 'string', description: 'Template name or empty string for none.' },
            answerWrapper: { type: 'boolean', description: 'Whether answer wrapper is enabled.' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
        },
    },
    execute: executeQueueUpdateItem,
};

interface QueueSetStatusInput {
    queueItemId: string;
    status: 'staged' | 'pending';
}

async function executeQueueSetStatus(input: QueueSetStatusInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.setStatus(input.queueItemId, input.status);
        if (!ok) {
            return `Error: unable to set status for \"${input.queueItemId}\".`;
        }
        return JSON.stringify({ success: true, id: input.queueItemId, status: input.status });
    } catch (err: any) {
        return `Error setting queue status: ${err.message ?? err}`;
    }
}

export const QUEUE_SET_STATUS_TOOL: SharedToolDefinition<QueueSetStatusInput> = {
    name: 'tom_queue_set_status',
    displayName: 'Queue Set Status',
    description: 'Set queue item status to staged or pending.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'status'],
        properties: {
            queueItemId: { type: 'string' },
            status: { type: 'string', enum: ['staged', 'pending'] },
        },
    },
    execute: executeQueueSetStatus,
};

interface QueueSendNowInput {
    queueItemId: string;
}

async function executeQueueSendNow(input: QueueSendNowInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        await queue.sendNow(input.queueItemId);
        const item = queue.getById(input.queueItemId);
        return JSON.stringify({ success: true, id: input.queueItemId, status: item?.status || 'unknown' });
    } catch (err: any) {
        return `Error sending queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_SEND_NOW_TOOL: SharedToolDefinition<QueueSendNowInput> = {
    name: 'tom_queue_send_now',
    displayName: 'Queue Send Now',
    description: 'Send a staged/pending queue item immediately.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string' },
        },
    },
    execute: executeQueueSendNow,
};

interface QueueRemoveItemInput {
    queueItemId: string;
}

async function executeQueueRemoveItem(input: QueueRemoveItemInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        queue.remove(input.queueItemId);
        return JSON.stringify({ success: true, deleted: input.queueItemId });
    } catch (err: any) {
        return `Error removing queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_REMOVE_ITEM_TOOL: SharedToolDefinition<QueueRemoveItemInput> = {
    name: 'tom_queue_remove_item',
    displayName: 'Queue Remove Item',
    description: 'Remove a queue item by ID.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string' },
        },
    },
    execute: executeQueueRemoveItem,
};

interface QueueUpdateFollowUpInput {
    queueItemId: string;
    followUpId: string;
    text?: string;
    template?: string;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
}

async function executeQueueUpdateFollowUp(input: QueueUpdateFollowUpInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.updateFollowUpPrompt(input.queueItemId, input.followUpId, {
            originalText: input.text,
            template: input.template,
            reminderEnabled: input.reminderEnabled,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
        });
        if (!ok) {
            return 'Error: queue item or follow-up not found.';
        }
        return JSON.stringify({ success: true, queueItemId: input.queueItemId, followUpId: input.followUpId });
    } catch (err: any) {
        return `Error updating follow-up: ${err.message ?? err}`;
    }
}

export const QUEUE_UPDATE_FOLLOW_UP_TOOL: SharedToolDefinition<QueueUpdateFollowUpInput> = {
    name: 'tom_queue_update_followup',
    displayName: 'Queue Update Follow-Up',
    description: 'Update a follow-up prompt fields for an existing queue item.',
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'followUpId'],
        properties: {
            queueItemId: { type: 'string' },
            followUpId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
        },
    },
    execute: executeQueueUpdateFollowUp,
};

interface QueueRemoveFollowUpInput {
    queueItemId: string;
    followUpId: string;
}

async function executeQueueRemoveFollowUp(input: QueueRemoveFollowUpInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.removeFollowUpPrompt(input.queueItemId, input.followUpId);
        if (!ok) {
            return 'Error: queue item or follow-up not found.';
        }
        return JSON.stringify({ success: true, queueItemId: input.queueItemId, followUpId: input.followUpId });
    } catch (err: any) {
        return `Error removing follow-up: ${err.message ?? err}`;
    }
}

export const QUEUE_REMOVE_FOLLOW_UP_TOOL: SharedToolDefinition<QueueRemoveFollowUpInput> = {
    name: 'tom_queue_remove_followup',
    displayName: 'Queue Remove Follow-Up',
    description: 'Remove a follow-up prompt from a queue item.',
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'followUpId'],
        properties: {
            queueItemId: { type: 'string' },
            followUpId: { type: 'string' },
        },
    },
    execute: executeQueueRemoveFollowUp,
};

interface TimedListInput {
    includeCompleted?: boolean;
}

async function executeTimedList(input: TimedListInput): Promise<string> {
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        const timer = TimerEngine.instance;
        const includeCompleted = !!input.includeCompleted;
        const entries = timer.entries
            .filter(e => includeCompleted || e.status !== 'completed')
            .map(e => ({
                id: e.id,
                status: e.status,
                enabled: !!e.enabled,
                template: e.template,
                answerWrapper: !!e.answerWrapper,
                scheduleMode: e.scheduleMode,
                intervalMinutes: e.intervalMinutes ?? null,
                scheduledTimes: e.scheduledTimes || [],
                reminderEnabled: !!e.reminderEnabled,
                reminderTemplateId: e.reminderTemplateId || null,
                reminderTimeoutMinutes: e.reminderTimeoutMinutes ?? null,
                reminderRepeat: !!e.reminderRepeat,
                lastSentAt: e.lastSentAt || null,
                textPreview: String(e.originalText || '').slice(0, 160),
            }));

        return JSON.stringify({ timerActivated: timer.timerActivated, totalCount: entries.length, entries }, null, 2);
    } catch (err: any) {
        return `Error listing timed requests: ${err.message ?? err}`;
    }
}

export const TIMED_LIST_TOOL: SharedToolDefinition<TimedListInput> = {
    name: 'tom_timed_list',
    displayName: 'Timed List',
    description: 'List timed request entries with schedule and reminder metadata.',
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeCompleted: { type: 'boolean', description: 'Include completed timed entries. Default false.' },
        },
    },
    execute: executeTimedList,
};

interface TimedUpdateEntryInput {
    entryId: string;
    patch: {
        enabled?: boolean;
        template?: string;
        answerWrapper?: boolean;
        originalText?: string;
        scheduleMode?: 'interval' | 'scheduled';
        intervalMinutes?: number;
        scheduledTimes?: Array<{ hour: number; minute: number }>;
        reminderEnabled?: boolean;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
    };
}

async function executeTimedUpdateEntry(input: TimedUpdateEntryInput): Promise<string> {
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        const timer = TimerEngine.instance;
        timer.updateEntry(input.entryId, input.patch as any);
        const updated = timer.getEntry(input.entryId);
        if (!updated) {
            return `Error: timed entry \"${input.entryId}\" not found.`;
        }
        return JSON.stringify({ success: true, id: updated.id, status: updated.status, enabled: updated.enabled });
    } catch (err: any) {
        return `Error updating timed entry: ${err.message ?? err}`;
    }
}

export const TIMED_UPDATE_ENTRY_TOOL: SharedToolDefinition<TimedUpdateEntryInput> = {
    name: 'tom_timed_update_entry',
    displayName: 'Timed Update Entry',
    description: 'Update a timed request entry fields (text/template/schedule/reminder/enabled).',
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['entryId', 'patch'],
        properties: {
            entryId: { type: 'string' },
            patch: { type: 'object', properties: {
                enabled: { type: 'boolean' },
                template: { type: 'string' },
                answerWrapper: { type: 'boolean' },
                originalText: { type: 'string' },
                scheduleMode: { type: 'string', enum: ['interval', 'scheduled'] },
                intervalMinutes: { type: 'number' },
                scheduledTimes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['hour', 'minute'],
                        properties: {
                            hour: { type: 'number' },
                            minute: { type: 'number' },
                        },
                    },
                },
                reminderEnabled: { type: 'boolean' },
                reminderTemplateId: { type: 'string' },
                reminderTimeoutMinutes: { type: 'number' },
                reminderRepeat: { type: 'boolean' },
            } },
        },
    },
    execute: executeTimedUpdateEntry,
};

interface TimedRemoveEntryInput {
    entryId: string;
}

async function executeTimedRemoveEntry(input: TimedRemoveEntryInput): Promise<string> {
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        const timer = TimerEngine.instance;
        timer.removeEntry(input.entryId);
        return JSON.stringify({ success: true, deleted: input.entryId });
    } catch (err: any) {
        return `Error removing timed entry: ${err.message ?? err}`;
    }
}

export const TIMED_REMOVE_ENTRY_TOOL: SharedToolDefinition<TimedRemoveEntryInput> = {
    name: 'tom_timed_remove_entry',
    displayName: 'Timed Remove Entry',
    description: 'Remove a timed request entry by ID.',
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['entryId'],
        properties: {
            entryId: { type: 'string' },
        },
    },
    execute: executeTimedRemoveEntry,
};

interface TimedSetEngineStateInput {
    activated: boolean;
}

async function executeTimedSetEngineState(input: TimedSetEngineStateInput): Promise<string> {
    try {
        const { TimerEngine } = await import('../managers/timerEngine.js');
        const timer = TimerEngine.instance;
        timer.timerActivated = !!input.activated;
        return JSON.stringify({ success: true, timerActivated: timer.timerActivated });
    } catch (err: any) {
        return `Error setting timer engine state: ${err.message ?? err}`;
    }
}

export const TIMED_SET_ENGINE_STATE_TOOL: SharedToolDefinition<TimedSetEngineStateInput> = {
    name: 'tom_timed_set_engine_state',
    displayName: 'Timed Set Engine State',
    description: 'Enable or disable the global timed request engine.',
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['activated'],
        properties: {
            activated: { type: 'boolean' },
        },
    },
    execute: executeTimedSetEngineState,
};

interface PromptTemplateManageInput {
    operation: 'list' | 'create' | 'update' | 'delete';
    name?: string;
    newName?: string;
    template?: string;
    showInMenu?: boolean;
}

async function executePromptTemplateManage(input: PromptTemplateManageInput): Promise<string> {
    const config = loadSendToChatConfig();
    if (!config) {
        return 'Error: Send-to-chat config is not available.';
    }
    if (!config.templates) {
        config.templates = {};
    }

    if (input.operation === 'list') {
        const templates = Object.entries(config.templates).map(([name, value]) => ({
            name,
            template: value.template,
            showInMenu: value.showInMenu !== false,
        }));
        return JSON.stringify({ count: templates.length, templates }, null, 2);
    }

    if (input.operation === 'create') {
        if (!input.name) { return 'Error: name is required for create.'; }
        config.templates[input.name] = {
            template: input.template || '${originalPrompt}',
            showInMenu: input.showInMenu !== false,
        };
        saveSendToChatConfig(config);
        return JSON.stringify({ success: true, operation: 'create', name: input.name });
    }

    if (input.operation === 'update') {
        if (!input.name || !config.templates[input.name]) {
            return 'Error: existing template name is required for update.';
        }
        const targetName = input.newName || input.name;
        const old = config.templates[input.name];
        if (targetName !== input.name) {
            delete config.templates[input.name];
        }
        config.templates[targetName] = {
            template: input.template !== undefined ? input.template : old.template,
            showInMenu: input.showInMenu !== undefined ? input.showInMenu : (old.showInMenu !== false),
        };
        saveSendToChatConfig(config);
        return JSON.stringify({ success: true, operation: 'update', name: targetName });
    }

    if (input.operation === 'delete') {
        if (!input.name || !config.templates[input.name]) {
            return 'Error: existing template name is required for delete.';
        }
        delete config.templates[input.name];
        saveSendToChatConfig(config);
        return JSON.stringify({ success: true, operation: 'delete', name: input.name });
    }

    return `Error: unsupported operation \"${input.operation}\".`;
}

export const PROMPT_TEMPLATE_MANAGE_TOOL: SharedToolDefinition<PromptTemplateManageInput> = {
    name: 'tom_prompt_template_manage',
    displayName: 'Prompt Template Manage',
    description: 'List/create/update/delete prompt templates used by queue and timed requests.',
    tags: ['templates', 'queue', 'timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
            name: { type: 'string' },
            newName: { type: 'string' },
            template: { type: 'string' },
            showInMenu: { type: 'boolean' },
        },
    },
    execute: executePromptTemplateManage,
};

interface ReminderTemplateManageInput {
    operation: 'list' | 'create' | 'update' | 'delete';
    id?: string;
    name?: string;
    prompt?: string;
    isDefault?: boolean;
}

async function executeReminderTemplateManage(input: ReminderTemplateManageInput): Promise<string> {
    try {
        const reminder = ReminderSystem.instance;

        if (input.operation === 'list') {
            return JSON.stringify({
                count: reminder.templates.length,
                templates: reminder.templates,
            }, null, 2);
        }

        if (input.operation === 'create') {
            if (!input.name || !input.prompt) {
                return 'Error: name and prompt are required for create.';
            }
            const created = reminder.addTemplate({
                name: input.name,
                prompt: input.prompt,
                isDefault: !!input.isDefault,
            });
            return JSON.stringify({ success: true, operation: 'create', template: created }, null, 2);
        }

        if (input.operation === 'update') {
            if (!input.id) { return 'Error: id is required for update.'; }
            reminder.updateTemplate(input.id, {
                name: input.name,
                prompt: input.prompt,
                isDefault: input.isDefault,
            });
            const updated = reminder.templates.find(t => t.id === input.id) || null;
            return JSON.stringify({ success: true, operation: 'update', template: updated }, null, 2);
        }

        if (input.operation === 'delete') {
            if (!input.id) { return 'Error: id is required for delete.'; }
            reminder.removeTemplate(input.id);
            return JSON.stringify({ success: true, operation: 'delete', id: input.id });
        }

        return `Error: unsupported operation \"${input.operation}\".`;
    } catch (err: any) {
        return `Error managing reminder templates: ${err.message ?? err}`;
    }
}

export const REMINDER_TEMPLATE_MANAGE_TOOL: SharedToolDefinition<ReminderTemplateManageInput> = {
    name: 'tom_reminder_template_manage',
    displayName: 'Reminder Template Manage',
    description: 'List/create/update/delete reminder templates used by queue and timed reminders.',
    tags: ['templates', 'reminder', 'queue', 'timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            isDefault: { type: 'boolean' },
        },
    },
    execute: executeReminderTemplateManage,
};

// ============================================================================
// Master list of all new tools
// ============================================================================

/** All chat-enhancement tools. Add to ALL_SHARED_TOOLS in tool-executors.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHAT_ENHANCEMENT_TOOLS: SharedToolDefinition<any>[] = [
    NOTIFY_USER_TOOL,
    GET_WORKSPACE_INFO_TOOL,
    DETERMINE_QUEST_TOOL,
    LIST_TODOS_TOOL,
    GET_ALL_TODOS_TOOL,
    GET_TODO_TOOL,
    CREATE_TODO_TOOL,
    UPDATE_TODO_TOOL,
    MOVE_TODO_TOOL,
    WINDOW_TODO_ADD_TOOL,
    WINDOW_TODO_LIST_TOOL,
    WINDOW_TODO_GET_ALL_TOOL,
    WINDOW_TODO_UPDATE_TOOL,
    WINDOW_TODO_DELETE_TOOL,
    ADD_TO_PROMPT_QUEUE_TOOL,
    ADD_FOLLOW_UP_PROMPT_TOOL,
    SEND_QUEUED_PROMPT_TOOL,
    ADD_TIMED_REQUEST_TOOL,
    QUEUE_LIST_TOOL,
    QUEUE_UPDATE_ITEM_TOOL,
    QUEUE_SET_STATUS_TOOL,
    QUEUE_SEND_NOW_TOOL,
    QUEUE_REMOVE_ITEM_TOOL,
    QUEUE_UPDATE_FOLLOW_UP_TOOL,
    QUEUE_REMOVE_FOLLOW_UP_TOOL,
    TIMED_LIST_TOOL,
    TIMED_UPDATE_ENTRY_TOOL,
    TIMED_REMOVE_ENTRY_TOOL,
    TIMED_SET_ENGINE_STATE_TOOL,
    PROMPT_TEMPLATE_MANAGE_TOOL,
    REMINDER_TEMPLATE_MANAGE_TOOL,
];
