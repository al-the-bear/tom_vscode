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
import { refreshSessionPanel, deleteSessionTodoToFile } from '../handlers/questTodoPanel-handler';

// ============================================================================
// §1.1  Notify User (Telegram)
// ============================================================================

// ============================================================================
// tomAi_notifyUser — relocated to `notify-user-tool.ts` (vscode-free impl +
// narrow `NotificationChannels` dep) by the entry #22 coverage refactor.
// The bridge wires vscode.window.showXxxMessage + Telegram fetch into the
// interface; channel selection happens in the impl based on input + the
// Telegram config.
// ============================================================================

import {
    NOTIFY_USER_TOOL as NOTIFY_USER_DEF,
    NotifyUserInput,
    type NotificationChannels,
    notifyUserImpl,
} from './notify-user-tool';

interface TelegramConfig { enabled?: boolean; botTokenEnv?: string; defaultChatId?: string }

function readTelegramConfig(): { token: string; chatId: string } | null {
    const config = loadSendToChatConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tg = (config as { aiConversation?: { telegram?: TelegramConfig } } | undefined)?.aiConversation?.telegram;
    if (!tg?.enabled || !tg.botTokenEnv) { return null; }
    const token = process.env[tg.botTokenEnv];
    const chatId = tg.defaultChatId;
    if (!token || !chatId) { return null; }
    return { token, chatId };
}

const liveNotificationChannels: NotificationChannels = {
    async showInformation(text, opts) { return vscode.window.showInformationMessage(text, { modal: opts.modal }); },
    async showWarning(text, opts) { return vscode.window.showWarningMessage(text, { modal: opts.modal }); },
    async showError(text, opts) { return vscode.window.showErrorMessage(text, { modal: opts.modal }); },
    setStatusBarMessage(text, timeoutMs) { vscode.window.setStatusBarMessage(text, timeoutMs); },
    sendTelegram(text) {
        const tg = readTelegramConfig();
        if (!tg) { return null; }
        return (async () => {
            try {
                const url = `https://api.telegram.org/bot${tg.token}/sendMessage`;
                const body = JSON.stringify({ chat_id: tg.chatId, text, parse_mode: 'Markdown' });
                const resp = await fetch(url, {
                    method: 'POST',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!resp.ok) { return { ok: false as const, reason: `HTTP ${resp.status}` }; }
                return { ok: true as const };
            } catch (e) {
                return { ok: false as const, reason: (e as Error).message };
            }
        })();
    },
};

export const NOTIFY_USER_TOOL: SharedToolDefinition<NotifyUserInput> = {
    ...NOTIFY_USER_DEF,
    execute: (input) => notifyUserImpl(liveNotificationChannels, input),
};

// Workspace-info tool moved to `editor-context-tools.ts` (tomAi_getWorkspaceInfo).

// ============================================================================
// §1.0  Quest / project introspection — relocated to
//       `quest-introspection-tools.ts` (vscode-free impls + narrow
//       QuestSource/ProjectSource/DocumentSource deps) by entry #23.
//       The four bridges (live QuestSource, live ProjectSource, live
//       DocumentSource) are wired further down, just before the master
//       CHAT_ENHANCEMENT_TOOLS array.
// ============================================================================

import {
    GET_ACTIVE_QUEST_TOOL as GET_ACTIVE_QUEST_DEF,
    LIST_QUESTS_TOOL as LIST_QUESTS_DEF,
    LIST_PROJECTS_TOOL as LIST_PROJECTS_DEF,
    LIST_DOCUMENTS_TOOL as LIST_DOCUMENTS_DEF,
    GetActiveQuestInput as IntroGetActiveQuestInput,
    ListQuestsInput as IntroListQuestsInput,
    ListProjectsInput as IntroListProjectsInput,
    ListDocumentsInput as IntroListDocumentsInput,
    type QuestSource,
    type ProjectSource,
    type DocumentSource,
    type DocumentCategory,
    type ProjectInfo,
    getActiveQuestImpl,
    listQuestsImpl,
    listProjectsImpl,
    listDocumentsImpl,
} from './quest-introspection-tools';

// — QuestSource bridge ——————————————————————————————————————————————

const liveQuestSource: QuestSource = {
    getActiveQuestId(): string { return WsPaths.getWorkspaceQuestId(); },
    questFolderExists(questId): boolean {
        if (!questId) { return false; }
        const folder = WsPaths.ai('quests', questId);
        if (!folder) { return false; }
        try { return fs.existsSync(folder) && fs.statSync(folder).isDirectory(); }
        catch { return false; }
    },
    listQuestIds(): string[] { return questTodo.listQuestIds(); },
    hasOverviewFile(questId): boolean {
        const folder = WsPaths.ai('quests', questId);
        if (!folder) { return false; }
        return fs.existsSync(path.join(folder, `overview.${questId}.md`));
    },
    listTodoFiles(questId): string[] { return questTodo.listTodoFiles(questId); },
    questFolderRelative(questId): string {
        return `${WsPaths.aiFolder}/quests/${questId}`;
    },
};

export const DETERMINE_QUEST_TOOL: SharedToolDefinition<IntroGetActiveQuestInput> = {
    ...GET_ACTIVE_QUEST_DEF,
    execute: (input) => getActiveQuestImpl(liveQuestSource, input),
};

// ============================================================================
// §1.3  Quest Todo Tools — relocated to `quest-todo-tools.ts` (vscode-free
//       impls + narrow `QuestTodoStoreAccess` dep). The bridge below wires
//       the live `questTodoManager.*` free functions through that interface.
// ============================================================================

import {
    LIST_QUEST_TODOS_TOOL as LIST_QUEST_TODOS_DEF,
    GET_QUEST_TODO_TOOL as GET_QUEST_TODO_DEF,
    CREATE_QUEST_TODO_TOOL as CREATE_QUEST_TODO_DEF,
    UPDATE_QUEST_TODO_TOOL as UPDATE_QUEST_TODO_DEF,
    MOVE_QUEST_TODO_TOOL as MOVE_QUEST_TODO_DEF,
    DELETE_QUEST_TODO_TOOL as DELETE_QUEST_TODO_DEF,
    ARCHIVE_QUEST_TODOS_TOOL as ARCHIVE_QUEST_TODOS_DEF,
    DELETE_QUEST_TODOS_TOOL as DELETE_QUEST_TODOS_DEF,
    ListQuestTodosInput,
    GetQuestTodoInput,
    CreateQuestTodoInput,
    UpdateQuestTodoInput,
    MoveQuestTodoInput,
    DeleteQuestTodoInput,
    ArchiveQuestTodosInput,
    DeleteQuestTodosInput,
    type QuestTodoFull,
    type QuestTodoStoreAccess,
    type QuestTodoSummary,
    type QuestTodoToolsDeps,
    type QuestTodoArchiveAccess,
    type QuestTodoArchiveToolsDeps,
    listQuestTodosImpl,
    getQuestTodoImpl,
    createQuestTodoImpl,
    updateQuestTodoImpl,
    moveQuestTodoImpl,
    deleteQuestTodoImpl,
    archiveQuestTodosImpl,
    deleteQuestTodosImpl,
} from './quest-todo-tools';

function toFull(t: questTodo.QuestTodoItem): QuestTodoFull {
    return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        tags: t.tags,
        scope: t.scope,
        references: t.references,
        dependencies: t.dependencies,
        blocked_by: t.blocked_by,
        notes: t.notes,
        created: t.created,
        updated: t.updated,
        completed_date: t.completed_date,
        completed_by: t.completed_by,
        sourceFile: t._sourceFile,
    };
}

