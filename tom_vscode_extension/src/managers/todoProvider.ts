import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { EventEmitter } from 'vscode';
import { WsPaths } from '../utils/workspacePaths';
import {
    createTodoInFile,
    ensureTodoFile,
    findTodoByIdInFile,
    listTodoFiles,
    persistentTodoPath,
    readTodoFile,
    updateTodoInFile,
    type QuestTodoItem,
} from './questTodoManager';
import { WindowSessionTodoStore } from './windowSessionTodoStore';

export interface TodoInput {
    id?: string;
    title: string;
    description?: string;
    status?: 'not-started' | 'in-progress' | 'blocked' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'critical';
    tags?: string[];
}

export interface TodoFilter {
    status?: 'all' | 'not-started' | 'in-progress' | 'blocked' | 'completed' | 'cancelled';
    tags?: string[];
}

export interface TodoProviderOptions {
    scope: 'quest' | 'session' | 'workspace' | 'scratch';
    todoFile?: string;
    questId?: string;
    windowId?: string;
    autoDiscover?: boolean;
}

export class TodoProvider {
    private readonly options: TodoProviderOptions;
    private readonly _onDidChange = new EventEmitter<void>();

    constructor(options: TodoProviderOptions) {
        this.options = options;
    }

    get onDidChange(): vscode.Event<void> {
        return this._onDidChange.event;
    }

    async create(todo: TodoInput): Promise<QuestTodoItem> {
        if (this.options.scope === 'session') {
            const created = WindowSessionTodoStore.instance.add(todo.title, 'copilot', {
                details: todo.description,
                priority: todo.priority,
                tags: todo.tags,
            });
            this._onDidChange.fire();
            return {
                id: created.id,
                title: created.title,
                description: created.details ?? created.title,
                status: created.status === 'done' ? 'completed' : 'not-started',
                priority: created.priority,
                tags: created.tags,
            };
        }

        const filePath = this.resolveWriteFilePath();
        ensureTodoFile(filePath, this.options.questId ? { quest: this.options.questId } : undefined);
        const created = createTodoInFile(filePath, {
            id: todo.id ?? `todo-${Date.now()}`,
            title: todo.title,
            description: todo.description ?? todo.title,
            status: todo.status ?? 'not-started',
            priority: todo.priority,
            tags: todo.tags,
        }, this.options.questId ? { quest: this.options.questId } : undefined);
        this._onDidChange.fire();
        return created;
    }

    async update(id: string, changes: Partial<QuestTodoItem>): Promise<QuestTodoItem> {
        if (this.options.scope === 'session') {
            const updated = WindowSessionTodoStore.instance.update(id, {
                title: changes.title,
                details: changes.description,
                priority: changes.priority,
                status: changes.status === 'completed' ? 'done' : 'pending',
            });
            if (!updated) {
                throw new Error(`Todo not found: ${id}`);
            }
            this._onDidChange.fire();
            return {
                id: updated.id,
                title: updated.title,
                description: updated.details ?? updated.title,
                status: updated.status === 'done' ? 'completed' : 'not-started',
                priority: updated.priority,
                tags: updated.tags,
            };
        }

        const item = updateTodoInFile(this.resolveWriteFilePath(), id, {
            title: changes.title,
            description: changes.description,
            status: changes.status,
            priority: changes.priority,
            tags: changes.tags,
            notes: changes.notes,
        });
        if (!item) {
            throw new Error(`Todo not found: ${id}`);
        }
        this._onDidChange.fire();
        return item;
    }

    async delete(id: string): Promise<void> {
        if (this.options.scope === 'session') {
            WindowSessionTodoStore.instance.delete(id);
            this._onDidChange.fire();
            return;
        }

        updateTodoInFile(this.resolveWriteFilePath(), id, { status: 'cancelled' });
        this._onDidChange.fire();
    }

    async move(id: string, targetFile: string): Promise<void> {
        const source = await this.get(id);
        if (!source) {
            throw new Error(`Todo not found: ${id}`);
        }

        await this.delete(id);
        ensureTodoFile(targetFile, this.options.questId ? { quest: this.options.questId } : undefined);
        createTodoInFile(targetFile, {
            ...source,
            id: source.id,
        }, this.options.questId ? { quest: this.options.questId } : undefined);
        this._onDidChange.fire();
    }

