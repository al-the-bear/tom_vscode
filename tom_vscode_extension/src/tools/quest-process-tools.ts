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
import { getCurrentToolContext } from '../services/tool-execution-context';

/** What the tools need from the process store; faked in tests. */
export interface ProcessToolDeps {
    list(): ProcessEntry[];
    activeQuest(): string;
    state(): ProcessState;
    currentRole(): string;
    contextBlock(): string;
    apply(change: ProcessChange): ProcessChangeResult;
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

export async function getProcessStateImpl(deps: ProcessToolDeps): Promise<string> {
    return JSON.stringify({
        ok: true,
        quest: deps.activeQuest(),
        state: deps.state(),
        role: deps.currentRole(),
        context: deps.contextBlock(),
    }, null, 2);
}

export const GET_PROCESS_STATE_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_getProcessState',
    displayName: 'Get Process State',
    description:
        'Where the active quest is in its process: `state` `{process, phase, phaseIteration, step, ' +
        'stepIteration, substep, substepIteration}` (empty strings when no process is set), the `role` ' +
        'the current step names, and `context` — the same Markdown block the system prompt carries ' +
        '(positions, the steps of the phase, the post-gate todos when in that step, the descriptions). ' +
        'The state is kept per quest in `_ai/quests/<quest>/process-state.<quest>.yaml`.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => getProcessStateImpl(liveDeps()),
};

// ===========================================================================
// tomAi_setProcessState
// ===========================================================================

export async function setProcessStateImpl(deps: ProcessToolDeps, input: ProcessChange): Promise<string> {
    const roleBefore = deps.currentRole();
    const result = deps.apply(input);
    if (!result.ok) { return JSON.stringify(result); }
    const role = deps.currentRole();
    return JSON.stringify({ ok: true, state: result.state, role, roleChanged: role !== roleBefore && role !== '' }, null, 2);
}

export const SET_PROCESS_STATE_TOOL: SharedToolDefinition<ProcessChange> = {
    name: 'tomAi_setProcessState',
    displayName: 'Set Process State',
    description:
        'Move the active quest in its process. Give any of `process` (an id from `tomAi_listProcesses`; ' +
        'another process starts at its first phase and step; `""` clears the state), `phase`, `step`, ' +
        '`substep` (applied in that order: a new phase starts at its first step, a step with sub-steps at ' +
        'its first sub-step), and `phaseIteration` / `stepIteration` / `substepIteration` (set as given; ' +
        'only on a repeatable level, at most its maxIterations). A step\'s id may be its phase\'s gate or ' +
        'post-gate step. Every name is checked against the definition; a refusal returns `{ok:false, ' +
        'error}` and changes nothing. On success: `{ok, state, role, roleChanged}` — moving to a step ' +
        'that names a role also sets the `role` chat variable, so the role description in the system ' +
        'prompt follows the process. Record each move as the work moves on.',
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
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const QUEST_PROCESS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PROCESSES_TOOL,
    GET_PROCESS_TOOL,
    GET_PROCESS_STATE_TOOL,
    SET_PROCESS_STATE_TOOL,
];