function toSummary(t: questTodo.QuestTodoItem): QuestTodoSummary {
    return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        tags: t.tags,
        sourceFile: t._sourceFile,
    };
}

const liveQuestTodoStore: QuestTodoStoreAccess = {
    listFiles(questId): string[] {
        return questTodo.listTodoFiles(questId);
    },
    listTodos(questId, file): QuestTodoSummary[] {
        let items: questTodo.QuestTodoItem[];
        if (file) {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const filePath = path.join(folder, WsPaths.aiFolder, 'quests', questId, file);
            items = questTodo.readTodoFile(filePath);
        } else {
            items = questTodo.readAllTodos(questId);
        }
        return items.map(toSummary);
    },
    findById(questId, todoId) {
        const t = questTodo.findTodoById(questId, todoId);
        return t ? toFull(t) : undefined;
    },
    create(questId, todo, file): QuestTodoFull {
        const created = questTodo.createTodo(questId, {
            id: todo.id,
            title: todo.title,
            description: todo.description,
            status: todo.status,
            priority: todo.priority,
            tags: todo.tags,
            notes: todo.notes,
            dependencies: todo.dependencies,
            blocked_by: todo.blocked_by,
            scope: todo.scope,
            references: todo.references,
        }, file);
        return toFull(created);
    },
    update(questId, todoId, updates) {
        const updated = questTodo.updateTodo(questId, todoId, {
            title: updates.title,
            description: updates.description,
            status: updates.status as questTodo.QuestTodoItem['status'],
            priority: updates.priority as questTodo.QuestTodoItem['priority'],
            tags: updates.tags,
            notes: updates.notes,
            completed_date: updates.completed_date,
            completed_by: updates.completed_by,
            dependencies: updates.dependencies,
            blocked_by: updates.blocked_by,
        });
        return updated ? toFull(updated) : undefined;
    },
    move(questId, todoId, targetFile) {
        const moved = questTodo.moveTodo(questId, todoId, targetFile);
        return moved ? toFull(moved) : undefined;
    },
    delete(questId, todoId, sourceFile): boolean {
        return questTodo.deleteTodo(questId, todoId, sourceFile);
    },
};

const liveQuestTodoDeps: QuestTodoToolsDeps = {
    store: liveQuestTodoStore,
    onMutate: () => refreshSessionPanel(),  // shared panel updates both session + quest views
};

export const LIST_TODOS_TOOL: SharedToolDefinition<ListQuestTodosInput> = {
    ...LIST_QUEST_TODOS_DEF,
    execute: (input) => listQuestTodosImpl(liveQuestTodoDeps, input),
};

// Archive/delete-to-sibling tools (TRA05) — bridged onto the TRA01 move
// operations in questTodoManager. The impls validate questId/file/ids;
// the bridge only resolves the quest-folder absolute path.

function questTodoAbsolutePath(questId: string, file: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.join(folder, WsPaths.aiFolder, 'quests', questId, file);
}

const liveQuestTodoArchiveAccess: QuestTodoArchiveAccess = {
    archiveTodos: (questId, file, todoIds) =>
        questTodo.archiveTodos(questTodoAbsolutePath(questId, file), todoIds),
    deleteTodos: (questId, file, todoIds) =>
        questTodo.deleteTodos(questTodoAbsolutePath(questId, file), todoIds),
    archiveAllCompleted: (questId, file) =>
        questTodo.archiveAllCompleted(questTodoAbsolutePath(questId, file)),
    deleteAllCancelled: (questId, file) =>
        questTodo.deleteAllCancelled(questTodoAbsolutePath(questId, file)),
};

const liveQuestTodoArchiveDeps: QuestTodoArchiveToolsDeps = {
    archive: liveQuestTodoArchiveAccess,
    onMutate: () => refreshSessionPanel(),  // shared panel updates both session + quest views
};

export const ARCHIVE_TODOS_TOOL: SharedToolDefinition<ArchiveQuestTodosInput> = {
    ...ARCHIVE_QUEST_TODOS_DEF,
    execute: (input) => archiveQuestTodosImpl(liveQuestTodoArchiveDeps, input),
};

export const DELETE_TODOS_TO_FILE_TOOL: SharedToolDefinition<DeleteQuestTodosInput> = {
    ...DELETE_QUEST_TODOS_DEF,
    execute: (input) => deleteQuestTodosImpl(liveQuestTodoArchiveDeps, input),
};

// getCombinedTodos bridged to cross-cutting-todo-tools.ts.

import {
    GET_COMBINED_TODOS_TOOL as GET_COMBINED_TODOS_DEF,
    LIST_WORKSPACE_QUEST_TODOS_TOOL as LIST_WORKSPACE_QUEST_TODOS_DEF,
    GetCombinedTodosInput,
    ListWorkspaceQuestTodosInput,
    type CombinedQuestTodo,
    type CombinedSessionTodo,
    type CombinedTodosSource,
    type WorkspaceQuestTodo,
    type WorkspaceTodosSource,
    getCombinedTodosImpl,
    listWorkspaceQuestTodosImpl,
} from './cross-cutting-todo-tools';

