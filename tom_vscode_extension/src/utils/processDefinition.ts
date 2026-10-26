/**
 * Processes — pure core (no `vscode`, no fs).
 *
 * A process is a named way of working through a quest: phases, each made of
 * steps (some of them grouping sub-steps), ending with a quality-gate step and
 * optionally a post-gate step whose todos are done after the gate passed and
 * before the next phase starts. Phases, steps and sub-steps may be repeatable;
 * a step or sub-step may name the role that does it.
 *
 * Whether a level is repeated is decided at a **decision position**, which
 * the engine puts after every decision point — after a gate, at the end of
 * every phase, after every repeatable sub-step and at the end of every
 * repeatable step — without anything in the definition. There the user picks
 * repeat (each repeatable level that ends there) or go on; after a gate,
 * passed (go on) or failed (back to the gate's `onFail` step, by default the
 * gate itself).
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

/**
 * The named Agent SDK session a phase, step or sub-step runs in
 * (src/utils/agentSdkSessions.ts): a name, or the name with the session it is
 * based on and how — so a missing session can be created from the definition.
 * Names may hold `${phase-iteration}`, `${step-iteration}` and
 * `${substep-iteration}`, filled in for the position (effectiveSession).
 */
export type ProcessSessionSpec = string | { name: string; basedOn?: string; mode?: ProcessSessionMode; profile?: string };

/** A session lifetime as a definition writes it; `fork-from-base` is the old name of `per-prompt`. */
export type ProcessSessionMode = 'continue' | 'per-prompt' | 'per-iteration' | 'fork-from-base';

/** A session spec in its object form. */
export interface ProcessSession {
    name: string;
    basedOn?: string;
    mode?: ProcessSessionMode;
    /** The Anthropic profile a missing session is created with. */
    profile?: string;
}

/** A sub-step: always an action. */
export interface ProcessSubstep {
    id: string;
    name?: string;
    description?: string;
    /** What is to be done when it starts — the prompt a process action builds on. */
    prompt?: string;
    /** The Agent SDK session it runs in; inherited from its step and phase when unset. */
    session?: ProcessSessionSpec;
    /** The role doing it (a folder name under `_ai/roles/`). */
    role?: string;
    repeatable?: boolean;
    /** Upper bound on iterations; only for a repeatable sub-step. */
    maxIterations?: number;
    /**
     * Done by the user, not by an agent (reviewing, answering questions,
     * approving): it runs no prompt, and Proceed asks the user to confirm it
     * is done. Not on a gate, nor on a step with sub-steps (flag those).
     */
    userAction?: boolean;
}

/**
 * A step. With `substeps` it is no action of its own but a group of them; its
 * `role` then applies to the sub-steps that name none.
 */
export interface ProcessStep extends ProcessSubstep {
    substeps?: ProcessSubstep[];
}

/** A phase's quality gate. */
export interface ProcessGate extends ProcessStep {
    /**
     * Where a failed gate goes: the id of one of the phase's steps (or the
     * gate's own id). Unset: the gate is run again.
     */
    onFail?: string;
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
    /** What is to be done when the phase starts. */
    prompt?: string;
    /** The Agent SDK session its steps run in unless they name their own. */
    session?: ProcessSessionSpec;
    repeatable?: boolean;
    maxIterations?: number;
    steps: ProcessStep[];
    /** Every phase ends with a quality gate. */
    gate: ProcessGate;
    postGate?: ProcessPostGateStep;
}

