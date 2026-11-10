/**
 * Process tools — the process a quest follows and where it is in it.
 *
 * A process (`_ai/processes/<id>/<id>.process.yaml` + `<id>.md`) has phases
 * of steps (some grouping sub-steps); each phase ends with a quality-gate
 * step and optionally a post-gate step whose todos are done before the next
 * phase starts. The active quest's position — process, phase, step, sub-step
 * and their iterations — is kept in its quest folder and shown to the model in
 * the system prompt (`${process-context}`). These tools list and read the
 * definitions and read and move that position.
 *
 * A quest may hold several runs, each a position of its own
 * (src/utils/processRuns.ts): the run tools list, create, select and delete
 * them, and `run` on tomAi_getProcessState / tomAi_setProcessState reads or
 * moves one without selecting it.
 *
 * (Not to be confused with `process-tools.ts`, which spawns OS processes.)
 */

import { SharedToolDefinition } from './shared-tool-registry';
import type { ProcessStateStore } from '../managers/processStateStore';
import type { ProcessEntry } from '../utils/processRepository';
import {
    phaseSteps,
    type ProcessChange,
    type ProcessChangeResult,
    type ProcessDefinition,
    type ProcessState,
} from '../utils/processDefinition';
import type { ChangeSource } from '../managers/chatVariablesStore';
import { unescapePlaceholders } from '../utils/placeholderEscape';
import { getCurrentToolContext } from '../services/tool-execution-context';

/** What the tools need from the process store; faked in tests. */
export interface ProcessToolDeps {
    list(): ProcessEntry[];
    activeQuest(): string;
    state(): ProcessState;
    currentRole(): string;
    contextBlock(): string;
    apply(change: ProcessChange): ProcessChangeResult;
    /** Remove the quest's open process-move markers (a state set by hand ends the running step); answers how many. */
    dropProcessMoveMarkers(): number;
    /** The quest's process stack, bottom first (`tomAi_getProcessState {level}`); unset: the one level. */
    levels?(): ProcessState[];
    /** The context block of the level at an index (0 the bottom). */
    levelContextBlock?(index: number): string;
    /** Do `fn` on run `run` instead of the window's (an unknown run is refused). */
    withRun?<T extends object>(run: string | undefined, fn: () => T): T | { ok: false; error: string };
    /** The window's run. */
    currentRun?(): string;
    /** The quest's runs, the last changed first. */
    runs?(): Array<{ run: string; changed: string | null; process: string; position: string; levels: number; current: boolean }>;
    selectRun?(run: string): ProcessChangeResult;
    createRun?(run: string, process: string | undefined, select: boolean): ProcessChangeResult;
    deleteRuns?(runs: string[]): { ok: true; deleted: string[] } | { ok: false; error: string };
    /** Remove the open process-move markers of run `run` (default: the window's). */
    dropRunMarkers?(run: string | undefined): number;
}

/** `fn` on `run` when one is named and the deps know runs; else on the window's run. */
function onRun<T extends object>(deps: ProcessToolDeps, run: string | undefined, fn: () => T): T | { ok: false; error: string } {
    return run && deps.withRun ? deps.withRun(run, fn) : fn();
}

/**
 * A `level` argument as an index into `levels`: 0 the bottom (the quest's own
 * process), 1 the level above it, …; -1 the top (the running level, the
 * default), -2 the one below it, ….
 */
export function resolveLevelIndex(count: number, level: number | undefined): number | { error: string } {
    const n = level ?? -1;
    if (!Number.isInteger(n)) { return { error: '`level` is a whole number: 0 the bottom, -1 the top' }; }
    const index = n < 0 ? count + n : n;
    if (index < 0 || index >= count) { return { error: `no level ${n}: the stack has ${count} level(s) (0 … ${count - 1}, or -1 … -${count})` }; }
    return index;
}