const liveCombinedTodosSource: CombinedTodosSource = {
    questTodos(questId): CombinedQuestTodo[] {
        return questTodo.readAllTodos(questId).map((t) => ({
            id: t.id, title: t.title, description: t.description,
            status: t.status, priority: t.priority, tags: t.tags,
            sourceFile: t._sourceFile,
        }));
    },
    sessionTodos(): CombinedSessionTodo[] {
        try {
            return SessionTodoStore.instance.getAll().todos.map((t) => ({
                id: t.id, title: t.title, details: t.details,
                status: t.status, priority: t.priority, tags: t.tags,
                source: t.source,
            }));
        } catch {
            return [];   // session store not initialised — return empty
        }
    },
};

const liveWorkspaceTodosSource: WorkspaceTodosSource = {
    listAll(): WorkspaceQuestTodo[] {
        return questTodo.readWorkspaceTodos().map((t) => {
            // Derive questId from the relative path the manager stamps onto
            // `_sourceFile` for workspace items — same convention used by the
            // legacy impl. Fall back to empty when the manager has nothing.
            const src = t._sourceFile ?? '';
            // workspace items prefix `_sourceFile` with `<questId>/`
            const slash = src.indexOf('/');
            const questId = slash > 0 ? src.slice(0, slash) : '';
            return {
                id: t.id, title: t.title, description: t.description,
                status: t.status, priority: t.priority, tags: t.tags,
                sourceFile: t._sourceFile, questId,
            };
        });
    },
};

export const GET_ALL_TODOS_TOOL: SharedToolDefinition<GetCombinedTodosInput> = {
    ...GET_COMBINED_TODOS_DEF,
    execute: (input) => getCombinedTodosImpl(liveCombinedTodosSource, input),
};

export const WORKSPACE_TODO_LIST_TOOL_NEW: SharedToolDefinition<ListWorkspaceQuestTodosInput> = {
    ...LIST_WORKSPACE_QUEST_TODOS_DEF,
    execute: (input) => listWorkspaceQuestTodosImpl(liveWorkspaceTodosSource, input),
};

// getTodo / createTodo / updateTodo / moveTodo bridged to quest-todo-tools.ts impls.

export const GET_TODO_TOOL: SharedToolDefinition<GetQuestTodoInput> = {
    ...GET_QUEST_TODO_DEF,
    execute: (input) => getQuestTodoImpl(liveQuestTodoDeps, input),
};

export const CREATE_TODO_TOOL: SharedToolDefinition<CreateQuestTodoInput> = {
    ...CREATE_QUEST_TODO_DEF,
    execute: (input) => createQuestTodoImpl(liveQuestTodoDeps, input),
};

export const UPDATE_TODO_TOOL: SharedToolDefinition<UpdateQuestTodoInput> = {
    ...UPDATE_QUEST_TODO_DEF,
    execute: (input) => updateQuestTodoImpl(liveQuestTodoDeps, input),
};

export const MOVE_TODO_TOOL: SharedToolDefinition<MoveQuestTodoInput> = {
    ...MOVE_QUEST_TODO_DEF,
    execute: (input) => moveQuestTodoImpl(liveQuestTodoDeps, input),
};

// ============================================================================
// §1.4  Window Session Todo Tools — relocated to `session-todo-tools.ts`
//       (vscode-free impls + narrow `SessionTodoStoreAccess` dep). The
//       bridge below wires the live SessionTodoStore + side-effect hooks
//       (`refreshSessionPanel`); delete moves the todo to the -deleted /
//       -archived sibling file via `deleteSessionTodoToFile` (TRA03).
// ============================================================================

import {
    ADD_SESSION_TODO_TOOL as ADD_SESSION_TODO_DEF,
    LIST_SESSION_TODOS_TOOL as LIST_SESSION_TODOS_DEF,
    GET_ALL_SESSION_TODOS_TOOL as GET_ALL_SESSION_TODOS_DEF,
    UPDATE_SESSION_TODO_TOOL as UPDATE_SESSION_TODO_DEF,
    DELETE_SESSION_TODO_TOOL as DELETE_SESSION_TODO_DEF,
    SessionTodoAddInput,
    SessionTodoListInput,
    SessionTodoGetAllInput,
    SessionTodoUpdateInput,
    SessionTodoDeleteInput,
    type SessionTodoStoreAccess,
    type SessionTodoToolsDeps,
    addSessionTodoImpl,
    listSessionTodosImpl,
    getAllSessionTodosImpl,
    updateSessionTodoImpl,
    deleteSessionTodoImpl,
} from './session-todo-tools';

const liveSessionTodoStore: SessionTodoStoreAccess = {
    add(input) {
        const item = SessionTodoStore.instance.add(input.title, 'copilot', {
            details: input.details,
            priority: input.priority,
            tags: input.tags,
        });
        // The store returns a wider SessionTodoItem; project to the tool snapshot.
        return {
            id: item.id, title: item.title, details: item.details,
            priority: item.priority, tags: item.tags, status: item.status,
            createdAt: item.createdAt, updatedAt: item.updatedAt,
        };
    },
    list(filter) {
        return SessionTodoStore.instance.list(filter).map((i) => ({
            id: i.id, title: i.title, details: i.details,
            priority: i.priority, tags: i.tags, status: i.status,
            createdAt: i.createdAt, updatedAt: i.updatedAt,
        }));
    },
    getAll() {
        const all = SessionTodoStore.instance.getAll();
        return {
            todos: all.todos.map((i) => ({
                id: i.id, title: i.title, details: i.details,
                priority: i.priority, tags: i.tags, status: i.status,
                createdAt: i.createdAt, updatedAt: i.updatedAt,
            })),
            count: all.count,
            pendingCount: all.pendingCount,
        };
    },
    update(id, updates) {
        const updated = SessionTodoStore.instance.update(id, updates);
        if (!updated) { return undefined; }
        return {
            id: updated.id, title: updated.title, details: updated.details,
            priority: updated.priority, tags: updated.tags, status: updated.status,
            createdAt: updated.createdAt, updatedAt: updated.updatedAt,
        };
    },
    // TRA03: deleting via the tool moves the todo to the -deleted / -archived
    // sibling of the session file (no soft-cancel, no backup copy).
    delete(id) { return deleteSessionTodoToFile(id); },
};

const liveSessionTodoDeps: SessionTodoToolsDeps = {
    store: liveSessionTodoStore,
    onMutate: () => refreshSessionPanel(),
};

