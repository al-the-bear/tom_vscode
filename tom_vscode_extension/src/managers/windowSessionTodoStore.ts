/**
 * WindowSessionTodoStore — ephemeral, window-scoped todo list for LLMs.
 *
 * Allows an LLM to store and retrieve its own reminders during a session
 * so postponed tasks aren't lost when the context window rotates.
 *
 * Storage: quest session YAML file (*.todo.yaml), one file per window.
 *
 * Spec reference: chat_enhancements.md §1.4
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import type { ChangeSource } from './chatVariablesStore';
import {
    createTodoInFile,
    ensureTodoFile,
    findTodoByIdInFile,
    readTodoFile,
    sessionTodoFilename,
    updateTodoInFile,
} from './questTodoManager';

// ============================================================================
// Types
// ============================================================================

export interface WindowTodoItem {
    id: string;
    title: string;
    details?: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    tags: string[];
    status: 'pending' | 'done';
    createdAt: string;
    updatedAt: string;
    source: ChangeSource;
}

export interface WindowTodoSnapshot {
    todos: WindowTodoItem[];
    nextSeq: number;
}

// ============================================================================
// Store
// ============================================================================

function getWorkspaceQuestId(): string {
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    if (wsFile) {
        const base = path.basename(wsFile).replace(/\.code-workspace$/, '').trim();
        if (base) { return base; }
    }
    return 'incidents';
}

/**
 * Manages the window-scoped session todo list for LLMs.
 * Create once per window at activation time.
 */
export class WindowSessionTodoStore {
    private static _instance: WindowSessionTodoStore | undefined;

    static get instance(): WindowSessionTodoStore {
        if (!WindowSessionTodoStore._instance) {
            throw new Error('WindowSessionTodoStore not initialised. Call init() first.');
        }
        return WindowSessionTodoStore._instance;
    }

    static init(context: vscode.ExtensionContext, windowId: string): WindowSessionTodoStore {
        if (WindowSessionTodoStore._instance) { return WindowSessionTodoStore._instance; }
        WindowSessionTodoStore._instance = new WindowSessionTodoStore(context, windowId);
        return WindowSessionTodoStore._instance;
    }

    // ---- state ----
    private todos: WindowTodoItem[] = [];
    private nextSeq = 1;
    private readonly context: vscode.ExtensionContext;
    private readonly windowId: string;
    private readonly questId: string;
    private readonly sessionFilePath: string;

    /** The absolute path to the current session's YAML todo file. */
    get filePath(): string { return this.sessionFilePath; }

    /** The quest ID for this session. */
    get sessionQuestId(): string { return this.questId; }

    private constructor(context: vscode.ExtensionContext, windowId: string) {
        this.context = context;
        this.windowId = windowId;
        this.questId = getWorkspaceQuestId();
        this.sessionFilePath = this.resolveSessionFilePath();
        // Defer file creation: only restore if the file already exists.
        // The file is created lazily on the first add() call to avoid
        // polluting the quest folder with empty session todo files.
        this.restore();
    }

    private resolveSessionFilePath(): string {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
            throw new Error('No workspace folder available for session todos.');
        }
        const fileName = sessionTodoFilename(this.windowId);
        return WsPaths.ai('quests', this.questId, fileName) || path.join(wsRoot, '_ai', 'quests', this.questId, fileName);
    }

    private ensureSessionFile(): void {
        ensureTodoFile(this.sessionFilePath, { quest: this.questId });
    }

    private static fromYamlStatus(status: string | undefined): 'pending' | 'done' {
        if (status === 'completed' || status === 'cancelled') { return 'done'; }
        return 'pending';
    }

    private static toYamlStatus(status: 'pending' | 'done' | undefined): 'not-started' | 'completed' {
        return status === 'done' ? 'completed' : 'not-started';
    }

    private static toItem(todo: any): WindowTodoItem | null {
        if (!todo || !todo.id || todo.status === 'cancelled') { return null; }
        const nowIso = new Date().toISOString();
        const createdIso = (todo.created ? `${todo.created}T00:00:00.000Z` : nowIso);
        const updatedIso = (todo.updated ? `${todo.updated}T00:00:00.000Z` : createdIso);
        return {
            id: String(todo.id),
            title: String(todo.title || todo.description || todo.id),
            details: todo.description ? String(todo.description) : undefined,
            priority: (todo.priority === 'critical' || todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low') ? todo.priority : 'medium',
            tags: Array.isArray(todo.tags) ? todo.tags.map((t: unknown) => String(t)) : [],
            status: WindowSessionTodoStore.fromYamlStatus(todo.status),
            createdAt: createdIso,
            updatedAt: updatedIso,
            source: 'copilot',
        };
    }

    // ---- CRUD ----

    add(
        title: string,
        source: ChangeSource,
        opts?: { details?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; tags?: string[] },
    ): WindowTodoItem {
        // Lazily create the session file on first write
        this.ensureSessionFile();
        const id = `wt-${this.nextSeq++}`;
        const created = createTodoInFile(this.sessionFilePath, {
            id,
            title,
            description: opts?.details || title,
            status: 'not-started',
            priority: opts?.priority ?? 'medium',
            tags: opts?.tags ?? [],
        }, { quest: this.questId });
        const mapped = WindowSessionTodoStore.toItem(created)!;
        mapped.source = source;
        this.restore();
        return mapped;
    }

    list(filter?: { status?: 'pending' | 'done' | 'all'; tags?: string[] }): WindowTodoItem[] {
        let items = [...this.todos];
        if (filter?.status && filter.status !== 'all') {
            items = items.filter(t => t.status === filter.status);
        }
        if (filter?.tags && filter.tags.length > 0) {
            const tagSet = new Set(filter.tags);
            items = items.filter(t => t.tags.some(tag => tagSet.has(tag)));
        }
        return items;
    }

    getAll(): { todos: WindowTodoItem[]; count: number; pendingCount: number } {
        return {
            todos: [...this.todos],
            count: this.todos.length,
            pendingCount: this.todos.filter(t => t.status === 'pending').length,
        };
    }

    get(id: string): WindowTodoItem | undefined {
        const todo = findTodoByIdInFile(this.sessionFilePath, id);
        const mapped = WindowSessionTodoStore.toItem(todo);
        return mapped ?? undefined;
    }

    update(
        id: string,
        updates: { title?: string; details?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; status?: 'pending' | 'done' },
    ): WindowTodoItem | undefined {
        const updated = updateTodoInFile(this.sessionFilePath, id, {
            title: updates.title,
            description: updates.details,
            priority: updates.priority,
            status: WindowSessionTodoStore.toYamlStatus(updates.status),
        });
        this.restore();
        const mapped = WindowSessionTodoStore.toItem(updated);
        return mapped ?? undefined;
    }

    delete(id: string): boolean {
        const updated = updateTodoInFile(this.sessionFilePath, id, { status: 'cancelled' });
        this.restore();
        return !!updated;
    }

    // ---- persistence ----

    private persist(): void {
        // No-op for YAML backend; file operations persist immediately.
    }

    private restore(): void {
        const raw = readTodoFile(this.sessionFilePath);
        this.todos = raw
            .map(t => WindowSessionTodoStore.toItem(t))
            .filter((t): t is WindowTodoItem => !!t);

        let max = 0;
        for (const item of this.todos) {
            const m = item.id.match(/^wt-(\d+)$/);
            if (m) {
                const n = parseInt(m[1], 10);
                if (!Number.isNaN(n) && n > max) { max = n; }
            }
        }
        this.nextSeq = max + 1;
    }
}
