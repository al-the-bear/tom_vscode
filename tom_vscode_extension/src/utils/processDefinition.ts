/**
 * Processes — pure core (no `vscode`, no fs).
 *
 * A process is a named way of working through a quest: phases, each made of
 * steps (some of them grouping sub-steps), ending with a quality-gate step and
 * optionally a post-gate step whose todos are done after the gate passed and
 * before the next phase starts. Phases, steps and sub-steps may be repeatable;
 * a step or sub-step may name the role that does it.
 *
 * On disk a process is `_ai/processes/<id>/<id>.process.yaml` (the structure,
 * validated here and by `src/config/process.schema.json`) plus
 * `_ai/processes/<id>/<id>.md` (its description). The state a quest is in —
 * process, phase, step, sub-step and their iterations — is kept per quest by
 * `src/managers/processStateStore.ts`; this module holds everything about it
 * that needs no IO: parsing, validation, the moves between states, the chat
 * variable values and the block the system prompt is given.
 */

import { parse, stringify } from 'yaml';

// ============================================================================
// Definition types
// ============================================================================

export interface ProcessTodoItem {
    title: string;
    description?: string;
}

/** A sub-step: always an action. */
export interface ProcessSubstep {
    id: string;
    name?: string;
    description?: string;
    /** The role doing it (a folder name under `_ai/roles/`). */
    role?: string;
    repeatable?: boolean;
    /** Upper bound on iterations; only for a repeatable sub-step. */
    maxIterations?: number;
}

/**
 * A step. With `substeps` it is no action of its own but a group of them; its
 * `role` then applies to the sub-steps that name none.
 */
export interface ProcessStep extends ProcessSubstep {
    substeps?: ProcessSubstep[];
}

/** The optional step after a passed gate: its todos close the phase. */
export interface ProcessPostGateStep extends ProcessStep {
    /** Todos written into the process. */
    todos?: ProcessTodoItem[];
    /** Quest todos whose id starts with this prefix belong to the step too. */
    todoPrefix?: string;
}

export interface ProcessPhase {
    id: string;
    name?: string;
    description?: string;
    repeatable?: boolean;
    maxIterations?: number;
    steps: ProcessStep[];
    /** Every phase ends with a quality gate. */
    gate: ProcessStep;
    postGate?: ProcessPostGateStep;
}

export interface ProcessDefinition {
    id: string;
    name?: string;
    /** One line; the full description is the process's `.md` file. */
    summary?: string;
    phases: ProcessPhase[];
}

export type ProcessStepKind = 'step' | 'gate' | 'post-gate';

/** A step of a phase in order — the steps, then the gate, then the post-gate step. */
export interface PhaseStepEntry {
    kind: ProcessStepKind;
    step: ProcessStep | ProcessPostGateStep;
}

export function phaseSteps(phase: ProcessPhase): PhaseStepEntry[] {
    const out: PhaseStepEntry[] = phase.steps.map((step) => ({ kind: 'step' as const, step }));
    out.push({ kind: 'gate', step: phase.gate });
    if (phase.postGate) { out.push({ kind: 'post-gate', step: phase.postGate }); }
    return out;
}

// ============================================================================
// Validation
// ============================================================================

export interface ProcessProblem {
    /** Where, e.g. `phases[0].steps[1].id`. */
    path: string;
    message: string;
}