export const SESSION_TODO_ADD_TOOL: SharedToolDefinition<SessionTodoAddInput> = {
    ...ADD_SESSION_TODO_DEF,
    execute: (input) => addSessionTodoImpl(liveSessionTodoDeps, input),
};
export const SESSION_TODO_LIST_TOOL: SharedToolDefinition<SessionTodoListInput> = {
    ...LIST_SESSION_TODOS_DEF,
    execute: (input) => listSessionTodosImpl(liveSessionTodoDeps, input),
};
export const SESSION_TODO_GET_ALL_TOOL: SharedToolDefinition<SessionTodoGetAllInput> = {
    ...GET_ALL_SESSION_TODOS_DEF,
    execute: (input) => getAllSessionTodosImpl(liveSessionTodoDeps, input),
};
export const SESSION_TODO_UPDATE_TOOL: SharedToolDefinition<SessionTodoUpdateInput> = {
    ...UPDATE_SESSION_TODO_DEF,
    execute: (input) => updateSessionTodoImpl(liveSessionTodoDeps, input),
};
export const SESSION_TODO_DELETE_TOOL: SharedToolDefinition<SessionTodoDeleteInput> = {
    ...DELETE_SESSION_TODO_DEF,
    execute: (input) => deleteSessionTodoImpl(liveSessionTodoDeps, input),
};

// ============================================================================
// Prompt Queue Tools (14) — relocated to `prompt-queue-tools.ts` (vscode-free
// impls + narrow `PromptQueueAccess` dep) by the entry #18 coverage refactor.
// The bridge below wires the live `PromptQueueManager.instance` to the
// interface so the impls work against real queue state.
// ============================================================================

import {
    ADD_QUEUE_ITEM_TOOL as ADD_QUEUE_ITEM_DEF,
    LIST_QUEUE_TOOL as LIST_QUEUE_DEF,
    SEND_QUEUED_PROMPT_TOOL as SEND_QUEUED_PROMPT_DEF,
    SEND_QUEUE_ITEM_TOOL as SEND_QUEUE_ITEM_DEF,
    RESEND_QUEUE_ITEM_TOOL as RESEND_QUEUE_ITEM_DEF,
    SET_QUEUE_ITEM_STATUS_TOOL as SET_QUEUE_ITEM_STATUS_DEF,
    UPDATE_QUEUE_ITEM_TOOL as UPDATE_QUEUE_ITEM_DEF,
    REMOVE_QUEUE_ITEM_TOOL as REMOVE_QUEUE_ITEM_DEF,
    ADD_QUEUE_PRE_PROMPT_TOOL as ADD_QUEUE_PRE_PROMPT_DEF,
    UPDATE_QUEUE_PRE_PROMPT_TOOL as UPDATE_QUEUE_PRE_PROMPT_DEF,
    REMOVE_QUEUE_PRE_PROMPT_TOOL as REMOVE_QUEUE_PRE_PROMPT_DEF,
    ADD_QUEUE_FOLLOW_UP_TOOL as ADD_QUEUE_FOLLOW_UP_DEF,
    UPDATE_QUEUE_FOLLOW_UP_TOOL as UPDATE_QUEUE_FOLLOW_UP_DEF,
    REMOVE_QUEUE_FOLLOW_UP_TOOL as REMOVE_QUEUE_FOLLOW_UP_DEF,
    AddQueueItemInput,
    ListQueueInput,
    SendQueuedPromptInput,
    SendQueueItemInput,
    ResendQueueItemInput,
    SetQueueItemStatusInput,
    UpdateQueueItemInput,
    RemoveQueueItemInput,
    AddQueuePrePromptInput,
    UpdateQueuePrePromptInput,
    RemoveQueuePrePromptInput,
    AddQueueFollowUpInput,
    UpdateQueueFollowUpInput,
    RemoveQueueFollowUpInput,
    type PromptQueueAccess,
    type QueueItemSnapshot,
    type FollowUpItem,
    addQueueItemImpl,
    listQueueImpl,
    sendQueuedPromptImpl,
    sendQueueItemImpl,
    resendQueueItemImpl,
    setQueueItemStatusImpl,
    updateQueueItemImpl,
    removeQueueItemImpl,
    addQueuePrePromptImpl,
    updateQueuePrePromptImpl,
    removeQueuePrePromptImpl,
    addQueueFollowUpImpl,
    updateQueueFollowUpImpl,
    removeQueueFollowUpImpl,
} from './prompt-queue-tools';

