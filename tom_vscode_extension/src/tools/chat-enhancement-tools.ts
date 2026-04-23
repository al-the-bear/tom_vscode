/**
 * New LLM tool executors for the Chat Enhancements spec.
 *
 * Tools:
 *  - tomAi_notifyUser         §1.1
 *  - tomAi_getWorkspaceInfo   §1.2
 *  - tomAi_listTodos          §1.3
 *  - tomAi_getCombinedTodos         §1.3
 *  - tomAi_getTodo            §1.3
 *  - tomAi_createTodo         §1.3
 *  - tomAi_updateTodo         §1.3
 *  - tomAi_moveTodo           §1.3
 *  - tomAi_addSessionTodo     §1.4
 *  - tomAi_listSessionTodos    §1.4
 *  - tomAi_getAllSessionTodos  §1.4
 *  - tomAi_updateSessionTodo  §1.4
 *  - tomAi_deleteSessionTodo  §1.4
 *
 * Each tool follows the SharedToolDefinition pattern from shared-tool-registry.ts.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { ChatVariablesStore, ChangeSource } from '../managers/chatVariablesStore';
import { SessionTodoStore } from '../managers/sessionTodoStore';
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
    const tg = (config as any)?.aiConversation?.telegram;
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

// Workspace-info tool moved to `editor-context-tools.ts` (tomAi_getWorkspaceInfo).

// --- tomAi_getActiveQuest ---------------------------------------------------------

interface DetermineQuestInput {
    // no parameters
}

function tomAi_getActiveQuestFromWorkspaceFile(): string {
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
    const quest = WsPaths.getWorkspaceQuestId();

    if (quest === 'default' || !questFolderExists(quest)) {
        return 'No quest set';
    }
    return quest;
}

export const DETERMINE_QUEST_TOOL: SharedToolDefinition<DetermineQuestInput> = {
    name: 'tomAi_getActiveQuest',
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
    name: 'tomAi_listQuestTodos',
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
        const winStore = SessionTodoStore.instance;
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
        sessionTodos: windowItems.map(t => ({
            id: t.id, title: t.title, status: t.status,
            priority: t.priority, source: t.source,
        })),
        sources: Array.from(sourceMap.entries()).map(([file, count]) => ({ file, count })),
    }, null, 2);
}

export const GET_ALL_TODOS_TOOL: SharedToolDefinition<GetAllTodosInput> = {
    name: 'tomAi_getCombinedTodos',
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
    name: 'tomAi_getQuestTodo',
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
    name: 'tomAi_createQuestTodo',
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
    name: 'tomAi_updateQuestTodo',
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
    name: 'tomAi_moveQuestTodo',
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

// --- sessionTodo_add ----------------------------------------------------------

interface SessionTodoAddInput {
    title: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
    tags?: string[];
}

async function executeSessionTodoAdd(input: SessionTodoAddInput): Promise<string> {
    try {
        const store = SessionTodoStore.instance;
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

export const SESSION_TODO_ADD_TOOL: SharedToolDefinition<SessionTodoAddInput> = {
    name: 'tomAi_addSessionTodo',
    displayName: 'Add Session Todo',
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
    execute: executeSessionTodoAdd,
};

// --- sessionTodo_list ---------------------------------------------------------

interface SessionTodoListInput {
    status?: 'pending' | 'done' | 'all';
    tags?: string[];
}

async function executeSessionTodoList(input: SessionTodoListInput): Promise<string> {
    try {
        const store = SessionTodoStore.instance;
        const items = store.list({ status: input.status, tags: input.tags });
        return JSON.stringify(items, null, 2);
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const SESSION_TODO_LIST_TOOL: SharedToolDefinition<SessionTodoListInput> = {
    name: 'tomAi_listSessionTodos',
    displayName: 'List Session Todos',
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
    execute: executeSessionTodoList,
};

// --- sessionTodo_getAll -------------------------------------------------------

interface SessionTodoGetAllInput {
    // no params
}

async function executeSessionTodoGetAll(_input: SessionTodoGetAllInput): Promise<string> {
    try {
        const store = SessionTodoStore.instance;
        return JSON.stringify(store.getAll(), null, 2);
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const SESSION_TODO_GET_ALL_TOOL: SharedToolDefinition<SessionTodoGetAllInput> = {
    name: 'tomAi_getAllSessionTodos',
    displayName: 'Get All Session Todos',
    description:
        'Get ALL window session todos in a single call with counts. No filtering.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: executeSessionTodoGetAll,
};

// --- sessionTodo_update -------------------------------------------------------

interface SessionTodoUpdateInput {
    id: string;
    status?: 'pending' | 'done';
    title?: string;
    details?: string;
    priority?: 'low' | 'medium' | 'high';
}

async function executeSessionTodoUpdate(input: SessionTodoUpdateInput): Promise<string> {
    try {
        const store = SessionTodoStore.instance;
        const updated = store.update(input.id, {
            status: input.status,
            title: input.title,
            details: input.details,
            priority: input.priority,
        });
        if (!updated) { return `Session todo "${input.id}" not found.`; }
        refreshSessionPanel();
        return JSON.stringify({ success: true, todo: updated });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const SESSION_TODO_UPDATE_TOOL: SharedToolDefinition<SessionTodoUpdateInput> = {
    name: 'tomAi_updateSessionTodo',
    displayName: 'Update Session Todo',
    description: 'Update a window session todo (mark done, change title/priority).',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'The session todo ID (e.g. "wt-1").' },
            status: { type: 'string', enum: ['pending', 'done'], description: 'New status.' },
            title: { type: 'string', description: 'Updated title.' },
            details: { type: 'string', description: 'Updated details.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Updated priority.' },
        },
    },
    execute: executeSessionTodoUpdate,
};

// --- sessionTodo_delete -------------------------------------------------------

interface SessionTodoDeleteInput {
    id: string;
}

async function executeSessionTodoDelete(input: SessionTodoDeleteInput): Promise<string> {
    try {
        const store = SessionTodoStore.instance;
        // Backup before deleting
        backupSessionTodo(input.id);
        const ok = store.delete(input.id);
        if (!ok) { return `Session todo "${input.id}" not found.`; }
        refreshSessionPanel();
        return JSON.stringify({ success: true, deleted: input.id });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const SESSION_TODO_DELETE_TOOL: SharedToolDefinition<SessionTodoDeleteInput> = {
    name: 'tomAi_deleteSessionTodo',
    displayName: 'Delete Session Todo',
    description: 'Delete a window session todo.',
    tags: ['todo', 'session', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'The session todo ID to delete.' },
        },
    },
    execute: executeSessionTodoDelete,
};

// ============================================================================
// Prompt Queue / Timed Request Tools
// ============================================================================

interface QueuePrePromptInput {
    text: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
}

interface QueueFollowUpInput {
    text: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
}

interface AddToPromptQueueInput {
    text: string;
    template?: string;
    answerWrapper?: boolean;
    position?: number;
    deferSend?: boolean;
    prePrompts?: QueuePrePromptInput[];
    followUps?: QueueFollowUpInput[];
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    // Multi-transport (spec §4.13).
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
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
            repeatCount: input.repeatCount,
            repeatPrefix: input.repeatPrefix,
            repeatSuffix: input.repeatSuffix,
            templateRepeatCount: input.templateRepeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
            prePrompts: (input.prePrompts || []).map(p => ({
                text: p.text,
                template: p.template,
                repeatCount: p.repeatCount,
                answerWaitMinutes: p.answerWaitMinutes,
                reminderTemplateId: p.reminderTemplateId,
                reminderTimeoutMinutes: p.reminderTimeoutMinutes,
                reminderRepeat: p.reminderRepeat,
                reminderEnabled: p.reminderEnabled,
            })),
            followUps: (input.followUps || []).map(f => ({
                originalText: f.text,
                template: f.template,
                repeatCount: f.repeatCount,
                answerWaitMinutes: f.answerWaitMinutes,
                reminderTemplateId: f.reminderTemplateId,
                reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                reminderRepeat: f.reminderRepeat,
                reminderEnabled: f.reminderEnabled,
            })),
        });
        return JSON.stringify({
            success: true,
            id: item.id,
            status: item.status,
            queueLength: queue.items.length,
            prePromptCount: item.prePrompts?.length ?? 0,
            followUpCount: item.followUps?.length ?? 0,
        });
    } catch (err: any) {
        return `Error adding to prompt queue: ${err.message ?? err}`;
    }
}

const prePromptItemSchema = {
    type: 'object' as const,
    required: ['text'],
    properties: {
        text: { type: 'string' },
        template: { type: 'string' },
        repeatCount: { description: 'Literal number or chat-variable name (string). When a string, resolved at send time against chat variables.' },
        answerWaitMinutes: { type: 'number', description: 'Auto-advance after N minutes instead of waiting for answer.' },
        reminderTemplateId: { type: 'string' },
        reminderTimeoutMinutes: { type: 'number' },
        reminderRepeat: { type: 'boolean' },
        reminderEnabled: { type: 'boolean' },
    },
};
const followUpItemSchema = {
    type: 'object' as const,
    required: ['text'],
    properties: {
        text: { type: 'string' },
        template: { type: 'string' },
        repeatCount: { description: 'Literal number or chat-variable name for per-follow-up repeats.' },
        answerWaitMinutes: { type: 'number' },
        reminderTemplateId: { type: 'string' },
        reminderTimeoutMinutes: { type: 'number' },
        reminderRepeat: { type: 'boolean' },
        reminderEnabled: { type: 'boolean' },
    },
};

export const ADD_TO_PROMPT_QUEUE_TOOL: SharedToolDefinition<AddToPromptQueueInput> = {
    name: 'tomAi_addQueueItem',
    displayName: 'Add To Prompt Queue',
    description:
        'Add a prompt to the Copilot Chat prompt queue. Supports pre-prompts (sent before the main prompt), follow-ups (sent after each answer), and per-item repeat/answer-wait controls. ' +
        'repeatCount / templateRepeatCount / pre-prompt repeatCount / follow-up repeatCount accept a literal number or the name of a chat variable that holds the count — the manager resolves the variable at send time and decrements it each iteration.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string', description: 'Initial prompt text.' },
            template: { type: 'string', description: 'Optional template name.' },
            answerWrapper: { type: 'boolean', description: 'Wrap the initial prompt with the answer wrapper.' },
            position: { type: 'number', description: 'Insert index. -1 means append.' },
            deferSend: { type: 'boolean', description: 'When true (default), prompt is staged but not sent immediately.' },
            prePrompts: { type: 'array', items: prePromptItemSchema, description: 'Pre-prompts sent before the main prompt (in order).' },
            followUps: { type: 'array', items: followUpItemSchema, description: 'Follow-ups sent sequentially after each answer.' },
            repeatCount: { description: 'Main-prompt repeat count (number) or chat-variable name (string). Uses repeatPrefix/repeatSuffix for ${repeatNumber}/${repeatIndex} placeholder expansion.' },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            templateRepeatCount: { description: 'Repeat the entire template (main + follow-ups) this many times. Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number', description: 'Main-prompt answer-wait: auto-advance after N minutes instead of waiting for the answer file.' },
            reminderTemplateId: { type: 'string', description: 'Reminder template ID for the main prompt.' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            // Multi-transport (spec §4.13).
            transport: {
                type: 'string',
                enum: ['copilot', 'anthropic'],
                description: 'Queue transport for this item. Default: copilot. Anthropic routes through AnthropicHandler.sendMessage using the resolved profile+configuration and forces toolApprovalMode=never (queue is unattended).',
            },
            anthropicProfileId: {
                type: 'string',
                description: 'Anthropic profile id (required when transport=anthropic). Falls back to the default profile when omitted.',
            },
            anthropicConfigId: {
                type: 'string',
                description: 'Optional: override the profile\'s configuration. May reference an Anthropic config or (future) a Local LLM config id.',
            },
        },
    },
    execute: executeAddToPromptQueue,
};

// ---------------------------------------------------------------------------
// Pre-prompt management
// ---------------------------------------------------------------------------

interface AddPrePromptInput {
    queueItemId: string;
    text: string;
    template?: string;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

async function executeAddPrePrompt(input: AddPrePromptInput): Promise<string> {
    try {
        if (!input.queueItemId || !input.text) {
            return 'Error: queueItemId and text are required.';
        }
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.addPrePrompt(input.queueItemId, input.text, input.template, {
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!ok) {
            return 'Error: could not add pre-prompt (item not found or not editable).';
        }
        const updated = queue.getById(input.queueItemId);
        return JSON.stringify({
            success: true,
            queueItemId: input.queueItemId,
            prePromptCount: updated?.prePrompts?.length ?? 0,
        });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const ADD_PRE_PROMPT_TOOL: SharedToolDefinition<AddPrePromptInput> = {
    name: 'tomAi_addQueuePrePrompt',
    displayName: 'Add Pre-Prompt',
    description:
        'Append a pre-prompt to an existing staged queue item. Pre-prompts are sent *before* the main prompt, in order, and each waits for its answer (or answerWaitMinutes) before the next runs. ' +
        'Use tomAi_updateQueuePrePrompt to add repeat count, answer-wait, or reminder settings after creation.',
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'text'],
        properties: {
            queueItemId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            // Multi-transport (spec §4.13).
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Override transport for just this pre-prompt. Stage > item > queue default > copilot.' },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: executeAddPrePrompt,
};

interface UpdatePrePromptInput {
    queueItemId: string;
    index: number;
    text?: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

async function executeUpdatePrePrompt(input: UpdatePrePromptInput): Promise<string> {
    try {
        if (!input.queueItemId || typeof input.index !== 'number') {
            return 'Error: queueItemId and index are required.';
        }
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.updatePrePrompt(input.queueItemId, input.index, {
            text: input.text,
            template: input.template,
            repeatCount: input.repeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!ok) { return 'Error: could not update pre-prompt (item/index not found or item not editable).'; }
        return JSON.stringify({ success: true, queueItemId: input.queueItemId, index: input.index });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const UPDATE_PRE_PROMPT_TOOL: SharedToolDefinition<UpdatePrePromptInput> = {
    name: 'tomAi_updateQueuePrePrompt',
    displayName: 'Update Pre-Prompt',
    description: 'Patch fields on an existing pre-prompt (by queue-item id + zero-based index).',
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'index'],
        properties: {
            queueItemId: { type: 'string' },
            index: { type: 'number', description: 'Zero-based pre-prompt index.' },
            text: { type: 'string' },
            template: { type: 'string' },
            repeatCount: { description: 'Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            // Multi-transport (spec §4.13).
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: executeUpdatePrePrompt,
};

interface RemovePrePromptInput { queueItemId: string; index: number }

async function executeRemovePrePrompt(input: RemovePrePromptInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        const ok = queue.removePrePrompt(input.queueItemId, input.index);
        if (!ok) { return 'Error: could not remove pre-prompt.'; }
        return JSON.stringify({ success: true, queueItemId: input.queueItemId, index: input.index });
    } catch (err: any) {
        return `Error: ${err.message ?? err}`;
    }
}

export const REMOVE_PRE_PROMPT_TOOL: SharedToolDefinition<RemovePrePromptInput> = {
    name: 'tomAi_removeQueuePrePrompt',
    displayName: 'Remove Pre-Prompt',
    description: 'Remove a pre-prompt from a queue item by zero-based index.',
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'index'],
        properties: {
            queueItemId: { type: 'string' },
            index: { type: 'number' },
        },
    },
    execute: executeRemovePrePrompt,
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
    name: 'tomAi_sendQueuedPrompt',
    displayName: 'Send Queued Prompt',
    description:
        'Explicitly send one staged prompt from the Prompt Queue. ' +
        'Recommended workflow: (1) call tomAi_addQueueItem with deferSend=true (default) to stage the initial prompt, ' +
        '(2) call tomAi_addQueueFollowUp one or more times to append follow-ups, then (3) call tomAi_sendQueuedPrompt to start execution. ' +
        'After tomAi_sendQueuedPrompt starts the item, the queue manager waits for the answer file, then automatically sends follow-up #1, waits again, sends follow-up #2, and so on until all follow-ups finish, finally marking the item as sent. ' +
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
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
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
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });

        if (!follow) {
            return 'Error: failed to add follow-up prompt.';
        }

        // The manager's addFollowUpPrompt() doesn't accept repeatCount / answerWaitMinutes;
        // patch via updateFollowUpPrompt if the caller provided them.
        if (input.repeatCount !== undefined || input.answerWaitMinutes !== undefined) {
            queue.updateFollowUpPrompt(item.id, follow.id, {
                repeatCount: input.repeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
            });
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
    name: 'tomAi_addQueueFollowUp',
    displayName: 'Add Follow-Up Prompt',
    description:
        'Add a follow-up prompt to an existing queue item. Supports per-follow-up repeatCount (number or chat-variable name), answerWaitMinutes, and reminder settings.',
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            queueItemId: { type: 'string', description: 'Target queue item ID (preferred).' },
            requestId: { type: 'string', description: 'Alternative: request ID of the queued/sending item.' },
            text: { type: 'string', description: 'Follow-up prompt text.' },
            template: { type: 'string' },
            repeatCount: { description: 'Literal number or chat-variable name to repeat this follow-up.' },
            answerWaitMinutes: { type: 'number' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            // Multi-transport (spec §4.13).
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Override transport for this follow-up stage.' },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
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
    repeatCount?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    sendMaximum?: number;
    answerWaitMinutes?: number;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
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
            repeatCount: input.repeatCount,
            repeatPrefix: input.repeatPrefix,
            repeatSuffix: input.repeatSuffix,
            sendMaximum: input.sendMaximum,
            answerWaitMinutes: input.answerWaitMinutes,
            reminderEnabled: input.reminderEnabled,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
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
    name: 'tomAi_addTimedRequest',
    displayName: 'Add Timed Request',
    description:
        'Add a timed request entry (interval mode). Supports per-entry repeat (count/prefix/suffix), sendMaximum ' +
        '(auto-pause after N total sends), answerWaitMinutes (auto-advance), and reminder settings. ' +
        'Use tomAi_updateTimedRequest to switch to scheduled mode with HH:MM slots.',
    tags: ['timed', 'queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string' },
            template: { type: 'string' },
            answerWrapper: { type: 'boolean' },
            enabled: { type: 'boolean', description: 'Whether the entry starts enabled. Default false.' },
            intervalMinutes: { type: 'number', description: 'Interval in minutes (min 1). Default 30.' },
            repeatCount: { type: 'number' },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            sendMaximum: { type: 'number', description: 'Auto-pause after this many sends (0 = no cap).' },
            answerWaitMinutes: { type: 'number' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
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
                // Multi-transport fields (spec §4.13 output).
                transport: i.transport || 'copilot',
                anthropicProfileId: i.anthropicProfileId || null,
                anthropicConfigId: i.anthropicConfigId || null,
                answerText: i.answerText || null,
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
    name: 'tomAi_listQueue',
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
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    // Multi-transport (spec §4.13).
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
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

        if (
            input.repeatCount !== undefined ||
            input.repeatPrefix !== undefined ||
            input.repeatSuffix !== undefined ||
            input.templateRepeatCount !== undefined ||
            input.answerWaitMinutes !== undefined
        ) {
            queue.updateItemRepetition(input.queueItemId, {
                repeatCount: input.repeatCount,
                repeatPrefix: input.repeatPrefix,
                repeatSuffix: input.repeatSuffix,
                templateRepeatCount: input.templateRepeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
            });
        }

        if (
            input.transport !== undefined ||
            input.anthropicProfileId !== undefined ||
            input.anthropicConfigId !== undefined
        ) {
            queue.updateItemTransport(input.queueItemId, {
                transport: input.transport,
                anthropicProfileId: input.anthropicProfileId,
                anthropicConfigId: input.anthropicConfigId,
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
            repeatCount: updated?.repeatCount ?? null,
            templateRepeatCount: updated?.templateRepeatCount ?? null,
            answerWaitMinutes: updated?.answerWaitMinutes ?? null,
        });
    } catch (err: any) {
        return `Error updating queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_UPDATE_ITEM_TOOL: SharedToolDefinition<QueueUpdateItemInput> = {
    name: 'tomAi_updateQueueItem',
    displayName: 'Queue Update Item',
    description:
        'Update an editable queue item: text, template, answer-wrapper, reminder, main-prompt repeat (count/prefix/suffix), templateRepeatCount, and answerWaitMinutes. ' +
        'repeatCount / templateRepeatCount accept a literal number or the name of a chat variable that holds the count.',
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string', description: 'Queue item ID to update.' },
            text: { type: 'string' },
            template: { type: 'string' },
            answerWrapper: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            repeatCount: { description: 'Main-prompt repeat count (literal number or chat-variable name).' },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            templateRepeatCount: { description: 'Template-level repeat count (literal number or chat-variable name).' },
            answerWaitMinutes: { type: 'number' },
            // Multi-transport (spec §4.13).
            transport: {
                type: 'string',
                enum: ['copilot', 'anthropic'],
                description: 'Change queue transport for this item (editable while staged/pending only).',
            },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
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
    name: 'tomAi_setQueueItemStatus',
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
        return JSON.stringify({
            success: true,
            id: input.queueItemId,
            status: item?.status || 'unknown',
            // Multi-transport (spec §4.13) — surface the resolved
            // transport + anthropic target in the output so callers
            // know which leaf this item will hit without a second
            // tool call.
            transport: item?.transport || 'copilot',
            anthropicProfileId: item?.anthropicProfileId || null,
            anthropicConfigId: item?.anthropicConfigId || null,
            answerText: item?.answerText || null,
        });
    } catch (err: any) {
        return `Error sending queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_SEND_NOW_TOOL: SharedToolDefinition<QueueSendNowInput> = {
    name: 'tomAi_sendQueueItem',
    displayName: 'Queue Send Now',
    description: 'Send a staged/pending queue item immediately. Returns the resolved transport + anthropic target ids so callers can see which leaf was triggered.',
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
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

interface QueueResendLastPromptInput {
    queueItemId: string;
}

async function executeQueueResendLastPrompt(input: QueueResendLastPromptInput): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const queue = PromptQueueManager.instance;
        await queue.resendLastPrompt(input.queueItemId);
        const item = queue.getById(input.queueItemId);
        return JSON.stringify({
            success: true,
            id: input.queueItemId,
            status: item?.status || 'unknown',
            transport: item?.transport || 'copilot',
            anthropicProfileId: item?.anthropicProfileId || null,
            anthropicConfigId: item?.anthropicConfigId || null,
            lastDispatched: item?.lastDispatched || null,
            warning: item?.warning || null,
        });
    } catch (err: any) {
        return `Error resending queue item: ${err.message ?? err}`;
    }
}

export const QUEUE_RESEND_TOOL: SharedToolDefinition<QueueResendLastPromptInput> = {
    name: 'tomAi_resendQueueItem',
    displayName: 'Queue Resend Last Prompt',
    description:
        'Re-send the last dispatched pre-prompt / main / follow-up of a queue item without touching repetition counters. ' +
        'Use to recover from rate-limit, quota-exceeded, overload, or interrupted responses without losing loop state. ' +
        'The item must have a recorded last-dispatched entry (i.e. it was previously sent).',
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string' },
        },
    },
    execute: executeQueueResendLastPrompt,
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
    name: 'tomAi_removeQueueItem',
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
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
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
            repeatCount: input.repeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
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
    name: 'tomAi_updateQueueFollowUp',
    displayName: 'Queue Update Follow-Up',
    description:
        'Update fields on an existing follow-up prompt: text, template, reminder, repeatCount (number or chat-variable name), answerWaitMinutes.',
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat', 'anthropic'],
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
            repeatCount: { description: 'Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number' },
            // Multi-transport (spec §4.13).
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
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
    name: 'tomAi_removeQueueFollowUp',
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
    name: 'tomAi_listTimedRequests',
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
        /** HH:MM slots; optionally one-shot via ISO date "YYYY-MM-DD". */
        scheduledTimes?: Array<{ time: string; date?: string }>;
        reminderEnabled?: boolean;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        repeatCount?: number;
        repeatPrefix?: string;
        repeatSuffix?: string;
        sendMaximum?: number;
        answerWaitMinutes?: number;
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
    name: 'tomAi_updateTimedRequest',
    displayName: 'Timed Update Entry',
    description:
        'Patch fields on a timed-request entry: schedule (interval or HH:MM-slot scheduled mode), ' +
        'repeat (count/prefix/suffix), sendMaximum (auto-pause after N sends), answerWaitMinutes, reminder settings.',
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
                    description: 'Per-entry schedule slots. Each element: {time:"HH:MM"} for daily, or add date:"YYYY-MM-DD" for one-shot.',
                    items: {
                        type: 'object',
                        required: ['time'],
                        properties: {
                            time: { type: 'string', description: 'HH:MM (24h).' },
                            date: { type: 'string', description: 'Optional YYYY-MM-DD for one-shot firing.' },
                        },
                    },
                },
                reminderEnabled: { type: 'boolean' },
                reminderTemplateId: { type: 'string' },
                reminderTimeoutMinutes: { type: 'number' },
                reminderRepeat: { type: 'boolean' },
                repeatCount: { type: 'number' },
                repeatPrefix: { type: 'string' },
                repeatSuffix: { type: 'string' },
                sendMaximum: { type: 'number', description: 'Auto-pause after N total sends; 0 for no cap.' },
                answerWaitMinutes: { type: 'number' },
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
    name: 'tomAi_removeTimedRequest',
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
    name: 'tomAi_setTimerEngineState',
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

