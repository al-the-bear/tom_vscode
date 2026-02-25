import * as fs from 'fs';
import * as path from 'path';

/**
 * Todo item structure with headline and detailed description
 */
export interface TodoItem {
    id: number;
    title: string;
    description: string;
    status: 'not-started' | 'in-progress' | 'completed';
    createdAt: string;
    updatedAt: string;
}

/**
 * Result of a todo operation for logging
 */
export interface TodoOperationResult {
    operation: 'list' | 'add' | 'update' | 'remove' | 'clear';
    success: boolean;
    message: string;
    todos?: TodoItem[];
    affectedTodo?: TodoItem;
}

/**
 * Manages todo items for a chat session with persistence.
 * Todos are stored in _ai/tom_ai_chat/<chat-id>.todos.json
 */
export class TodoManager {
    private chatId: string;
    private dir: string;
    private todosPath: string;
    private todos: TodoItem[] = [];
    private nextId: number = 1;
    private onOperationCallback?: (result: TodoOperationResult) => void;

    constructor(chatId: string, dir: string) {
        this.chatId = chatId;
        this.dir = dir;
        this.todosPath = path.join(dir, `${chatId}.todos.json`);
        this.loadTodos();
    }

    /**
     * Set callback for when operations occur (for logging)
     */
    setOperationCallback(callback: (result: TodoOperationResult) => void): void {
        this.onOperationCallback = callback;
    }

    private loadTodos(): void {
        if (fs.existsSync(this.todosPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.todosPath, 'utf8'));
                this.todos = data.todos || [];
                this.nextId = data.nextId || 1;
            } catch {
                this.todos = [];
                this.nextId = 1;
            }
        }
    }

    private saveTodos(): void {
        fs.writeFileSync(this.todosPath, JSON.stringify({
            chatId: this.chatId,
            nextId: this.nextId,
            todos: this.todos
        }, null, 2), 'utf8');
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

    /**
     * List all todos or filter by status
     */
    list(status?: 'not-started' | 'in-progress' | 'completed'): TodoOperationResult {
        let filteredTodos = this.todos;
        if (status) {
            filteredTodos = this.todos.filter(t => t.status === status);
        }

        const result: TodoOperationResult = {
            operation: 'list',
            success: true,
            message: `Found ${filteredTodos.length} todo(s)${status ? ` with status '${status}'` : ''}`,
            todos: filteredTodos
        };
        this.notifyOperation(result);
        return result;
    }

    /**
     * Add a new todo item
     */
    add(title: string, description: string = ''): TodoOperationResult {
        const timestamp = this.formatTimestamp();
        const todo: TodoItem = {
            id: this.nextId++,
            title,
            description,
            status: 'not-started',
            createdAt: timestamp,
            updatedAt: timestamp
        };

        this.todos.push(todo);
        this.saveTodos();

        const result: TodoOperationResult = {
            operation: 'add',
            success: true,
            message: `Added todo #${todo.id}: "${title}"`,
            affectedTodo: todo,
            todos: this.todos
        };
        this.notifyOperation(result);
        return result;
    }

    /**
     * Update a todo item (title, description, or status)
     */
    update(id: number, updates: { title?: string; description?: string; status?: 'not-started' | 'in-progress' | 'completed' }): TodoOperationResult {
        const todo = this.todos.find(t => t.id === id);
        if (!todo) {
            const result: TodoOperationResult = {
                operation: 'update',
                success: false,
                message: `Todo #${id} not found`
            };
            this.notifyOperation(result);
            return result;
        }

        if (updates.title !== undefined) {
            todo.title = updates.title;
        }
        if (updates.description !== undefined) {
            todo.description = updates.description;
        }
        if (updates.status !== undefined) {
            todo.status = updates.status;
        }
        todo.updatedAt = this.formatTimestamp();

        this.saveTodos();

        const result: TodoOperationResult = {
            operation: 'update',
            success: true,
            message: `Updated todo #${id}: "${todo.title}" (status: ${todo.status})`,
            affectedTodo: todo,
            todos: this.todos
        };
        this.notifyOperation(result);
        return result;
    }

    /**
     * Remove a todo item by ID
     */
    remove(id: number): TodoOperationResult {
        const index = this.todos.findIndex(t => t.id === id);
        if (index === -1) {
            const result: TodoOperationResult = {
                operation: 'remove',
                success: false,
                message: `Todo #${id} not found`
            };
            this.notifyOperation(result);
            return result;
        }

        const removed = this.todos.splice(index, 1)[0];
        this.saveTodos();

        const result: TodoOperationResult = {
            operation: 'remove',
            success: true,
            message: `Removed todo #${id}: "${removed.title}"`,
            affectedTodo: removed,
            todos: this.todos
        };
        this.notifyOperation(result);
        return result;
    }

    /**
     * Clear all todos
     */
    clear(): TodoOperationResult {
        const count = this.todos.length;
        this.todos = [];
        this.saveTodos();

        const result: TodoOperationResult = {
            operation: 'clear',
            success: true,
            message: `Cleared ${count} todo(s)`,
            todos: []
        };
        this.notifyOperation(result);
        return result;
    }

    /**
     * Get summary for display
     */
    getSummary(): string {
        if (this.todos.length === 0) {
            return 'No todos.';
        }

        const notStarted = this.todos.filter(t => t.status === 'not-started').length;
        const inProgress = this.todos.filter(t => t.status === 'in-progress').length;
        const completed = this.todos.filter(t => t.status === 'completed').length;

        return `Todos: ${notStarted} not-started, ${inProgress} in-progress, ${completed} completed`;
    }

    /**
     * Format todos as markdown for response
     */
    formatAsMarkdown(): string {
        if (this.todos.length === 0) {
            return '**No todos.**';
        }

        const lines: string[] = ['**Current Todos:**', ''];
        for (const todo of this.todos) {
            const statusIcon = todo.status === 'completed' ? '✅' : 
                              todo.status === 'in-progress' ? '🔄' : '⬜';
            lines.push(`${statusIcon} **#${todo.id}** ${todo.title} _(${todo.status})_`);
            if (todo.description) {
                lines.push(`   ${todo.description}`);
            }
        }
        return lines.join('\n');
    }
}