// Lazy-import the manager so we don't pay the module-load cost when
// the queue isn't in use. Same dynamic-import pattern the previous
// impls used.
async function getQueueManager() {
    const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
    return PromptQueueManager.instance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectItem(i: any): QueueItemSnapshot {
    return {
        id: i.id, status: i.status, type: i.type,
        originalText: i.originalText || '',
        template: i.template, answerWrapper: i.answerWrapper,
        requestId: i.requestId, expectedRequestId: i.expectedRequestId,
        createdAt: i.createdAt, sentAt: i.sentAt,
        reminderEnabled: i.reminderEnabled, reminderTemplateId: i.reminderTemplateId,
        reminderTimeoutMinutes: i.reminderTimeoutMinutes, reminderRepeat: i.reminderRepeat,
        repeatCount: i.repeatCount, repeatPrefix: i.repeatPrefix, repeatSuffix: i.repeatSuffix,
        templateRepeatCount: i.templateRepeatCount, answerWaitMinutes: i.answerWaitMinutes,
        followUpIndex: i.followUpIndex, followUps: i.followUps as FollowUpItem[] | undefined,
        prePrompts: i.prePrompts, transport: i.transport,
        anthropicProfileId: i.anthropicProfileId, anthropicConfigId: i.anthropicConfigId,
        answerText: i.answerText, lastDispatched: i.lastDispatched, warning: i.warning,
    };
}

const livePromptQueueAccess: PromptQueueAccess = {
    items(): QueueItemSnapshot[] {
        // Synchronous getter — read the manager once at module load and
        // proxy. Using a `Promise.resolve` here would break the interface;
        // the manager is a singleton + the module-level `instance` is
        // synchronous, so we wrap it lazily via require at call time.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const PromptQueueManager = require('../managers/promptQueueManager.js').PromptQueueManager;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (PromptQueueManager.instance.items as any[]).map(projectItem);
    },
    autoSendEnabled() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.autoSendEnabled;
    },
    responseFileTimeoutMinutes() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.responseFileTimeoutMinutes;
    },
    pendingCount() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.pendingCount;
    },
    getById(id) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const item = require('../managers/promptQueueManager.js').PromptQueueManager.instance.getById(id);
        return item ? projectItem(item) : undefined;
    },
    getByRequestId(requestId) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const item = require('../managers/promptQueueManager.js').PromptQueueManager.instance.getByRequestId(requestId);
        return item ? projectItem(item) : undefined;
    },
    async enqueue(input): Promise<QueueItemSnapshot> {
        const m = await getQueueManager();
        const item = await m.enqueue(input);
        return projectItem(item);
    },
    remove(id) { void getQueueManager().then((m) => m.remove(id)); },
    setStatus(id, status) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.setStatus(id, status);
    },
    async updateText(id, text) { await (await getQueueManager()).updateText(id, text); },
    async updateItemTemplateAndWrapper(id, opts) { await (await getQueueManager()).updateItemTemplateAndWrapper(id, opts); },
    updateItemReminder(id, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../managers/promptQueueManager.js').PromptQueueManager.instance.updateItemReminder(id, opts);
    },
    updateItemRepetition(id, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../managers/promptQueueManager.js').PromptQueueManager.instance.updateItemRepetition(id, opts);
    },
    updateItemTransport(id, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../managers/promptQueueManager.js').PromptQueueManager.instance.updateItemTransport(id, opts);
    },
    addPrePrompt(id, text, template, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.addPrePrompt(id, text, template, opts);
    },
    updatePrePrompt(id, index, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.updatePrePrompt(id, index, opts);
    },
    removePrePrompt(id, index) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.removePrePrompt(id, index);
    },
    addFollowUpPrompt(id, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.addFollowUpPrompt(id, opts) as FollowUpItem | undefined;
    },
    updateFollowUpPrompt(id, fuId, opts) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.updateFollowUpPrompt(id, fuId, opts);
    },
    removeFollowUpPrompt(id, fuId) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../managers/promptQueueManager.js').PromptQueueManager.instance.removeFollowUpPrompt(id, fuId);
    },
    async sendQueuedPrompt(selector) {
        const item = await (await getQueueManager()).sendQueuedPrompt(selector);
        return item ? projectItem(item) : null;
    },
    async sendNow(id) { await (await getQueueManager()).sendNow(id); },
    async resendLastPrompt(id) { await (await getQueueManager()).resendLastPrompt(id); },
};

// Clone-and-override the 14 imported defs to wire the live executor.
// Names match the legacy ALL_SHARED_TOOLS spread so registration is unchanged.
export const ADD_TO_PROMPT_QUEUE_TOOL: SharedToolDefinition<AddQueueItemInput> = {
    ...ADD_QUEUE_ITEM_DEF,
    execute: (input) => addQueueItemImpl(livePromptQueueAccess, input),
};
export const QUEUE_LIST_TOOL: SharedToolDefinition<ListQueueInput> = {
    ...LIST_QUEUE_DEF,
    execute: (input) => listQueueImpl(livePromptQueueAccess, input),
};
export const SEND_QUEUED_PROMPT_TOOL: SharedToolDefinition<SendQueuedPromptInput> = {
    ...SEND_QUEUED_PROMPT_DEF,
    execute: (input) => sendQueuedPromptImpl(livePromptQueueAccess, input),
};
export const QUEUE_SEND_NOW_TOOL: SharedToolDefinition<SendQueueItemInput> = {
    ...SEND_QUEUE_ITEM_DEF,
    execute: (input) => sendQueueItemImpl(livePromptQueueAccess, input),
};
export const QUEUE_RESEND_TOOL: SharedToolDefinition<ResendQueueItemInput> = {
    ...RESEND_QUEUE_ITEM_DEF,
    execute: (input) => resendQueueItemImpl(livePromptQueueAccess, input),
};
export const QUEUE_SET_STATUS_TOOL: SharedToolDefinition<SetQueueItemStatusInput> = {
    ...SET_QUEUE_ITEM_STATUS_DEF,
    execute: (input) => setQueueItemStatusImpl(livePromptQueueAccess, input),
};
export const QUEUE_UPDATE_ITEM_TOOL: SharedToolDefinition<UpdateQueueItemInput> = {
    ...UPDATE_QUEUE_ITEM_DEF,
    execute: (input) => updateQueueItemImpl(livePromptQueueAccess, input),
};
export const QUEUE_REMOVE_ITEM_TOOL: SharedToolDefinition<RemoveQueueItemInput> = {
    ...REMOVE_QUEUE_ITEM_DEF,
    execute: (input) => removeQueueItemImpl(livePromptQueueAccess, input),
};
export const ADD_PRE_PROMPT_TOOL: SharedToolDefinition<AddQueuePrePromptInput> = {
    ...ADD_QUEUE_PRE_PROMPT_DEF,
    execute: (input) => addQueuePrePromptImpl(livePromptQueueAccess, input),
};
export const UPDATE_PRE_PROMPT_TOOL: SharedToolDefinition<UpdateQueuePrePromptInput> = {
    ...UPDATE_QUEUE_PRE_PROMPT_DEF,
    execute: (input) => updateQueuePrePromptImpl(livePromptQueueAccess, input),
};
export const REMOVE_PRE_PROMPT_TOOL: SharedToolDefinition<RemoveQueuePrePromptInput> = {
    ...REMOVE_QUEUE_PRE_PROMPT_DEF,
    execute: (input) => removeQueuePrePromptImpl(livePromptQueueAccess, input),
};
export const ADD_FOLLOW_UP_PROMPT_TOOL: SharedToolDefinition<AddQueueFollowUpInput> = {
    ...ADD_QUEUE_FOLLOW_UP_DEF,
    execute: (input) => addQueueFollowUpImpl(livePromptQueueAccess, input),
};
export const QUEUE_UPDATE_FOLLOW_UP_TOOL: SharedToolDefinition<UpdateQueueFollowUpInput> = {
    ...UPDATE_QUEUE_FOLLOW_UP_DEF,
    execute: (input) => updateQueueFollowUpImpl(livePromptQueueAccess, input),
};
export const QUEUE_REMOVE_FOLLOW_UP_TOOL: SharedToolDefinition<RemoveQueueFollowUpInput> = {
    ...REMOVE_QUEUE_FOLLOW_UP_DEF,
    execute: (input) => removeQueueFollowUpImpl(livePromptQueueAccess, input),
};

