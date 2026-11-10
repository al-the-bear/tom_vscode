/**
 * SessionTodoStore — the todos of a quest's sessions.
 *
 * A session todo belongs to ONE session: the small steps an agent notes for
 * itself while carrying out a quest todo, in the flow of that session (a
 * quest todo is a quest todo; this is not where they go). Each session keeps
 * its own file, `history/sessions/<session>/session-todos.todo.yaml`
 * (services/sessionTodoFiles.ts), unversioned and deleted with the session.
 *
 * Every method takes the session it works on; without one it is the session
 * the current tool call runs in (the active tool trail's), else the session
 * the SESSION TODOS view shows, else `default`.
 *
 * The former single file per machine and quest (`session-todo.<host>.<quest>.todo.yaml`,
 * and the per-window files before it) is taken over once: its open todos go
 * to `default`, and it is removed with its siblings.
 *
 * Spec reference: chat_enhancements.md §1.4
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { isSessionTodoFileName } from '../utils/sessionTodoNames';
import type { ChangeSource } from './chatVariablesStore';
import {
    createTodoInFile,
    ensureTodoFile,
    findTodoByIdInFile,
    listTodoFiles,
    readTodoFile,
    updateTodoInFile,
} from './questTodoManager';
import { sessionTodoCounts, sessionTodoFile, type SessionTodoCount } from '../services/sessionTodoFiles';
import { getActiveToolTrail } from '../services/tool-trail';
import { questHistoryRoot } from '../services/trailService';

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

    static init(_context?: vscode.ExtensionContext): SessionTodoStore {
        if (SessionTodoStore._instance) { return SessionTodoStore._instance; }
        SessionTodoStore._instance = new SessionTodoStore();
        return SessionTodoStore._instance;
    }

    private readonly questId: string;
    private readonly historyRoot: string;
    /** The session the SESSION TODOS view shows; the default of a call outside any session. */
    private viewSession = 'default';

    /** The quest ID for this window. */
    get sessionQuestId(): string { return this.questId; }

    /** The file of the session a call without one works on. */
    get filePath(): string { return this.filePathFor(); }

    private constructor() {
        this.questId = WsPaths.getWorkspaceQuestId();
        this.historyRoot = questHistoryRoot(this.questId);
        this.takeOverFormerFiles();
    }

    /** The session a call works on: the one named, else the tool call's, else the view's. */
    sessionOf(session?: string): string {
        if (session && session.trim()) { return session.trim(); }
        let caller: string | undefined;
        try { caller = getActiveToolTrail()?.session || undefined; } catch { caller = undefined; }
        return caller || this.viewSession || 'default';
    }

    /** The session the SESSION TODOS view shows (its switch sets it). */
    get shownSession(): string { return this.viewSession; }
    set shownSession(session: string) { this.viewSession = session || 'default'; }

    /** The todo file of `session` (default: {@link sessionOf}). */
    filePathFor(session?: string): string {
        return sessionTodoFile(this.historyRoot, this.sessionOf(session));
    }

    /** Every session with a session todo file and its counts, most recently written first. */
    counts(): SessionTodoCount[] {
        return sessionTodoCounts(this.historyRoot, (file) => readTodoFile(file).map((t) => String(t.status ?? 'not-started')));
    }

    /** The open (not done) todos of `session`. */
    openCount(session: string): number {
        return this.list({ status: 'pending' }, session).length;
    }

    /**
     * Take over the former per-machine file once: its open todos go to the
     * `default` session, then it and its siblings (and any older per-window
     * file) are removed.
     */
    private takeOverFormerFiles(): void {
        let former: string[] = [];
        try { former = listTodoFiles(this.questId).filter(isSessionTodoFileName); } catch { return; }
        if (!former.length) { return; }
        const questDir = WsPaths.ai('quests', this.questId) ?? path.dirname(this.historyRoot);
        for (const fileName of former) {
            const file = path.join(questDir, fileName);
            try {
                for (const t of readTodoFile(file)) {
                    if (!t || t.status === 'cancelled' || t.status === 'completed') { continue; }
                    this.add(String(t.title ?? t.description ?? t.id), 'copilot', {
                        details: t.description,
                        priority: t.priority,
                        tags: Array.isArray(t.tags) ? t.tags : [],
                    }, 'default');
                }
                fs.unlinkSync(file);
                const stem = fileName.split('.')[0];
                for (const sibling of [`${stem}-archived`, `${stem}-deleted`]) {
                    const siblingFile = path.join(questDir, [sibling, ...fileName.split('.').slice(1)].join('.'));
                    if (fs.existsSync(siblingFile)) { fs.unlinkSync(siblingFile); }
                }
                console.log(`[SessionTodo] Took over ${fileName}: its open todos are now the default session's`);
            } catch (e) {
                console.error(`[SessionTodo] Could not take over ${fileName}:`, e);
            }
        }
    }

    private ensureFile(file: string): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        ensureTodoFile(file, { quest: this.questId });
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

    private items(session?: string): SessionTodoItem[] {
        return readTodoFile(this.filePathFor(session))
            .map((t) => SessionTodoStore.toItem(t))
            .filter((t): t is SessionTodoItem => !!t);
    }

    /** The next `wt-<n>` id of a session's file. */
    private nextId(file: string): string {
        let max = 0;
        for (const t of readTodoFile(file)) {
            const m = String(t.id ?? '').match(/^wt-(\d+)$/);
            if (m) { max = Math.max(max, parseInt(m[1], 10)); }
        }
        return `wt-${max + 1}`;
    }

    // ---- CRUD ----

    add(
        title: string,
        source: ChangeSource,
        opts?: { details?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; tags?: string[]; status?: 'pending' | 'done' },
        session?: string,
    ): SessionTodoItem {
        const file = this.filePathFor(session);
        this.ensureFile(file);
        const created = createTodoInFile(file, {
            id: this.nextId(file),
            title,
            description: opts?.details || title,
            status: SessionTodoStore.toYamlStatus(opts?.status),
            priority: opts?.priority ?? 'medium',
            tags: opts?.tags ?? [],
        }, { quest: this.questId });
        const mapped = SessionTodoStore.toItem(created)!;
        mapped.source = source;
        return mapped;
    }

    list(filter?: { status?: 'pending' | 'done' | 'all'; tags?: string[] }, session?: string): SessionTodoItem[] {
        let items = this.items(session);
        if (filter?.status && filter.status !== 'all') {
            items = items.filter(t => t.status === filter.status);
        }
        if (filter?.tags && filter.tags.length > 0) {
            const tagSet = new Set(filter.tags);
            items = items.filter(t => t.tags.some(tag => tagSet.has(tag)));
        }
        return items;
    }

    getAll(session?: string): { todos: SessionTodoItem[]; count: number; pendingCount: number; session: string } {
        const todos = this.items(session);
        return {
            todos,
            count: todos.length,
            pendingCount: todos.filter(t => t.status === 'pending').length,
            session: this.sessionOf(session),
        };
    }

    get(id: string, session?: string): SessionTodoItem | undefined {
        const todo = findTodoByIdInFile(this.filePathFor(session), id);
        return SessionTodoStore.toItem(todo) ?? undefined;
    }

    update(
        id: string,
        updates: { title?: string; details?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; status?: 'pending' | 'done'; tags?: string[] },
        session?: string,
    ): SessionTodoItem | undefined {
        // A field the caller leaves out stays as it is — the status included:
        // mapping an absent status to `not-started` reopened a done todo on
        // every title or priority edit.
        const updated = updateTodoInFile(this.filePathFor(session), id, {
            title: updates.title,
            description: updates.details,
            priority: updates.priority,
            ...(updates.status !== undefined ? { status: SessionTodoStore.toYamlStatus(updates.status) } : {}),
            ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
        });
        return SessionTodoStore.toItem(updated) ?? undefined;
    }

    delete(id: string, session?: string): boolean {
        return !!updateTodoInFile(this.filePathFor(session), id, { status: 'cancelled' });
    }
}
