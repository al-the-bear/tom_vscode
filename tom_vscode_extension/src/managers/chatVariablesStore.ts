/**
 * ChatVariablesStore — singleton that holds current chat variable state,
 * emits change events, and persists to a YAML file of the window's workspace
 * on this machine, `_ai/chat_variables/<workspace>.<host>.chatvariable.yaml`.
 *
 * The file is named after the workspace (the `.code-workspace` stem, else the
 * first folder's name) — one window per workspace, so it is the window's —
 * and the host (`_ai` is shared by the fleet: another machine's window of the
 * workspace has its own file). It is kept when the window closes: a reload,
 * an extension install and a restart find the variables as they were.
 * Custom variables (run parameters such as `design-mode`, a reported `TODO`)
 * stay until written or deleted. Files of older builds were named per window
 * *session* (`<workspace>.<sessionId>.chatvariable.yaml`, a new id on every
 * reload, and deleted on close), which lost every custom variable on a
 * reload; a window without a file of its own starts from the newest of them.
 *
 * Runs (vscimpb43): the custom variables are a process run's parameters, so
 * each run of the quest (src/utils/processRuns.ts) has its own set. The
 * `default` run's set is the custom part of the file above; another run's is
 * `<workspace>.<host>.<run>.chatvariable.yaml` beside it. Which set reads and
 * writes go to: a run a caller names (`withRun`), else the run a queued
 * Proceed is sent for (processRunContext), else the window's run
 * (`setWindowRun`, kept by the ProcessStateStore). The built-in variables and
 * the change log stay one per window.
 *
 * All panels, tools, and LLM integrations read/write through this store so
 * values stay in sync across the extension.
 *
 * Spec reference: chat_enhancements.md §2
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import { hostSlugOf } from '../utils/hostSlug';
import { DEFAULT_RUN, normalizeRun } from '../utils/processRuns';
import { currentProcessRun } from '../services/processRunContext';

// ============================================================================
// Types
// ============================================================================

/** Identifies who triggered a variable change. */
export type ChangeSource = 'user' | 'localLlm' | 'copilot' | 'anthropic' | 'mcp';

/** A single entry in the change log. */
export interface ChangeLogEntry {
    timestamp: string; // ISO
    key: string;
    oldValue: unknown;
    newValue: unknown;
    source: ChangeSource;
    requestId?: string;
    /** A custom variable of a run other than `default`: that run. */
    run?: string;
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
    /** The run whose custom variables `custom` holds (snapshot() only; not written to the window file). */
    run?: string;
}

/**
 * Read-only variables another store supplies (the active quest's process
 * state, src/managers/processStateStore.ts). They read like built-ins —
 * `getRaw`, template values, `${name}` placeholders — but are written by
 * their owner, never through `set`.
 */
export interface DerivedVariableProvider {
    values(): Record<string, string>;
}

// ============================================================================
// Store
// ============================================================================

