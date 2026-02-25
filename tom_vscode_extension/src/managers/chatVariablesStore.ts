/**
 * ChatVariablesStore — singleton that holds current chat variable state,
 * emits change events, and persists to VS Code workspace state.
 *
 * All panels, tools, and LLM integrations read/write through this store so
 * values stay in sync across the extension.
 *
 * Spec reference: chat_enhancements.md §2
 */

import * as vscode from 'vscode';

// ============================================================================
// Types
// ============================================================================

/** Identifies who triggered a variable change. */
export type ChangeSource = 'user' | 'localLlm' | 'copilot' | 'tomAiChat';

/** A single entry in the change log. */
export interface ChangeLogEntry {
    timestamp: string; // ISO
    key: string;
    oldValue: unknown;
    newValue: unknown;
    source: ChangeSource;
}

/** Serialisable snapshot of the store (for workspace state). */
export interface ChatVariablesSnapshot {
    quest: string;
    role: string;
    activeProjects: string[];
    todo: string;         // todo ID or empty
    todoFile: string;     // selected file name or "all"
    custom: Record<string, string>;
    changeLog: ChangeLogEntry[];
}

// ============================================================================
// Store
// ============================================================================

const MAX_CHANGE_LOG = 100;
const WORKSPACE_STATE_KEY = 'chatVariablesStore';

/**
 * Singleton managing all chat variable state.
 * Create with `ChatVariablesStore.init(context)` at activation time.
 */
export class ChatVariablesStore {
    // ----- singleton ---------------------------------------------------------
    private static _instance: ChatVariablesStore | undefined;

    static get instance(): ChatVariablesStore {
        if (!ChatVariablesStore._instance) {
            throw new Error('ChatVariablesStore not initialised. Call ChatVariablesStore.init() first.');
        }
        return ChatVariablesStore._instance;
    }

    /** Call once from `activate()`. */
    static init(context: vscode.ExtensionContext): ChatVariablesStore {
        if (ChatVariablesStore._instance) { return ChatVariablesStore._instance; }
        ChatVariablesStore._instance = new ChatVariablesStore(context);
        return ChatVariablesStore._instance;
    }

    // ----- state -------------------------------------------------------------
    private _quest = '';
    private _role = '';
    private _activeProjects: string[] = [];
    private _todo = '';          // selected todo ID
    private _todoFile = 'all';  // selected todo file
    private _custom: Record<string, string> = {};
    private _changeLog: ChangeLogEntry[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<{ key: string; value: unknown }>();
    /** Fires whenever any variable changes. */
    readonly onDidChange: vscode.Event<{ key: string; value: unknown }> = this._onDidChange.event;

    private readonly context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        context.subscriptions.push(this._onDidChange);
        this.restore();
    }

    // ----- accessors ---------------------------------------------------------

    get quest(): string { return this._quest; }
    set quest(v: string) { this.set('quest', v, 'user'); }

    get role(): string { return this._role; }
    set role(v: string) { this.set('role', v, 'user'); }

    get activeProjects(): string[] { return [...this._activeProjects]; }
    setActiveProjects(v: string[], source: ChangeSource = 'user'): void {
        this.set('activeProjects', v, source);
    }

    get todo(): string { return this._todo; }
    set todo(v: string) { this.set('todo', v, 'user'); }

    get todoFile(): string { return this._todoFile; }
    set todoFile(v: string) { this.set('todoFile', v, 'user'); }

    get custom(): Readonly<Record<string, string>> { return { ...this._custom }; }

    get changeLog(): readonly ChangeLogEntry[] { return this._changeLog; }

    // ----- mutations ---------------------------------------------------------

    /**
     * Set a variable. Use this for programmatic updates with source tracking.
     */
    set(key: string, value: unknown, source: ChangeSource): void {
        const old = this.getRaw(key);

        // Apply
        switch (key) {
            case 'quest':      this._quest = String(value ?? ''); break;
            case 'role':       this._role = String(value ?? ''); break;
            case 'activeProjects':
                this._activeProjects = Array.isArray(value)
                    ? value.map(String) : [];
                break;
            case 'todo':       this._todo = String(value ?? ''); break;
            case 'todoFile':   this._todoFile = String(value ?? 'all'); break;
            default:
                // Custom variable
                if (value === undefined || value === null || value === '') {
                    delete this._custom[key];
                } else {
                    this._custom[key] = String(value);
                }
                break;
        }

        // Log
        this._changeLog.push({
            timestamp: new Date().toISOString(),
            key,
            oldValue: old,
            newValue: this.getRaw(key),
            source,
        });
        if (this._changeLog.length > MAX_CHANGE_LOG) {
            this._changeLog = this._changeLog.slice(-MAX_CHANGE_LOG);
        }

        this.persist();
        this._onDidChange.fire({ key, value: this.getRaw(key) });
    }

    /** Bulk-set custom variables (e.g. from an answer file). */
    setCustomBulk(values: Record<string, string>, source: ChangeSource): void {
        for (const [k, v] of Object.entries(values)) {
            this.set(k, v, source);
        }
    }

    /** Remove a custom variable. Built-in keys are reset to empty. */
    remove(key: string, source: ChangeSource = 'user'): void {
        this.set(key, '', source);
    }

    // ----- query -------------------------------------------------------------

    /** Get the raw value for a key. */
    getRaw(key: string): unknown {
        switch (key) {
            case 'quest':          return this._quest;
            case 'role':           return this._role;
            case 'activeProjects': return [...this._activeProjects];
            case 'todo':           return this._todo;
            case 'todoFile':       return this._todoFile;
            default:               return this._custom[key] ?? '';
        }
    }

    /** All variables as a flat Record<string, string> for template expansion. */
    toTemplateValues(): Record<string, string> {
        const out: Record<string, string> = {
            quest: this._quest,
            role: this._role,
            activeProjects: this._activeProjects.join(', '),
            todo: this._todo,
            todoFile: this._todoFile,
        };
        for (const [k, v] of Object.entries(this._custom)) {
            out[`custom.${k}`] = v;
        }
        return out;
    }

    // ----- persistence -------------------------------------------------------

    private persist(): void {
        const snap: ChatVariablesSnapshot = {
            quest: this._quest,
            role: this._role,
            activeProjects: this._activeProjects,
            todo: this._todo,
            todoFile: this._todoFile,
            custom: { ...this._custom },
            changeLog: this._changeLog,
        };
        this.context.workspaceState.update(WORKSPACE_STATE_KEY, snap);
    }

    private restore(): void {
        const snap = this.context.workspaceState.get<ChatVariablesSnapshot>(WORKSPACE_STATE_KEY);
        if (!snap) { return; }
        this._quest = snap.quest ?? '';
        this._role = snap.role ?? '';
        this._activeProjects = snap.activeProjects ?? [];
        this._todo = snap.todo ?? '';
        this._todoFile = snap.todoFile ?? 'all';
        this._custom = snap.custom ?? {};
        this._changeLog = snap.changeLog ?? [];
    }

    /** Get a serialisable snapshot (for tests / debugging). */
    snapshot(): ChatVariablesSnapshot {
        return {
            quest: this._quest,
            role: this._role,
            activeProjects: [...this._activeProjects],
            todo: this._todo,
            todoFile: this._todoFile,
            custom: { ...this._custom },
            changeLog: [...this._changeLog],
        };
    }
}