/** A definition's outline: ids, names, kinds, roles, repeat flags — no descriptions. */
export function outlineDefinition(def: ProcessDefinition): unknown {
    return {
        id: def.id,
        name: def.name,
        summary: def.summary,
        phases: def.phases.map((p) => ({
            id: p.id,
            name: p.name,
            repeatable: p.repeatable === true,
            ...(p.maxIterations ? { maxIterations: p.maxIterations } : {}),
            steps: phaseSteps(p).map((e) => ({
                id: e.step.id,
                kind: e.kind,
                name: e.step.name,
                role: e.step.role,
                repeatable: e.step.repeatable === true,
                ...(e.step.maxIterations ? { maxIterations: e.step.maxIterations } : {}),
                ...(e.step.substeps?.length ? {
                    substeps: e.step.substeps.map((s) => ({ id: s.id, name: s.name, role: s.role, repeatable: s.repeatable === true })),
                } : {}),
            })),
        })),
    };
}

// ===========================================================================
// tomAi_listProcesses
// ===========================================================================

export async function listProcessesImpl(deps: ProcessToolDeps): Promise<string> {
    const state = deps.state();
    return JSON.stringify({
        ok: true,
        quest: deps.activeQuest(),
        currentProcess: state.process,
        processes: deps.list().map((e) => e.definition
            ? { ...(outlineDefinition(e.definition) as object), valid: true }
            : { id: e.id, valid: false, errors: e.errors.map((x) => `${x.path}: ${x.message}`) }),
    }, null, 2);
}

export const LIST_PROCESSES_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listProcesses',
    displayName: 'List Processes',
    description:
        'List the processes defined under `_ai/processes/` — each `{id, name, summary, valid, phases: ' +
        '[{id, name, repeatable, steps: [{id, kind, name, role, repeatable, substeps?}]}]}`, where a ' +
        'step\'s `kind` is `step`, `gate` (the quality gate that ends every phase) or `post-gate` (the ' +
        'optional step after a passed gate whose todos are done before the next phase). An invalid ' +
        'definition is listed with its `errors`. Also returns the active `quest` and its `currentProcess`. ' +
        'Read a process in full with `tomAi_getProcess`; move the quest with `tomAi_setProcessState`.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listProcessesImpl(liveDeps()),
};

// ===========================================================================
// tomAi_getProcess
// ===========================================================================

export interface GetProcessInput { id?: string }

export async function getProcessImpl(deps: ProcessToolDeps, input: GetProcessInput): Promise<string> {
    const id = input.id || deps.state().process;
    if (!id) { return JSON.stringify({ ok: false, error: 'no `id` given and the quest has no process' }); }
    const entry = deps.list().find((e) => e.id === id);
    if (!entry) { return JSON.stringify({ ok: false, error: `no process "${id}"`, known: deps.list().map((e) => e.id) }); }
    return JSON.stringify({
        ok: true,
        id,
        valid: !!entry.definition,
        errors: entry.errors.map((x) => `${x.path}: ${x.message}`),
        description: entry.description,
        definition: entry.definition,
        files: { yaml: entry.yamlPath, description: entry.mdPath },
    }, null, 2);
}

export const GET_PROCESS_TOOL: SharedToolDefinition<GetProcessInput> = {
    name: 'tomAi_getProcess',
    displayName: 'Get Process',
    description:
        'Read one process in full: its definition (phases, steps, gate, post-gate with its `todos` and ' +
        '`todoPrefix`, sub-steps, roles, repeatable / maxIterations, every `description`), its Markdown ' +
        'description (`_ai/processes/<id>/<id>.md`) and the two file paths. `id` defaults to the active ' +
        'quest\'s process. The definitions are edited by the user in the process editor.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Process id. Default: the quest\'s current process.' } },
    },
    execute: async (input) => getProcessImpl(liveDeps(), input),
};

// ===========================================================================
// tomAi_getProcessState
// ===========================================================================