// ============================================================================
// Timed-request Tools (5) — relocated to `timed-request-tools.ts` (vscode-free
// impls + narrow `TimerEngineAccess` dep) by the entry #19 coverage refactor.
// Bridge wires the live `TimerEngine.instance` to the interface.
// ============================================================================

import {
    ADD_TIMED_REQUEST_TOOL as ADD_TIMED_REQUEST_DEF,
    LIST_TIMED_REQUESTS_TOOL as LIST_TIMED_REQUESTS_DEF,
    UPDATE_TIMED_REQUEST_TOOL as UPDATE_TIMED_REQUEST_DEF,
    REMOVE_TIMED_REQUEST_TOOL as REMOVE_TIMED_REQUEST_DEF,
    SET_TIMER_ENGINE_STATE_TOOL as SET_TIMER_ENGINE_STATE_DEF,
    AddTimedEntryInput,
    ListTimedRequestsInput,
    UpdateTimedRequestInput,
    RemoveTimedRequestInput,
    SetTimerEngineStateInput,
    type TimedEntrySnapshot,
    type TimerEngineAccess,
    addTimedRequestImpl,
    listTimedRequestsImpl,
    updateTimedRequestImpl,
    removeTimedRequestImpl,
    setTimerEngineStateImpl,
} from './timed-request-tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectTimedEntry(e: any): TimedEntrySnapshot {
    return {
        id: e.id, status: e.status, enabled: !!e.enabled,
        template: e.template, answerWrapper: !!e.answerWrapper,
        originalText: e.originalText ?? '',
        scheduleMode: e.scheduleMode,
        intervalMinutes: e.intervalMinutes, scheduledTimes: e.scheduledTimes,
        repeatCount: e.repeatCount, repeatPrefix: e.repeatPrefix, repeatSuffix: e.repeatSuffix,
        sendMaximum: e.sendMaximum, answerWaitMinutes: e.answerWaitMinutes,
        reminderEnabled: e.reminderEnabled, reminderTemplateId: e.reminderTemplateId,
        reminderTimeoutMinutes: e.reminderTimeoutMinutes, reminderRepeat: e.reminderRepeat,
        lastSentAt: e.lastSentAt,
    };
}

const liveTimerEngineAccess: TimerEngineAccess = {
    entries(): TimedEntrySnapshot[] {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TimerEngine = require('../managers/timerEngine.js').TimerEngine;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (TimerEngine.instance.entries as any[]).map(projectTimedEntry);
    },
    isTimerActivated() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return !!require('../managers/timerEngine.js').TimerEngine.instance.timerActivated;
    },
    setTimerActivated(v: boolean) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../managers/timerEngine.js').TimerEngine.instance.timerActivated = v;
    },
    getEntry(id: string) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const e = require('../managers/timerEngine.js').TimerEngine.instance.getEntry(id);
        return e ? projectTimedEntry(e) : undefined;
    },
    addEntry(spec) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const e = require('../managers/timerEngine.js').TimerEngine.instance.addEntry(spec);
        return projectTimedEntry(e);
    },
    updateEntry(id: string, patch) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TimerEngine = require('../managers/timerEngine.js').TimerEngine;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TimerEngine.instance.updateEntry(id, patch as any);
        const updated = TimerEngine.instance.getEntry(id);
        return updated ? projectTimedEntry(updated) : undefined;
    },
    removeEntry(id: string): boolean {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TimerEngine = require('../managers/timerEngine.js').TimerEngine;
        const existed = !!TimerEngine.instance.getEntry(id);
        TimerEngine.instance.removeEntry(id);
        return existed;
    },
};

export const ADD_TIMED_REQUEST_TOOL: SharedToolDefinition<AddTimedEntryInput> = {
    ...ADD_TIMED_REQUEST_DEF,
    execute: (input) => addTimedRequestImpl(liveTimerEngineAccess, input),
};
export const TIMED_LIST_TOOL: SharedToolDefinition<ListTimedRequestsInput> = {
    ...LIST_TIMED_REQUESTS_DEF,
    execute: (input) => listTimedRequestsImpl(liveTimerEngineAccess, input),
};
export const TIMED_UPDATE_ENTRY_TOOL: SharedToolDefinition<UpdateTimedRequestInput> = {
    ...UPDATE_TIMED_REQUEST_DEF,
    execute: (input) => updateTimedRequestImpl(liveTimerEngineAccess, input),
};
export const TIMED_REMOVE_ENTRY_TOOL: SharedToolDefinition<RemoveTimedRequestInput> = {
    ...REMOVE_TIMED_REQUEST_DEF,
    execute: (input) => removeTimedRequestImpl(liveTimerEngineAccess, input),
};
export const TIMED_SET_ENGINE_STATE_TOOL: SharedToolDefinition<SetTimerEngineStateInput> = {
    ...SET_TIMER_ENGINE_STATE_DEF,
    execute: (input) => setTimerEngineStateImpl(liveTimerEngineAccess, input),
};

// ============================================================================
// Prompt Templates (4) — relocated to `prompt-template-tools.ts` (vscode-free
// impls + narrow `PromptTemplateStore` dep) by the entry #20 coverage refactor.
// The bridge below wires `loadSendToChatConfig`/`saveSendToChatConfig` to the
// interface; each operation reloads the config so concurrent edits from other
// panels are picked up.
// ============================================================================

import {
    LIST_PROMPT_TEMPLATES_TOOL as LIST_PROMPT_TEMPLATES_DEF,
    CREATE_PROMPT_TEMPLATE_TOOL as CREATE_PROMPT_TEMPLATE_DEF,
    UPDATE_PROMPT_TEMPLATE_TOOL as UPDATE_PROMPT_TEMPLATE_DEF,
    DELETE_PROMPT_TEMPLATE_TOOL as DELETE_PROMPT_TEMPLATE_DEF,
    ListPromptTemplatesInput,
    CreatePromptTemplateInput,
    UpdatePromptTemplateInput,
    DeletePromptTemplateInput,
    type AnthropicTemplateEntry,
    type CopilotTemplateEntry,
    type PromptTemplateStore,
    createPromptTemplateImpl,
    deletePromptTemplateImpl,
    listPromptTemplatesImpl,
    updatePromptTemplateImpl,
} from './prompt-template-tools';