export interface ProcessDefinition {
    id: string;
    name?: string;
    /** One line; the full description is the process's `.md` file. */
    summary?: string;
    /** The session every prompt of the process runs in, unless a phase, step or sub-step names its own. */
    session?: ProcessSessionSpec;
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

/**
 * The placeholders a session name may hold: the iteration of its phase, step
 * or sub-step, so every iteration of a repeatable level runs in its own session.
 */
const SESSION_PLACEHOLDER = /\$\{(phase|step|substep)-iteration\}/g;
const SESSION_MESSAGE = `${ID_MESSAGE}; \${phase-iteration}, \${step-iteration} and \${substep-iteration} are filled in`;

function isSessionName(v: string): boolean {
    return ID_PATTERN.test(v.replace(SESSION_PLACEHOLDER, '1'));
}

const DEFINITION_KEYS = ['id', 'name', 'summary', 'session', 'phases'];
const PHASE_KEYS = ['id', 'name', 'description', 'prompt', 'session', 'repeatable', 'maxIterations', 'steps', 'gate', 'postGate'];
const SUBSTEP_KEYS = ['id', 'name', 'description', 'prompt', 'session', 'role', 'repeatable', 'maxIterations', 'userAction'];
const STEP_KEYS = [...SUBSTEP_KEYS, 'substeps'];
const POST_GATE_KEYS = [...STEP_KEYS, 'todos', 'todoPrefix'];
const GATE_KEYS = [...STEP_KEYS, 'onFail'];
const TODO_KEYS = ['title', 'description'];

type Raw = Record<string, unknown>;

function isObject(x: unknown): x is Raw {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** What a definition is checked against beyond its own shape. */
export interface ProcessValidationContext {
    /** The window's Anthropic profile ids: a session's `profile` must be one of them. Unset: not checked. */
    profileIds?: readonly string[];
}

/**
 * Check `raw` (a parsed `.process.yaml`) and return it typed when it holds no
 * error. With `context.profileIds` (the process checked against the window's
 * config) a session naming an unknown profile is an error too.
 */
export function validateProcessDefinition(raw: unknown, context: ProcessValidationContext = {}): ProcessValidation {
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
    const checkSession = (obj: Raw, path: string): void => {
        const v = obj.session;
        if (v === undefined) { return; }
        const at = `${path}${path ? '.' : ''}session`;
        if (typeof v === 'string') {
            if (!isSessionName(v)) { err(at, SESSION_MESSAGE); }
            return;
        }
        if (!isObject(v)) { err(at, 'a session name or {name, basedOn, mode, profile}'); return; }
        unknownKeys(v, ['name', 'basedOn', 'mode', 'profile'], at);
        if (typeof v.name !== 'string' || v.name === '') { err(`${at}.name`, 'required'); } else if (!isSessionName(v.name)) { err(`${at}.name`, SESSION_MESSAGE); }
        if (v.basedOn !== undefined && (typeof v.basedOn !== 'string' || !isSessionName(v.basedOn))) { err(`${at}.basedOn`, SESSION_MESSAGE); }
        if (v.mode !== undefined && !['continue', 'per-prompt', 'per-iteration', 'fork-from-base'].includes(v.mode as string)) {
            err(`${at}.mode`, '"continue", "per-prompt" or "per-iteration"');
        }
        if (v.profile !== undefined && (typeof v.profile !== 'string' || v.profile === '')) {
            err(`${at}.profile`, 'an Anthropic profile id');
        } else if (typeof v.profile === 'string' && context.profileIds && !context.profileIds.includes(v.profile)) {
            err(`${at}.profile`, `no Anthropic profile "${v.profile}" in this window's configuration`);
        }
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
        for (const key of ['name', 'description', 'prompt', 'role']) { checkText(obj, key, path); }
        checkSession(obj, path);
        checkRepeat(obj, path, what);
        if (obj.userAction !== undefined && typeof obj.userAction !== 'boolean') { err(`${path}.userAction`, 'true or false'); }
        if (obj.userAction === true) {
            for (const key of ['prompt', 'session']) {
                if (obj[key] !== undefined) { err(`${path}.${key}`, 'a user action runs no prompt — say what the user does in its description'); }
            }
        }
        return id;
    };
    const checkStep = (obj: unknown, path: string, allowed: string[]): string => {
        const id = checkSubstep(obj, path, allowed, 'step');
        if (isObject(obj) && obj.userAction === true && obj.substeps !== undefined) {
            err(`${path}.userAction`, 'a step with sub-steps is a group — flag the sub-steps the user does');
        }
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
        return { errors: [{ path: '', message: 'a process definition is a mapping (id, name, summary, session, phases)' }] };
    }
    unknownKeys(raw, DEFINITION_KEYS, '');
    if (typeof raw.id !== 'string' || raw.id === '') { err('id', 'required'); } else if (!ID_PATTERN.test(raw.id)) { err('id', ID_MESSAGE); }
    checkText(raw, 'name', '');
    checkText(raw, 'summary', '');
    checkSession(raw, '');
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
            checkText(phase, 'prompt', path);
            checkSession(phase, path);
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
                noteStep(checkStep(phase.gate, `${path}.gate`, GATE_KEYS), `${path}.gate`);
                if (isObject(phase.gate) && phase.gate.onFail !== undefined) {
                    const targets = [...(Array.isArray(phase.steps) ? phase.steps.filter(isObject).map((x) => x.id) : []), phase.gate.id];
                    if (typeof phase.gate.onFail !== 'string' || !targets.includes(phase.gate.onFail)) {
                        err(`${path}.gate.onFail`, `the step a failed gate goes back to: one of ${targets.filter((t) => typeof t === 'string').map((t) => `"${t}"`).join(', ')}`);
                    }
                }
                if (isObject(phase.gate) && phase.gate.userAction !== undefined) {
                    err(`${path}.gate.userAction`, 'a gate is the agents\' check; the user\'s approval is the Gate passed / failed decision');
                }
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
export function parseProcessYaml(text: string, context: ProcessValidationContext = {}): ProcessValidation {
    let raw: unknown;
    try {
        raw = parse(text);
    } catch (e) {
        return { errors: [{ path: '(yaml)', message: (e as Error).message.split('\n')[0] }] };
    }
    return validateProcessDefinition(raw, context);
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
        ...pick(def, ['id', 'name', 'summary', 'session']),
        phases: def.phases.map((p) => {
            const gate = step(p.gate);
            if (p.gate.onFail) { gate.onFail = p.gate.onFail; }
            const out: Raw = { ...pick(p, ['id', 'name', 'description', 'prompt', 'session', 'repeatable', 'maxIterations']), steps: p.steps.map(step), gate };
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
    /** The process is finished (its last step done); the position stays where it ended. */
    completed: boolean;
    /**
     * At the decision position after this one: the position was run (it is a
     * decision point — a gate, the end of a phase, a repeatable sub-step or the
     * end of a repeatable step) and the user decides how the process goes on.
     * Dropped by every move and every change of position. Older state files
     * wrote it as `ran`.
     */
    decision?: true;
    /**
     * The iteration each step of the current phase iteration was at when it
     * was last left, so a step entered again — a failed gate going back to
     * its `onFail` step, the steps after it — continues at its next iteration
     * instead of repeating an earlier one (session names and todo prefixes
     * carry the iteration). Kept by {@link trackStepIterations}; belongs to
     * `phase` / `phaseIteration` and means nothing in another.
     */
    stepIterations?: StepIterationRecord;
}

/** The last iterations of the steps of one phase iteration. */
export interface StepIterationRecord {
    phase: string;
    phaseIteration: number;
    steps: Record<string, number>;
}

/** The record of `state` when it belongs to the phase iteration `state` is in. */
function recordOf(state: ProcessState): StepIterationRecord | undefined {
    const r = state.stepIterations;
    return r && r.phase === state.phase && r.phaseIteration === state.phaseIteration ? r : undefined;
}

function withoutRecord(state: ProcessState): ProcessState {
    if (!state.stepIterations) { return state; }
    const { stepIterations: _record, ...rest } = state;
    return rest;
}

/**
 * The state `after` a move from `before`, with the step it left recorded:
 * within one phase iteration, the step `before` was at keeps the iteration it
 * had; any other phase or phase iteration starts with no record. Every
 * committed change of a quest's state goes through it.
 */
export function trackStepIterations(before: ProcessState, after: ProcessState): ProcessState {
    const samePhase = before.process === after.process && before.phase === after.phase
        && before.phaseIteration === after.phaseIteration && !!after.phase;
    if (!samePhase) { return withoutRecord(after); }
    const steps = { ...(recordOf(before)?.steps ?? {}) };
    if (before.step && before.step !== after.step) { steps[before.step] = before.stepIteration; }
    if (Object.keys(steps).length === 0) { return withoutRecord(after); }
    return { ...after, stepIterations: { phase: after.phase, phaseIteration: after.phaseIteration, steps } };
}

/** The state at the position itself, not at the decision after it. */
export function notRun(state: ProcessState): ProcessState {
    if (!state.decision) { return state; }
    const { decision: _decision, ...rest } = state;
    return rest;
}

/** Whether two states are at the same position (process, phase, step, sub-step and their iterations). */
export function samePosition(a: ProcessState, b: ProcessState): boolean {
    return a.process === b.process && a.phase === b.phase && a.phaseIteration === b.phaseIteration
        && a.step === b.step && a.stepIteration === b.stepIteration
        && a.substep === b.substep && a.substepIteration === b.substepIteration;
}

export const EMPTY_PROCESS_STATE: ProcessState = Object.freeze({
    process: '', phase: '', phaseIteration: 1, step: '', stepIteration: 1, substep: '', substepIteration: 1, completed: false,
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
    return { ...state, step: step.id, stepIteration, substep: step.substeps?.[0]?.id ?? '', substepIteration: 1, completed: false };
}

/**
 * The iteration a step of `phase` is entered at by a move on through the
 * phase: the one after its last (it runs again), bounded by what it allows;
 * 1 when it has not run in this phase iteration.
 */
function reentryIteration(state: ProcessState, phase: ProcessPhase, step: ProcessStep): number {
    const last = recordOf(state)?.phase === phase.id ? recordOf(state)!.steps[step.id] : undefined;
    return last === undefined ? 1 : clampIteration(repeatView(phase, step), last + 1);
}

/**
 * A step as far as repeating goes: a gate can always be run again (a failed
 * gate is run again), whether or not it is marked repeatable.
 */
function repeatView(phase: ProcessPhase, step: ProcessStep): ProcessStep {
    return step === phase.gate && step.repeatable !== true ? { ...step, repeatable: true, maxIterations: undefined } : step;
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

/**
 * Go to a step of the current phase (its first sub-step); the iteration is
 * kept when it is the current step, the next one when it already ran in this
 * phase iteration, else 1.
 */
export function selectStep(state: ProcessState, def: ProcessDefinition, stepId: string): ProcessState {
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, stepId);
    if (!phase || !step) { throw new Error(`no step "${stepId}" in phase "${state.phase}"`); }
    return withStep(state, step, stepId === state.step ? state.stepIteration : reentryIteration(state, phase, step));
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
    if (level === 'step') { return phase && step ? repeatView(phase, step) : undefined; }
    return findSubstep(step, state.substep);
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
    const moved = notRun({ ...state, [key]: next, completed: false });
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

/** The role a quest falls back to when it leaves its process. */
export const DEFAULT_ROLE = 'default';

/**
 * The user action at `state`: the current sub-step, or the current step
 * without sub-steps, when it is flagged `userAction`; null otherwise.
 */
export function userActionAt(def: ProcessDefinition | null, state: ProcessState): { level: 'step' | 'substep'; node: ProcessSubstep } | null {
    if (!def || !state.process) { return null; }
    const step = findStep(findPhase(def, state.phase), state.step);
    if (!step) { return null; }
    if (step.substeps && step.substeps.length) {
        const sub = findSubstep(step, state.substep);
        return sub && sub.userAction === true ? { level: 'substep', node: sub } : null;
    }
    return step.userAction === true ? { level: 'step', node: step } : null;
}

/**
 * The `role` chat variable after a move from `before` to `after`: the role
 * the new step or sub-step names when the position changed; the default role
 * when the process was cleared; `null` — leave the role as it is — otherwise.
 */
export function roleAfterMove(before: ProcessState, after: ProcessState, def: ProcessDefinition | null): string | null {
    if (before.process && !after.process) { return DEFAULT_ROLE; }
    const moved = (['process', 'phase', 'step', 'substep'] as const).some((k) => before[k] !== after[k])
        || before.phaseIteration !== after.phaseIteration || before.stepIteration !== after.stepIteration;
    if (!moved) { return null; }
    return currentRole(def, after) || null;
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
    const record = recordOf(out);
    out = record ? { ...out, stepIterations: record } : withoutRecord(out);
    const step = findStep(phase, state.step);
    if (!step) { return withStep(out, firstStepOf(phase), 1); }
    out = { ...out, stepIteration: clampIteration(repeatView(phase, step), state.stepIteration) };
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
    /** Mark the process finished (true) or open again (false). Any other change opens it again. */
    completed?: boolean;
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
        const changed = { ...next, completed: change.completed === true };
        return { ok: true, state: samePosition(state, changed) ? changed : notRun(changed) };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

// ============================================================================
// Moves — what the PROCESS view's action bar offers
// ============================================================================

export type ProcessMoveKind = 'proceed' | 'finish' | 'repeat' | 'gate-passed' | 'gate-failed' | 'finish-process' | 'skip' | 'back';

/** The move kinds, in the order the action bar shows them. */
export const PROCESS_MOVE_KINDS: readonly ProcessMoveKind[] = ['proceed', 'finish', 'repeat', 'gate-passed', 'gate-failed', 'finish-process', 'skip', 'back'];

export interface ProcessMove {
    kind: ProcessMoveKind;
    /** For `finish` the level that ends, for `repeat` the level that starts again. */
    level?: ProcessLevel;
    label: string;
    /** The state the move leads to. */
    target: ProcessState;
    /** One of the options of the decision the quest is at; chosen in the decision dialog, not shown in the action bar. */
    branchOption?: true;
}

const LEVEL_TITLE: Record<ProcessLevel, string> = { phase: 'phase', step: 'step', substep: 'sub-step' };

interface Position {
    phase: ProcessPhase;
    phaseIndex: number;
    entries: PhaseStepEntry[];
    stepIndex: number;
    substepIndex: number;
}

function positionOf(def: ProcessDefinition, state: ProcessState): Position | null {
    const phase = findPhase(def, state.phase);
    if (!phase) { return null; }
    const entries = phaseSteps(phase);
    const stepIndex = entries.findIndex((e) => e.step.id === state.step);
    if (stepIndex < 0) { return null; }
    const subs = entries[stepIndex].step.substeps ?? [];
    return { phase, phaseIndex: def.phases.indexOf(phase), entries, stepIndex, substepIndex: subs.findIndex((x) => x.id === state.substep) };
}

/** The position after the current one: next sub-step, else next step, else next phase; null at the end. */
function forwardTarget(def: ProcessDefinition, state: ProcessState, pos: Position): ProcessState | null {
    const subs = pos.entries[pos.stepIndex].step.substeps ?? [];
    if (pos.substepIndex >= 0 && pos.substepIndex < subs.length - 1) {
        return { ...state, substep: subs[pos.substepIndex + 1].id, substepIteration: 1, completed: false };
    }
    if (pos.stepIndex < pos.entries.length - 1) {
        const next = pos.entries[pos.stepIndex + 1].step;
        return withStep(state, next, reentryIteration(state, pos.phase, next));
    }
    const nextPhase = def.phases[pos.phaseIndex + 1];
    return nextPhase ? withStep({ ...state, phase: nextPhase.id, phaseIteration: 1 }, firstStepOf(nextPhase), 1) : null;
}

/**
 * The position before the current one — the previous sub-step, else the last
 * sub-step of the previous step, else the last step of the previous phase.
 * A correction: the iteration numbers are kept as they are (bounded by the
 * level they land on).
 */
function backTarget(def: ProcessDefinition, state: ProcessState, pos: Position): ProcessState | null {
    const subs = pos.entries[pos.stepIndex].step.substeps ?? [];
    if (pos.substepIndex > 0) {
        const sub = subs[pos.substepIndex - 1];
        return { ...state, substep: sub.id, substepIteration: clampIteration(sub, state.substepIteration), completed: false };
    }
    let phase = pos.phase;
    let entries = pos.entries;
    let index = pos.stepIndex - 1;
    if (index < 0) {
        if (pos.phaseIndex === 0) { return null; }
        phase = def.phases[pos.phaseIndex - 1];
        entries = phaseSteps(phase);
        index = entries.length - 1;
    }
    const step = entries[index].step;
    const last = step.substeps?.[step.substeps.length - 1];
    // Within the phase, back to the iteration the step was at when it was left.
    const was = phase === pos.phase ? recordOf(state)?.steps[step.id] : undefined;
    return {
        ...state,
        phase: phase.id,
        phaseIteration: clampIteration(phase, state.phaseIteration),
        step: step.id,
        stepIteration: clampIteration(repeatView(phase, step), was ?? state.stepIteration),
        substep: last?.id ?? '',
        substepIteration: last ? clampIteration(last, state.substepIteration) : 1,
        completed: false,
    };
}

function canRepeat(node: { repeatable?: boolean; maxIterations?: number } | undefined, iteration: number): boolean {
    return !!node && node.repeatable === true && (node.maxIterations === undefined || iteration < node.maxIterations);
}

/**
 * Whether the end of `pos` is a decision point — a decision position follows
 * it: a gate's end, a phase's end, a repeatable sub-step, the end of a
 * repeatable step (gates and post-gate steps included). Structural: a level
 * at its maxIterations still has its decision, which then offers going on.
 */
function isDecisionPoint(pos: Position): boolean {
    const entry = pos.entries[pos.stepIndex];
    const subs = entry.step.substeps ?? [];
    const stepEnds = subs.length === 0 || pos.substepIndex === subs.length - 1;
    const phaseEnds = stepEnds && pos.stepIndex === pos.entries.length - 1;
    return (entry.kind === 'gate' && stepEnds)
        || phaseEnds
        || subs[pos.substepIndex]?.repeatable === true
        || (stepEnds && entry.step.repeatable === true);
}

const nameOf = (node: { id: string; name?: string }): string => node.name || node.id;

/** Where a move leads, for a label: the step (and sub-step), with the phase when it is another one. */
function whereTo(def: ProcessDefinition, from: ProcessState, to: ProcessState): string {
    const phase = findPhase(def, to.phase);
    const step = findStep(phase, to.step);
    const sub = findSubstep(step, to.substep);
    const parts = [to.phase !== from.phase && phase ? nameOf(phase) : '', step ? nameOf(step) : to.step, sub ? nameOf(sub) : ''];
    return parts.filter(Boolean).join(' › ');
}

/**
 * The options at the decision position after `pos`: go on (gate passed after
 * a gate; finish the process at its end), a repeat of each repeatable level
 * that ends there (below its maxIterations), and after a gate, gate failed —
 * back to the gate's `onFail` step, by default the gate run again.
 */
function decisionOptions(def: ProcessDefinition, here: ProcessState, pos: Position, forward: ProcessState | null): ProcessMove[] {
    const entry = pos.entries[pos.stepIndex];
    const subs = entry.step.substeps ?? [];
    const isGate = entry.kind === 'gate';
    const stepEnds = subs.length === 0 || pos.substepIndex === subs.length - 1;
    const phaseEnds = stepEnds && pos.stepIndex === pos.entries.length - 1;
    const onward = forward ? `go on to ${whereTo(def, here, forward)}` : '';
    const options: ProcessMove[] = [];
    if (!forward) {
        options.push({ kind: 'finish-process', label: isGate ? 'Gate passed — finish the process' : 'Finish the process', target: { ...here, completed: true } });
    } else if (isGate && stepEnds) {
        options.push({ kind: 'gate-passed', label: `Gate passed — ${onward}`, target: forward });
    } else {
        options.push({ kind: 'finish', label: onward.charAt(0).toUpperCase() + onward.slice(1), target: forward });
    }
    if (isGate && stepEnds) {
        const gate = pos.phase.gate;
        const back = gate.onFail && gate.onFail !== gate.id ? findStep(pos.phase, gate.onFail) : undefined;
        options.push(back
            ? { kind: 'gate-failed', label: `Gate failed — back to ${nameOf(back)}`, target: withStep(here, back, reentryIteration(here, pos.phase, back)) }
            : { kind: 'gate-failed', label: `Gate failed — run ${nameOf(gate)} again`, target: changeIteration(here, def, 'step', 1) });
    }
    const sub = subs[pos.substepIndex];
    if (sub && canRepeat(sub, here.substepIteration)) {
        options.push({ kind: 'repeat', level: 'substep', label: `Repeat ${nameOf(sub)}`, target: changeIteration(here, def, 'substep', 1) });
    }
    if (stepEnds && !isGate && canRepeat(entry.step, here.stepIteration)) {
        options.push({ kind: 'repeat', level: 'step', label: `Repeat the step ${nameOf(entry.step)}`, target: changeIteration(here, def, 'step', 1) });
    }
    if (phaseEnds && canRepeat(pos.phase, here.phaseIteration)) {
        options.push({ kind: 'repeat', level: 'phase', label: `Repeat the phase ${nameOf(pos.phase)}`, target: changeIteration(here, def, 'phase', 1) });
    }
    return options.map((o) => ({ ...o, branchOption: true as const }));
}

/**
 * The moves offered at `state`, in the order the action bar shows them:
 *
 * - at a position: `proceed` — the only move that runs anything: the prompt
 *   of THIS position is queued (a user action is confirmed), then the state
 *   moves on — to the next position, or, at a decision point, to the decision
 *   position after it; `skip` — the same target, without running; `back` —
 *   the previous position (its decision, when it has one), a correction;
 * - at a **decision position**: `proceed` ("Decide…") opens the options,
 *   which follow as moves marked `branchOption` — go on (`finish`;
 *   `gate-passed` after a gate; `finish-process` at the end), `gate-failed`
 *   (back to the gate's `onFail` step, or the gate again), `repeat` of each
 *   repeatable level ending there — then `back` (to the position itself).
 *
 * Only a decision position repeats or decides. A finished process offers only
 * `back` ("Reopen"); no process, nothing.
 */
export function availableMoves(def: ProcessDefinition | null, state: ProcessState): ProcessMove[] {
    if (!def || !state.process) { return []; }
    if (state.completed) { return [{ kind: 'back', label: 'Reopen', target: notRun({ ...state, completed: false }) }]; }
    const pos = positionOf(def, state);
    if (!pos) { return []; }
    const here = notRun(state);
    const forwardRaw = forwardTarget(def, here, pos);
    const forward = forwardRaw ? notRun(forwardRaw) : null;
    const moves: ProcessMove[] = [];
    if (state.decision && isDecisionPoint(pos)) {
        moves.push({ kind: 'proceed', label: 'Decide…', target: state });
        moves.push(...decisionOptions(def, here, pos, forward));
        moves.push({ kind: 'back', label: 'Back', target: here });
        return moves;
    }
    const next = isDecisionPoint(pos) || !forward ? { ...here, decision: true as const } : forward;
    moves.push({ kind: 'proceed', label: userActionAt(def, state) ? 'Confirm done' : 'Proceed', target: next });
    moves.push({ kind: 'skip', label: 'Skip', target: next });
    const backRaw = backTarget(def, here, pos);
    if (backRaw) {
        const prev = positionOf(def, backRaw);
        moves.push({ kind: 'back', label: 'Back', target: prev && isDecisionPoint(prev) ? { ...notRun(backRaw), decision: true } : notRun(backRaw) });
    }
    return moves;
}

/** The decision the quest is at — its options — or null when it is not at a decision position. */
export function decisionAt(def: ProcessDefinition | null, state: ProcessState): { options: ProcessMove[] } | null {
    if (!def || !state.process || state.completed || !state.decision) { return null; }
    const pos = positionOf(def, state);
    if (!pos || !isDecisionPoint(pos)) { return null; }
    return { options: availableMoves(def, state).filter((m) => m.branchOption) };
}

// ============================================================================
// What chat variables and the system prompt see
// ============================================================================

/** The chat-variable names of a process state, in display order. */
export const PROCESS_VARIABLE_KEYS = [
    'process', 'phase', 'step', 'substep',
    'phase-iteration', 'step-iteration', 'substep-iteration',
    'process-description', 'phase-description', 'step-description', 'substep-description',
    'phase-prompt', 'step-prompt', 'substep-prompt',
    'session',
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
    out.session = effectiveSession(def, state)?.name ?? '';
    out['process-description'] = processDescription;
    if (!state.phase) { return out; }
    out.phase = state.phase;
    out['phase-iteration'] = String(state.phaseIteration);
    const phase = def ? findPhase(def, state.phase) : undefined;
    out['phase-description'] = phase?.description ?? '';
    out['phase-prompt'] = phase?.prompt ?? '';
    if (!state.step) { return out; }
    out.step = state.step;
    out['step-iteration'] = String(state.stepIteration);
    const step = findStep(phase, state.step);
    out['step-description'] = step?.description ?? '';
    out['step-prompt'] = step?.prompt ?? '';
    if (!state.substep) { return out; }
    out.substep = state.substep;
    out['substep-iteration'] = String(state.substepIteration);
    const sub = findSubstep(step, state.substep);
    out['substep-description'] = sub?.description ?? '';
    out['substep-prompt'] = sub?.prompt ?? '';
    return out;
}

/** A session spec in its object form. */
export function sessionSpec(spec: ProcessSessionSpec | undefined): ProcessSession | null {
    if (spec === undefined) { return null; }
    if (typeof spec === 'string') { return { name: spec }; }
    return {
        name: spec.name,
        ...(spec.basedOn ? { basedOn: spec.basedOn } : {}),
        ...(spec.mode ? { mode: spec.mode } : {}),
        ...(spec.profile ? { profile: spec.profile } : {}),
    };
}

/**
 * The session the position runs in: the sub-step's, else the step's, else the
 * phase's, else the process's; null when none names one. The iteration placeholders of its names
 * are filled in from `state`.
 */
export function effectiveSession(def: ProcessDefinition | null, state: ProcessState): ProcessSession | null {
    if (!def) { return null; }
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, state.step);
    const sub = findSubstep(step, state.substep);
    // The innermost wins: sub-step, step, phase, then the process.
    const spec = sessionSpec(sub?.session) ?? sessionSpec(step?.session) ?? sessionSpec(phase?.session) ?? sessionSpec(def.session);
    if (!spec) { return null; }
    const iteration: Record<string, number> = { phase: state.phaseIteration, step: state.stepIteration, substep: state.substepIteration };
    const fill = (name: string): string => name.replace(SESSION_PLACEHOLDER, (_m, level: string) => String(iteration[level] || 1));
    return { ...spec, name: fill(spec.name), ...(spec.basedOn ? { basedOn: fill(spec.basedOn) } : {}) };
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
        const session = effectiveSession(def, state);
        if (session) {
            const from = session.basedOn ? `from \`${session.basedOn}\`` : 'fresh';
            const how = session.mode === 'per-prompt' || session.mode === 'fork-from-base'
                ? ` (${from} for every prompt)`
                : session.mode === 'per-iteration' ? ` (${from} for every queue iteration)`
                    : session.basedOn ? ` (based on \`${session.basedOn}\`)` : '';
            lines.push(`Session: \`${session.name}\`${how} — prompts this step queues run in it unless they name another`);
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
    if (!state.completed && userActionAt(def, state)) {
        lines.push('', '**User action** — this position is done by the user, not by an agent: do not do its work and do not move past it; the user confirms it with Proceed in the PROCESS view.');
    }
    if (state.completed) { lines.push('', 'The process is finished: its last step is done.'); }
    const decision = decisionAt(def, state);
    if (decision) {
        lines.push('', `**Decision** — this position has run; the user decides here how the process goes on: ${decision.options.map((o) => o.label).join('; ')}. An agent does not decide it and does not move past it.`);
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

function parseStepIterations(raw: unknown): { stepIterations?: StepIterationRecord } {
    if (!isObject(raw) || typeof raw.phase !== 'string' || !isObject(raw.steps)) { return {}; }
    const steps: Record<string, number> = {};
    for (const [id, n] of Object.entries(raw.steps)) {
        if (Number.isInteger(n) && (n as number) >= 1) { steps[id] = n as number; }
    }
    if (Object.keys(steps).length === 0) { return {}; }
    const phaseIteration = Number.isInteger(raw.phaseIteration) && (raw.phaseIteration as number) >= 1 ? raw.phaseIteration as number : 1;
    return { stepIterations: { phase: raw.phase, phaseIteration, steps } };
}

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
            completed: raw.completed === true,
            ...(raw.decision === true || raw.ran === true ? { decision: true as const } : {}),
            ...parseStepIterations(raw.stepIterations),
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
        ...(state.completed ? { completed: true } : {}),
        ...(state.decision ? { decision: true } : {}),
        ...(state.stepIterations ? { stepIterations: state.stepIterations } : {}),
        updated,
    });
}