// Prompt templates (queue + timed requests) — one tool per operation.
// Per spec §4.16 the tools accept a `transport` field and route to the
// matching store:
//   copilot   → config.copilot.templates (map of { template, showInMenu? })
//   anthropic → config.anthropic.userMessageTemplates (array of
//               { id, name, description?, template, isDefault? })

interface PromptTemplateEntry { template: string; showInMenu?: boolean }
type TemplateTransport = 'copilot' | 'anthropic';

function getPromptTemplates(): { config: NonNullable<ReturnType<typeof loadSendToChatConfig>>; map: Record<string, PromptTemplateEntry> } | string {
    const config = loadSendToChatConfig();
    if (!config) { return 'Error: Send-to-chat config is not available.'; }
    if (!config.copilot) { config.copilot = {}; }
    if (!config.copilot.templates) { config.copilot.templates = {}; }
    return { config, map: config.copilot.templates as Record<string, PromptTemplateEntry> };
}

interface AnthropicUserMessageTemplate {
    id: string;
    name: string;
    description?: string;
    template: string;
    isDefault?: boolean;
}

function getAnthropicTemplates(): { config: NonNullable<ReturnType<typeof loadSendToChatConfig>>; list: AnthropicUserMessageTemplate[] } | string {
    const config = loadSendToChatConfig();
    if (!config) { return 'Error: Send-to-chat config is not available.'; }
    if (!config.anthropic) { config.anthropic = {}; }
    if (!Array.isArray(config.anthropic.userMessageTemplates)) { config.anthropic.userMessageTemplates = []; }
    return { config, list: config.anthropic.userMessageTemplates as AnthropicUserMessageTemplate[] };
}

