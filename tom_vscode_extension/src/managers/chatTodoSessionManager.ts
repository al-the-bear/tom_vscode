import * as path from 'path';
import { TodoProvider } from './todoProvider';

export interface TodoItem {
    id: number;
    title: string;
    description: string;
    status: 'not-started' | 'in-progress' | 'completed';
    createdAt: string;
    updatedAt: string;
}

export interface TodoOperationResult {
    operation: 'list' | 'add' | 'update' | 'remove' | 'clear';
    success: boolean;
    message: string;
    todos?: TodoItem[];
    affectedTodo?: TodoItem;
}

export class ChatTodoSessionManager {
    private readonly provider: TodoProvider;
    private readonly todosPath: string;
    private onOperationCallback?: (result: TodoOperationResult) => void;

    constructor(chatId: string, dir: string) {
        this.todosPath = path.join(dir, `${chatId}.todo.yaml`);
        this.provider = new TodoProvider({
            scope: 'scratch',
            todoFile: this.todosPath,
        });
    }

    setOperationCallback(callback: (result: TodoOperationResult) => void): void {
        this.onOperationCallback = callback;
    }

    private notifyOperation(result: TodoOperationResult): void {
        if (this.onOperationCallback) {
            this.onOperationCallback(result);
        }
    }

    private formatTimestamp(): string {
        const now = new Date();
        return now.toISOString();
    }

    async list(status?: 'not-started' | 'in-progress' | 'completed'): Promise<TodoOperationResult> {
        try {
            const rows = await this.provider.list(status ? { status } : { status: 'all' });
            const todos = rows.map((row, index) => this.mapProviderTodo(row, index + 1));
            const result: TodoOperationResult = {
                operation: 'list',
                success: true,
                message: `Found ${todos.length} todo(s)${status ? ` with status '${status}'` : ''}`,
                todos,
            };
            this.notifyOperation(result);
            return result;
        } catch (error) {
            const result: TodoOperationResult = {
                operation: 'list',
                success: false,
                message: `Error listing todos: ${error}`,
            };
            this.notifyOperation(result);
            return result;
        }
    }

    async add(title: string, description: string = ''): Promise<TodoOperationResult> {
        try {
            const existing = await this.provider.list({ status: 'all' });
            const nextId = existing
                .map((item) => this.parseTodoNumber(item.id))
                .reduce((max, value) => Math.max(max, value), 0) + 1;

            const created = await this.provider.create({
                id: `todo-${nextId}`,
                title,
                description,
                status: 'not-started',
            });

            const mapped = this.mapProviderTodo(created, nextId);
            const result: TodoOperationResult = {
                operation: 'add',
                success: true,
                message: `Added todo #${mapped.id}: "${title}"`,
                affectedTodo: mapped,
                todos: (await this.list()).todos,
            };
            this.notifyOperation(result);
            return result;
        } catch (error) {
            const result: TodoOperationResult = {
                operation: 'add',
                success: false,
                message: `Error adding todo: ${error}`,
            };
            this.notifyOperation(result);
            return result;
        }
    }

    async update(id: number, updates: { title?: string; description?: string; status?: 'not-started' | 'in-progress' | 'completed' }): Promise<TodoOperationResult> {
        try {
            const providerId = await this.resolveProviderId(id);
            if (!providerId) {
                const result: TodoOperationResult = {
                    operation: 'update',
                    success: false,
                    message: `Todo #${id} not found`,
                };
                this.notifyOperation(result);
                return result;
            }

            const updated = await this.provider.update(providerId, {
                title: updates.title,
                description: updates.description,
                status: updates.status,
            });

            const mapped = this.mapProviderTodo(updated, id);
            const result: TodoOperationResult = {
                operation: 'update',
                success: true,
                message: `Updated todo #${id}: "${mapped.title}" (status: ${mapped.status})`,
                affectedTodo: mapped,
                todos: (await this.list()).todos,
            };
            this.notifyOperation(result);
            return result;
        } catch (error) {
            const result: TodoOperationResult = {
                operation: 'update',
                success: false,
                message: `Error updating todo #${id}: ${error}`,
            };
            this.notifyOperation(result);
            return result;
        }
    }