export async function getProcessStateImpl(deps: ProcessToolDeps, input: { level?: number; run?: string } = {}): Promise<string> {
    const answer = onRun(deps, input.run, () => {
        const levels = deps.levels?.() ?? [deps.state()];
        const index = resolveLevelIndex(levels.length, input.level);
        if (typeof index !== 'number') { return { ok: false, error: index.error }; }
        const top = index === levels.length - 1;
        return {
            ok: true,
            quest: deps.activeQuest(),
            ...(deps.currentRun ? { run: input.run || deps.currentRun() } : {}),
            level: index,
            levels: levels.length,
            state: top ? deps.state() : levels[index],
            ...(top ? { role: deps.currentRole() } : { waiting: 'this level waits at its step for the level above it' }),
            // What the system prompt shows: a literal `$${…}` in a description reads as `${…}`.
            context: unescapePlaceholders(top ? deps.contextBlock() : deps.levelContextBlock?.(index) ?? ''),
        };
    });
    return JSON.stringify(answer, null, 2);
}

/** The `run` argument of the process-state tools. */
const RUN_PARAM = { run: { type: 'string', description: 'A run of the quest (tomAi_listProcessRuns) to read / move instead of the window\'s current run; it is not selected.' } };

export const GET_PROCESS_STATE_TOOL: SharedToolDefinition<{ level?: number; run?: string }> = {
    name: 'tomAi_getProcessState',
    displayName: 'Get Process State',
    description:
        'Where the active quest is in its process: `state` `{process, phase, phaseIteration, step, ' +
        'stepIteration, substep, substepIteration, completed}` (empty strings when no process is set; ' +
        '`completed` once the last step is done), the `role` ' +
        'the current step names, and `context` — the same Markdown block the system prompt carries ' +
        '(positions, the steps of the phase, the post-gate todos when in that step, the descriptions). ' +
        'With subprocesses or branches running, `level` reads another level of the quest\'s process stack ' +
        '(0 the quest\'s own process, -1 the running level and the default). ' +
        'The state is kept per quest in `_ai/quests/<quest>/process-state.<quest>.yaml`; another run of the quest in `process-state.<quest>.<run>.yaml` — `run` reads that run (default: the window\'s current run, answered as `run`).',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: { level: { type: 'number', description: 'Level of the process stack: 0 the bottom, -1 the top (default), -2 the one below it.' }, ...RUN_PARAM } },
    execute: async (input: { level?: number; run?: string }) => getProcessStateImpl(liveDeps(), input ?? {}),
};

// ===========================================================================
// tomAi_setProcessState
// ===========================================================================

export async function setProcessStateImpl(deps: ProcessToolDeps, input: ProcessChange & { run?: string }): Promise<string> {
    const { run, ...change } = input;
    const answer = onRun(deps, run, () => {
        const roleBefore = deps.currentRole();
        const result = deps.apply(change);
        if (!result.ok) { return result; }
        // The state is set by hand now: a step still running from a Proceed no longer moves it.
        // Only outputs set (the subprocess's agent recording its result) moves nothing: the step runs on.
        const onlyOutputs = Object.keys(change).every((k) => k === 'outputs');
        const markersRemoved = onlyOutputs ? 0 : (deps.dropRunMarkers ? deps.dropRunMarkers(run) : deps.dropProcessMoveMarkers());
        const role = deps.currentRole();
        return {
            ok: true, ...(run ? { run } : {}), state: result.state, role, roleChanged: role !== roleBefore && role !== '',
            ...(markersRemoved > 0 ? { processMoveMarkersRemoved: markersRemoved } : {}),
        };
    });
    return JSON.stringify(answer, null, 2);
}

