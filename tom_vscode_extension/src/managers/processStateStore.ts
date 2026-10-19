/**
 * ProcessStateStore — the process the active quest follows and where it is.
 *
 * Definitions come from `_ai/processes/<id>/` and the state from
 * `_ai/quests/<quest>/process-state.<quest>.yaml` (src/utils/processRepository.ts):
 * the state belongs to the quest, so it is the same in every window and on
 * every machine, and switching the quest switches it. The store follows the
 * `quest` chat variable, watches both kinds of files (another window, an MCP
 * client or a hand edit may change them), and supplies the process chat
 * variables (`process`, `phase`, `step`, `substep`, their iterations and
 * descriptions) to ChatVariablesStore as read-only values.
 *
 * Moving to another step or sub-step also sets the `role` chat variable to the
 * role that step names, so the role description in the system prompt follows
 * the process.
 */

import * as vscode from 'vscode';

import { ChatVariablesStore, type ChangeSource } from './chatVariablesStore';
import { WsPaths } from '../utils/workspacePaths';
import { ProcessRepository, type ProcessEntry, type RepositoryResult } from '../utils/processRepository';
import {
    EMPTY_PROCESS_STATE,
    applyProcessChange,
    changeIteration,
    currentRole,
    normalizeState,
    roleAfterMove,
    processContextBlock,
    processVariableValues,
    type ProcessChange,
    type ProcessChangeResult,
    type ProcessDefinition,
    type ProcessLevel,
    type ProcessState,
    type ProcessVariableKey,
} from '../utils/processDefinition';

export class ProcessStateStore {
    private static _instance: ProcessStateStore | undefined;
    private static _resolveReady: (store: ProcessStateStore) => void = () => undefined;

    /**
     * Resolves once the store exists. Views are registered before activation
     * reaches the stores, so a view that is visible at startup waits on this.
     */
    static readonly ready: Promise<ProcessStateStore> = new Promise((resolve) => { ProcessStateStore._resolveReady = resolve; });

    static init(context: vscode.ExtensionContext): ProcessStateStore {
        if (!ProcessStateStore._instance) {
            ProcessStateStore._instance = new ProcessStateStore(context);
            ProcessStateStore._resolveReady(ProcessStateStore._instance);
        }
        return ProcessStateStore._instance;
    }

    /** The store, or undefined before activation (tests, early callers). */
    static get instance(): ProcessStateStore | undefined {
        return ProcessStateStore._instance;
    }

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /** Fires when a definition, the quest or its state changed. */
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    private entries: ProcessEntry[] = [];
    private quest = '';
    private rawState: ProcessState = { ...EMPTY_PROCESS_STATE };