interface TemplateStoreSession {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any;
    copilotMap: Record<string, CopilotTemplateEntry>;
    anthropicList: AnthropicTemplateEntry[];
}

function openTemplateSession(): TemplateStoreSession | null {
    const config = loadSendToChatConfig();
    if (!config) { return null; }
    if (!config.copilot) { config.copilot = {}; }
    if (!config.copilot.templates) { config.copilot.templates = {}; }
    if (!config.anthropic) { config.anthropic = {}; }
    if (!Array.isArray(config.anthropic.userMessageTemplates)) { config.anthropic.userMessageTemplates = []; }
    return {
        config,
        copilotMap: config.copilot.templates as Record<string, CopilotTemplateEntry>,
        anthropicList: config.anthropic.userMessageTemplates as AnthropicTemplateEntry[],
    };
}

const livePromptTemplateStore: PromptTemplateStore = {
    copilot: {
        list() {
            const s = openTemplateSession();
            return s ? s.copilotMap : {};
        },
        has(name) {
            const s = openTemplateSession();
            return !!(s && Object.prototype.hasOwnProperty.call(s.copilotMap, name));
        },
        set(name, entry) {
            const s = openTemplateSession();
            if (!s) { throw new Error('Send-to-chat config is not available.'); }
            s.copilotMap[name] = entry;
            saveSendToChatConfig(s.config);
        },
        delete(name) {
            const s = openTemplateSession();
            if (!s || !Object.prototype.hasOwnProperty.call(s.copilotMap, name)) { return false; }
            delete s.copilotMap[name];
            saveSendToChatConfig(s.config);
            return true;
        },
    },
    anthropic: {
        list() {
            const s = openTemplateSession();
            return s ? s.anthropicList : [];
        },
        find(id) {
            const s = openTemplateSession();
            return s?.anthropicList.find((t) => t.id === id);
        },
        add(entry) {
            const s = openTemplateSession();
            if (!s) { throw new Error('Send-to-chat config is not available.'); }
            s.anthropicList.push(entry);
            saveSendToChatConfig(s.config);
        },
        update(id, patch) {
            const s = openTemplateSession();
            if (!s) { return undefined; }
            const entry = s.anthropicList.find((t) => t.id === id);
            if (!entry) { return undefined; }
            if (patch.newId !== undefined && patch.newId !== entry.id) { entry.id = patch.newId; }
            if (patch.name !== undefined) { entry.name = patch.name; }
            if (patch.description !== undefined) { entry.description = patch.description || undefined; }
            if (patch.template !== undefined) { entry.template = patch.template; }
            if (patch.isDefault !== undefined) { entry.isDefault = patch.isDefault === true; }
            saveSendToChatConfig(s.config);
            return entry;
        },
        delete(id) {
            const s = openTemplateSession();
            if (!s) { return false; }
            const idx = s.anthropicList.findIndex((t) => t.id === id);
            if (idx < 0) { return false; }
            s.anthropicList.splice(idx, 1);
            saveSendToChatConfig(s.config);
            return true;
        },
        setDefault(id) {
            const s = openTemplateSession();
            if (!s) { return; }
            for (const t of s.anthropicList) { t.isDefault = (t.id === id); }
            saveSendToChatConfig(s.config);
        },
    },
};

export const LIST_PROMPT_TEMPLATES_TOOL: SharedToolDefinition<ListPromptTemplatesInput> = {
    ...LIST_PROMPT_TEMPLATES_DEF,
    execute: (input) => listPromptTemplatesImpl(livePromptTemplateStore, input),
};
export const CREATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<CreatePromptTemplateInput> = {
    ...CREATE_PROMPT_TEMPLATE_DEF,
    execute: (input) => createPromptTemplateImpl(livePromptTemplateStore, input),
};
export const UPDATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<UpdatePromptTemplateInput> = {
    ...UPDATE_PROMPT_TEMPLATE_DEF,
    execute: (input) => updatePromptTemplateImpl(livePromptTemplateStore, input),
};
export const DELETE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<DeletePromptTemplateInput> = {
    ...DELETE_PROMPT_TEMPLATE_DEF,
    execute: (input) => deletePromptTemplateImpl(livePromptTemplateStore, input),
};

// ============================================================================
// Reminder Templates (4) — relocated to `reminder-template-tools.ts` (vscode-
// free impls + narrow `ReminderTemplateStore` dep) by the entry #21 coverage
// refactor. The bridge wires the live `ReminderSystem.instance` to the
// interface.
// ============================================================================

import {
    LIST_REMINDER_TEMPLATES_TOOL as LIST_REMINDER_TEMPLATES_DEF,
    CREATE_REMINDER_TEMPLATE_TOOL as CREATE_REMINDER_TEMPLATE_DEF,
    UPDATE_REMINDER_TEMPLATE_TOOL as UPDATE_REMINDER_TEMPLATE_DEF,
    DELETE_REMINDER_TEMPLATE_TOOL as DELETE_REMINDER_TEMPLATE_DEF,
    ListReminderTemplatesInput,
    CreateReminderTemplateInput,
    UpdateReminderTemplateInput,
    DeleteReminderTemplateInput,
    type ReminderTemplateEntry,
    type ReminderTemplateStore,
    createReminderTemplateImpl,
    deleteReminderTemplateImpl,
    listReminderTemplatesImpl,
    updateReminderTemplateImpl,
} from './reminder-template-tools';

function projectReminderTemplate(t: { id: string; name: string; prompt: string; isDefault: boolean }): ReminderTemplateEntry {
    return { id: t.id, name: t.name, prompt: t.prompt, isDefault: !!t.isDefault };
}