export const LIST_PROMPT_TEMPLATES_TOOL: SharedToolDefinition<{ transport?: TemplateTransport }> = {
    name: 'tomAi_listPromptTemplates',
    displayName: 'List Prompt Templates',
    description: 'List prompt templates used by the queue and timed requests. Pass transport=anthropic to list Anthropic user-message templates instead (see spec §4.16); default is copilot.',
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Which template store to list. Default: copilot.' },
        },
    },
    execute: async (input) => {
        const transport: TemplateTransport = input?.transport === 'anthropic' ? 'anthropic' : 'copilot';
        if (transport === 'anthropic') {
            const r = getAnthropicTemplates();
            if (typeof r === 'string') { return r; }
            const entries = r.list.map((t) => ({
                transport: 'anthropic',
                id: t.id,
                name: t.name,
                description: t.description,
                template: t.template,
                isDefault: t.isDefault === true,
            }));
            return JSON.stringify({ count: entries.length, templates: entries }, null, 2);
        }
        const r = getPromptTemplates();
        if (typeof r === 'string') { return r; }
        const entries = Object.entries(r.map).map(([name, value]) => ({
            transport: 'copilot',
            name,
            template: value.template,
            showInMenu: value.showInMenu !== false,
        }));
        return JSON.stringify({ count: entries.length, templates: entries }, null, 2);
    },
};