export const SET_PROCESS_STATE_TOOL: SharedToolDefinition<ProcessChange & { run?: string }> = {
    name: 'tomAi_setProcessState',
    displayName: 'Set Process State',
    description:
        'Move the active quest in its process — the running (top) level of its process stack: `process` ("" clears it; leaves every level), `phase`, `step`, `substep` (applied in that order, each starting at its first child), the iterations (repeatable levels only), `completed: true`. Every name is checked against the definition; a refusal changes nothing. In a subprocess, `outputs` sets its declared outputs (handed back to the step that started it when it finishes; a required one must be set first). Answers `{state, role, roleChanged}` (a step\'s role becomes the `role` chat variable). Setting the state removes a Proceed\'s process-move marker. `run` moves another run of the quest (tomAi_listProcessRuns) instead of the window\'s current one.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    // Like tomAi_writeChatVariable: state, not content, and visible live in
    // the PROCESS view — an approval prompt per move would only get in the way.
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            process: { type: 'string', description: 'Process id; "" clears the quest\'s process state.' },
            phase: { type: 'string', description: 'Phase id.' },
            step: { type: 'string', description: 'Step id of the phase (including its gate / post-gate step).' },
            substep: { type: 'string', description: 'Sub-step id of the step.' },
            phaseIteration: { type: 'number', description: 'Iteration of the phase (≥ 1).' },
            stepIteration: { type: 'number', description: 'Iteration of the step (≥ 1).' },
            substepIteration: { type: 'number', description: 'Iteration of the sub-step (≥ 1).' },
            completed: { type: 'boolean', description: 'true: the process is finished (its last step done).' },
            outputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Outputs of the running subprocess or branch, by declared name (merged with those set before).' },
            ...RUN_PARAM,
        },
    },
    // The change source (which transport called) is read when the tool runs, as the chat-variable tools do.
    execute: async (input) => setProcessStateImpl(liveDeps(getCurrentToolContext()?.source ?? 'anthropic'), input),
};

// ===========================================================================
// Live wiring
// ===========================================================================

function liveDeps(source: ChangeSource = 'anthropic'): ProcessToolDeps {
    const store = (): ProcessStateStore => {
        // Required lazily: the store needs `vscode`, and the impls above are tested without it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const s = require('../managers/processStateStore.js').ProcessStateStore.instance as ProcessStateStore | undefined;
        if (!s) { throw new Error('the process store is not initialised'); }
        return s;
    };
    return {
        list: () => store().list(),
        activeQuest: () => store().activeQuest,
        state: () => store().state,
        currentRole: () => store().currentRole(),
        contextBlock: () => store().contextBlock(),
        apply: (change) => store().apply(change, source),
        levels: () => store().levels,
        levelContextBlock: (index) => store().levelContextBlock(index),
        dropProcessMoveMarkers: () => dropMarkers(store().currentRun),
        dropRunMarkers: (run) => dropMarkers(run || store().currentRun),
        withRun: (run, fn) => store().withRun(run, fn),
        currentRun: () => store().currentRun,
        runs: () => store().runs(),
        selectRun: (run) => store().selectRun(run),
        createRun: (run, process, select) => store().createRun(run, process, source, select),
        deleteRuns: (runs) => store().deleteRuns(runs),
    };
    function dropMarkers(run: string): number {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const queue = require('../managers/promptQueueManager.js').PromptQueueManager as { instance?: { dropProcessMoveMarkers(q: string, why: string, run?: string): number } };
        try { return queue.instance?.dropProcessMoveMarkers(store().activeQuest, 'state set with tomAi_setProcessState', run) ?? 0; } catch { return 0; }
    }
}

// ===========================================================================
// Runs: tomAi_listProcessRuns, tomAi_createProcessRun, tomAi_selectProcessRun, tomAi_deleteProcessRuns
// ===========================================================================

const RUNS_NOTE = ' A run is a process position of its own in the quest (its own state file, any process); `default` is the quest\'s own position, always there and never deleted.';

function needRuns(deps: ProcessToolDeps): string | null {
    return deps.runs && deps.currentRun ? null : JSON.stringify({ ok: false, error: 'runs are not available here' });
}

export async function listProcessRunsImpl(deps: ProcessToolDeps): Promise<string> {
    const missing = needRuns(deps);
    if (missing) { return missing; }
    return JSON.stringify({ ok: true, quest: deps.activeQuest(), currentRun: deps.currentRun!(), runs: deps.runs!() }, null, 2);
}

export async function createProcessRunImpl(deps: ProcessToolDeps, input: { run: string; process?: string; select?: boolean }): Promise<string> {
    if (!deps.createRun) { return JSON.stringify({ ok: false, error: 'runs are not available here' }); }
    if (typeof input.run !== 'string' || !input.run.trim()) { return JSON.stringify({ ok: false, error: '`run` is required: the new run\'s name' }); }
    const result = deps.createRun(input.run.trim(), input.process || undefined, input.select !== false);
    return JSON.stringify(result.ok ? { ok: true, run: input.run.trim(), selected: input.select !== false, state: result.state } : result, null, 2);
}