const liveReminderTemplateStore: ReminderTemplateStore = {
    list() {
        return ReminderSystem.instance.templates.map(projectReminderTemplate);
    },
    findById(id) {
        const t = ReminderSystem.instance.templates.find((x) => x.id === id);
        return t ? projectReminderTemplate(t) : undefined;
    },
    findByName(name) {
        const t = ReminderSystem.instance.templates.find((x) => x.name === name);
        return t ? projectReminderTemplate(t) : undefined;
    },
    add(entry) {
        const created = ReminderSystem.instance.addTemplate({
            name: entry.name,
            prompt: entry.prompt,
            isDefault: entry.isDefault,
        });
        return projectReminderTemplate(created);
    },
    update(id, patch) {
        const existed = ReminderSystem.instance.templates.find((x) => x.id === id);
        if (!existed) { return undefined; }
        ReminderSystem.instance.updateTemplate(id, {
            name: patch.name,
            prompt: patch.prompt,
            isDefault: patch.isDefault,
        });
        const updated = ReminderSystem.instance.templates.find((x) => x.id === id);
        return updated ? projectReminderTemplate(updated) : undefined;
    },
    delete(id) {
        const existed = ReminderSystem.instance.templates.find((x) => x.id === id);
        if (!existed) { return { existed: false }; }
        const wasDefault = existed.isDefault;
        ReminderSystem.instance.removeTemplate(id);
        if (!wasDefault) { return { existed: true }; }
        // Manager auto-promotes the first remaining; surface that.
        const remaining = ReminderSystem.instance.templates;
        const promotedDefault = remaining.find((x) => x.isDefault);
        return {
            existed: true,
            promotedDefault: promotedDefault ? projectReminderTemplate(promotedDefault) : undefined,
        };
    },
};

export const LIST_REMINDER_TEMPLATES_TOOL: SharedToolDefinition<ListReminderTemplatesInput> = {
    ...LIST_REMINDER_TEMPLATES_DEF,
    execute: () => listReminderTemplatesImpl(liveReminderTemplateStore),
};
export const CREATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<CreateReminderTemplateInput> = {
    ...CREATE_REMINDER_TEMPLATE_DEF,
    execute: (input) => createReminderTemplateImpl(liveReminderTemplateStore, input),
};
export const UPDATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<UpdateReminderTemplateInput> = {
    ...UPDATE_REMINDER_TEMPLATE_DEF,
    execute: (input) => updateReminderTemplateImpl(liveReminderTemplateStore, input),
};
export const DELETE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<DeleteReminderTemplateInput> = {
    ...DELETE_REMINDER_TEMPLATE_DEF,
    execute: (input) => deleteReminderTemplateImpl(liveReminderTemplateStore, input),
};

// ============================================================================
// §1.5  Delete Quest Todo — bridged to `quest-todo-tools.ts` impl.
// ============================================================================

export const DELETE_TODO_TOOL: SharedToolDefinition<DeleteQuestTodoInput> = {
    ...DELETE_QUEST_TODO_DEF,
    execute: (input) => deleteQuestTodoImpl(liveQuestTodoDeps, input),
};

// ============================================================================
// §1.6 / §1.7 / §1.8 — List Quests / Projects / Documents
//
// Impls and tool defs live in `quest-introspection-tools.ts` (entry #23).
// Bridges below wire the vscode-bound sources:
//   - liveProjectSource reads .tom_metadata/tom_master.yaml via dynamic YAML import.
//   - liveDocumentSource resolves WsPaths.ai('prompt'|'answersCopilot'|'notes'|'roles')
//     and WsPaths.guidelines() for the `guidelines` category.
//   - liveQuestSource was wired further up where DETERMINE_QUEST_TOOL is exported.
// ============================================================================

const liveProjectSource: ProjectSource = {
    readProjects() {
        const masterPath = WsPaths.metadata('tom_master.yaml') ?? '';
        if (!masterPath || !fs.existsSync(masterPath)) {
            return { found: false, masterPath, projects: [] };
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yaml = require('yaml');
        const content = fs.readFileSync(masterPath, 'utf8');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = yaml.parse(content) as { projects?: any[] } | null;
        const projects: ProjectInfo[] = [];
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
        return { found: true, masterPath, projects };
    },
};

function categoryFolder(category: DocumentCategory): string | undefined {
    switch (category) {
        case 'prompts':    return WsPaths.ai('prompt');
        case 'answers':    return WsPaths.ai('answersCopilot');
        case 'notes':      return WsPaths.ai('notes');
        case 'roles':      return WsPaths.ai('roles');
        case 'guidelines': return WsPaths.guidelines();
    }
}

const CATEGORY_RELATIVE: Record<DocumentCategory, string> = {
    prompts:    '_ai/prompt',
    answers:    '_ai/answers/copilot',
    notes:      '_ai/notes',
    roles:      '_ai/roles',
    guidelines: '_copilot_guidelines',
};

function walkRecursive(dir: string, prefix = ''): string[] {
    if (!fs.existsSync(dir)) { return []; }
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.')) { continue; }
            const relPath = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) { results.push(...walkRecursive(path.join(dir, e.name), relPath)); }
            else { results.push(relPath); }
        }
    } catch { /* ignore */ }
    return results.sort();
}

const liveDocumentSource: DocumentSource = {
    resolveCategoryFolder(category) {
        const abs = categoryFolder(category);
        if (!abs) { return undefined; }
        return { absolute: abs, relative: CATEGORY_RELATIVE[category] };
    },
    listFilesRecursive(absoluteFolder) {
        if (!fs.existsSync(absoluteFolder)) { return { exists: false, files: [] }; }
        return { exists: true, files: walkRecursive(absoluteFolder) };
    },
};

export const LIST_QUESTS_TOOL: SharedToolDefinition<IntroListQuestsInput> = {
    ...LIST_QUESTS_DEF,
    execute: (input) => listQuestsImpl(liveQuestSource, input),
};

export const LIST_PROJECTS_TOOL: SharedToolDefinition<IntroListProjectsInput> = {
    ...LIST_PROJECTS_DEF,
    execute: (input) => listProjectsImpl(liveProjectSource, input),
};

export const LIST_DOCUMENTS_TOOL: SharedToolDefinition<IntroListDocumentsInput> = {
    ...LIST_DOCUMENTS_DEF,
    execute: (input) => listDocumentsImpl(liveDocumentSource, input),
};

// ============================================================================
// §1.9  Workspace-level Todos — relocated to `cross-cutting-todo-tools.ts`.
//       Aliased here to keep the existing CHAT_ENHANCEMENT_TOOLS spread name.
// ============================================================================

export const WORKSPACE_TODO_LIST_TOOL = WORKSPACE_TODO_LIST_TOOL_NEW;

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
    ARCHIVE_TODOS_TOOL,
    DELETE_TODOS_TO_FILE_TOOL,
    LIST_QUESTS_TOOL,
    LIST_PROJECTS_TOOL,
    LIST_DOCUMENTS_TOOL,
    WORKSPACE_TODO_LIST_TOOL,
];