export const CREATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<{ transport?: TemplateTransport; name: string; template?: string; showInMenu?: boolean; description?: string; id?: string; isDefault?: boolean }> = {
    name: 'tomAi_createPromptTemplate',
    displayName: 'Create Prompt Template',
    description: 'Create a new prompt template. Pass transport=anthropic to add an Anthropic user-message template (spec §4.16); default is copilot.',
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Target template store. Default: copilot.' },
            name: { type: 'string' },
            template: { type: 'string', description: 'Template body. Default: "${originalPrompt}".' },
            showInMenu: { type: 'boolean', description: 'Copilot only — default true.' },
            description: { type: 'string', description: 'Anthropic only — optional description.' },
            id: { type: 'string', description: 'Anthropic only — template id (defaults to name).' },
            isDefault: { type: 'boolean', description: 'Anthropic only — mark as the default template.' },
        },
    },
    execute: async (input) => {
        if (!input.name) { return 'Error: name is required.'; }
        const transport: TemplateTransport = input?.transport === 'anthropic' ? 'anthropic' : 'copilot';
        if (transport === 'anthropic') {
            const r = getAnthropicTemplates();
            if (typeof r === 'string') { return r; }
            const id = input.id?.trim() || input.name.trim();
            if (r.list.some((t) => t.id === id)) {
                return `Error: anthropic template with id "${id}" already exists.`;
            }
            r.list.push({
                id,
                name: input.name,
                description: input.description,
                template: input.template || '${userMessage}',
                isDefault: input.isDefault === true,
            });
            saveSendToChatConfig(r.config);
            return JSON.stringify({ success: true, transport: 'anthropic', id, name: input.name });
        }
        const r = getPromptTemplates();
        if (typeof r === 'string') { return r; }
        r.map[input.name] = {
            template: input.template || '${originalPrompt}',
            showInMenu: input.showInMenu !== false,
        };
        saveSendToChatConfig(r.config);
        return JSON.stringify({ success: true, transport: 'copilot', name: input.name });
    },
};