    async get(id: string): Promise<QuestTodoItem | undefined> {
        if (this.options.scope === 'session') {
            const item = WindowSessionTodoStore.instance.get(id);
            if (!item) {
                return undefined;
            }
            return {
                id: item.id,
                title: item.title,
                description: item.details ?? item.title,
                status: item.status === 'done' ? 'completed' : 'not-started',
                priority: item.priority,
                tags: item.tags,
            };
        }

        const file = this.resolveWriteFilePath();
        return findTodoByIdInFile(file, id) ?? undefined;
    }

    async list(filter?: TodoFilter): Promise<QuestTodoItem[]> {
        if (this.options.scope === 'session') {
            const status = filter?.status === 'completed' ? 'done' : filter?.status === 'all' || !filter?.status ? 'all' : 'pending';
            return WindowSessionTodoStore.instance.list({ status }).map((item) => ({
                id: item.id,
                title: item.title,
                description: item.details ?? item.title,
                status: item.status === 'done' ? 'completed' : 'not-started',
                priority: item.priority,
                tags: item.tags,
            }));
        }

        const files = this.getFiles();
        const rows = files.flatMap((file) => readTodoFile(file));
        let out = rows;

        if (filter?.status && filter.status !== 'all') {
            out = out.filter((row) => row.status === filter.status);
        }
        if (filter?.tags && filter.tags.length > 0) {
            const wanted = new Set(filter.tags);
            out = out.filter((row) => (row.tags ?? []).some((tag) => wanted.has(tag)));
        }
        return out;
    }

    async getSummary(): Promise<string> {
        const todos = await this.list({ status: 'all' });
        const counts = {
            todo: todos.length,
            notStarted: todos.filter((t) => t.status === 'not-started').length,
            inProgress: todos.filter((t) => t.status === 'in-progress').length,
            completed: todos.filter((t) => t.status === 'completed').length,
        };
        return `Todos: ${counts.todo} total (${counts.notStarted} not-started, ${counts.inProgress} in-progress, ${counts.completed} completed)`;
    }

    async formatAsMarkdown(): Promise<string> {
        const todos = await this.list({ status: 'all' });
        if (todos.length === 0) {
            return '**No todos.**';
        }
        const lines: string[] = ['**Current Todos:**', ''];
        for (const todo of todos) {
            lines.push(`- ${todo.id}: ${todo.title ?? todo.description} (${todo.status})`);
        }
        return lines.join('\n');
    }

    getFiles(): string[] {
        if (this.options.todoFile) {
            return [this.options.todoFile];
        }
        if (this.options.scope === 'session') {
            return [WindowSessionTodoStore.instance.filePath];
        }
        if (this.options.scope === 'quest' && this.options.questId) {
            const folder = WsPaths.ai('quests', this.options.questId);
            if (!folder) {
                return [];
            }
            return listTodoFiles(this.options.questId).map((name) => path.join(folder, name));
        }
        if (this.options.scope === 'workspace' || this.options.autoDiscover) {
            const ids = this.options.questId ? [this.options.questId] : this.listQuestIds();
            return ids.map((id) => persistentTodoPath(id));
        }

        return [this.resolveWriteFilePath()];
    }

    findTodoFile(questId: string): string | undefined {
        const file = persistentTodoPath(questId);
        return file;
    }

    private resolveWriteFilePath(): string {
        if (this.options.todoFile) {
            return this.options.todoFile;
        }
        if (this.options.questId) {
            return persistentTodoPath(this.options.questId);
        }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return wsRoot ? path.join(wsRoot, 'workspace.todo.yaml') : 'workspace.todo.yaml';
    }

    private listQuestIds(): string[] {
        const questsRoot = WsPaths.ai('quests');
        if (!questsRoot || !fs.existsSync(questsRoot)) {
            return [];
        }

        return fs.readdirSync(questsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => name.trim().length > 0)
            .sort((a, b) => a.localeCompare(b));
    }
}