const MAX_CHANGE_LOG = 100;

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
    /** The `default` run's custom variables (the window file's `custom`). */
    private _custom: Record<string, string> = {};
    /** Other runs' custom variables, read from their files when first needed. */
    private _runSets = new Map<string, Record<string, string>>();
    /** The run this window works on (ProcessStateStore.currentRun). */
    private _windowRun = DEFAULT_RUN;
    /** A run a caller named for one synchronous call (withRun). */
    private _runOverride: string | undefined;
    private _changeLog: ChangeLogEntry[] = [];
    private _derived: DerivedVariableProvider[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<{ key: string; value: unknown }>();
    /** Fires whenever any variable changes. */
    readonly onDidChange: vscode.Event<{ key: string; value: unknown }> = this._onDidChange.event;

    private readonly filePath: string;

    private constructor(context: vscode.ExtensionContext) {
        this.filePath = this.resolveFilePath();
        context.subscriptions.push(this._onDidChange);
        this.takeOverLegacyFiles();
        this.restore();
        this.autoInitDefaults();
    }

    /** Tests only: forget the singleton, as a window reload does. */
    static resetForTests(): void {
        ChatVariablesStore._instance = undefined;
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

    get custom(): Readonly<Record<string, string>> { return { ...this.customSet() }; }

    // ----- runs ---------------------------------------------------------------

    /** The run reads and writes go to now: a named one, a queued Proceed's, else the window's. */
    get activeRun(): string {
        if (this._runOverride !== undefined) { return this._runOverride; }
        const sending = currentProcessRun();
        if (sending && sending.quest === this._quest) { return normalizeRun(sending.run); }
        return this._windowRun;
    }

    /** The run this window works on. */
    get windowRun(): string { return this._windowRun; }

    /** The window works on `run` now: its custom variables are the ones read and written (listeners are told). */
    setWindowRun(run: string): void {
        const name = normalizeRun(run);
        if (name === this._windowRun) { return; }
        this._windowRun = name;
        this._onDidChange.fire({ key: 'run', value: name });
    }

    /** `fn` with run `run`'s custom variables (synchronous: nothing else sees the switch). */
    withRun<T>(run: string | undefined, fn: () => T): T {
        const before = this._runOverride;
        this._runOverride = normalizeRun(run);
        try { return fn(); } finally { this._runOverride = before; }
    }

    /** The custom variables of `run` (the active one by default), loaded from its file when first needed. */
    private customSet(run: string = this.activeRun): Record<string, string> {
        if (run === DEFAULT_RUN) { return this._custom; }
        let set = this._runSets.get(run);
        if (!set) {
            const snap = FsUtils.safeReadYaml<{ custom?: Record<string, string> }>(this.runFilePath(run));
            set = snap?.custom && typeof snap.custom === 'object' ? { ...snap.custom } : {};
            this._runSets.set(run, set);
        }
        return set;
    }

    /** The file of run `run`'s custom variables (`default`: the window file). */
    runFilePath(run: string): string {
        const name = normalizeRun(run);
        return name === DEFAULT_RUN ? this.filePath : this.filePath.replace(/\.chatvariable\.yaml$/, `.${name}.chatvariable.yaml`);
    }

    /** A run was deleted: its custom variables and their file go (`default` has none of its own to delete). */
    deleteRunSet(run: string): void {
        const name = normalizeRun(run);
        if (name === DEFAULT_RUN) { return; }
        this._runSets.delete(name);
        try { fs.rmSync(this.runFilePath(name), { force: true }); } catch { /* already gone */ }
        if (this._windowRun === name) { this.setWindowRun(DEFAULT_RUN); }
    }

    get changeLog(): readonly ChangeLogEntry[] { return this._changeLog; }

    // ----- mutations ---------------------------------------------------------

    /**
     * Set a variable. Use this for programmatic updates with source tracking.
     */
    set(key: string, value: unknown, source: ChangeSource, requestId?: string): void {
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
                // Custom variable: the active run's.
                if (value === undefined || value === null || value === '') {
                    delete this.customSet()[key];
                } else {
                    this.customSet()[key] = String(value);
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
            ...(requestId ? { requestId } : {}),
            ...(this.isCustomKey(key) && this.activeRun !== DEFAULT_RUN ? { run: this.activeRun } : {}),
        });
        if (this._changeLog.length > MAX_CHANGE_LOG) {
            this._changeLog = this._changeLog.slice(-MAX_CHANGE_LOG);
        }

        this.persist();
        this._onDidChange.fire({ key, value: this.getRaw(key) });
    }

    /** Add a supplier of read-only variables; dispose to remove it. */
    registerDerivedVariables(provider: DerivedVariableProvider): vscode.Disposable {
        this._derived.push(provider);
        return { dispose: () => { this._derived = this._derived.filter((p) => p !== provider); } };
    }

    /** A supplier's values changed: tell the listeners (panels, editors). */
    notifyDerivedChange(key: string): void {
        this._onDidChange.fire({ key, value: this.getRaw(key) });
    }

    /** The supplied read-only variables, merged. */
    derivedValues(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const p of this._derived) {
            try { Object.assign(out, p.values()); } catch { /* a failing supplier supplies nothing */ }
        }
        return out;
    }

    /** Bulk-set custom variables (e.g. from an answer file). */
    setCustomBulk(values: Record<string, string>, source: ChangeSource, requestId?: string): void {
        for (const [k, v] of Object.entries(values)) {
            this.set(k, v, source, requestId);
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
            default: {
                const derived = this.derivedValues();
                if (key in derived) { return derived[key]; }
                return this.customSet()[key] ?? '';
            }
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
            ...this.derivedValues(),
        };
        for (const [k, v] of Object.entries(this.customSet())) {
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
        FsUtils.safeWriteYaml(this.filePath, snap);
        // Another run's custom variables: its own file (an empty set too, so a cleared run reads empty).
        const run = this.activeRun;
        if (run !== DEFAULT_RUN && this._runSets.has(run)) {
            FsUtils.safeWriteYaml(this.runFilePath(run), { run, custom: { ...this.customSet(run) } });
        }
    }

    private isCustomKey(key: string): boolean {
        return !['quest', 'role', 'activeProjects', 'todo', 'todoFile'].includes(key);
    }

    private restore(): void {
        const snap = FsUtils.safeReadYaml<ChatVariablesSnapshot>(this.filePath);
        if (!snap) { return; }
        this._quest = snap.quest ?? '';
        this._role = snap.role ?? '';
        this._activeProjects = snap.activeProjects ?? [];
        this._todo = snap.todo ?? '';
        this._todoFile = snap.todoFile ?? 'all';
        this._custom = snap.custom ?? {};
        this._changeLog = snap.changeLog ?? [];
    }

    /**
     * Derive defaults for `quest` and `role` on first open of a workspace.
     * Runs once after `restore()` and never overwrites a value that is
     * already set.
     */
    private autoInitDefaults(): void {
        if (!this._quest) {
            const derivedQuest = this.deriveQuestFromWorkspaceFile();
            if (derivedQuest) {
                this.set('quest', derivedQuest, 'user');
            }
        }
        if (!this._role) {
            this.set('role', 'default', 'user');
        }
    }

    /**
     * Spec §8.5: "same logic as `detectQuestFromWorkspace()` in
     * `chatPanel-handler.ts`". Derives the quest ID from the open
     * `.code-workspace` filename stem, but only returns it when a
     * matching `_ai/quests/{stem}/` folder actually exists — so
     * generic (non-quest) workspaces don't pick up a bogus value.
     */
    private deriveQuestFromWorkspaceFile(): string | null {
        const wsFile = vscode.workspace.workspaceFile?.fsPath;
        if (!wsFile || !wsFile.endsWith('.code-workspace')) {
            return null;
        }
        const stem = path.basename(wsFile, '.code-workspace');
        if (!stem) {
            return null;
        }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
            return null;
        }
        const questFolder = WsPaths.ai('quests', stem) || path.join(wsRoot, '_ai', 'quests', stem);
        return fs.existsSync(questFolder) ? stem : null;
    }

    private resolveFilePath(): string {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fallbackRoot = wsRoot ? path.join(wsRoot, '_ai') : path.join(process.cwd(), '_ai');
        const chatVarsDir = WsPaths.ai('chat_variables') ?? path.join(fallbackRoot, 'chat_variables');
        const wsFile = vscode.workspace.workspaceFile?.fsPath;
        const workspaceScopeRaw = wsFile
            ? path.basename(wsFile, path.extname(wsFile))
            : (vscode.workspace.workspaceFolders?.[0]?.name || 'workspace');
        return path.join(chatVarsDir, chatVariablesFileName(workspaceScopeRaw, hostSlugOf()));
    }

    /**
     * Without a file of its own yet, the window starts from the newest file an
     * older build wrote for this workspace (one per window session). They are
     * left where they are: `_ai` versions them, and removing them is not this
     * window's business.
     */
    private takeOverLegacyFiles(): void {
        try {
            if (fs.existsSync(this.filePath)) { return; }
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) { return; }
            const newest = legacyChatVariableFiles(fs.readdirSync(dir), workspaceScopeOf(path.basename(this.filePath)))
                .map((name) => path.join(dir, name))
                .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)[0];
            if (newest) { fs.copyFileSync(newest.file, this.filePath); }
        } catch {
            // The take-over is a convenience: a window without it starts empty, as before.
        }
    }

    /** Get a serialisable snapshot (for tests / debugging). */
    snapshot(): ChatVariablesSnapshot {
        return {
            quest: this._quest,
            role: this._role,
            activeProjects: [...this._activeProjects],
            todo: this._todo,
            todoFile: this._todoFile,
            custom: { ...this.customSet() },
            changeLog: [...this._changeLog],
            run: this.activeRun,
        };
    }
}

/** The file name of a workspace's chat variables on a host: `<workspace>.<host>.chatvariable.yaml` (unsafe characters as `_`). */
export function chatVariablesFileName(workspaceScope: string, host: string): string {
    const safe = (v: string): string => v.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${safe(workspaceScope)}.${safe(host)}.chatvariable.yaml`;
}

/** The workspace part of a chat-variables file name. */
function workspaceScopeOf(fileName: string): string {
    return fileName.split('.')[0];
}

/** A window session id as older builds wrote it into the name: a UUID followed by digits (`-` kept, unsafe characters `_`), or `window-<ms>`. */
const SESSION_ID_PART = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\d*|window-\d+)$/i;

/**
 * The files older builds wrote for workspace `scope`, one per window session:
 * `<workspace>.<sessionId>.chatvariable.yaml`. A host's file
 * (`<workspace>.<host>.chatvariable.yaml`) is not one of them.
 */
export function legacyChatVariableFiles(names: readonly string[], scope: string): string[] {
    const suffix = '.chatvariable.yaml';
    return names.filter((n) => n.startsWith(`${scope}.`) && n.endsWith(suffix)
        && SESSION_ID_PART.test(n.slice(scope.length + 1, -suffix.length)));
}