export const UPDATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<{ transport?: TemplateTransport; name: string; newName?: string; template?: string; showInMenu?: boolean; description?: string; id?: string; newId?: string; isDefault?: boolean }> = {
    name: 'tomAi_updatePromptTemplate',
    displayName: 'Update Prompt Template',
    description: 'Patch an existing prompt template. Pass transport=anthropic to touch the Anthropic user-message store (spec §4.16); default is copilot. Copilot templates are keyed by name; Anthropic templates by id.',
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Target template store. Default: copilot.' },
            name: { type: 'string', description: 'Copilot: existing template name. Anthropic: new display name (optional).' },
            newName: { type: 'string', description: 'Copilot only — rename target.' },
            template: { type: 'string' },
            showInMenu: { type: 'boolean', description: 'Copilot only.' },
            description: { type: 'string', description: 'Anthropic only.' },
            id: { type: 'string', description: 'Anthropic only — existing template id to patch.' },
            newId: { type: 'string', description: 'Anthropic only — rename target id.' },
            isDefault: { type: 'boolean', description: 'Anthropic only.' },
        },
    },
    execute: async (input) => {
        const transport: TemplateTransport = input?.transport === 'anthropic' ? 'anthropic' : 'copilot';
        if (transport === 'anthropic') {
            const r = getAnthropicTemplates();
            if (typeof r === 'string') { return r; }
            const id = input.id || input.name;
            const existing = r.list.find((t) => t.id === id);
            if (!existing) {
                return `Error: anthropic template with id "${id}" not found.`;
            }
            const targetId = input.newId?.trim() || existing.id;
            if (targetId !== existing.id && r.list.some((t) => t.id === targetId)) {
                return `Error: anthropic template with id "${targetId}" already exists.`;
            }
            existing.id = targetId;
            if (input.name !== undefined) { existing.name = input.name; }
            if (input.description !== undefined) { existing.description = input.description || undefined; }
            if (input.template !== undefined) { existing.template = input.template; }
            if (input.isDefault !== undefined) {
                existing.isDefault = input.isDefault === true;
                if (input.isDefault === true) {
                    for (const other of r.list) {
                        if (other !== existing) { other.isDefault = false; }
                    }
                }
            }
            saveSendToChatConfig(r.config);
            return JSON.stringify({ success: true, transport: 'anthropic', id: targetId });
        }
        const r = getPromptTemplates();
        if (typeof r === 'string') { return r; }
        if (!input.name || !r.map[input.name]) {
            return 'Error: existing template name is required.';
        }
        const targetName = input.newName || input.name;
        const old = r.map[input.name];
        if (targetName !== input.name) { delete r.map[input.name]; }
        r.map[targetName] = {
            template: input.template !== undefined ? input.template : old.template,
            showInMenu: input.showInMenu !== undefined ? input.showInMenu : (old.showInMenu !== false),
        };
        saveSendToChatConfig(r.config);
        return JSON.stringify({ success: true, transport: 'copilot', name: targetName });
    },
};