    async remove(id: number): Promise<TodoOperationResult> {
        try {
            const providerId = await this.resolveProviderId(id);
            if (!providerId) {
                const result: TodoOperationResult = {
                    operation: 'remove',
                    success: false,
                    message: `Todo #${id} not found`,
                };
                this.notifyOperation(result);
                return result;
            }

            const found = await this.provider.get(providerId);
            await this.provider.delete(providerId);
            const mapped = found ? this.mapProviderTodo(found, id) : undefined;
            const result: TodoOperationResult = {
                operation: 'remove',
                success: true,
                message: mapped ? `Removed todo #${id}: "${mapped.title}"` : `Removed todo #${id}`,
                affectedTodo: mapped,
                todos: (await this.list()).todos,
            };
            this.notifyOperation(result);
            return result;
        } catch (error) {
            const result: TodoOperationResult = {
                operation: 'remove',
                success: false,
                message: `Error removing todo #${id}: ${error}`,
            };
            this.notifyOperation(result);
            return result;
        }
    }

    async clear(): Promise<TodoOperationResult> {
        try {
            const rows = await this.provider.list({ status: 'all' });
            for (const row of rows) {
                await this.provider.delete(row.id);
            }

            const result: TodoOperationResult = {
                operation: 'clear',
                success: true,
                message: `Cleared ${rows.length} todo(s)`,
                todos: [],
            };
            this.notifyOperation(result);
            return result;
        } catch (error) {
            const result: TodoOperationResult = {
                operation: 'clear',
                success: false,
                message: `Error clearing todos: ${error}`,
            };
            this.notifyOperation(result);
            return result;
        }
    }

    async getSummary(): Promise<string> {
        const listed = await this.list();
        const todos = listed.todos ?? [];
        if (todos.length === 0) {
            return 'No todos.';
        }

        const notStarted = todos.filter(t => t.status === 'not-started').length;
        const inProgress = todos.filter(t => t.status === 'in-progress').length;
        const completed = todos.filter(t => t.status === 'completed').length;

        return `Todos: ${notStarted} not-started, ${inProgress} in-progress, ${completed} completed`;
    }

    async formatAsMarkdown(): Promise<string> {
        const listed = await this.list();
        const todos = listed.todos ?? [];
        if (todos.length === 0) {
            return '**No todos.**';
        }

        const lines: string[] = ['**Current Todos:**', ''];
        for (const todo of todos) {
            const statusIcon = todo.status === 'completed' ? '✅'
                : todo.status === 'in-progress' ? '🔄' : '⬜';
            lines.push(`${statusIcon} **#${todo.id}** ${todo.title} _(${todo.status})_`);
            if (todo.description) {
                lines.push(`   ${todo.description}`);
            }
        }
        return lines.join('\n');
    }

    private mapProviderTodo(
        todo: { id: string; title?: string; description?: string; status?: string },
        fallbackId: number
    ): TodoItem {
        const id = this.parseTodoNumber(todo.id) || fallbackId;
        const status = todo.status === 'completed' || todo.status === 'in-progress'
            ? todo.status
            : 'not-started';
        const timestamp = this.formatTimestamp();
        return {
            id,
            title: todo.title ?? todo.description ?? `Todo ${id}`,
            description: todo.description ?? todo.title ?? '',
            status,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    }

    private parseTodoNumber(id: string): number {
        const prefixed = id.match(/^todo-(\d+)$/);
        if (prefixed) {
            return Number(prefixed[1]);
        }
        const plain = Number(id);
        return Number.isFinite(plain) ? plain : 0;
    }

    private async resolveProviderId(id: number): Promise<string | undefined> {
        const preferred = `todo-${id}`;
        const byPreferred = await this.provider.get(preferred);
        if (byPreferred) {
            return preferred;
        }

        const rows = await this.provider.list({ status: 'all' });
        return rows.find((row) => this.parseTodoNumber(row.id) === id)?.id;
    }
}
