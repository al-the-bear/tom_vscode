/**
 * Tom Scripting API Bridge Handler
 *
 * Handles bridge requests from Dart scripts for:
 * - todo.* - TODO CRUD operations
 * - queue.* - Prompt queue operations  
 * - timed.* - Timed request operations
 * - doc.* - Document access operations
 * - workspace.* - Workspace/project/quest operations
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import * as questTodo from '../managers/questTodoManager.js';
import { SessionTodoStore } from '../managers/sessionTodoStore.js';
import { PromptQueueManager, QueuedPrompt } from '../managers/promptQueueManager';
import { TimerEngine, TimedRequest, ScheduledTime } from '../managers/timerEngine';
import { ChatVariablesStore } from '../managers/chatVariablesStore.js';
import { scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';

// ============================================================================
// Singleton Manager
// ============================================================================

let _instance: TomScriptingBridgeHandler | undefined;
let _ctx: vscode.ExtensionContext | undefined;

export function initTomScriptingBridgeHandler(ctx: vscode.ExtensionContext): void {
    _ctx = ctx;
    _instance = new TomScriptingBridgeHandler(ctx);
}

export function getTomScriptingBridgeHandler(): TomScriptingBridgeHandler | undefined {
    return _instance;
}

// ============================================================================
// Handler Class
// ============================================================================

export class TomScriptingBridgeHandler {
    private ctx: vscode.ExtensionContext;

    constructor(ctx: vscode.ExtensionContext) {
        this.ctx = ctx;
    }

    /**
     * Handle bridge requests from Dart scripts.
     * Routes to appropriate handler based on method prefix.
     */
    async handleBridgeRequest(method: string, params: any): Promise<any> {
        if (method.startsWith('todo.')) {
            return this.handleTodoRequest(method, params);
        }
        if (method.startsWith('queue.')) {
            return this.handleQueueRequest(method, params);
        }
        if (method.startsWith('timed.')) {
            return this.handleTimedRequest(method, params);
        }
        if (method.startsWith('doc.')) {
            return this.handleDocRequest(method, params);
        }
        if (method.startsWith('workspace.')) {
            return this.handleWorkspaceRequest(method, params);
        }
        throw new Error(`Unknown Tom scripting method: ${method}`);
    }

    // ========================================================================
    // TODO Handlers
    // ========================================================================

    private async handleTodoRequest(method: string, params: any): Promise<any> {
        switch (method) {
            // Quest TODO operations
            case 'todo.listFilesVce':
                return this.todoListFiles(params.questId);
            case 'todo.listQuestVce':
                return this.todoListQuest(params.questId, params.file);
            case 'todo.getQuestVce':
                return this.todoGetQuest(params.questId, params.todoId, params.file);
            case 'todo.createQuestVce':
                return this.todoCreateQuest(params.questId, params.todo, params.file);
            case 'todo.updateQuestVce':
                return this.todoUpdateQuest(params.questId, params.todo, params.file);
            case 'todo.deleteQuestVce':
                return this.todoDeleteQuest(params.questId, params.todoId, params.file);

            // Workspace TODO operations
            case 'todo.listWorkspaceFilesVce':
                return this.todoListWorkspaceFiles();
            case 'todo.listWorkspaceVce':
                return this.todoListWorkspace(params.file);
            case 'todo.getWorkspaceVce':
                return this.todoGetWorkspace(params.todoId, params.file);
            case 'todo.createWorkspaceVce':
                return this.todoCreateWorkspace(params.todo, params.file);
            case 'todo.updateWorkspaceVce':
                return this.todoUpdateWorkspace(params.todo, params.file);
            case 'todo.deleteWorkspaceVce':
                return this.todoDeleteWorkspace(params.todoId, params.file);

            // Session TODO operations
            case 'todo.listSessionVce':
                return this.todoListSession();
            case 'todo.getSessionVce':
                return this.todoGetSession(params.todoId);
            case 'todo.createSessionVce':
                return this.todoCreateSession(params.todo);
            case 'todo.updateSessionVce':
                return this.todoUpdateSession(params.todo);
            case 'todo.deleteSessionVce':
                return this.todoDeleteSession(params.todoId);

            // Combined query
            case 'todo.listAllVce':
                return this.todoListAll(params);

            default:
                throw new Error(`Unknown todo method: ${method}`);
        }
    }

    private async todoListFiles(questId: string): Promise<any> {
        const files = questTodo.listTodoFiles(questId);
        return { files, questId };
    }

    private async todoListQuest(questId: string, file?: string): Promise<any> {
        if (file) {
            const todos = questTodo.readTodoFile(file);
            return { todos, questId, file };
        }
        const todos = questTodo.readAllTodos(questId);
        return { todos, questId };
    }

    private async todoGetQuest(questId: string, todoId: string, file?: string): Promise<any> {
        const todos = file
            ? questTodo.readTodoFile(file)
            : questTodo.readAllTodos(questId);
        const todo = todos.find((t: any) => t.id === todoId);
        return todo || null;
    }

    private async todoCreateQuest(questId: string, todo: any, file?: string): Promise<any> {
        const targetFile = file || questTodo.persistentTodoPath(questId);
        const created = questTodo.createTodoInFile(targetFile, todo, { quest: questId });
        return created;
    }

    private async todoUpdateQuest(questId: string, todo: any, file?: string): Promise<any> {
        const targetFile = file || questTodo.persistentTodoPath(questId);
        const updated = questTodo.updateTodoInFile(targetFile, todo.id, todo);
        if (!updated) {
            throw new Error(`Todo not found: ${todo.id}`);
        }
        return updated;
    }

    private async todoDeleteQuest(questId: string, todoId: string, file?: string): Promise<any> {
        const targetFile = file || questTodo.persistentTodoPath(questId);
        const success = questTodo.deleteTodo(questId, todoId, targetFile);
        return { success };
    }

    private async todoListWorkspaceFiles(): Promise<any> {
        const files = questTodo.listWorkspaceTodoFiles();
        return { files };
    }

    private async todoListWorkspace(file?: string): Promise<any> {
        const todos = questTodo.readWorkspaceTodos();
        // If a specific file is requested, filter to that file's todos
        if (file) {
            const fileTodos = questTodo.readTodoFile(file);
            return { todos: fileTodos, file };
        }
        return { todos };
    }

    private async todoGetWorkspace(todoId: string, file?: string): Promise<any> {
        const todos = questTodo.readWorkspaceTodos();
        const todo = todos.find((t: any) => t.id === todoId);
        return todo || null;
    }

    private async todoCreateWorkspace(todo: any, file?: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const targetFile = file || path.join(wsRoot, 'workspace.todo.yaml');
        const created = questTodo.createTodoInFile(targetFile, todo, {});
        return created;
    }

    private async todoUpdateWorkspace(todo: any, file?: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const targetFile = file || path.join(wsRoot, 'workspace.todo.yaml');
        const updated = questTodo.updateTodoInFile(targetFile, todo.id, todo);
        if (!updated) {
            throw new Error(`Todo not found: ${todo.id}`);
        }
        return updated;
    }

    private async todoDeleteWorkspace(todoId: string, file?: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const targetFile = file || path.join(wsRoot, 'workspace.todo.yaml');
        let todos = questTodo.readTodoFile(targetFile);
        const idx = todos.findIndex((t: any) => t.id === todoId);
        if (idx < 0) {
            return { success: false };
        }
        // Use updateTodoInFile with cancelled status since there's no direct delete
        questTodo.updateTodoInFile(targetFile, todoId, { status: 'cancelled' });
        return { success: true };
    }

    private async todoListSession(): Promise<any> {
        const store = SessionTodoStore.instance;
        const result = store.getAll();
        return { todos: result.todos, count: result.count, pendingCount: result.pendingCount };
    }

    private async todoGetSession(todoId: string): Promise<any> {
        const store = SessionTodoStore.instance;
        const todo = store.get(todoId);
        return todo || null;
    }

    private async todoCreateSession(todo: any): Promise<any> {
        const store = SessionTodoStore.instance;
        const created = store.add(todo.title || todo.description, 'copilot', {
            details: todo.details || todo.description,
            priority: todo.priority,
            tags: todo.tags,
        });
        return created;
    }

    private async todoUpdateSession(todo: any): Promise<any> {
        const store = SessionTodoStore.instance;
        const updated = store.update(todo.id, {
            title: todo.title,
            details: todo.details,
            priority: todo.priority,
            status: todo.status,
        });
        return updated || null;
    }

    private async todoDeleteSession(todoId: string): Promise<any> {
        const store = SessionTodoStore.instance;
        const success = store.delete(todoId);
        return { success };
    }

    private async todoListAll(params: any): Promise<any> {
        const todos: any[] = [];

        if (params.includeQuest) {
            const questId = params.questId || WsPaths.getWorkspaceQuestId();
            if (questId && questId !== 'default') {
                const questTodos = questTodo.readAllTodos(questId);
                todos.push(...questTodos.map((t: any) => ({ ...t, _scope: 'quest' })));
            }
        }

        if (params.includeWorkspace) {
            const wsTodos = questTodo.readWorkspaceTodos();
            todos.push(...wsTodos.map((t: any) => ({ ...t, _scope: 'workspace' })));
        }

        if (params.includeSession) {
            const store = SessionTodoStore.instance;
            const result = store.getAll();
            todos.push(...result.todos.map((t: any) => ({ ...t, _scope: 'session' })));
        }

        return { todos };
    }

    // ========================================================================
    // Queue Handlers
    // ========================================================================

    private async handleQueueRequest(method: string, params: any): Promise<any> {
        const qm = PromptQueueManager.instance;

        switch (method) {
            case 'queue.listVce': {
                const items = [...qm.items];
                const pending = items.filter(i => i.status !== 'sent');
                const sent = items.filter(i => i.status === 'sent');
                return {
                    items: params.includeSent ? items : pending,
                    totalCount: items.length,
                    pendingCount: pending.length,
                    sentCount: sent.length,
                };
            }

            case 'queue.getVce': {
                const item = qm.getById(params.itemId);
                return item || null;
            }

            case 'queue.addVce': {
                const item = await qm.enqueue({
                    originalText: params.promptText,
                    template: params.template || '(None)',
                    answerWrapper: params.answerWrapper,
                    reminderEnabled: params.reminderEnabled,
                    reminderTemplateId: params.reminderTemplateId,
                    reminderTimeoutMinutes: params.reminderTimeoutMinutes,
                    reminderRepeat: params.reminderRepeat,
                });
                return item;
            }

            case 'queue.removeVce': {
                qm.remove(params.itemId);
                return { success: true };
            }

            case 'queue.clearPendingVce': {
                const items = [...qm.items].filter(i => i.status !== 'sent');
                let count = 0;
                for (const item of items) {
                    qm.remove(item.id);
                    count++;
                }
                return { removedCount: count };
            }

            case 'queue.clearSentVce': {
                const items = [...qm.items].filter(i => i.status === 'sent');
                let count = 0;
                for (const item of items) {
                    qm.remove(item.id);
                    count++;
                }
                return { removedCount: count };
            }

            case 'queue.updateStatusVce': {
                const success = qm.setStatus(params.itemId, params.status);
                const item = qm.getById(params.itemId);
                return item || null;
            }

            case 'queue.updateTextVce': {
                await qm.updateText(params.itemId, params.text);
                const item = qm.getById(params.itemId);
                return item || null;
            }

            case 'queue.updateReminderVce': {
                qm.updateItemReminder(params.itemId, {
                    reminderEnabled: params.enabled,
                    reminderTemplateId: params.templateId,
                    reminderTimeoutMinutes: params.timeoutMinutes,
                    reminderRepeat: params.repeat,
                });
                const item = qm.getById(params.itemId);
                return item || null;
            }

            case 'queue.moveToVce': {
                // moveTo is not directly supported - use move('up'/'down') multiple times
                // For now, just return the current position
                return { success: false, reason: 'moveTo not supported, use moveUp/moveDown' };
            }

            case 'queue.moveUpVce': {
                qm.move(params.itemId, 'up');
                return { success: true };
            }

            case 'queue.moveDownVce': {
                qm.move(params.itemId, 'down');
                return { success: true };
            }

            case 'queue.addFollowUpVce': {
                const followUp = qm.addFollowUpPrompt(params.itemId, {
                    originalText: params.promptText,
                    template: params.template,
                    reminderEnabled: params.reminderEnabled,
                    reminderTemplateId: params.reminderTemplateId,
                    reminderTimeoutMinutes: params.reminderTimeoutMinutes,
                    reminderRepeat: params.reminderRepeat,
                });
                return followUp;
            }

            case 'queue.removeFollowUpVce': {
                const success = qm.removeFollowUpPrompt(params.itemId, params.followUpId);
                return { success };
            }

            case 'queue.updateFollowUpVce': {
                const success = qm.updateFollowUpPrompt(params.itemId, params.followUpId, {
                    originalText: params.text,
                    template: params.template,
                    reminderEnabled: params.reminderEnabled,
                    reminderTemplateId: params.reminderTemplateId,
                    reminderTimeoutMinutes: params.reminderTimeoutMinutes,
                    reminderRepeat: params.reminderRepeat,
                });
                return { success };
            }

            case 'queue.sendNextVce': {
                // Send the first pending item
                const pending = [...qm.items].find(i => i.status === 'pending' || i.status === 'staged');
                if (pending) {
                    await qm.sendNow(pending.id);
                    return { sent: true, itemId: pending.id };
                }
                return { sent: false };
            }

            case 'queue.pauseVce': {
                // Pause/resume is not a built-in feature of PromptQueueManager
                // Could be implemented via a separate flag
                return { success: false, reason: 'pause not implemented' };
            }

            case 'queue.resumeVce': {
                return { success: false, reason: 'resume not implemented' };
            }

            case 'queue.isPausedVce': {
                return { paused: false };
            }

            default:
                throw new Error(`Unknown queue method: ${method}`);
        }
    }

    // ========================================================================
    // Timed Request Handlers
    // ========================================================================

    private async handleTimedRequest(method: string, params: any): Promise<any> {
        const te = TimerEngine.instance;

        switch (method) {
            case 'timed.listVce': {
                const entries = [...te.entries];
                const active = entries.filter(e => e.enabled && e.status === 'active');
                const paused = entries.filter(e => !e.enabled || e.status === 'paused');
                return {
                    entries,
                    totalCount: entries.length,
                    activeCount: active.length,
                    pausedCount: paused.length,
                    timerActivated: te.timerActivated,
                };
            }

            case 'timed.getVce': {
                const entry = te.getEntry(params.entryId);
                return entry || null;
            }

            case 'timed.createVce': {
                const entry = te.addEntry({
                    enabled: true,
                    template: params.template || '(None)',
                    answerWrapper: params.answerWrapper,
                    originalText: params.promptText,
                    scheduleMode: params.scheduleMode || 'interval',
                    intervalMinutes: params.intervalMinutes,
                    scheduledTimes: params.scheduledTimes,
                    reminderEnabled: params.reminderEnabled,
                    reminderTemplateId: params.reminderTemplateId,
                    reminderTimeoutMinutes: params.reminderTimeoutMinutes,
                    reminderRepeat: params.reminderRepeat,
                });
                return entry;
            }

            case 'timed.updateVce': {
                const updates: Partial<TimedRequest> = {};
                if (params.promptText !== undefined) { updates.originalText = params.promptText; }
                if (params.template !== undefined) { updates.template = params.template; }
                if (params.answerWrapper !== undefined) { updates.answerWrapper = params.answerWrapper; }
                if (params.scheduleMode !== undefined) { updates.scheduleMode = params.scheduleMode; }
                if (params.intervalMinutes !== undefined) { updates.intervalMinutes = params.intervalMinutes; }
                if (params.scheduledTimes !== undefined) { updates.scheduledTimes = params.scheduledTimes; }
                if (params.reminderEnabled !== undefined) { updates.reminderEnabled = params.reminderEnabled; }
                if (params.reminderTemplateId !== undefined) { updates.reminderTemplateId = params.reminderTemplateId; }
                if (params.reminderTimeoutMinutes !== undefined) { updates.reminderTimeoutMinutes = params.reminderTimeoutMinutes; }
                if (params.reminderRepeat !== undefined) { updates.reminderRepeat = params.reminderRepeat; }
                if (params.enabled !== undefined) { updates.enabled = params.enabled; }
                te.updateEntry(params.entryId, updates);
                return te.getEntry(params.entryId) || null;
            }

            case 'timed.deleteVce': {
                te.removeEntry(params.entryId);
                return { success: true };
            }

            case 'timed.enableVce': {
                te.updateEntry(params.entryId, { enabled: true });
                return te.getEntry(params.entryId) || null;
            }

            case 'timed.disableVce': {
                te.updateEntry(params.entryId, { enabled: false });
                return te.getEntry(params.entryId) || null;
            }

            case 'timed.isActivatedVce': {
                return { activated: te.timerActivated };
            }

            case 'timed.activateVce': {
                te.timerActivated = true;
                return { success: true };
            }

            case 'timed.deactivateVce': {
                te.timerActivated = false;
                return { success: true };
            }

            case 'timed.triggerCheckVce': {
                // Manual trigger is not directly supported by TimerEngine
                // The timer runs automatically at CHECK_INTERVAL_MS
                return { processedCount: 0, reason: 'manual trigger not supported' };
            }

            default:
                throw new Error(`Unknown timed method: ${method}`);
        }
    }

    // ========================================================================
    // Document Handlers
    // ========================================================================

    private async handleDocRequest(method: string, params: any): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        switch (method) {
            case 'doc.listVce': {
                const folderPath = this.getDocFolderPath(params.folder, params.subfolder);
                return this.listDocuments(folderPath, params.pattern, params.recursive);
            }

            case 'doc.readVce': {
                return this.readDocument(params.path);
            }

            case 'doc.writeVce': {
                return this.writeDocument(params.path, params.content);
            }

            case 'doc.deleteVce': {
                return this.deleteDocument(params.path);
            }

            case 'doc.existsVce': {
                const exists = fs.existsSync(params.path);
                return { exists };
            }

            case 'doc.listPromptsVce': {
                const promptDir = WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
                return this.listDocuments(promptDir, params.pattern, false);
            }

            case 'doc.readPromptVce': {
                const promptDir = WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
                const filePath = path.join(promptDir, params.filename);
                return this.readDocument(filePath);
            }

            case 'doc.createPromptVce': {
                const promptDir = WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
                const filename = params.filename || `prompt_${Date.now()}.md`;
                const filePath = path.join(promptDir, filename);
                await this.writeDocument(filePath, params.content);
                return { path: filePath };
            }

            case 'doc.listAnswersVce': {
                const answersDir = WsPaths.ai('answers') || path.join(wsRoot, '_ai', 'answers');
                const searchDir = params.subfolder ? path.join(answersDir, params.subfolder) : answersDir;
                return this.listDocuments(searchDir, params.pattern, false);
            }

            case 'doc.readAnswerVce': {
                return this.readDocument(params.path);
            }

            case 'doc.listTrailVce': {
                return this.listTrailEntries(params.questId, params.limit, params.since);
            }

            case 'doc.getTrailEntryVce': {
                return this.getTrailEntry(params.entryId);
            }

            case 'doc.findTrailByRequestIdVce': {
                return this.findTrailByRequestId(params.requestId);
            }

            case 'doc.listGuidelinesVce': {
                return this.listGuidelines(params.category);
            }

            case 'doc.readGuidelineVce': {
                return this.readGuideline(params.name);
            }

            case 'doc.listNotesVce': {
                const notesDir = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
                return this.listDocuments(notesDir, params.pattern, false);
            }

            case 'doc.readNoteVce': {
                const notesDir = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
                const filePath = path.join(notesDir, params.filename);
                return this.readDocument(filePath);
            }

            case 'doc.writeNoteVce': {
                const notesDir = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
                const filePath = path.join(notesDir, params.filename);
                return this.writeDocument(filePath, params.content);
            }

            case 'doc.listQuestDocsVce': {
                const questDir = WsPaths.ai('quests', params.questId) || path.join(wsRoot, '_ai', 'quests', params.questId);
                return this.listDocuments(questDir, params.pattern, false);
            }

            case 'doc.readQuestDocVce': {
                const questDir = WsPaths.ai('quests', params.questId) || path.join(wsRoot, '_ai', 'quests', params.questId);
                const filePath = path.join(questDir, params.filename);
                return this.readDocument(filePath);
            }

            case 'doc.writeQuestDocVce': {
                const questDir = WsPaths.ai('quests', params.questId) || path.join(wsRoot, '_ai', 'quests', params.questId);
                const filePath = path.join(questDir, params.filename);
                return this.writeDocument(filePath, params.content);
            }

            default:
                throw new Error(`Unknown doc method: ${method}`);
        }
    }

    private getDocFolderPath(folder: string, subfolder?: string): string {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        let basePath: string;

        switch (folder) {
            case 'prompt':
                basePath = WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
                break;
            case 'answers':
                basePath = WsPaths.ai('answers') || path.join(wsRoot, '_ai', 'answers');
                break;
            case 'notes':
                basePath = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
                break;
            case 'trail':
                basePath = WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
                break;
            case 'guidelines':
                basePath = path.join(wsRoot, '_copilot_guidelines');
                break;
            case 'quest':
                basePath = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
                break;
            case 'clarifications':
                basePath = WsPaths.ai('clarifications') || path.join(wsRoot, '_ai', 'clarifications');
                break;
            case 'bot_conversations':
                basePath = WsPaths.ai('bot_conversations') || path.join(wsRoot, '_ai', 'bot_conversations');
                break;
            case 'send_to_chat':
                basePath = WsPaths.ai('send_to_chat') || path.join(wsRoot, '_ai', 'send_to_chat');
                break;
            default:
                basePath = path.join(wsRoot, '_ai', folder);
        }

        if (subfolder) {
            basePath = path.join(basePath, subfolder);
        }

        return basePath;
    }

    private async listDocuments(dirPath: string, pattern?: string, recursive?: boolean): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const documents: any[] = [];

        if (!fs.existsSync(dirPath)) {
            return { documents, folder: dirPath };
        }

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(wsRoot, fullPath);

            if (pattern) {
                const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
                if (!regex.test(entry.name)) { continue; }
            }

            const stat = fs.statSync(fullPath);
            documents.push({
                name: entry.name,
                path: fullPath,
                relativePath,
                isDirectory: entry.isDirectory(),
                size: entry.isDirectory() ? undefined : stat.size,
                modified: stat.mtime.toISOString(),
                created: stat.birthtime.toISOString(),
            });

            if (recursive && entry.isDirectory()) {
                const subDocs = await this.listDocuments(fullPath, pattern, true);
                documents.push(...subDocs.documents);
            }
        }

        return { documents, folder: dirPath };
    }

    private async readDocument(filePath: string): Promise<any> {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);

        return {
            path: filePath,
            content,
            encoding: 'utf-8',
            size: stat.size,
            modified: stat.mtime.toISOString(),
        };
    }

    private async writeDocument(filePath: string, content: string): Promise<any> {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
    }

    private async deleteDocument(filePath: string): Promise<any> {
        if (!fs.existsSync(filePath)) {
            return { success: false };
        }

        fs.unlinkSync(filePath);
        return { success: true };
    }

    private async listTrailEntries(questId?: string, limit?: number, since?: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const trailDir = WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
        const entries: any[] = [];

        if (!fs.existsSync(trailDir)) {
            return { entries, totalCount: 0, questId };
        }

        const files = fs.readdirSync(trailDir).filter(f => f.endsWith('.yaml') || f.endsWith('.json'));
        
        for (const file of files.slice(0, limit || 100)) {
            const filePath = path.join(trailDir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                // Parse trail entry (simplified - actual implementation would parse YAML/JSON)
                entries.push({
                    id: path.basename(file, path.extname(file)),
                    promptFile: file,
                    timestamp: fs.statSync(filePath).mtime.toISOString(),
                });
            } catch (e) {
                // Skip invalid files
            }
        }

        return { entries, totalCount: entries.length, questId };
    }

    private async getTrailEntry(entryId: string): Promise<any> {
        // Simplified - would search trail files for matching entry
        return null;
    }

    private async findTrailByRequestId(requestId: string): Promise<any> {
        // Simplified - would search trail files for matching request ID
        return null;
    }

    private async listGuidelines(category?: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const guidelinesDir = path.join(wsRoot, '_copilot_guidelines');
        const guidelines: any[] = [];
        const categories = new Set<string>();

        if (!fs.existsSync(guidelinesDir)) {
            return { guidelines, categories: [] };
        }

        const processDir = (dirPath: string, cat?: string) => {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const relativePath = path.relative(wsRoot, fullPath);

                if (entry.isDirectory()) {
                    categories.add(entry.name);
                    if (!category || category === entry.name) {
                        processDir(fullPath, entry.name);
                    }
                } else if (entry.name.endsWith('.md')) {
                    if (!category || category === cat) {
                        guidelines.push({
                            name: entry.name,
                            path: fullPath,
                            relativePath,
                            category: cat,
                        });
                    }
                }
            }
        };

        processDir(guidelinesDir);

        return { guidelines, categories: Array.from(categories) };
    }

    private async readGuideline(name: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const guidelinesDir = path.join(wsRoot, '_copilot_guidelines');

        // First try direct match
        let filePath = path.join(guidelinesDir, name);
        if (!name.endsWith('.md')) {
            filePath += '.md';
        }

        if (fs.existsSync(filePath)) {
            return this.readDocument(filePath);
        }

        // Search in subdirectories
        const subdirs = ['dart', 'cloud', 'd4rt'];
        for (const subdir of subdirs) {
            const subPath = path.join(guidelinesDir, subdir, name.endsWith('.md') ? name : `${name}.md`);
            if (fs.existsSync(subPath)) {
                return this.readDocument(subPath);
            }
        }

        throw new Error(`Guideline not found: ${name}`);
    }

    // ========================================================================
    // Workspace Handlers
    // ========================================================================

    private async handleWorkspaceRequest(method: string, params: any): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        switch (method) {
            case 'workspace.getInfoVce': {
                return this.getWorkspaceInfo();
            }

            case 'workspace.getRootPathVce': {
                return { rootPath: wsRoot };
            }

            case 'workspace.getWindowIdVce': {
                const windowId = vscode.env.sessionId;
                return { windowId };
            }

            case 'workspace.listProjectsVce': {
                return this.listProjects(params.type, params.includeSubWorkspaces);
            }

            case 'workspace.getProjectVce': {
                return this.getProject(params.projectId);
            }

            case 'workspace.findProjectsVce': {
                return this.findProjects(params.pattern);
            }

            case 'workspace.listQuestsVce': {
                return this.listQuests(params.includeTodoCounts);
            }

            case 'workspace.getQuestVce': {
                return this.getQuest(params.questId);
            }

            case 'workspace.getActiveQuestVce': {
                const questId = WsPaths.getWorkspaceQuestId();
                if (questId === 'default') { return null; }
                return this.getQuest(questId);
            }

            case 'workspace.setActiveQuestVce': {
                // Quest is determined by workspace file - this is now a no-op
                return { success: false, message: 'Quest is determined by the .code-workspace filename' };
            }

            case 'workspace.listChatVariablesVce': {
                return this.listChatVariables();
            }

            case 'workspace.getChatVariableVce': {
                const value = ChatVariablesStore.instance?.getRaw(params.name);
                return value !== undefined ? { name: params.name, value } : null;
            }

            case 'workspace.setChatVariableVce': {
                ChatVariablesStore.instance?.set(params.name, params.value, 'copilot');
                return { success: true };
            }

            case 'workspace.getConfigVce': {
                const config = vscode.workspace.getConfiguration(params.section);
                const configObj: Record<string, any> = {};
                // Get all top-level keys for the section
                for (const key of Object.keys(config)) {
                    if (typeof config[key] !== 'function') {
                        configObj[key] = config.get(key);
                    }
                }
                return { config: configObj };
            }

            case 'workspace.updateConfigVce': {
                const config = vscode.workspace.getConfiguration(params.section);
                for (const [key, value] of Object.entries(params.values)) {
                    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
                }
                return { success: true };
            }

            default:
                throw new Error(`Unknown workspace method: ${method}`);
        }
    }

    private async getWorkspaceInfo(): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const wsFile = vscode.workspace.workspaceFile?.fsPath;
        const questIds = questTodo.listQuestIds();
        const projects = await scanWorkspaceProjectsByDetectors();
        const activeQuest = WsPaths.getWorkspaceQuestId();
        const windowId = vscode.env.sessionId;

        return {
            name: vscode.workspace.name || path.basename(wsRoot),
            rootPath: wsRoot,
            workspaceFile: wsFile,
            projectCount: projects.length,
            questCount: questIds.length,
            activeQuestId: activeQuest,
            windowId,
        };
    }

    private async listProjects(type?: string, includeSubWorkspaces?: boolean): Promise<any> {
        const projects = await scanWorkspaceProjectsByDetectors();
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        // DetectedWorkspaceProject has: name, relativePath, absolutePath, attributes, detectorNames
        const mapped = projects
            .filter(p => {
                if (!type) return true;
                // Check if any detector matches the type
                return p.detectorNames.includes(type) || 
                       p.attributes['type']?.includes(type);
            })
            .map(p => ({
                id: p.name,
                name: p.name,
                path: p.absolutePath,
                relativePath: p.relativePath,
                type: p.detectorNames[0] || 'other',
                detectors: p.detectorNames,
                attributes: p.attributes,
                isSubWorkspace: p.attributes['subWorkspace']?.includes('true') ?? false,
            }));

        return {
            projects: includeSubWorkspaces === false
                ? mapped.filter(p => !p.isSubWorkspace)
                : mapped,
            totalCount: mapped.length,
        };
    }

    private async getProject(projectId: string): Promise<any> {
        const projects = await scanWorkspaceProjectsByDetectors();
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        const project = projects.find(p => p.name === projectId);
        if (!project) { return null; }

        return {
            id: project.name,
            name: project.name,
            path: project.absolutePath,
            relativePath: project.relativePath,
            type: project.detectorNames[0] || 'other',
            detectors: project.detectorNames,
            attributes: project.attributes,
            isSubWorkspace: project.attributes['subWorkspace']?.includes('true') ?? false,
        };
    }

    private async findProjects(pattern: string): Promise<any> {
        const projects = await scanWorkspaceProjectsByDetectors();
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');

        const filtered = projects
            .filter(p => regex.test(p.name) || regex.test(p.absolutePath))
            .map(p => ({
                id: p.name,
                name: p.name,
                path: p.absolutePath,
                relativePath: p.relativePath,
                type: p.detectorNames[0] || 'other',
                detectors: p.detectorNames,
                attributes: p.attributes,
                isSubWorkspace: p.attributes['subWorkspace']?.includes('true') ?? false,
            }));

        return { projects: filtered, totalCount: filtered.length };
    }

    private async listQuests(includeTodoCounts?: boolean): Promise<any> {
        const questIds = questTodo.listQuestIds();
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const activeQuest = WsPaths.getWorkspaceQuestId();
        const quests: any[] = [];

        for (const questId of questIds) {
            const questDir = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
            const overviewPath = path.join(questDir, `overview.${questId}.md`);
            const hasOverview = fs.existsSync(overviewPath);
            const todoFiles = questTodo.listTodoFiles(questId);
            const hasTodos = todoFiles.length > 0;

            let todoCount: number | undefined;
            let completedTodoCount: number | undefined;

            if (includeTodoCounts && hasTodos) {
                try {
                    const todos = questTodo.readAllTodos(questId);
                    todoCount = todos.length;
                    completedTodoCount = todos.filter((t: any) => t.status === 'completed').length;
                } catch { /* ignore */ }
            }

            quests.push({
                id: questId,
                name: questId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                path: questDir,
                hasOverview,
                hasTodos,
                todoCount,
                completedTodoCount,
            });
        }

        return { quests, totalCount: quests.length, activeQuestId: activeQuest };
    }

    private async getQuest(questId: string): Promise<any> {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questDir = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);

        if (!fs.existsSync(questDir)) {
            return null;
        }

        const overviewPath = path.join(questDir, `overview.${questId}.md`);
        const hasOverview = fs.existsSync(overviewPath);
        const todoFiles = questTodo.listTodoFiles(questId);
        const hasTodos = todoFiles.length > 0;

        let todoCount: number | undefined;
        let completedTodoCount: number | undefined;

        if (hasTodos) {
            try {
                const todos = questTodo.readAllTodos(questId);
                todoCount = todos.length;
                completedTodoCount = todos.filter((t: any) => t.status === 'completed').length;
            } catch { /* ignore */ }
        }

        return {
            id: questId,
            name: questId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            path: questDir,
            hasOverview,
            hasTodos,
            todoCount,
            completedTodoCount,
        };
    }

    private async listChatVariables(): Promise<any> {
        const store = ChatVariablesStore.instance;
        if (!store) {
            return { variables: [] };
        }

        const variables: any[] = [];
        const snap = store.snapshot();
        // Add built-in variables
        variables.push({ name: 'quest', value: snap.quest });
        variables.push({ name: 'role', value: snap.role });
        variables.push({ name: 'activeProjects', value: snap.activeProjects.join(', ') });
        variables.push({ name: 'todo', value: snap.todo });
        variables.push({ name: 'todoFile', value: snap.todoFile });
        // Add custom variables
        for (const [name, value] of Object.entries(snap.custom)) {
            variables.push({ name: `custom.${name}`, value });
        }

        return { variables, activeQuestId: snap.quest };
    }
}