export async function selectProcessRunImpl(deps: ProcessToolDeps, input: { run: string }): Promise<string> {
    if (!deps.selectRun) { return JSON.stringify({ ok: false, error: 'runs are not available here' }); }
    const result = deps.selectRun(input.run ?? '');
    return JSON.stringify(result.ok ? { ok: true, run: deps.currentRun?.() ?? input.run, state: result.state } : result, null, 2);
}

export async function deleteProcessRunsImpl(deps: ProcessToolDeps, input: { runs: string[] }): Promise<string> {
    if (!deps.deleteRuns) { return JSON.stringify({ ok: false, error: 'runs are not available here' }); }
    if (!Array.isArray(input.runs) || input.runs.length === 0) { return JSON.stringify({ ok: false, error: '`runs` is required: the names of the runs to delete' }); }
    const result = deps.deleteRuns(input.runs.map(String));
    return JSON.stringify(result.ok ? { ...result, currentRun: deps.currentRun?.() } : result, null, 2);
}

export const LIST_PROCESS_RUNS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listProcessRuns',
    displayName: 'List Process Runs',
    description: 'The runs of the active quest, the last changed first: each `{run, process, position, levels, changed, current}` (`current`: the run this window works on, also `currentRun`).' + RUNS_NOTE,
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => listProcessRunsImpl(liveDeps()),
};

export const CREATE_PROCESS_RUN_TOOL: SharedToolDefinition<{ run: string; process?: string; select?: boolean }> = {
    name: 'tomAi_createProcessRun',
    displayName: 'Create Process Run',
    description: 'Create a run of the active quest: `run` its name (letters, digits, `_`, `-`), `process` the process it follows from its first position (any process; default none yet). It is selected in this window unless `select: false`. Refused: a taken name, `default`, an unknown process.' + RUNS_NOTE,
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            run: { type: 'string', description: 'The new run\'s name, e.g. a change id.' },
            process: { type: 'string', description: 'The process it follows (tomAi_listProcesses). Default: none yet.' },
            select: { type: 'boolean', description: 'Work on it in this window from now on. Default true.' },
        },
        required: ['run'],
    },
    execute: async (input) => createProcessRunImpl(liveDeps(getCurrentToolContext()?.source ?? 'anthropic'), input),
};

export const SELECT_PROCESS_RUN_TOOL: SharedToolDefinition<{ run: string }> = {
    name: 'tomAi_selectProcessRun',
    displayName: 'Select Process Run',
    description: 'Work on another run of the active quest in this window: the PROCESS view, the process chat variables, the system prompt\'s process context and the process tools without `run` follow it. Answers its state.' + RUNS_NOTE,
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'The run (tomAi_listProcessRuns); `default` the quest\'s own position.' } }, required: ['run'] },
    execute: async (input) => selectProcessRunImpl(liveDeps(), input),
};

export const DELETE_PROCESS_RUNS_TOOL: SharedToolDefinition<{ runs: string[] }> = {
    name: 'tomAi_deleteProcessRuns',
    displayName: 'Delete Process Runs',
    description: 'Delete runs of the active quest (their state files); `default` and an unknown run are refused and then nothing is deleted. A deleted current run leaves this window on `default`.' + RUNS_NOTE,
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: { type: 'object', properties: { runs: { type: 'array', items: { type: 'string' }, description: 'The runs to delete.' } }, required: ['runs'] },
    execute: async (input) => deleteProcessRunsImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const QUEST_PROCESS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PROCESSES_TOOL,
    GET_PROCESS_TOOL,
    GET_PROCESS_STATE_TOOL,
    SET_PROCESS_STATE_TOOL,
    LIST_PROCESS_RUNS_TOOL,
    CREATE_PROCESS_RUN_TOOL,
    SELECT_PROCESS_RUN_TOOL,
    DELETE_PROCESS_RUNS_TOOL,
];