    private constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(this._onDidChange);
        this.reload();
        const chat = ChatVariablesStore.instance;
        context.subscriptions.push(chat.registerDerivedVariables({ values: () => this.variables() }));
        context.subscriptions.push(chat.onDidChange((e) => {
            if (e.key === 'quest') { this.reload(); }
        }));
        const ws = WsPaths.wsRoot;
        if (ws) {
            const ai = WsPaths.aiFolder;
            for (const glob of [`${ai}/processes/**`, `${ai}/quests/*/process-state.*.yaml`]) {
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, glob));
                const onFile = (): void => this.reload();
                watcher.onDidCreate(onFile);
                watcher.onDidChange(onFile);
                watcher.onDidDelete(onFile);
                context.subscriptions.push(watcher);
            }
        }
    }

    private repo(): ProcessRepository | undefined {
        const processes = WsPaths.ai('processes');
        const quests = WsPaths.ai('quests');
        return processes && quests ? new ProcessRepository(processes, quests) : undefined;
    }

    /** Re-read definitions and the active quest's state, then tell listeners. */
    reload(): void {
        const repo = this.repo();
        this.entries = repo ? repo.list() : [];
        try { this.quest = ChatVariablesStore.instance.quest; } catch { this.quest = ''; }
        this.rawState = repo ? repo.readState(this.quest) : { ...EMPTY_PROCESS_STATE };
        this.fire();
    }

    private fire(): void {
        this._onDidChange.fire();
        try { ChatVariablesStore.instance.notifyDerivedChange('process'); } catch { /* not initialised */ }
    }

    /** Every process folder, valid or not. */
    list(): ProcessEntry[] {
        return this.entries;
    }

    definitions(): Map<string, ProcessDefinition> {
        const out = new Map<string, ProcessDefinition>();
        for (const e of this.entries) { if (e.definition) { out.set(e.id, e.definition); } }
        return out;
    }

    entry(id: string): ProcessEntry | undefined {
        return this.entries.find((e) => e.id === id);
    }

    /** The active quest; `''` when none. */
    get activeQuest(): string {
        return this.quest;
    }

    /** The current definition, when the quest has a process and it is valid. */
    currentDefinition(): ProcessDefinition | null {
        return this.entry(this.rawState.process)?.definition ?? null;
    }

    /** The quest's state, repaired against its definition when that was edited since. */
    get state(): ProcessState {
        const def = this.currentDefinition();
        return def ? normalizeState(this.rawState, def) : this.rawState;
    }

    /** The process chat variables. */
    variables(): Record<ProcessVariableKey, string> {
        const def = this.currentDefinition();
        return processVariableValues(def, this.state, this.entry(this.rawState.process)?.description ?? '');
    }

    /** The `${process-context}` block for the system prompt; `''` without a process. */
    contextBlock(): string {
        return processContextBlock(this.currentDefinition(), this.state, this.entry(this.rawState.process)?.description ?? '');
    }

    /** The role the current step names; `''` when none. */
    currentRole(): string {
        return currentRole(this.currentDefinition(), this.state);
    }

    /**
     * Change the quest's state (the PROCESS panel, `tomAi_setProcessState`).
     * Written to the quest's state file; a move to another step or sub-step
     * sets the `role` chat variable to the role it names.
     */
    apply(change: ProcessChange, source: ChangeSource): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const before = this.state;
        const result = applyProcessChange(before, this.definitions(), change);
        if (!result.ok) { return result; }
        return this.commit(repo, before, result.state, source);
    }

    /**
     * Step an iteration forward or back (the PROCESS panel's −/+). Forward
     * starts the next iteration, so what is inside it restarts.
     */
    stepIteration(level: ProcessLevel, delta: number, source: ChangeSource): ProcessChangeResult {
        const def = this.currentDefinition();
        if (!this.quest || !def) { return { ok: false, error: 'no process is set for the active quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const before = this.state;
        try {
            return this.commit(repo, before, changeIteration(before, def, level, delta), source);
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }

    private commit(repo: ProcessRepository, before: ProcessState, next: ProcessState, source: ChangeSource): ProcessChangeResult {
        const result: ProcessChangeResult = { ok: true, state: next };
        repo.writeState(this.quest, next);
        this.rawState = result.state;
        const role = roleAfterMove(before, result.state, this.currentDefinition());
        if (role) {
            try {
                const chat = ChatVariablesStore.instance;
                if (chat.role !== role) { chat.set('role', role, source); }
            } catch { /* not initialised */ }
        }
        this.fire();
        return result;
    }

    // ----- definitions (the process editor) ---------------------------------

    private edit(action: (repo: ProcessRepository) => RepositoryResult): RepositoryResult {
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const result = action(repo);
        this.reload();
        return result;
    }

    create(id: string, name?: string): RepositoryResult { return this.edit((r) => r.create(id, name)); }

    copy(fromId: string, toId: string): RepositoryResult { return this.edit((r) => r.copy(fromId, toId)); }

    save(def: ProcessDefinition, description: string): RepositoryResult { return this.edit((r) => r.save(def, description)); }
}
