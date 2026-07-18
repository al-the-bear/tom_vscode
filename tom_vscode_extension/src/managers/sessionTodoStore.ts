/**
 * SessionTodoStore — session todo list for LLMs.
 *
 * Allows an LLM to store and retrieve its own reminders during a session
 * so postponed tasks aren't lost when the context window rotates.
 *
 * Storage (TRA04): ONE stable, git-tracked YAML file per host+quest —
 * `session-todo.<host>.<quest>.todo.yaml` in the quest folder — so session
 * todos survive window reloads and are shared between windows on the same
 * machine. Legacy per-window files (`{date}_{time}_win-*.todo.yaml`) are
 * merged into the stable file and removed on first access.
 *
 * Spec reference: chat_enhancements.md §1.4
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { isLegacySessionTodoFileName, sessionTodoFilename } from '../utils/sessionTodoNames';
import type { ChangeSource } from './chatVariablesStore';
import {
    createTodoInFile,
    ensureTodoFile,
    findTodoByIdInFile,
    listTodoFiles,
    readTodoFile,
    updateTodoInFile,
} from './questTodoManager';

// ============================================================================
// Types
// ============================================================================

export interface SessionTodoItem {
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

export interface SessionTodoSnapshot {
    todos: SessionTodoItem[];
    nextSeq: number;
}

// ============================================================================
// Store
// ============================================================================

/**
 * Manages the per-host per-quest session todo list for LLMs.
 * Create once per window at activation time; every window on the same
 * host+quest shares the same backing file.
 */
export class SessionTodoStore {
    private static _instance: SessionTodoStore | undefined;

    static get instance(): SessionTodoStore {
        if (!SessionTodoStore._instance) {
            throw new Error('SessionTodoStore not initialised. Call init() first.');
        }
        return SessionTodoStore._instance;
    }

    static init(context: vscode.ExtensionContext): SessionTodoStore {
        if (SessionTodoStore._instance) { return SessionTodoStore._instance; }
        SessionTodoStore._instance = new SessionTodoStore(context);
        return SessionTodoStore._instance;
    }

    // ---- state ----
    private todos: SessionTodoItem[] = [];
    private nextSeq = 1;
    private readonly context: vscode.ExtensionContext;
    private readonly questId: string;
    private readonly sessionFilePath: string;

    /** The absolute path to the current session's YAML todo file. */
    get filePath(): string { return this.sessionFilePath; }

    /** The quest ID for this session. */
    get sessionQuestId(): string { return this.questId; }

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.questId = WsPaths.getWorkspaceQuestId();
        this.sessionFilePath = this.resolveSessionFilePath();
        // One-time lazy migration of legacy per-window files (TRA04).
        this.migrateLegacySessionFiles();
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
        const fileName = sessionTodoFilename(WsPaths.hostSlug(), this.questId);
        return WsPaths.ai('quests', this.questId, fileName) || path.join(wsRoot, '_ai', 'quests', this.questId, fileName);
    }

    /**
     * Merge todos from legacy per-window session files
     * (`{date}_{time}_win-*.todo.yaml`) into the stable per-host file, then
     * remove the legacy files. Cancelled todos (the old soft-delete) are
     * dropped; surviving todos get fresh sequential `wt-N` ids so ids from
     * different windows cannot collide.
     */
    private migrateLegacySessionFiles(): void {
        try {
            const legacyFiles = listTodoFiles(this.questId).filter(isLegacySessionTodoFileName);
            if (!legacyFiles.length) { return; }
            const questDir = path.dirname(this.sessionFilePath);

            // Continue numbering after whatever the stable file already holds.
            let seq = 0;
            for (const t of readTodoFile(this.sessionFilePath)) {
                const m = String(t.id ?? '').match(/^wt-(\d+)$/);
                if (m) { seq = Math.max(seq, parseInt(m[1], 10)); }
            }

            for (const fileName of legacyFiles) {
                const legacyPath = path.join(questDir, fileName);
                try {
                    for (const t of readTodoFile(legacyPath)) {
                        if (!t || t.status === 'cancelled') { continue; }
                        this.ensureSessionFile();
                        createTodoInFile(this.sessionFilePath, {
                            id: `wt-${++seq}`,
                            title: t.title ?? t.description ?? t.id,
                            description: t.description ?? t.title ?? '',
                            status: t.status ?? 'not-started',
                            priority: t.priority ?? 'medium',
                            tags: Array.isArray(t.tags) ? t.tags : [],
                        }, { quest: this.questId });
                    }
                    fs.unlinkSync(legacyPath);
                    console.log(`[SessionTodo] Migrated legacy session file ${fileName} into ${path.basename(this.sessionFilePath)}`);
                } catch (e) {
                    // Leave an unreadable legacy file in place; it stays
                    // visible via the legacy-name detection and can be
                    // migrated on a later activation.
                    console.error(`[SessionTodo] Failed to migrate ${fileName}:`, e);
                }
            }
        } catch (e) {
            console.error('[SessionTodo] Legacy session file migration failed:', e);
        }
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

    private static toItem(todo: any): SessionTodoItem | null {
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
            status: SessionTodoStore.fromYamlStatus(todo.status),
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
    ): SessionTodoItem {
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
        const mapped = SessionTodoStore.toItem(created)!;
        mapped.source = source;
        this.restore();
        return mapped;
    }

    list(filter?: { status?: 'pending' | 'done' | 'all'; tags?: string[] }): SessionTodoItem[] {
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

    getAll(): { todos: SessionTodoItem[]; count: number; pendingCount: number } {
        return {
            todos: [...this.todos],
            count: this.todos.length,
            pendingCount: this.todos.filter(t => t.status === 'pending').length,
        };
    }

    get(id: string): SessionTodoItem | undefined {
        const todo = findTodoByIdInFile(this.sessionFilePath, id);
        const mapped = SessionTodoStore.toItem(todo);
        return mapped ?? undefined;
    }

    update(
        id: string,
        updates: { title?: string; details?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; status?: 'pending' | 'done' },
    ): SessionTodoItem | undefined {
        const updated = updateTodoInFile(this.sessionFilePath, id, {
            title: updates.title,
            description: updates.details,
            priority: updates.priority,
            status: SessionTodoStore.toYamlStatus(updates.status),
        });
        this.restore();
        const mapped = SessionTodoStore.toItem(updated);
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
            .map(t => SessionTodoStore.toItem(t))
            .filter((t): t is SessionTodoItem => !!t);

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
