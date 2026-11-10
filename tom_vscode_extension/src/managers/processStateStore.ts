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
 *
 * Runs (vscimpb29, src/utils/processRuns.ts): a quest may hold several process
 * positions, each a run with a state file of its own. The window works on one
 * run at a time — its current run, kept per window and quest (`default` until
 * another is selected) and offered as the `run` chat variable; every read and
 * move goes to that run's file. {@link withRun} works on another run for one
 * call (a tool naming a run, a queued Proceed of another run).
 */

import * as vscode from 'vscode';

import { ChatVariablesStore, type ChangeSource } from './chatVariablesStore';
import { WsPaths } from '../utils/workspacePaths';
import { ProcessRepository, type ProcessEntry, type RepositoryResult } from '../utils/processRepository';
import { currentProcessRun } from '../services/processRunContext';
import { DEFAULT_RUN, normalizeRun, runNameError } from '../utils/processRuns';
import type { ProcessRunEntry } from '../utils/processRepository';
import * as fs from 'fs';
import * as path from 'path';
import { decisionsJournalHeader } from '../utils/decisionsJournalFormat';
import { positionText } from '../utils/processActionPrompt';
import {
    abortedLevelJournalEntry,
    checkNestedStart,
    endNestedLevel,
    checkSuggestions,
    ioVariables,
    levelOutputs,
    mergeSuggestions,
    parentProcessLines,
    positionProcessLists,
    type SuggestionInput,
    pushNestedLevel,
    setLevelOutputs,
    topLevel,
} from '../utils/processStack';
import {
    EMPTY_PROCESS_STATE,
    applyProcessChange,
    availableMoves,
    conditionLookup,
    judgedLevelAt,
    passExcluded,
    type ConditionOptions,
    changeIteration,
    currentRole,
    effectiveSession,
    normalizeState,
    samePosition,
    type ProcessSession,
    trackStepIterations,
    roleAfterMove,
    processContextBlock,
    processVariableValues,
    type ProcessChange,
    type ProcessChangeResult,
    type ProcessDefinition,
    type ProcessLevel,
    type ProcessMove,
    type ProcessMoveKind,
    type NestedFollowUp,
    type NestedKind,
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
    /** The run this window works on (DEFAULT_RUN unless another was selected for the quest). */
    private run = DEFAULT_RUN;
    private readonly context: vscode.ExtensionContext;
    private rawState: ProcessState = { ...EMPTY_PROCESS_STATE };
    /** The quest's process stack, bottom first; its top is `rawState`. */
    private rawLevels: ProcessState[] = [{ ...EMPTY_PROCESS_STATE }];

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
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
        // The window's run of this quest; a run deleted meanwhile (another window) falls back to `default`.
        const chosen = normalizeRun(this.context.workspaceState?.get<string>(runStateKey(this.quest)));
        this.run = repo && this.quest && repo.hasRun(this.quest, chosen) ? chosen : DEFAULT_RUN;
        this.rawLevels = repo ? repo.readStateStack(this.quest, this.run).levels : [{ ...EMPTY_PROCESS_STATE }];
        this.rawState = topLevel(this.rawLevels);
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

    // ----- runs (vscimpb29) ---------------------------------------------------

    /** The run this window works on. */
    get currentRun(): string {
        return this.run;
    }

    /** The quest's runs, the last changed first, each with its process and position. */
    runs(): Array<ProcessRunEntry & { process: string; position: string; levels: number; current: boolean }> {
        const repo = this.repo();
        if (!repo || !this.quest) { return []; }
        return repo.listRuns(this.quest).map((r) => {
            const levels = repo.readStateStack(this.quest, r.run).levels;
            const top = topLevel(levels);
            return { ...r, process: top.process, position: top.process ? this.positionOf(top) : '', levels: levels.length, current: r.run === this.run };
        });
    }

    /** Work on `run` in this window from now on (it must exist; `default` always does). */
    selectRun(run: string): ProcessChangeResult {
        const repo = this.repo();
        if (!repo || !this.quest) { return { ok: false, error: 'no quest is active; runs belong to a quest' }; }
        const name = normalizeRun(run);
        if (!repo.hasRun(this.quest, name)) { return { ok: false, error: `the quest ${this.quest} has no run "${name}"`, ...this.knownRuns(repo) }; }
        void this.context.workspaceState?.update(runStateKey(this.quest), name);
        this.reload();
        return { ok: true, state: this.state };
    }

    /**
     * A new run of the quest: its state file, at the first position of
     * `process` when given (any process, also another than the other runs'),
     * else with no process yet. Selected in this window unless `select` is false.
     */
    createRun(run: string, process: string | undefined, source: ChangeSource, select = true): ProcessChangeResult {
        const repo = this.repo();
        if (!repo || !this.quest) { return { ok: false, error: 'no quest is active; runs belong to a quest' }; }
        const error = runNameError(run);
        if (error) { return { ok: false, error }; }
        if (repo.hasRun(this.quest, run)) { return { ok: false, error: `the quest ${this.quest} has a run "${run}" already` }; }
        repo.writeStateStack(this.quest, [{ ...EMPTY_PROCESS_STATE }], run);
        if (process) {
            const set = this.withRun(run, () => this.apply({ process }, source));
            if (!set.ok) { repo.deleteRun(this.quest, run); return set; }
        }
        return select ? this.selectRun(run) : { ok: true, state: repo.readState(this.quest, run) };
    }

    /** Delete runs of the quest (`default` is refused); a deleted current run leaves this window on `default`. */
    deleteRuns(runs: readonly string[]): { ok: true; deleted: string[] } | { ok: false; error: string } {
        const repo = this.repo();
        if (!repo || !this.quest) { return { ok: false, error: 'no quest is active; runs belong to a quest' }; }
        const names = runs.map(normalizeRun);
        if (names.includes(DEFAULT_RUN)) { return { ok: false, error: 'the run "default" cannot be deleted' }; }
        const missing = names.filter((n) => !repo.hasRun(this.quest, n));
        if (missing.length) { return { ok: false, error: `the quest ${this.quest} has no run ${missing.map((m) => `"${m}"`).join(', ')}; nothing was deleted` }; }
        for (const n of names) { repo.deleteRun(this.quest, n); }
        if (names.includes(this.run)) { void this.context.workspaceState?.update(runStateKey(this.quest), DEFAULT_RUN); }
        this.reload();
        return { ok: true, deleted: names };
    }

    /**
     * Do `fn` on `run` instead of the window's run (a tool naming a run, a
     * queued Proceed of another run): its reads and moves go to that run's
     * file; the window's run is back afterwards. Synchronous, so nothing else
     * sees the swap. An unknown run is refused before `fn` runs.
     */
    withRun<T extends ProcessChangeResult | object>(run: string | undefined, fn: () => T): T | { ok: false; error: string } {
        const name = normalizeRun(run);
        if (name === this.run) { return fn(); }
        const repo = this.repo();
        if (!repo || !this.quest) { return { ok: false, error: 'no quest is active; runs belong to a quest' }; }
        if (!repo.hasRun(this.quest, name)) { return { ok: false, error: `the quest ${this.quest} has no run "${name}"`, ...this.knownRuns(repo) }; }
        const own = this.run;
        this.run = name;
        this.rawLevels = repo.readStateStack(this.quest, name).levels;
        this.rawState = topLevel(this.rawLevels);
        try {
            return fn();
        } finally {
            this.run = own;
            this.reload();
        }
    }

    private knownRuns(repo: ProcessRepository): { runs: string[] } {
        return { runs: repo.listRuns(this.quest).map((r) => r.run) };
    }

    /** The current definition, when the quest has a process and it is valid. */
    currentDefinition(): ProcessDefinition | null {
        return this.entry(this.rawState.process)?.definition ?? null;
    }

    /** The quest's state — the top level of its stack — repaired against its definition when that was edited since. */
    get state(): ProcessState {
        const def = this.currentDefinition();
        return def ? normalizeState(this.rawState, def) : this.rawState;
    }

    /** The quest's process stack, bottom first (the quest's own process), each level repaired against its definition. */
    get levels(): ProcessState[] {
        return this.rawLevels.map((l) => {
            const def = this.entry(l.process)?.definition;
            return def ? normalizeState(l, def) : l;
        });
    }

    /** The index of the running (top) level: 0 for the quest's own process. */
    get levelIndex(): number {
        return this.rawLevels.length - 1;
    }

    /**
     * Start a subprocess or a branch from the running step (processStack.ts):
     * only a process the position lists, as that kind; the new level starts at
     * the process's first position and the step below waits. The depth
     * confirmation is the caller's (startNeedsConfirmation).
     */
    startNested(kind: NestedKind, processId: string, followUp: NestedFollowUp, source: ChangeSource, inputs: Record<string, string> = {}): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const levels = this.levels;
        const check = checkNestedStart(levels, this.definitions(), kind, processId);
        if (!check.ok) { return check; }
        const before = topLevel(levels);
        const pushed = pushNestedLevel(levels, check.def, kind, followUp, new Date(), inputs);
        // The new level starts at its first position — past what its conditions leave out.
        const start = pushed[pushed.length - 1];
        pushed[pushed.length - 1] = passExcluded(check.def, { ...EMPTY_PROCESS_STATE }, start, this.conditionOptions(start));
        return this.writeLevels(repo, before, pushed, source);
    }

    /**
     * Abort the running subprocess or branch (confirmed by the user): the
     * level goes, its position is written to the quest's decisions journal,
     * and the step below goes on with the follow-up chosen at the start.
     */
    abortNested(source: ChangeSource): ProcessChangeResult {
        return this.endTop('aborted', source);
    }

    private endTop(outcome: 'finished' | 'aborted', source: ChangeSource, levels: ProcessState[] = this.levels): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const ended = endNestedLevel(levels, this.definitions(), outcome);
        if ('error' in ended) { return { ok: false, error: ended.error }; }
        if (outcome === 'aborted') { this.journalAbort(ended.ended, ended.parentBefore); }
        return this.writeLevels(repo, ended.ended, ended.levels, source);
    }

    /** CC-42: the aborted level's position goes to the quest's decisions journal (best effort). */
    private journalAbort(ended: ProcessState, parent: ProcessState): void {
        try {
            const quests = WsPaths.ai('quests');
            if (!quests) { return; }
            const file = path.join(quests, this.quest, `decisions.${this.quest}.md`);
            const where = (l: ProcessState): string => {
                const def = this.entry(l.process)?.definition;
                return def ? positionText(def, l) : `${l.phase} › ${l.step}`;
            };
            const entry = abortedLevelJournalEntry(ended, where(ended), parent, where(parent));
            const head = fs.existsSync(file) ? '' : decisionsJournalHeader(this.quest);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, `${head}${entry}\n`, 'utf-8');
        } catch { /* the journal is a record, not a participant */ }
    }

    /** Write a stack whose top changed level (pushed or removed); the role follows the new top. */
    private writeLevels(repo: ProcessRepository, before: ProcessState, levels: ProcessState[], source: ChangeSource): ProcessChangeResult {
        repo.writeStateStack(this.quest, levels, this.run);
        this.rawLevels = levels;
        this.rawState = topLevel(levels);
        // The new top's position names the role (a level started at its first step, or the step below going on).
        const role = currentRole(this.currentDefinition(), this.rawState);
        if (role && before !== this.rawState) {
            try {
                const chat = ChatVariablesStore.instance;
                if (chat.role !== role) { chat.set('role', role, source); }
            } catch { /* not initialised */ }
        }
        this.fire();
        return { ok: true, state: this.state };
    }

    /**
     * What a prompt sees: the position the current send runs for (a queued
     * Proceed prompt, processRunContext), else the quest's state. A Proceed
     * moves the quest on at once, so its prompt must not see the next step.
     */
    private viewed(): { def: ProcessDefinition | null; state: ProcessState; description: string } {
        const run = currentProcessRun();
        if (run && run.quest === this.quest) {
            const e = this.entry(run.state.process);
            const def = e?.definition ?? null;
            return { def, state: def ? normalizeState(run.state, def) : run.state, description: e?.description ?? '' };
        }
        return { def: this.currentDefinition(), state: this.state, description: this.processDescription() };
    }

    /**
     * The process chat variables, for the position a prompt runs for, with the
     * running level's inputs (`input.<name>`) and the outputs its subprocesses
     * handed back (`sub.<process>.<name>`).
     */
    variables(): Record<ProcessVariableKey, string> & Record<string, string> {
        const v = this.viewed();
        // `run`: the run the prompt runs for (a queued Proceed's), else the window's.
        const run = currentProcessRun();
        return { ...processVariableValues(v.def, v.state, v.description), ...ioVariables(v.state), run: run && run.quest === this.quest ? normalizeRun(run.run) : this.run };
    }

    /**
     * The `${process-context}` block for the system prompt; `''` without a
     * process. With a stack, the *Parent processes* list comes first; at a
     * position that lists processes, how the agent may suggest one.
     */
    contextBlock(): string {
        const v = this.viewed();
        const run = currentProcessRun();
        const block = processContextBlock(v.def, v.state, v.description, !!run?.proceedId && run.quest === this.quest, this.conditionOptions(v.state));
        if (!block) { return block; }
        const parents = parentProcessLines(this.levels, (l) => this.positionOf(l));
        return [...(parents.length ? [...parents, ''] : []), block, ...this.suggestionLines(v.def, v.state)].join('\n');
    }

    /** The context block of the level at `index` (0 the bottom): its own position, no run context. */
    levelContextBlock(index: number): string {
        const level = this.levels[index];
        if (!level) { return ''; }
        const e = this.entry(level.process);
        return processContextBlock(e?.definition ?? null, level, e?.description ?? '');
    }

    private positionOf(level: ProcessState): string {
        const def = this.entry(level.process)?.definition;
        return def ? positionText(def, level) : [level.phase, level.step].filter(Boolean).join(' › ');
    }

    /** At a position that lists processes: what may be started, and how the agent suggests (never starts) one. */
    private suggestionLines(def: ProcessDefinition | null, state: ProcessState): string[] {
        const lists = positionProcessLists(def, state);
        if (!lists.subprocesses.length && !lists.branches.length) { return []; }
        const names = [...lists.subprocesses.map((e) => `\`${e.process}\` (subprocess)`), ...lists.branches.map((e) => `\`${e.process}\` (branch)`)];
        const lines = ['', `This step lists processes that may be started from it: ${names.join(', ')}. If the step's work shows one is needed, suggest it — with your reason, and optionally the follow-up you recommend — as the LAST thing of the step with \`tomAi_suggestSubprocess\` (the candidates: \`tomAi_listSubprocessCandidates\`). Never in the middle of the step, and never start or abort one yourself: the user decides when the step's queue items are done.`];
        if (state.suggestions?.length) {
            lines.push(`Suggested so far: ${state.suggestions.map((x) => `\`${x.process}\` (${x.kind}) — ${x.reason}`).join('; ')}.`);
        }
        return lines;
    }

    /**
     * The session of the step that started the running level, when that level
     * names none (CC-44): the nearest level below with a session, else none.
     */
    inheritedSession(): ProcessSession | null {
        const levels = this.levels;
        for (let i = levels.length - 2; i >= 0; i--) {
            const def = this.entry(levels[i].process)?.definition ?? null;
            const spec = effectiveSession(def, levels[i]);
            if (spec) { return spec; }
        }
        return null;
    }

    /**
     * Store the agent's suggestions on the running position (merged; a
     * process suggested again replaces its earlier suggestion). Nothing starts.
     */
    suggest(input: readonly SuggestionInput[], source: ChangeSource): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const before = this.state;
        const checked = checkSuggestions(this.currentDefinition(), before, input);
        if (!checked.ok) { return checked; }
        return this.commit(repo, before, { ...before, suggestions: mergeSuggestions(before.suggestions, checked.suggestions) }, source);
    }

    /** The step's queue run finished with suggestions: its move waits for the user's choice. */
    holdForSuggestions(move: { kind: ProcessMoveKind; level?: ProcessLevel; label: string }, source: ChangeSource): ProcessChangeResult {
        const repo = this.repo();
        if (!this.quest || !repo) { return { ok: false, error: 'no quest or workspace' }; }
        const before = this.state;
        return this.commit(repo, before, { ...before, suggestionsDue: { kind: move.kind, ...(move.level ? { level: move.level } : {}), label: move.label } }, source);
    }

    /**
     * The user dismissed the suggestions: they go, and a move that waited for
     * them (the step's run had finished) is made now.
     */
    dismissSuggestions(source: ChangeSource): ProcessChangeResult {
        const repo = this.repo();
        if (!this.quest || !repo) { return { ok: false, error: 'no quest or workspace' }; }
        const before = this.state;
        if (!before.suggestions?.length && !before.suggestionsDue) { return { ok: true, state: before }; }
        const due = before.suggestionsDue;
        const { suggestions: _s, suggestionsDue: _d, ...cleared } = before;
        const result = this.commit(repo, before, cleared, source);
        if (!result.ok || !due) { return result; }
        return this.move(due.kind, due.level, source);
    }

    /** While a queued Proceed prompt is sent: the role its position names (`''` when none); otherwise undefined. */
    runRole(): string | undefined {
        const run = currentProcessRun();
        if (!run || run.quest !== this.quest) { return undefined; }
        const v = this.viewed();
        return currentRole(v.def, v.state);
    }

    /** The current process's Markdown description; `''` when none. */
    processDescription(): string {
        return this.entry(this.rawState.process)?.description ?? '';
    }

    /**
     * What `when:` conditions are decided with: the chat variables (custom
     * ones by name), and `input.<name>` from the level's inputs.
     */
    conditionOptions(state: ProcessState = this.state): ConditionOptions {
        let values: Record<string, string> = {};
        try { values = ChatVariablesStore.instance.toTemplateValues(); } catch { /* not initialised: no variable is set */ }
        return { lookup: conditionLookup(values, state) };
    }

    /** The moves the PROCESS view's action bar offers at the current position. */
    moves(): ProcessMove[] {
        return availableMoves(this.currentDefinition(), this.state, this.conditionOptions());
    }

    /**
     * The agent judged the condition of the running phase or step not to hold
     * (tomAi_setProcessState `leaveOut`): recorded on the position; when the
     * step's Proceed run ends, the process leaves the phase or step out
     * instead of moving on through it. Without a running Proceed it is left
     * out at once. Refused where nothing has a condition to judge.
     */
    leaveOut(reason: string, running: boolean, source: ChangeSource): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        const judged = judgedLevelAt(this.currentDefinition(), this.state, this.conditionOptions().lookup);
        if (!judged) { return { ok: false, error: 'nothing at the current position has a condition for the agent to judge (a `when:` with `judge:`, or a variable that is not set)' }; }
        const why = reason.trim() || 'its condition does not hold';
        const marked = this.commit(repo, this.state, { ...this.state, leaveOut: { level: judged.level, reason: why } }, source);
        if (!marked.ok || running) { return marked; }
        return this.move('leave-out', judged.level, source);
    }

    /** The move of `kind` (and `level`) offered now, if any. */
    findMove(kind: ProcessMoveKind, level?: ProcessLevel): ProcessMove | undefined {
        return this.moves().find((m) => m.kind === kind && (m.level ?? undefined) === (level ?? undefined));
    }

    /**
     * Make a move of the action bar. It is looked up again at the current
     * position, so a view showing an outdated state cannot move the quest
     * somewhere the process does not lead from here.
     */
    move(kind: ProcessMoveKind, level: ProcessLevel | undefined, source: ChangeSource): ProcessChangeResult {
        if (!this.quest) { return { ok: false, error: 'no quest is active; the process state belongs to a quest' }; }
        const repo = this.repo();
        if (!repo) { return { ok: false, error: 'no workspace folder is open' }; }
        // The agent judged the step's condition not to hold: its Proceed run ends by leaving it out.
        if (kind === 'proceed' && this.state.leaveOut) { kind = 'leave-out'; level = this.state.leaveOut.level; }
        const move = this.findMove(kind, level);
        if (!move) { return { ok: false, error: `"${kind}${level ? ` ${level}` : ''}" is not possible at the current position` }; }
        return this.commit(repo, this.state, move.target, source);
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
        let before = this.state;
        if (change.outputs !== undefined) {
            const set = setLevelOutputs(this.currentDefinition(), before, change.outputs);
            if (!set.ok) { return set; }
            before = set.state;
            const { outputs: _outputs, ...rest } = change;
            // Only outputs: they are written and nothing moves.
            if (Object.keys(rest).length === 0) { return this.commit(repo, this.state, before, source); }
            change = rest;
        }
        const result = applyProcessChange(before, this.definitions(), change);
        if (!result.ok) { return result; }
        // A process started from its beginning (no position named) starts past what its conditions leave out.
        const started = change.process !== undefined && change.process !== '' && change.process !== before.process;
        if (started && change.phase === undefined && change.step === undefined && change.substep === undefined) {
            const def = this.entry(change.process!)?.definition;
            if (def) { result.state = passExcluded(def, { ...EMPTY_PROCESS_STATE }, result.state, this.conditionOptions(result.state)); }
        }
        const { nestedEnded: _ended, ...next } = result.state;
        // Another process for the quest leaves every level of the stack: it is the quest's process now.
        if (change.process !== undefined && change.process !== before.process && this.rawLevels.length > 1) {
            delete next.nested;
            return this.writeLevels(repo, before, [next], source);
        }
        if (before.nested && next.process === before.process) { next.nested = before.nested; }
        return this.commit(repo, before, next, source);
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
        // A move to another position leaves the step's suggestions behind (they belong to the step).
        if (!samePosition(before, next) && (next.suggestions || next.suggestionsDue || next.leaveOut)) {
            const { suggestions: _s, suggestionsDue: _d, leaveOut: _l, ...rest } = next;
            next = rest;
        }
        // Every change passes here, so the step it leaves is recorded once, in one place.
        const result: ProcessChangeResult = { ok: true, state: trackStepIterations(before, next) };
        // A subprocess or branch that finished its process ends: the step below goes on with its follow-up.
        if (result.state.nested && result.state.completed && this.rawLevels.length > 1) {
            // A subprocess hands its outputs back: every required one must be set (or have a default).
            const missing = result.state.nested.kind === 'subprocess' ? levelOutputs(this.entry(result.state.process)?.definition ?? null, result.state).missing : [];
            if (missing.length) {
                return { ok: false, error: `the subprocess ${result.state.process} cannot finish: its required output(s) ${missing.map((n) => `"${n}"`).join(', ')} are not set — set them with tomAi_setProcessState {outputs: {…}} first` };
            }
            return this.endTop('finished', source, [...this.levels.slice(0, -1), result.state]);
        }
        repo.writeState(this.quest, result.state, this.run);
        this.rawState = result.state;
        this.rawLevels = [...this.rawLevels.slice(0, -1), result.state];
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

/** The window's current run of `quest` (workspace state: per window, kept across a reload). */
function runStateKey(quest: string): string {
    return `tomAi.processRun.${quest}`;
}