export const DELETE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<{ transport?: TemplateTransport; name?: string; id?: string }> = {
    name: 'tomAi_deletePromptTemplate',
    displayName: 'Delete Prompt Template',
    description: 'Delete a prompt template. Pass transport=anthropic + id to remove an Anthropic user-message template; otherwise pass name for a Copilot template (spec §4.16).',
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Target template store. Default: copilot.' },
            name: { type: 'string', description: 'Copilot template name.' },
            id: { type: 'string', description: 'Anthropic template id.' },
        },
    },
    execute: async (input) => {
        const transport: TemplateTransport = input?.transport === 'anthropic' ? 'anthropic' : 'copilot';
        if (transport === 'anthropic') {
            const r = getAnthropicTemplates();
            if (typeof r === 'string') { return r; }
            const id = input.id;
            if (!id) { return 'Error: id is required for anthropic templates.'; }
            const idx = r.list.findIndex((t) => t.id === id);
            if (idx < 0) { return `Error: anthropic template with id "${id}" not found.`; }
            r.list.splice(idx, 1);
            saveSendToChatConfig(r.config);
            return JSON.stringify({ success: true, transport: 'anthropic', id });
        }
        const r = getPromptTemplates();
        if (typeof r === 'string') { return r; }
        if (!input.name || !r.map[input.name]) { return 'Error: template name required and must exist.'; }
        delete r.map[input.name];
        saveSendToChatConfig(r.config);
        return JSON.stringify({ success: true, transport: 'copilot', name: input.name });
    },
};

// Reminder templates — one tool per operation. Backed by ReminderSystem.

export const LIST_REMINDER_TEMPLATES_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listReminderTemplates',
    displayName: 'List Reminder Templates',
    description: 'List reminder templates used by the queue and timed-request reminders.',
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
        try {
            const reminder = ReminderSystem.instance;
            return JSON.stringify({
                count: reminder.templates.length,
                templates: reminder.templates,
            }, null, 2);
        } catch (err: any) {
            return `Error: ${err?.message ?? err}`;
        }
    },
};