export interface ProcessValidation {
    definition?: ProcessDefinition;
    errors: ProcessProblem[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ID_MESSAGE = 'letters, digits, "_" and "-" only, starting with a letter or digit';

const DEFINITION_KEYS = ['id', 'name', 'summary', 'phases'];
const PHASE_KEYS = ['id', 'name', 'description', 'repeatable', 'maxIterations', 'steps', 'gate', 'postGate'];
const SUBSTEP_KEYS = ['id', 'name', 'description', 'role', 'repeatable', 'maxIterations'];
const STEP_KEYS = [...SUBSTEP_KEYS, 'substeps'];
const POST_GATE_KEYS = [...STEP_KEYS, 'todos', 'todoPrefix'];
const TODO_KEYS = ['title', 'description'];

type Raw = Record<string, unknown>;

function isObject(x: unknown): x is Raw {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Check `raw` (a parsed `.process.yaml`) and return it typed when it holds no error. */
export function validateProcessDefinition(raw: unknown): ProcessValidation {
    const errors: ProcessProblem[] = [];
    const err = (path: string, message: string): void => { errors.push({ path, message }); };

    const unknownKeys = (obj: Raw, allowed: string[], path: string): void => {
        for (const key of Object.keys(obj)) {
            if (!allowed.includes(key)) { err(`${path}${path ? '.' : ''}${key}`, 'unknown key'); }
        }
    };
    const checkId = (obj: Raw, path: string): string => {
        const id = obj.id;
        if (typeof id !== 'string' || id === '') { err(`${path}.id`, 'required'); return ''; }
        if (!ID_PATTERN.test(id)) { err(`${path}.id`, ID_MESSAGE); }
        return id;
    };
    const checkText = (obj: Raw, key: string, path: string): void => {
        if (obj[key] !== undefined && typeof obj[key] !== 'string') { err(`${path}.${key}`, 'text expected'); }
    };
    const checkRepeat = (obj: Raw, path: string, what: string): void => {
        if (obj.repeatable !== undefined && typeof obj.repeatable !== 'boolean') { err(`${path}.repeatable`, 'true or false'); }
        if (obj.maxIterations !== undefined) {
            if (!Number.isInteger(obj.maxIterations) || (obj.maxIterations as number) < 1) {
                err(`${path}.maxIterations`, 'a whole number of at least 1');
            } else if (obj.repeatable !== true) {
                err(`${path}.maxIterations`, `only a repeatable ${what} has a maximum`);
            }
        }
    };
    const checkSubstep = (obj: unknown, path: string, allowed: string[], what: string): string => {
        if (!isObject(obj)) { err(path, 'an object expected'); return ''; }
        unknownKeys(obj, allowed, path);
        const id = checkId(obj, path);
        for (const key of ['name', 'description', 'role']) { checkText(obj, key, path); }
        checkRepeat(obj, path, what);
        return id;
    };
    const checkStep = (obj: unknown, path: string, allowed: string[]): string => {
        const id = checkSubstep(obj, path, allowed, 'step');
        if (!isObject(obj) || obj.substeps === undefined) { return id; }
        if (!Array.isArray(obj.substeps)) { err(`${path}.substeps`, 'a list expected'); return id; }
        if (obj.substeps.length === 0) { err(`${path}.substeps`, 'a step with sub-steps has at least one'); }
        const seen = new Set<string>();
        obj.substeps.forEach((sub, k) => {
            const subPath = `${path}.substeps[${k}]`;
            const subId = checkSubstep(sub, subPath, SUBSTEP_KEYS, 'sub-step');
            if (subId && seen.has(subId)) { err(`${subPath}.id`, `"${subId}" is used twice in step "${id}"`); }
            seen.add(subId);
        });
        return id;
    };

    if (!isObject(raw)) {
        return { errors: [{ path: '', message: 'a process definition is a mapping (id, name, summary, phases)' }] };
    }
    unknownKeys(raw, DEFINITION_KEYS, '');
    if (typeof raw.id !== 'string' || raw.id === '') { err('id', 'required'); } else if (!ID_PATTERN.test(raw.id)) { err('id', ID_MESSAGE); }
    checkText(raw, 'name', '');
    checkText(raw, 'summary', '');
    if (!Array.isArray(raw.phases)) {
        err('phases', 'a list of phases expected');
    } else {
        if (raw.phases.length === 0) { err('phases', 'at least one phase'); }
        const phaseIds = new Set<string>();
        raw.phases.forEach((phase, i) => {
            const path = `phases[${i}]`;
            if (!isObject(phase)) { err(path, 'an object expected'); return; }
            unknownKeys(phase, PHASE_KEYS, path);
            const phaseId = checkId(phase, path);
            if (phaseId && phaseIds.has(phaseId)) { err(`${path}.id`, `"${phaseId}" is used twice in the process`); }
            phaseIds.add(phaseId);
            checkText(phase, 'name', path);
            checkText(phase, 'description', path);
            checkRepeat(phase, path, 'phase');
            const stepIds = new Set<string>();
            const noteStep = (stepId: string, stepPath: string): void => {
                if (stepId && stepIds.has(stepId)) { err(`${stepPath}.id`, `"${stepId}" is used twice in phase "${phaseId}"`); }
                stepIds.add(stepId);
            };
            if (!Array.isArray(phase.steps)) {
                err(`${path}.steps`, 'a list of steps expected');
            } else {
                phase.steps.forEach((step, k) => {
                    const stepPath = `${path}.steps[${k}]`;
                    noteStep(checkStep(step, stepPath, STEP_KEYS), stepPath);
                });
            }
            if (phase.gate === undefined) {
                err(`${path}.gate`, 'a phase ends with a quality gate step');
            } else {
                noteStep(checkStep(phase.gate, `${path}.gate`, STEP_KEYS), `${path}.gate`);
            }
            if (phase.postGate !== undefined) {
                const postPath = `${path}.postGate`;
                noteStep(checkStep(phase.postGate, postPath, POST_GATE_KEYS), postPath);
                if (isObject(phase.postGate)) {
                    checkText(phase.postGate, 'todoPrefix', postPath);
                    const todos = phase.postGate.todos;
                    if (todos !== undefined && !Array.isArray(todos)) { err(`${postPath}.todos`, 'a list expected'); }
                    if (Array.isArray(todos)) {
                        todos.forEach((todo, t) => {
                            const todoPath = `${postPath}.todos[${t}]`;
                            if (!isObject(todo)) { err(todoPath, 'an object expected'); return; }
                            unknownKeys(todo, TODO_KEYS, todoPath);
                            if (typeof todo.title !== 'string' || todo.title.trim() === '') { err(`${todoPath}.title`, 'required'); }
                            checkText(todo, 'description', todoPath);
                        });
                    }
                }
            }
        });
    }
    return errors.length ? { errors } : { definition: raw as unknown as ProcessDefinition, errors };
}

/** Parse and validate the text of a `.process.yaml`. */
export function parseProcessYaml(text: string): ProcessValidation {
    let raw: unknown;
    try {
        raw = parse(text);
    } catch (e) {
        return { errors: [{ path: '(yaml)', message: (e as Error).message.split('\n')[0] }] };
    }
    return validateProcessDefinition(raw);
}

/** The text of a `.process.yaml` for `def`, keys in their documented order. */
export function stringifyProcessDefinition(def: ProcessDefinition): string {
    const pick = (obj: object, keys: string[]): Raw => {
        const out: Raw = {};
        for (const key of keys) {
            const value = (obj as Raw)[key];
            if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0 && key !== 'steps')) { continue; }
            out[key] = value;
        }
        return out;
    };
    const substep = (s: ProcessSubstep): Raw => pick(s, SUBSTEP_KEYS);
    const step = (s: ProcessStep): Raw => {
        const out = pick(s, SUBSTEP_KEYS);
        if (s.substeps && s.substeps.length) { out.substeps = s.substeps.map(substep); }
        return out;
    };
    const ordered = {
        ...pick(def, ['id', 'name', 'summary']),
        phases: def.phases.map((p) => {
            const out: Raw = { ...pick(p, ['id', 'name', 'description', 'repeatable', 'maxIterations']), steps: p.steps.map(step), gate: step(p.gate) };
            if (p.postGate) {
                const post = step(p.postGate);
                if (p.postGate.todos && p.postGate.todos.length) { post.todos = p.postGate.todos.map((t) => pick(t, TODO_KEYS)); }
                if (p.postGate.todoPrefix) { post.todoPrefix = p.postGate.todoPrefix; }
                out.postGate = post;
            }
            return out;
        }),
    };
    return stringify(ordered, { lineWidth: 0 });
}

// ============================================================================
// State
// ============================================================================

/** Where a quest is in its process. Empty strings: not set. */
export interface ProcessState {
    process: string;
    phase: string;
    phaseIteration: number;
    step: string;
    stepIteration: number;
    substep: string;
    substepIteration: number;
}

export const EMPTY_PROCESS_STATE: ProcessState = Object.freeze({
    process: '', phase: '', phaseIteration: 1, step: '', stepIteration: 1, substep: '', substepIteration: 1,
}) as ProcessState;

export type ProcessLevel = 'phase' | 'step' | 'substep';

const LEVEL_LABEL: Record<ProcessLevel, string> = { phase: 'phase', step: 'step', substep: 'sub-step' };

export function findPhase(def: ProcessDefinition, id: string): ProcessPhase | undefined {
    return def.phases.find((p) => p.id === id);
}

export function findStep(phase: ProcessPhase | undefined, id: string): ProcessStep | ProcessPostGateStep | undefined {
    return phase ? phaseSteps(phase).find((e) => e.step.id === id)?.step : undefined;
}

export function findSubstep(step: ProcessStep | undefined, id: string): ProcessSubstep | undefined {
    return step?.substeps?.find((s) => s.id === id);
}

function firstStepOf(phase: ProcessPhase): ProcessStep {
    return phaseSteps(phase)[0].step;
}

function withStep(state: ProcessState, step: ProcessStep, stepIteration: number): ProcessState {
    return { ...state, step: step.id, stepIteration, substep: step.substeps?.[0]?.id ?? '', substepIteration: 1 };
}

/** Start `def` at its first phase, step and sub-step; `null` clears the state. */
export function selectProcess(def: ProcessDefinition | null): ProcessState {
    if (!def) { return { ...EMPTY_PROCESS_STATE }; }
    const phase = def.phases[0];
    return withStep({ ...EMPTY_PROCESS_STATE, process: def.id, phase: phase.id, phaseIteration: 1 }, firstStepOf(phase), 1);
}

/** Go to a phase: its first step; the iteration is kept when it is the current phase. */
export function selectPhase(state: ProcessState, def: ProcessDefinition, phaseId: string): ProcessState {
    const phase = findPhase(def, phaseId);
    if (!phase) { throw new Error(`no phase "${phaseId}" in process "${def.id}"`); }
    const phaseIteration = phaseId === state.phase ? state.phaseIteration : 1;
    return withStep({ ...state, process: def.id, phase: phaseId, phaseIteration }, firstStepOf(phase), 1);
}

/** Go to a step of the current phase (its first sub-step); the iteration is kept when it is the current step. */
export function selectStep(state: ProcessState, def: ProcessDefinition, stepId: string): ProcessState {
    const step = findStep(findPhase(def, state.phase), stepId);
    if (!step) { throw new Error(`no step "${stepId}" in phase "${state.phase}"`); }
    return withStep(state, step, stepId === state.step ? state.stepIteration : 1);
}

/** Go to a sub-step of the current step; the iteration is kept when it is the current one. */
export function selectSubstep(state: ProcessState, def: ProcessDefinition, substepId: string): ProcessState {
    const step = findStep(findPhase(def, state.phase), state.step);
    if (!step?.substeps?.length) { throw new Error(`step "${state.step}" has no sub-steps`); }
    if (!findSubstep(step, substepId)) { throw new Error(`no sub-step "${substepId}" in step "${state.step}"`); }
    return { ...state, substep: substepId, substepIteration: substepId === state.substep ? state.substepIteration : 1 };
}

/** The phase, step or sub-step a level of `state` points at. */
function levelNode(state: ProcessState, def: ProcessDefinition, level: ProcessLevel): ProcessSubstep | ProcessPhase | undefined {
    const phase = findPhase(def, state.phase);
    if (level === 'phase') { return phase; }
    const step = findStep(phase, state.step);
    return level === 'step' ? step : findSubstep(step, state.substep);
}

const ITERATION_KEY: Record<ProcessLevel, 'phaseIteration' | 'stepIteration' | 'substepIteration'> = {
    phase: 'phaseIteration', step: 'stepIteration', substep: 'substepIteration',
};

/**
 * Move an iteration by `delta`. Forward starts the next iteration, so what is
 * inside it restarts (a phase at its first step, a step at its first
 * sub-step); backward only corrects the number. Bounded by 1 and
 * `maxIterations`; a level that is not repeatable throws.
 */
export function changeIteration(state: ProcessState, def: ProcessDefinition, level: ProcessLevel, delta: number): ProcessState {
    const node = levelNode(state, def, level);
    if (!node) { throw new Error(`no current ${LEVEL_LABEL[level]}`); }
    if (node.repeatable !== true) { throw new Error(`${LEVEL_LABEL[level]} "${node.id}" is not repeatable`); }
    const key = ITERATION_KEY[level];
    const next = Math.max(1, Math.min(node.maxIterations ?? Number.MAX_SAFE_INTEGER, state[key] + delta));
    if (next === state[key]) { return state; }
    const moved = { ...state, [key]: next };
    if (delta < 0) { return moved; }
    if (level === 'phase') { return withStep(moved, firstStepOf(node as ProcessPhase), 1); }
    if (level === 'step') { return withStep(moved, node as ProcessStep, next); }
    return moved;
}

/** The role doing the current step: the sub-step's own, else its step's; `''` when none is named. */
export function currentRole(def: ProcessDefinition | null, state: ProcessState): string {
    if (!def) { return ''; }
    const step = findStep(findPhase(def, state.phase), state.step);
    return findSubstep(step, state.substep)?.role || step?.role || '';
}

function clampIteration(node: { repeatable?: boolean; maxIterations?: number } | undefined, n: number): number {
    if (!node || node.repeatable !== true) { return 1; }
    return Math.max(1, Math.min(node.maxIterations ?? Number.MAX_SAFE_INTEGER, Number.isInteger(n) ? n : 1));
}

/**
 * Repair a state that no longer fits its definition (the definition was
 * edited): an unknown phase restarts the process, an unknown step its phase,
 * an unknown sub-step its step; iterations are bounded.
 */
export function normalizeState(state: ProcessState, def: ProcessDefinition): ProcessState {
    if (state.process !== def.id) { return selectProcess(def); }
    const phase = findPhase(def, state.phase);
    if (!phase) { return selectProcess(def); }
    let out: ProcessState = { ...state, phaseIteration: clampIteration(phase, state.phaseIteration) };
    const step = findStep(phase, state.step);
    if (!step) { return withStep(out, firstStepOf(phase), 1); }
    out = { ...out, stepIteration: clampIteration(step, state.stepIteration) };
    if (!step.substeps?.length) { return { ...out, substep: '', substepIteration: 1 }; }
    const sub = findSubstep(step, state.substep);
    if (!sub) { return { ...out, substep: step.substeps[0].id, substepIteration: 1 }; }
    return { ...out, substepIteration: clampIteration(sub, state.substepIteration) };
}

// ============================================================================
// Change requests (the tool's input, the panel's actions)
// ============================================================================

export interface ProcessChange {
    /** A process id; `''` clears the state. */
    process?: string;
    phase?: string;
    step?: string;
    substep?: string;
    phaseIteration?: number;
    stepIteration?: number;
    substepIteration?: number;
}

export type ProcessChangeResult = { ok: true; state: ProcessState } | { ok: false; error: string };

/**
 * Apply `change` to `state`: the process first (another process starts at its
 * beginning), then phase, step and sub-step in that order, then the
 * iterations set as given (bounded, only on repeatable levels).
 */
export function applyProcessChange(
    state: ProcessState,
    defs: ReadonlyMap<string, ProcessDefinition>,
    change: ProcessChange,
): ProcessChangeResult {
    try {
        let next = state;
        if (change.process !== undefined) {
            if (change.process === '') { return { ok: true, state: { ...EMPTY_PROCESS_STATE } }; }
            const def = defs.get(change.process);
            if (!def) { return { ok: false, error: `no process "${change.process}"; known: ${[...defs.keys()].sort().join(', ') || '(none)'}` }; }
            next = change.process === state.process ? normalizeState(state, def) : selectProcess(def);
        }
        if (!next.process) { return { ok: false, error: 'no process is set; pass `process` first' }; }
        const def = defs.get(next.process);
        if (!def) { return { ok: false, error: `the process "${next.process}" is not defined (any more)` }; }
        if (change.phase !== undefined) { next = selectPhase(next, def, change.phase); }
        if (change.step !== undefined) { next = selectStep(next, def, change.step); }
        if (change.substep !== undefined) { next = selectSubstep(next, def, change.substep); }
        for (const level of ['phase', 'step', 'substep'] as ProcessLevel[]) {
            const value = change[ITERATION_KEY[level]];
            if (value === undefined) { continue; }
            const node = levelNode(next, def, level);
            if (!node) { return { ok: false, error: `no current ${LEVEL_LABEL[level]} to set an iteration on` }; }
            if (!Number.isInteger(value) || value < 1) { return { ok: false, error: `${ITERATION_KEY[level]} must be a whole number of at least 1` }; }
            if (value !== 1 && node.repeatable !== true) { return { ok: false, error: `${LEVEL_LABEL[level]} "${node.id}" is not repeatable` }; }
            if (node.maxIterations !== undefined && value > node.maxIterations) {
                return { ok: false, error: `${LEVEL_LABEL[level]} "${node.id}" has at most ${node.maxIterations} iterations` };
            }
            next = { ...next, [ITERATION_KEY[level]]: value };
        }
        return { ok: true, state: next };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

// ============================================================================
// What chat variables and the system prompt see
// ============================================================================

/** The chat-variable names of a process state, in display order. */
export const PROCESS_VARIABLE_KEYS = [
    'process', 'phase', 'step', 'substep',
    'phase-iteration', 'step-iteration', 'substep-iteration',
    'process-description', 'phase-description', 'step-description', 'substep-description',
] as const;

export type ProcessVariableKey = typeof PROCESS_VARIABLE_KEYS[number];

/** The chat-variable values for `state`; every value `''` when no process is set. */
export function processVariableValues(
    def: ProcessDefinition | null,
    state: ProcessState,
    processDescription: string,
): Record<ProcessVariableKey, string> {
    const out = Object.fromEntries(PROCESS_VARIABLE_KEYS.map((k) => [k, ''])) as Record<ProcessVariableKey, string>;
    if (!state.process) { return out; }
    out.process = state.process;
    out['process-description'] = processDescription;
    if (!state.phase) { return out; }
    out.phase = state.phase;
    out['phase-iteration'] = String(state.phaseIteration);
    const phase = def ? findPhase(def, state.phase) : undefined;
    out['phase-description'] = phase?.description ?? '';
    if (!state.step) { return out; }
    out.step = state.step;
    out['step-iteration'] = String(state.stepIteration);
    const step = findStep(phase, state.step);
    out['step-description'] = step?.description ?? '';
    if (!state.substep) { return out; }
    out.substep = state.substep;
    out['substep-iteration'] = String(state.substepIteration);
    out['substep-description'] = findSubstep(step, state.substep)?.description ?? '';
    return out;
}

function iterationText(node: { repeatable?: boolean; maxIterations?: number }, n: number): string {
    if (node.repeatable !== true) { return `iteration ${n}`; }
    return node.maxIterations ? `iteration ${n} of at most ${node.maxIterations}` : `iteration ${n}`;
}

/**
 * The block the system prompt is given while a process is set: where the
 * quest is (process, phase, step, sub-step with their positions, iterations
 * and roles), the steps of the phase, the post-gate todos when in that step,
 * and the descriptions. `''` without a process.
 */
export function processContextBlock(def: ProcessDefinition | null, state: ProcessState, processDescription: string): string {
    if (!def || !state.process) { return ''; }
    const lines: string[] = [];
    const head = (node: { id: string; name?: string }, extra: string): string =>
        node.name ? `**${node.name}** (\`${node.id}\`${extra})` : `\`${node.id}\`${extra ? ` (${extra.replace(/^, /, '')})` : ''}`;
    lines.push(`Process: ${head(def, '')}${def.summary ? ` — ${def.summary}` : ''}`);
    const phase = findPhase(def, state.phase);
    let step: ProcessStep | ProcessPostGateStep | undefined;
    let sub: ProcessSubstep | undefined;
    let entries: PhaseStepEntry[] = [];
    if (phase) {
        const at = def.phases.indexOf(phase) + 1;
        lines.push(`Phase: ${head(phase, `, ${at} of ${def.phases.length}`)}, ${iterationText(phase, state.phaseIteration)}`);
        entries = phaseSteps(phase);
        const index = entries.findIndex((e) => e.step.id === state.step);
        if (index >= 0) {
            step = entries[index].step;
            const kind = entries[index].kind;
            const kindText = kind === 'gate' ? ', quality gate' : kind === 'post-gate' ? ', after the gate passed' : '';
            const role = step.role ? ` — role \`${step.role}\`` : '';
            lines.push(`Step: ${head(step, `, ${index + 1} of ${entries.length}${kindText}`)}, ${iterationText(step, state.stepIteration)}${role}`);
            sub = findSubstep(step, state.substep);
            if (sub && step.substeps) {
                const subRole = sub.role || step.role;
                lines.push(`Sub-step: ${head(sub, `, ${step.substeps.indexOf(sub) + 1} of ${step.substeps.length}`)}, ${iterationText(sub, state.substepIteration)}${subRole ? ` — role \`${subRole}\`` : ''}`);
            }
        }
        const outline = entries.map((e) => {
            const id = e.step.id === state.step ? `**\`${e.step.id}\`**` : `\`${e.step.id}\``;
            return e.kind === 'step' ? id : `${id} (${e.kind})`;
        }).join(' → ');
        lines.push(`Steps of this phase: ${outline}`);
    }
    if (step && entries.find((e) => e.step === step)?.kind === 'post-gate') {
        const post = step as ProcessPostGateStep;
        const todoLines = (post.todos ?? []).map((t) => `- ${t.title}${t.description ? ` — ${t.description}` : ''}`);
        if (todoLines.length || post.todoPrefix) {
            lines.push('', 'Todos of this step, to be done before the next phase starts:');
            lines.push(...todoLines);
            if (post.todoPrefix) { lines.push(`- and the quest todos with the id prefix \`${post.todoPrefix}\``); }
        }
    }
    lines.push('', 'When the work moves on — another step, sub-step, iteration or phase — record it with `tomAi_setProcessState`.');
    const section = (title: string, text: string | undefined): void => {
        if (text && text.trim()) { lines.push('', `### ${title}`, '', text.trim()); }
    };
    section('Process description', processDescription);
    if (phase) { section(`Phase: ${phase.name || phase.id}`, phase.description); }
    if (step) { section(`Step: ${step.name || step.id}`, step.description); }
    if (sub) { section(`Sub-step: ${sub.name || sub.id}`, sub.description); }
    return lines.join('\n');
}

// ============================================================================
// The per-quest state file
// ============================================================================

/** Read a state file's text; anything unreadable is the empty state. */
export function parseProcessState(text: string): ProcessState {
    try {
        const raw = parse(text);
        if (!isObject(raw)) { return { ...EMPTY_PROCESS_STATE }; }
        const str = (k: string): string => (typeof raw[k] === 'string' ? raw[k] as string : '');
        const num = (k: string): number => (Number.isInteger(raw[k]) && (raw[k] as number) >= 1 ? raw[k] as number : 1);
        return {
            process: str('process'), phase: str('phase'), phaseIteration: num('phaseIteration'),
            step: str('step'), stepIteration: num('stepIteration'),
            substep: str('substep'), substepIteration: num('substepIteration'),
        };
    } catch {
        return { ...EMPTY_PROCESS_STATE };
    }
}

/** The text of a state file. */
export function stringifyProcessState(state: ProcessState, updated: string): string {
    return stringify({
        process: state.process,
        phase: state.phase,
        phaseIteration: state.phaseIteration,
        step: state.step,
        stepIteration: state.stepIteration,
        substep: state.substep,
        substepIteration: state.substepIteration,
        updated,
    });
}