export const CREATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<{ name: string; prompt: string; isDefault?: boolean }> = {
    name: 'tomAi_createReminderTemplate',
    displayName: 'Create Reminder Template',
    description: 'Create a new reminder template.',
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['name', 'prompt'],
        properties: {
            name: { type: 'string' },
            prompt: { type: 'string', description: 'Template body (may contain {{timeoutMinutes}}, etc.).' },
            isDefault: { type: 'boolean' },
        },
    },
    execute: async (input) => {
        try {
            if (!input.name || !input.prompt) { return 'Error: name and prompt are required.'; }
            const created = ReminderSystem.instance.addTemplate({
                name: input.name,
                prompt: input.prompt,
                isDefault: !!input.isDefault,
            });
            return JSON.stringify({ success: true, template: created }, null, 2);
        } catch (err: any) {
            return `Error: ${err?.message ?? err}`;
        }
    },
};

export const UPDATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<{ id: string; name?: string; prompt?: string; isDefault?: boolean }> = {
    name: 'tomAi_updateReminderTemplate',
    displayName: 'Update Reminder Template',
    description: 'Patch an existing reminder template by id.',
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            isDefault: { type: 'boolean' },
        },
    },
    execute: async (input) => {
        try {
            if (!input.id) { return 'Error: id is required.'; }
            ReminderSystem.instance.updateTemplate(input.id, {
                name: input.name,
                prompt: input.prompt,
                isDefault: input.isDefault,
            });
            const updated = ReminderSystem.instance.templates.find((t) => t.id === input.id) || null;
            return JSON.stringify({ success: true, template: updated }, null, 2);
        } catch (err: any) {
            return `Error: ${err?.message ?? err}`;
        }
    },
};

export const DELETE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<{ id: string }> = {
    name: 'tomAi_deleteReminderTemplate',
    displayName: 'Delete Reminder Template',
    description: 'Delete a reminder template by id.',
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
    },
    execute: async (input) => {
        try {
            if (!input.id) { return 'Error: id is required.'; }
            ReminderSystem.instance.removeTemplate(input.id);
            return JSON.stringify({ success: true, id: input.id });
        } catch (err: any) {
            return `Error: ${err?.message ?? err}`;
        }
    },
};

// ============================================================================
// §1.5  Delete Quest Todo
// ============================================================================

interface DeleteTodoInput {
    questId: string;
    todoId: string;
    sourceFile?: string;
}

async function executeDeleteTodo(input: DeleteTodoInput): Promise<string> {
    try {
        const deleted = questTodo.deleteTodo(input.questId, input.todoId, input.sourceFile);
        if (!deleted) {
            return JSON.stringify({ success: false, error: `Todo '${input.todoId}' not found in quest '${input.questId}'.` });
        }
        refreshSessionPanel();
        return JSON.stringify({ success: true, id: input.todoId, questId: input.questId });
    } catch (err: any) {
        return `Error deleting todo: ${err.message ?? err}`;
    }
}

export const DELETE_TODO_TOOL: SharedToolDefinition<DeleteTodoInput> = {
    name: 'tomAi_deleteQuestTodo',
    displayName: 'Delete Quest Todo',
    description: 'Delete a todo item from a quest by its ID.',
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId'],
        properties: {
            questId: { type: 'string', description: 'The quest ID.' },
            todoId: { type: 'string', description: 'The todo item ID to delete.' },
            sourceFile: { type: 'string', description: 'Optional source file hint (relative to quest folder).' },
        },
    },
    execute: executeDeleteTodo,
};

// ============================================================================
// §1.6  List Quests
// ============================================================================

interface ListQuestsInput {
    includeOverview?: boolean;
}

async function executeListQuests(input: ListQuestsInput): Promise<string> {
    try {
        const questIds = questTodo.listQuestIds();
        if (!input.includeOverview) {
            return JSON.stringify({ quests: questIds }, null, 2);
        }
        // Enrich with overview info
        const result: Array<{ id: string; overviewFile?: string; hasTodos: boolean }> = [];
        for (const qid of questIds) {
            const overviewGlob = `overview.${qid}.md`;
            const questDir = WsPaths.ai('quests', qid);
            const todoFiles = questTodo.listTodoFiles(qid);
            let overviewFile: string | undefined;
            if (questDir && fs.existsSync(path.join(questDir, overviewGlob))) {
                overviewFile = overviewGlob;
            }
            result.push({ id: qid, overviewFile, hasTodos: todoFiles.length > 0 });
        }
        return JSON.stringify({ quests: result }, null, 2);
    } catch (err: any) {
        return `Error listing quests: ${err.message ?? err}`;
    }
}

export const LIST_QUESTS_TOOL: SharedToolDefinition<ListQuestsInput> = {
    name: 'tomAi_listQuests',
    displayName: 'List Quests',
    description: 'List all quest directory IDs under _ai/quests/. Optionally include overview file presence and todo count.',
    tags: ['quest', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeOverview: { type: 'boolean', description: 'Include overview file and todo presence (default false).' },
        },
    },
    execute: executeListQuests,
};

// ============================================================================
// §1.7  List Projects
// ============================================================================

interface ListProjectsInput {
    // no parameters
}

async function executeListProjects(_input: ListProjectsInput): Promise<string> {
    try {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { return JSON.stringify({ projects: [] }); }
        const masterPath = WsPaths.metadata('tom_master.yaml');
        if (!masterPath || !fs.existsSync(masterPath)) {
            return JSON.stringify({ error: 'tom_master.yaml not found', projects: [] });
        }
        const yaml = await import('yaml');
        const content = fs.readFileSync(masterPath, 'utf8');
        const doc = yaml.parse(content);
        const projects: Array<{ id: string; name: string; path: string; type?: string }> = [];
        if (doc?.projects && Array.isArray(doc.projects)) {
            for (const p of doc.projects) {
                projects.push({
                    id: p.id || p.name || '',
                    name: p.name || p.id || '',
                    path: p.path || '',
                    type: p.type || undefined,
                });
            }
        }
        return JSON.stringify({ projects }, null, 2);
    } catch (err: any) {
        return `Error listing projects: ${err.message ?? err}`;
    }
}

export const LIST_PROJECTS_TOOL: SharedToolDefinition<ListProjectsInput> = {
    name: 'tomAi_listProjects',
    displayName: 'List Projects',
    description: 'List all projects from .tom_metadata/tom_master.yaml.',
    tags: ['workspace', 'projects', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: executeListProjects,
};

// ============================================================================
// §1.8  List Documents (prompts, answers, notes)
// ============================================================================

interface ListDocumentsInput {
    category: 'prompts' | 'answers' | 'notes' | 'roles' | 'guidelines';
    subPath?: string;
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const relPath = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) {
                results.push(...listFilesRecursive(path.join(dir, e.name), relPath));
            } else {
                results.push(relPath);
            }
        }
    } catch { /* ignore */ }
    return results.sort();
}

async function executeListDocuments(input: ListDocumentsInput): Promise<string> {
    try {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { return JSON.stringify({ files: [] }); }

        let dir: string | undefined;
        switch (input.category) {
            case 'prompts':
                dir = WsPaths.ai('prompt');
                if (!dir) dir = path.join(wsRoot, '_ai', 'prompt');
                break;
            case 'answers':
                dir = WsPaths.ai('answersCopilot');
                if (!dir) dir = path.join(wsRoot, '_ai', 'answers', 'copilot');
                break;
            case 'notes':
                dir = WsPaths.ai('notes');
                if (!dir) dir = path.join(wsRoot, '_ai', 'notes');
                break;
            case 'roles':
                dir = WsPaths.ai('roles');
                if (!dir) dir = path.join(wsRoot, '_ai', 'roles');
                break;
            case 'guidelines':
                dir = WsPaths.guidelines();
                if (!dir) dir = path.join(wsRoot, '_copilot_guidelines');
                break;
        }

        if (input.subPath) {
            dir = dir ? path.join(dir, input.subPath) : undefined;
        }

        const files = dir ? listFilesRecursive(dir) : [];
        return JSON.stringify({ category: input.category, files }, null, 2);
    } catch (err: any) {
        return `Error listing documents: ${err.message ?? err}`;
    }
}

export const LIST_DOCUMENTS_TOOL: SharedToolDefinition<ListDocumentsInput> = {
    name: 'tomAi_listDocuments',
    displayName: 'List Documents',
    description:
        'List files in a workspace document category: prompts, answers, notes, roles, or guidelines.',
    tags: ['documents', 'files', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['category'],
        properties: {
            category: {
                type: 'string',
                enum: ['prompts', 'answers', 'notes', 'roles', 'guidelines'],
                description: 'The document category to list.',
            },
            subPath: { type: 'string', description: 'Optional sub-path within the category folder.' },
        },
    },
    execute: executeListDocuments,
};

// ============================================================================
// §1.9  Workspace-level Todos
// ============================================================================

interface WorkspaceTodoListInput {
    status?: string;
}

async function executeWorkspaceTodoList(input: WorkspaceTodoListInput): Promise<string> {
    try {
        let items = questTodo.readWorkspaceTodos();
        if (input.status) {
            items = items.filter(t => t.status === input.status);
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
    } catch (err: any) {
        return `Error listing workspace todos: ${err.message ?? err}`;
    }
}

export const WORKSPACE_TODO_LIST_TOOL: SharedToolDefinition<WorkspaceTodoListInput> = {
    name: 'tomAi_listWorkspaceQuestTodos',
    displayName: 'List Workspace Todos',
    description: 'List all *.todo.yaml todos across the entire workspace. Optionally filter by status.',
    tags: ['todo', 'workspace', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', description: 'Filter by status (e.g. "not-started", "in-progress", "done").' },
        },
    },
    execute: executeWorkspaceTodoList,
};

// ============================================================================
// Master list of all new tools
// ============================================================================

/** All chat-enhancement tools. Add to ALL_SHARED_TOOLS in tool-executors.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHAT_ENHANCEMENT_TOOLS: SharedToolDefinition<any>[] = [
    NOTIFY_USER_TOOL,
    DETERMINE_QUEST_TOOL,
    LIST_TODOS_TOOL,
    GET_ALL_TODOS_TOOL,
    GET_TODO_TOOL,
    CREATE_TODO_TOOL,
    UPDATE_TODO_TOOL,
    MOVE_TODO_TOOL,
    SESSION_TODO_ADD_TOOL,
    SESSION_TODO_LIST_TOOL,
    SESSION_TODO_GET_ALL_TOOL,
    SESSION_TODO_UPDATE_TOOL,
    SESSION_TODO_DELETE_TOOL,
    ADD_TO_PROMPT_QUEUE_TOOL,
    ADD_FOLLOW_UP_PROMPT_TOOL,
    ADD_PRE_PROMPT_TOOL,
    UPDATE_PRE_PROMPT_TOOL,
    REMOVE_PRE_PROMPT_TOOL,
    SEND_QUEUED_PROMPT_TOOL,
    QUEUE_RESEND_TOOL,
    ADD_TIMED_REQUEST_TOOL,
    QUEUE_LIST_TOOL,
    QUEUE_UPDATE_ITEM_TOOL,
    QUEUE_SET_STATUS_TOOL,
    QUEUE_REMOVE_ITEM_TOOL,
    QUEUE_UPDATE_FOLLOW_UP_TOOL,
    QUEUE_REMOVE_FOLLOW_UP_TOOL,
    TIMED_LIST_TOOL,
    TIMED_UPDATE_ENTRY_TOOL,
    TIMED_REMOVE_ENTRY_TOOL,
    TIMED_SET_ENGINE_STATE_TOOL,
    LIST_PROMPT_TEMPLATES_TOOL,
    CREATE_PROMPT_TEMPLATE_TOOL,
    UPDATE_PROMPT_TEMPLATE_TOOL,
    DELETE_PROMPT_TEMPLATE_TOOL,
    LIST_REMINDER_TEMPLATES_TOOL,
    CREATE_REMINDER_TEMPLATE_TOOL,
    UPDATE_REMINDER_TEMPLATE_TOOL,
    DELETE_REMINDER_TEMPLATE_TOOL,
    // §1.5–§1.9 — Extended tools
    DELETE_TODO_TOOL,
    LIST_QUESTS_TOOL,
    LIST_PROJECTS_TOOL,
    LIST_DOCUMENTS_TOOL,
    WORKSPACE_TODO_LIST_TOOL,
];
