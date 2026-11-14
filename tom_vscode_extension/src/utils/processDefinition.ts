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

import { Document, isMap, isScalar, isSeq, parse, parseDocument, Scalar, stringify, visit, type Node as YamlNode, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import { runSessionName } from './runSessions';

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
    /**
     * The processes that may be started from here as a **subprocess** — a level
     * on the quest's process stack that hands a result back — and as a
     * **branch** — a level that hands nothing back. Closed lists: nothing else
     * may be started from this position (src/utils/processStack.ts). A
     * sub-step without lists of its own takes its step's.
     */
    subprocesses?: ProcessListEntry[];
    branches?: ProcessListEntry[];
    /**
     * The documents this position puts in front of the user — a review step's
     * (vscimpb64): the PROCESS view shows a link per document, the process
     * tools name them. A sub-step without its own takes its step's
     * (src/utils/processDocuments.ts resolves them).
     */
    documents?: ProcessDocument[];
}

/**
 * A document of a position: `path` workspace-relative (or absolute), with
 * placeholders — `${<chat variable>}`, `${input.<name>}`, `${output.<name>}`,
 * `${dirname:<variable>}` — and an optional `label` (default the file name).
 */
export interface ProcessDocument {
    path: string;
    label?: string;
}

/**
 * An entry of a `subprocesses:` / `branches:` list: a process id, or the id
 * with a description and `inputs` — the process's declared inputs filled
 * from this position, each a text resolved by the placeholder engine when the
 * level starts (the step's chat and process variables, `${sub.…}` outputs).
 */
export type ProcessListEntry = string | { process: string; description?: string; inputs?: Record<string, string> };

/** What an input or output holds: a document, a list of documents, a folder. */
export type ProcessIoKind = 'document' | 'documents' | 'folder';

/**
 * A declared input or output of a process (CC-61). An input is filled by the
 * `subprocesses:` / `branches:` entry that starts the process and seen by its
 * prompts as `${input.<name>}`; an output is set while the process runs
 * (`tomAi_setProcessState {outputs}`) or taken from `value` (a text with
 * `${input.<name>}`), and handed back to the step that started it as
 * `${sub.<process>.<name>}` when it finishes as a subprocess.
 */
export interface ProcessIoDecl {
    name: string;
    kind?: ProcessIoKind;
    description?: string;
    /** An input that must be filled; an output that must be set before the process finishes. */
    required?: boolean;
    /** Outputs only: the value when none was set, e.g. `${input.folder}/consolidated.md`. */
    value?: string;
}

/**
 * When a phase or step runs (`when:`), in one of two notations — the key says
 * who decides:
 *
 * - `{var, equals | notEquals | in | set}` — the extension decides, from the
 *   chat variables (a custom one by its name, `custom.<name>` too, the
 *   built-ins, and a nested level's `input.<name>`): a forward move passes a
 *   phase or step whose condition does not hold by, recording why. A variable
 *   that is not set decides nothing (except for `set`): the agent judges it.
 * - `{judge: text}` — the agent decides, at Proceed: it is told the condition
 *   and, when it does not hold, leaves the phase or step out
 *   (`tomAi_setProcessState {leaveOut: why}`).
 */
export type ProcessCondition = ProcessVarCondition | ProcessJudgeCondition;

export interface ProcessVarCondition {
    var: string;
    equals?: string;
    notEquals?: string;
    in?: string[];
    /** true: runs when the variable has a value; false: when it has none. */
    set?: boolean;
}

export interface ProcessJudgeCondition {
    judge: string;
}

/** What a phase and a step (not a gate) may say about whether they run. */
export interface ProcessConditional {
    /** May be left out: the PROCESS view offers Leave out at its start. */
    optional?: boolean;
    /** Runs only when this holds ({@link ProcessCondition}). */
    when?: ProcessCondition;
}

/**
 * A follow-up process (vscimpb47): where the quest may continue when the
 * level that offers it ends — another process (or this one) at a named phase
 * and step, its first ones by default. Offered as an option of the decision
 * at the end of that level; the user picks it. The position switches there
 * in the same run, the run's chat variables kept; `carry` names the
 * variables the follow-up relies on (their values are recorded with the
 * switch), `context` the call context — texts resolved by the placeholder
 * engine when the switch is made, which the follow-up's prompts read as
 * `${origin.<name>}`.
 */
export interface ProcessFollowUp {
    process: string;
    phase?: string;
    step?: string;
    description?: string;
    carry?: string[];
    context?: Record<string, string>;
}

/** What a level that may offer follow-ups carries. */
export interface ProcessFollowUps {
    /** Follow-up processes offered at the decision at its end ({@link ProcessFollowUp}). */
    followUps?: ProcessFollowUp[];
}

/**
 * A step. With `substeps` it is no action of its own but a group of them; its
 * `role` then applies to the sub-steps that name none.
 */
export interface ProcessStep extends ProcessSubstep, ProcessConditional, ProcessFollowUps {
    substeps?: ProcessSubstep[];
    /** A decision step (vscimpb95): where the process goes when the step before it has finished. */
    decision?: ProcessDecisionSpec;
    /**
     * A goto step (vscimpb96): when the process reaches it, it goes on at
     * this step or phase (a decision target, `<phase>/<step>`, `<phase>` or a
     * step of this phase) — an automatic decision step with one target, e.g.
     * to pass the other alternative at the end of a branch.
     */
    goto?: string;
}

/** The decision a step makes: its `decision:` block, or its `goto:` as an automatic decision with one target. */
export function decisionOf(step: ProcessStep | ProcessPostGateStep | undefined): ProcessDecisionSpec | undefined {
    const s = step as ProcessStep | undefined;
    if (!s) { return undefined; }
    if (s.decision) { return s.decision; }
    return typeof s.goto === 'string' && s.goto ? { mode: 'auto', targets: [{ to: s.goto }] } : undefined;
}

/**
 * How a decision step chooses its target: `auto` — the extension takes the
 * first target whose `when:` holds (a target without one always holds), the
 * user decides when none does or a variable is not set; `user` — the user
 * picks one in the Decide… dialog; `judge` — Proceed runs the step's prompt
 * and the agent picks one (tomAi_setProcessState `decide`), the user decides
 * when it does not.
 */
export type ProcessDecisionMode = 'auto' | 'user' | 'judge';

export const PROCESS_DECISION_MODES: readonly ProcessDecisionMode[] = ['auto', 'user', 'judge'];

/**
 * A target of a decision step: `to` names a step or phase of the process —
 * `<phase>/<step>`, `<phase>` (its first step), or a bare step id of the
 * decision step's own phase (a bare id names that phase's step when it has
 * one, else a phase).
 */
export interface ProcessDecisionTarget {
    to: string;
    /** What the choice says; default `Go to <where>`. */
    label?: string;
    /** When it is the one (auto); what it is for (user, judge — shown with it). */
    when?: ProcessCondition;
}

/** A step's `decision:` block. */
export interface ProcessDecisionSpec {
    /** Default `user`. */
    mode?: ProcessDecisionMode;
    targets: ProcessDecisionTarget[];
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

export interface ProcessPhase extends ProcessConditional, ProcessFollowUps {
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
    /**
     * The phases that may follow it (vscimpb96): ids, or `{phase | end,
     * when, label}`; at the decision at its end the user goes on to one whose
     * condition does not fail (only one left: that one). Unset: the following
     * phase (the end after the last); `[]`: the process ends after it.
     */
    next?: ProcessNextEntry[];
}

/** An entry of a phase's `next:` — a phase id, or `{phase | end: true, when, label}`. */
export type ProcessNextEntry = string | { phase?: string; end?: boolean; when?: ProcessCondition; label?: string };

export interface ProcessDefinition extends ProcessFollowUps {
    id: string;
    name?: string;
    /** One line; the full description is the process's `.md` file. */
    summary?: string;
    /** The session every prompt of the process runs in, unless a phase, step or sub-step names its own. */
    session?: ProcessSessionSpec;
    /** What the process takes when it is started from a step (`${input.<name>}`). */
    inputs?: ProcessIoDecl[];
    /** What it hands back to the step that started it as a subprocess (`${sub.<process>.<name>}`). */
    outputs?: ProcessIoDecl[];
    /**
     * The custom chat variables a run of this process keeps as its run
     * parameters (e.g. process_design's `design`, `design-mode`): what the
     * PROCESS view's Reset Process clears (vscimpb91).
     */
    runParameters?: string[];
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

const DEFINITION_KEYS = ['id', 'name', 'summary', 'session', 'inputs', 'outputs', 'runParameters', 'followUps', 'phases'];
const FOLLOW_UP_KEYS = ['process', 'phase', 'step', 'description', 'carry', 'context'];
const IO_KEYS = ['name', 'kind', 'description', 'required'];
const IO_KINDS: readonly ProcessIoKind[] = ['document', 'documents', 'folder'];
const CONDITIONAL_KEYS = ['optional', 'when'];
const PHASE_KEYS = ['id', 'name', 'description', 'prompt', 'session', 'repeatable', 'maxIterations', ...CONDITIONAL_KEYS, 'followUps', 'steps', 'gate', 'postGate', 'next'];
const NEXT_KEYS = ['phase', 'end', 'when', 'label'];
const SUBSTEP_KEYS = ['id', 'name', 'description', 'prompt', 'session', 'role', 'repeatable', 'maxIterations', 'userAction', 'subprocesses', 'branches', 'documents'];
const STEP_KEYS = [...SUBSTEP_KEYS, ...CONDITIONAL_KEYS, 'followUps', 'substeps', 'decision', 'goto'];
const DECISION_KEYS = ['mode', 'targets'];
const DECISION_TARGET_KEYS = ['to', 'label', 'when'];
const CONDITION_TESTS = ['equals', 'notEquals', 'in', 'set'];
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
    /**
     * The other processes (by id): a follow-up's process, phase and step must
     * exist. Unset: not checked (a definition is valid on its own; the
     * validator tool and the editor check them).
     */
    processOf?: (id: string) => ProcessDefinition | undefined;
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
        for (const key of ['subprocesses', 'branches']) { checkProcessList(obj, key, path); }
        checkDocuments(obj, path);
        if (obj.userAction === true) {
            for (const key of ['prompt', 'session']) {
                if (obj[key] !== undefined) { err(`${path}.${key}`, 'a user action runs no prompt — say what the user does in its description'); }
            }
        }
        return id;
    };
    const checkDocuments = (obj: Raw, path: string): void => {
        const list = obj.documents;
        if (list === undefined) { return; }
        const at = `${path}.documents`;
        if (!Array.isArray(list)) { err(at, 'a list of {path, label}'); return; }
        list.forEach((entry, i) => {
            const entryAt = `${at}[${i}]`;
            if (!isObject(entry)) { err(entryAt, 'an object {path, label}'); return; }
            unknownKeys(entry, ['path', 'label'], entryAt);
            if (typeof entry.path !== 'string' || !entry.path.trim()) { err(`${entryAt}.path`, 'a path (placeholders allowed)'); }
            checkText(entry, 'label', entryAt);
        });
    };
    const checkProcessList = (obj: Raw, key: string, path: string): void => {
        const list = obj[key];
        if (list === undefined) { return; }
        const at = `${path}.${key}`;
        if (!Array.isArray(list)) { err(at, 'a list of process ids (or {process, description})'); return; }
        const seen = new Set<string>();
        list.forEach((entry, i) => {
            const entryAt = `${at}[${i}]`;
            let id: unknown = entry;
            if (isObject(entry)) {
                unknownKeys(entry, ['process', 'description', 'inputs'], entryAt);
                checkText(entry, 'description', entryAt);
                if (entry.inputs !== undefined) {
                    if (!isObject(entry.inputs)) {
                        err(`${entryAt}.inputs`, 'a mapping of input name → value (a text the placeholder engine resolves)');
                    } else {
                        for (const [name, value] of Object.entries(entry.inputs)) {
                            if (!ID_PATTERN.test(name)) { err(`${entryAt}.inputs.${name}`, `an input name: ${ID_MESSAGE}`); }
                            if (typeof value !== 'string') { err(`${entryAt}.inputs.${name}`, 'text expected'); }
                        }
                    }
                }
                id = entry.process;
            }
            if (typeof id !== 'string' || id === '') { err(isObject(entry) ? `${entryAt}.process` : entryAt, 'a process id'); return; }
            if (!ID_PATTERN.test(id)) { err(isObject(entry) ? `${entryAt}.process` : entryAt, ID_MESSAGE); }
            if (seen.has(id)) { err(entryAt, `"${id}" is listed twice`); }
            seen.add(id);
        });
    };
    const checkFollowUps = (obj: Raw, path: string): void => {
        const list = obj.followUps;
        if (list === undefined) { return; }
        const at = `${path}${path ? '.' : ''}followUps`;
        if (!Array.isArray(list)) { err(at, 'a list of {process, phase, step, description, carry, context}'); return; }
        const seen = new Set<string>();
        list.forEach((entry, i) => {
            const entryAt = `${at}[${i}]`;
            if (!isObject(entry)) { err(entryAt, 'an object {process, phase, step, description, carry, context}'); return; }
            unknownKeys(entry, FOLLOW_UP_KEYS, entryAt);
            for (const key of ['phase', 'step']) {
                if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !ID_PATTERN.test(entry[key] as string))) { err(`${entryAt}.${key}`, `a ${key} id: ${ID_MESSAGE}`); }
            }
            if (entry.step !== undefined && entry.phase === undefined) { err(`${entryAt}.step`, 'a step is named within its phase: name the phase too'); }
            checkText(entry, 'description', entryAt);
            if (entry.carry !== undefined && (!Array.isArray(entry.carry) || entry.carry.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(v)))) {
                err(`${entryAt}.carry`, 'a list of chat variable names (`change`, `custom.change`)');
            }
            if (entry.context !== undefined) {
                if (!isObject(entry.context)) {
                    err(`${entryAt}.context`, 'a mapping of name → value (a text the placeholder engine resolves when the switch is made)');
                } else {
                    for (const [name, value] of Object.entries(entry.context)) {
                        if (!ID_PATTERN.test(name)) { err(`${entryAt}.context.${name}`, `a context name: ${ID_MESSAGE}`); }
                        if (typeof value !== 'string') { err(`${entryAt}.context.${name}`, 'text expected'); }
                    }
                }
            }
            if (typeof entry.process !== 'string' || !ID_PATTERN.test(entry.process)) { err(`${entryAt}.process`, `required: a process id (${ID_MESSAGE})`); return; }
            const key = `${entry.process}/${entry.phase ?? ''}/${entry.step ?? ''}`;
            if (seen.has(key)) { err(entryAt, `the follow-up ${followUpTarget(entry as unknown as ProcessFollowUp)} is listed twice`); }
            seen.add(key);
            if (!context.processOf) { return; }
            // The target must exist: the process, its phase, the step in that phase.
            const own = typeof raw === 'object' && raw !== null && (raw as Raw).id === entry.process ? raw as unknown as ProcessDefinition : undefined;
            const target = own ?? context.processOf(entry.process);
            if (!target || !Array.isArray(target.phases)) { err(`${entryAt}.process`, `no process "${entry.process}" under _ai/processes/`); return; }
            if (entry.phase === undefined) { return; }
            const phase = target.phases.find((p) => isObject(p) && p.id === entry.phase);
            if (!phase) { err(`${entryAt}.phase`, `the process "${entry.process}" has no phase "${entry.phase}" (its phases: ${target.phases.map((p) => p.id).join(', ')})`); return; }
            if (entry.step === undefined) { return; }
            const steps = [...(phase.steps ?? []), phase.gate, ...(phase.postGate ? [phase.postGate] : [])].filter(isObject).map((x) => (x as { id: string }).id);
            if (!steps.includes(entry.step as string)) { err(`${entryAt}.step`, `the phase "${entry.phase}" of "${entry.process}" has no step "${entry.step}" (its steps: ${steps.join(', ')})`); }
        });
    };
    const checkConditional = (obj: Raw, path: string): void => {
        if (obj.optional !== undefined && typeof obj.optional !== 'boolean') { err(`${path}.optional`, 'true or false'); }
        const when = obj.when;
        if (when === undefined) { return; }
        const at = `${path}.when`;
        const shape = '{var, equals | notEquals | in | set} (the extension decides) or {judge: text} (the agent decides at Proceed)';
        if (!isObject(when)) { err(at, shape); return; }
        if ('judge' in when) {
            unknownKeys(when, ['judge'], at);
            if (typeof when.judge !== 'string' || when.judge.trim() === '') { err(`${at}.judge`, 'the condition, as text the agent judges'); }
            return;
        }
        unknownKeys(when, ['var', ...CONDITION_TESTS], at);
        if (typeof when.var !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(when.var)) { err(`${at}.var`, 'a chat variable name (`spec-mode`, `custom.spec-mode`, `input.folder`)'); }
        const tests = CONDITION_TESTS.filter((k) => when[k] !== undefined);
        if (tests.length !== 1) { err(at, `exactly one of ${CONDITION_TESTS.join(', ')}`); return; }
        const test = tests[0];
        if ((test === 'equals' || test === 'notEquals') && typeof when[test] !== 'string') { err(`${at}.${test}`, 'text expected (quote numbers and true/false)'); }
        if (test === 'in' && (!Array.isArray(when.in) || when.in.length === 0 || when.in.some((v) => typeof v !== 'string'))) { err(`${at}.in`, 'a list of texts'); }
        if (test === 'set' && typeof when.set !== 'boolean') { err(`${at}.set`, 'true or false'); }
    };
    const decisionSteps: Array<{ path: string; phase: string; step: string; decision: Raw; goto?: true }> = [];
    const checkDecision = (obj: Raw, path: string): void => {
        const decision = obj.decision;
        if (decision === undefined) { return; }
        const at = `${path}.decision`;
        if (!isObject(decision)) { err(at, 'a decision step: {mode: auto | user | judge, targets: [{to, label, when}]}'); return; }
        unknownKeys(decision, DECISION_KEYS, at);
        if (decision.mode !== undefined && !PROCESS_DECISION_MODES.includes(decision.mode as ProcessDecisionMode)) { err(`${at}.mode`, '"auto" (the extension decides from chat variables), "user" (the Decide… dialog) or "judge" (the agent decides)'); }
        if (obj.substeps !== undefined) { err(`${at}`, 'a decision step has no sub-steps: it only chooses where the process goes'); }
        if (obj.userAction !== undefined) { err(`${path}.userAction`, 'a decision step is decided by its mode (user: the Decide… dialog), not confirmed as a user action'); }
        if (!Array.isArray(decision.targets) || decision.targets.length === 0) { err(`${at}.targets`, 'at least one target {to, label, when}'); return; }
        decision.targets.forEach((target, i) => {
            const tAt = `${at}.targets[${i}]`;
            if (!isObject(target)) { err(tAt, 'an object {to, label, when}'); return; }
            unknownKeys(target, DECISION_TARGET_KEYS, tAt);
            if (typeof target.to !== 'string' || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(target.to)) { err(`${tAt}.to`, 'required: `<phase>/<step>`, `<phase>` or a step of this phase'); }
            checkText(target, 'label', tAt);
            checkConditional(target, tAt);
            if (decision.mode === 'auto' && isObject(target.when) && 'judge' in target.when) { err(`${tAt}.when`, 'an automatic decision is taken from chat variables: {var, …}; a text to judge needs mode judge'); }
        });
    };
    const checkGoto = (obj: Raw, path: string): void => {
        if (obj.goto === undefined) { return; }
        if (typeof obj.goto !== 'string' || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(obj.goto)) { err(`${path}.goto`, '`<phase>/<step>`, `<phase>` or a step of this phase'); }
        if (obj.decision !== undefined) { err(`${path}.goto`, 'a step is a goto or a decision step, not both (a goto is a decision with one target)'); }
        if (obj.substeps !== undefined) { err(`${path}.goto`, 'a goto step has no sub-steps'); }
        if (obj.userAction !== undefined) { err(`${path}.userAction`, 'a goto step goes on by itself; it is no user action'); }
    };
    const checkStep = (obj: unknown, path: string, allowed: string[]): string => {
        const id = checkSubstep(obj, path, allowed, 'step');
        if (isObject(obj)) { checkConditional(obj, path); checkFollowUps(obj, path); checkDecision(obj, path); checkGoto(obj, path); }
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
    checkFollowUps(raw, '');
    if (raw.runParameters !== undefined) {
        const list = raw.runParameters;
        if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(v))) {
            err('runParameters', 'a list of chat variable names (`design`, `design-mode`)');
        } else if (new Set(list).size !== list.length) {
            err('runParameters', 'a variable is named twice');
        }
    }
    for (const key of ['inputs', 'outputs']) {
        const list = raw[key];
        if (list === undefined) { continue; }
        if (!Array.isArray(list)) { err(key, 'a list of {name, kind, description, required}'); continue; }
        const seen = new Set<string>();
        list.forEach((decl, i) => {
            const at = `${key}[${i}]`;
            if (!isObject(decl)) { err(at, 'an object expected'); return; }
            unknownKeys(decl, key === 'outputs' ? [...IO_KEYS, 'value'] : IO_KEYS, at);
            if (typeof decl.name !== 'string' || !ID_PATTERN.test(decl.name)) { err(`${at}.name`, `required: ${ID_MESSAGE}`); }
            else if (seen.has(decl.name)) { err(`${at}.name`, `"${decl.name}" is declared twice`); }
            if (typeof decl.name === 'string') { seen.add(decl.name); }
            if (decl.kind !== undefined && !IO_KINDS.includes(decl.kind as ProcessIoKind)) { err(`${at}.kind`, '"document", "documents" or "folder"'); }
            if (decl.required !== undefined && typeof decl.required !== 'boolean') { err(`${at}.required`, 'true or false'); }
            checkText(decl, 'description', at);
            if (key === 'outputs') { checkText(decl, 'value', at); }
        });
    }
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
            checkConditional(phase, path);
            checkFollowUps(phase, path);
            if (phase.next !== undefined) {
                if (!Array.isArray(phase.next)) {
                    err(`${path}.next`, 'a list of the phases that may follow: ids, or {phase | end: true, when, label}; [] ends the process');
                } else {
                    phase.next.forEach((entry, k) => {
                        const nAt = `${path}.next[${k}]`;
                        if (typeof entry === 'string') {
                            if (!ID_PATTERN.test(entry)) { err(nAt, `a phase id: ${ID_MESSAGE}`); }
                            return;
                        }
                        if (!isObject(entry)) { err(nAt, 'a phase id or {phase | end: true, when, label}'); return; }
                        unknownKeys(entry, NEXT_KEYS, nAt);
                        if ((entry.phase === undefined) === (entry.end !== true)) { err(nAt, 'exactly one of `phase: <id>` and `end: true`'); }
                        if (entry.phase !== undefined && (typeof entry.phase !== 'string' || !ID_PATTERN.test(entry.phase))) { err(`${nAt}.phase`, `a phase id: ${ID_MESSAGE}`); }
                        if (entry.end !== undefined && entry.end !== true) { err(`${nAt}.end`, 'true (the process ends here)'); }
                        checkText(entry, 'label', nAt);
                        checkConditional(entry, nAt);
                    });
                }
            }
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
                    if (isObject(step) && isObject(step.decision) && typeof step.id === 'string') {
                        decisionSteps.push({ path: `${stepPath}.decision`, phase: phaseId, step: step.id, decision: step.decision });
                    } else if (isObject(step) && typeof step.goto === 'string' && typeof step.id === 'string') {
                        decisionSteps.push({ path: stepPath, phase: phaseId, step: step.id, decision: { targets: [{ to: step.goto }] }, goto: true });
                    }
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
                if (isObject(phase.gate) && phase.gate.goto !== undefined) {
                    err(`${path}.gate.goto`, 'a gate is decided by Gate passed / failed; a phase names what follows it in `next:`');
                }
                if (isObject(phase.gate) && phase.gate.decision !== undefined) {
                    err(`${path}.gate.decision`, 'a gate is decided by Gate passed / failed; put a decision step among the phase\'s steps');
                }
                if (isObject(phase.gate) && phase.gate.userAction !== undefined) {
                    err(`${path}.gate.userAction`, 'a gate is the agents\' check; the user\'s approval is the Gate passed / failed decision');
                }
                for (const key of CONDITIONAL_KEYS) {
                    if (isObject(phase.gate) && phase.gate[key] !== undefined) {
                        err(`${path}.gate.${key}`, 'every phase that runs ends with its gate — make the phase optional or conditional instead');
                    }
                }
            }
            if (phase.postGate !== undefined) {
                const postPath = `${path}.postGate`;
                noteStep(checkStep(phase.postGate, postPath, POST_GATE_KEYS), postPath);
                if (isObject(phase.postGate) && phase.postGate.goto !== undefined) {
                    err(`${postPath}.goto`, 'the post-gate step ends its phase: name the phases that follow in the phase\'s `next:`');
                }
                if (isObject(phase.postGate) && phase.postGate.decision !== undefined) {
                    err(`${postPath}.decision`, 'a decision step is one of the phase\'s steps, not its post-gate step');
                }
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
    // Every decision target names a step or phase of this process, and not the decision step itself.
    if (Array.isArray(raw.phases)) {
        const phases = raw.phases.filter(isObject) as unknown as ProcessPhase[];
        for (const d of decisionSteps) {
            if (!Array.isArray(d.decision.targets)) { continue; }
            d.decision.targets.forEach((target, i) => {
                if (!isObject(target) || typeof target.to !== 'string') { return; }
                const found = resolveDecisionTarget(phases, d.phase, target.to);
                const tAt = d.goto ? `${d.path}.goto` : `${d.path}.targets[${i}].to`;
                if (!found) { err(tAt, `no step or phase "${target.to}" in the process (\`<phase>/<step>\`, \`<phase>\` or a step of the phase "${d.phase}")`); return; }
                if (found.phase.id === d.phase && found.step.id === d.step) { err(tAt, `a ${d.goto ? 'goto' : 'decision'} step cannot go to itself`); }
            });
        }
        // The phase graph (vscimpb96): `next:` names phases of the process; every phase is reached and every path can end.
        const ids = phases.map((p) => p.id);
        let graphOk = errors.length === 0;
        phases.forEach((phase, i) => {
            if (!Array.isArray(phase.next)) { return; }
            phase.next.forEach((entry, k) => {
                const target = typeof entry === 'string' ? entry : entry?.phase;
                if (target === undefined) { return; }
                if (!ids.includes(target)) { err(`phases[${i}].next[${k}]`, `no phase "${target}" (the phases: ${ids.join(', ')})`); graphOk = false; }
                else if (target === phase.id) { err(`phases[${i}].next[${k}]`, 'a phase cannot follow itself: make it repeatable'); graphOk = false; }
            });
        });
        if (graphOk && phases.length) {
            const graph = phaseGraph(phases as ProcessPhase[]);
            const reached = new Set<string>([phases[0].id]);
            const queue = [phases[0].id];
            while (queue.length) {
                for (const n of graph.edges.get(queue.shift()!) ?? []) { if (!reached.has(n)) { reached.add(n); queue.push(n); } }
            }
            phases.forEach((phase, i) => {
                if (!reached.has(phase.id)) { err(`phases[${i}]`, `the phase "${phase.id}" is never reached: no phase before it leads to it (the following phase by default, \`next:\`, a decision or goto step)`); }
            });
            const ending = new Set<string>(graph.ends);
            let grown = true;
            while (grown) {
                grown = false;
                for (const id of ids) {
                    if (!ending.has(id) && (graph.edges.get(id) ?? []).some((n) => ending.has(n))) { ending.add(id); grown = true; }
                }
            }
            phases.forEach((phase, i) => {
                if (reached.has(phase.id) && !ending.has(phase.id)) { err(`phases[${i}]`, `from the phase "${phase.id}" the process never ends: no path leads to a phase after which it ends (the last phase by default, \`next: []\` or \`{end: true}\`)`); }
            });
        }
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

/**
 * The text of a `.process.yaml` for `def`, keys in their documented order.
 *
 * With `previous` — the text of the file it replaces — the changes are made
 * in that file's YAML document instead (vscimpb92): what did not change keeps
 * its text, key order, quoting, block scalars and comments, so a revision
 * diffs as itself. Text that is not a readable mapping is written anew.
 * Either way a string a YAML 1.1 reader would take for a bool, null or number
 * (`yes`, `off`, `1:30`) is quoted.
 */
export function stringifyProcessDefinition(def: ProcessDefinition, previous?: string): string {
    const ordered = orderedProcessDefinition(def);
    let doc: Document | undefined;
    if (previous !== undefined && previous.trim() !== '') {
        const old = parseDocument(previous);
        if (old.errors.length === 0 && isMap(old.contents)) {
            mergeYamlNode(old, old.contents, ordered);
            doc = old;
        }
    }
    doc ??= new Document(ordered);
    quoteYaml11Ambiguous(doc);
    return doc.toString({ lineWidth: 0 });
}

/** A plain object (not an array, not null). */
const isPlainObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep equality of JSON-like values, key order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) { return true; }
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const ka = Object.keys(a).filter((k) => a[k] !== undefined);
        const kb = Object.keys(b).filter((k) => b[k] !== undefined);
        return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
    }
    return false;
}

const pairKey = (p: Pair): unknown => (isScalar(p.key) ? p.key.value : p.key);

/** `node` changed in place to hold `value` where it can; the node to put in its place. */
function mergeYamlNode(doc: Document, node: unknown, value: unknown): unknown {
    const current = node && typeof (node as YamlNode).toJSON === 'function' ? (node as YamlNode).toJSON() : node;
    if (sameJson(current, value)) { return node; }
    if (isMap(node) && isPlainObject(value)) { mergeYamlMap(doc, node, value); return node; }
    if (isSeq(node) && Array.isArray(value)) { mergeYamlSeq(doc, node, value); return node; }
    if (isScalar(node) && typeof node.value === 'string' && typeof value === 'string') {
        // The scalar keeps its style; a flow style cannot hold a line break nicely, so it gives it up then.
        const flow = node.type === Scalar.PLAIN || node.type === Scalar.QUOTE_SINGLE || node.type === Scalar.QUOTE_DOUBLE;
        if (flow && value.includes('\n')) { delete node.type; }
        node.value = value;
        return node;
    }
    return doc.createNode(value);
}

/** The pairs of `map` brought to `value`: changed in place, removed, new ones after their predecessor in `value`'s order. */
function mergeYamlMap(doc: Document, map: YAMLMap, value: Raw): void {
    const wanted = Object.keys(value).filter((k) => value[k] !== undefined);
    map.items = map.items.filter((p) => wanted.includes(String(pairKey(p))));
    wanted.forEach((key, i) => {
        const pair = map.items.find((p) => String(pairKey(p)) === key);
        if (pair) { pair.value = mergeYamlNode(doc, pair.value, value[key]); return; }
        const fresh = doc.createPair(key, value[key]) as Pair;
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
            const before = map.items.findIndex((p) => String(pairKey(p)) === wanted[j]);
            if (before >= 0) { at = before + 1; break; }
        }
        map.items.splice(at, 0, fresh);
    });
}

/** The items of `seq` brought to `value`: entries with an `id` matched by it, the others by position. */
function mergeYamlSeq(doc: Document, seq: YAMLSeq, value: unknown[]): void {
    const idOf = (v: unknown): string | undefined => {
        const id = isMap(v) ? v.get('id') : isPlainObject(v) ? v.id : undefined;
        return typeof id === 'string' ? id : undefined;
    };
    const byId = value.length > 0 && value.every((v) => idOf(v) !== undefined) && seq.items.every((n) => idOf(n) !== undefined);
    const used = new Set<unknown>();
    seq.items = value.map((v, i) => {
        const old = byId ? seq.items.find((n) => !used.has(n) && idOf(n) === idOf(v)) : seq.items[i];
        if (old === undefined) { return doc.createNode(v); }
        used.add(old);
        return mergeYamlNode(doc, old, v);
    });
}

/** True when a YAML 1.1 reader takes the plain scalar `text` for something other than a string. */
export function yaml11ReadsAsNonString(text: string): boolean {
    if (text === '' || text.includes('\n')) { return false; }
    try {
        const v: unknown = parse(text, { version: '1.1' });
        return v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint';
    } catch {
        return false;
    }
}

/** Every string value a YAML 1.1 reader would take for a bool, null or number is double-quoted. */
function quoteYaml11Ambiguous(doc: Document): void {
    visit(doc, {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the yaml visitor's node-kind key
        Scalar(key, node) {
            if (key === 'key' || typeof node.value !== 'string') { return; }
            if (node.type !== undefined && node.type !== Scalar.PLAIN) { return; }
            if (yaml11ReadsAsNonString(node.value)) { node.type = Scalar.QUOTE_DOUBLE; }
        },
    });
}

/** `def` as a plain object, keys in their documented order and empty ones left out. */
function orderedProcessDefinition(def: ProcessDefinition): Raw {
    const pick = (obj: object, keys: string[]): Raw => {
        const out: Raw = {};
        for (const key of keys) {
            const value = (obj as Raw)[key];
            if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0 && key !== 'steps')) { continue; }
            out[key] = value;
        }
        return out;
    };
    // A list entry with nothing but its process is written as the bare id; empty inputs are left out.
    const entry = (e: ProcessListEntry): ProcessListEntry => {
        if (typeof e === 'string') { return e; }
        const inputs = Object.fromEntries(Object.entries(e.inputs ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
        if (!e.description && Object.keys(inputs).length === 0) { return e.process; }
        return { process: e.process, ...(e.description ? { description: e.description } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
    };
    // A follow-up's keys in their order, empty ones left out.
    const followUp = (f: ProcessFollowUp): Raw => {
        const out = pick(f, ['process', 'phase', 'step', 'description', 'carry']);
        const context = Object.fromEntries(Object.entries(f.context ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
        if (Object.keys(context).length) { out.context = context; }
        return out;
    };
    const lists = (out: Raw): Raw => {
        for (const key of ['subprocesses', 'branches']) {
            if (Array.isArray(out[key])) { out[key] = (out[key] as ProcessListEntry[]).map(entry); }
        }
        if (Array.isArray(out.followUps)) { out.followUps = (out.followUps as ProcessFollowUp[]).map(followUp); }
        // A document as {path, label}, the label left out when empty.
        if (Array.isArray(out.documents)) {
            out.documents = (out.documents as ProcessDocument[]).map((d) => ({ path: d.path, ...(d.label ? { label: d.label } : {}) }));
        }
        return out;
    };
    const substep = (s: ProcessSubstep): Raw => lists(pick(s, SUBSTEP_KEYS));
    const step = (s: ProcessStep): Raw => {
        const out = lists(pick(s, [...SUBSTEP_KEYS, ...CONDITIONAL_KEYS, 'followUps']));
        if (s.substeps && s.substeps.length) { out.substeps = s.substeps.map(substep); }
        if (typeof s.goto === 'string' && s.goto) { out.goto = s.goto; }
        if (s.decision) {
            out.decision = {
                ...(s.decision.mode ? { mode: s.decision.mode } : {}),
                targets: s.decision.targets.map((t) => pick(t, DECISION_TARGET_KEYS)),
            };
        }
        return out;
    };
    return {
        ...pick(def, ['id', 'name', 'summary', 'session']),
        ...(def.inputs?.length ? { inputs: def.inputs.map((d) => pick(d, IO_KEYS)) } : {}),
        ...(def.outputs?.length ? { outputs: def.outputs.map((d) => pick(d, [...IO_KEYS, 'value'])) } : {}),
        ...(def.runParameters?.length ? { runParameters: [...def.runParameters] } : {}),
        ...(def.followUps?.length ? { followUps: def.followUps.map(followUp) } : {}),
        phases: def.phases.map((p) => {
            const gate = step(p.gate);
            for (const key of CONDITIONAL_KEYS) { delete gate[key]; }
            if (p.gate.onFail) { gate.onFail = p.gate.onFail; }
            const out: Raw = { ...lists(pick(p, ['id', 'name', 'description', 'prompt', 'session', 'repeatable', 'maxIterations', ...CONDITIONAL_KEYS, 'followUps'])), steps: p.steps.map(step), gate };
            if (Array.isArray(p.next)) { out.next = p.next.map((e) => (typeof e === 'string' ? e : pick(e, NEXT_KEYS))); }
            if (p.postGate) {
                const post = step(p.postGate);
                if (p.postGate.todos && p.postGate.todos.length) { post.todos = p.postGate.todos.map((t) => pick(t, TODO_KEYS)); }
                if (p.postGate.todoPrefix) { post.todoPrefix = p.postGate.todoPrefix; }
                out.postGate = post;
            }
            return out;
        }),
    };
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
    /**
     * The iteration each phase of the process other than the current one was
     * last in (vscimpb93), so "Back to the start of the previous phase" counts
     * it on and the phase's round folders continue. Kept by
     * {@link trackStepIterations}; dropped when the process changes.
     */
    phaseIterations?: Record<string, number>;
    /** The jumps decision steps made (vscimpb95), oldest first: where from, where to, why. */
    jumps?: ProcessJumpRecord[];
    /** The phases the process went through (vscimpb96), oldest first: each phase iteration it entered. */
    phasePath?: ProcessPathEntry[];
    /**
     * The agent's choice at a decision step in `judge` mode (tomAi_setProcessState
     * `decide`): the target's index and why; taken when the step's Proceed run
     * ends, at once without one. Dropped when the position changes.
     */
    decide?: { target: number; reason: string };
    /**
     * A transient mark on a move's target: Back, a correction — the phase it
     * leaves is not recorded in `phaseIterations`. Never written.
     */
    correction?: true;
    /**
     * A level above the quest's own process (src/utils/processStack.ts): it
     * was started from the step of the level below as a subprocess or a
     * branch, with the follow-up the parent step gets when it ends.
     */
    nested?: NestedLevelInfo;
    /**
     * The level above this one ended (finished or aborted) with the follow-up
     * "ask me at the end": a decision — Go on (past the step) or Run the step
     * again. Dropped by the choice.
     */
    nestedEnded?: NestedLevelEnd;
    /** A nested level: its process's inputs as filled when it started (`${input.<name>}`). */
    inputs?: Record<string, string>;
    /** A nested level: the outputs set while it runs (tomAi_setProcessState `outputs`). */
    outputs?: Record<string, string>;
    /**
     * The outputs the subprocesses started from this level handed back, by
     * process id (the latest run of each): `${sub.<process>.<name>}`.
     */
    subOutputs?: Record<string, Record<string, string>>;
    /**
     * The agent's suggestions of processes this position lists
     * (tomAi_suggestSubprocess), kept with the step: dropped when the level
     * moves to another position or a level is started from it.
     */
    suggestions?: StoredSuggestion[];
    /**
     * The step's queue run finished while it holds suggestions: the move its
     * marker would have made waits until the user starts one of them (the
     * level waits) or dismisses them (the move is made).
     */
    suggestionsDue?: { kind: ProcessMoveKind; level?: ProcessLevel; label: string };
    /** The subprocesses and branches started from this level so far, oldest first (at most 50). */
    nestedRuns?: NestedRunRecord[];
    /**
     * The phases and steps left out so far, oldest first (at most 50): passed
     * by because their `when:` did not hold, or left out by the user or the
     * agent — which alternative ran is what is not here.
     */
    skipped?: ProcessSkipRecord[];
    /**
     * The agent judged the running phase's or step's `when:` not to hold
     * (tomAi_setProcessState `leaveOut`): when its Proceed run ends, the
     * process leaves it out instead of moving on through it. Dropped by every
     * change of position.
     */
    leaveOut?: { level: 'phase' | 'step'; reason: string };
    /**
     * Where the process came from by follow-ups (vscimpb47), oldest first (at
     * most {@link MAX_ORIGIN_RECORDS}): each switch adds the position it was
     * made from. Its last entry is `${process-origin}`, its call context
     * `${origin.<name>}`. Kept by every move within the process; a process
     * set by hand starts without it.
     */
    origins?: ProcessOrigin[];
}

/** A switch to a follow-up process: where it was made from, and what it took along. */
export interface ProcessOrigin {
    process: string;
    phase: string;
    phaseIteration: number;
    step: string;
    stepIteration: number;
    /** The level whose follow-up it was: the process (at its end), a phase, a step. */
    level: 'process' | 'phase' | 'step';
    /** ISO time of the switch. */
    at: string;
    /** The carried chat variables and their values at the switch (a variable not set is recorded empty). */
    carried?: Record<string, string>;
    /** The call context, resolved at the switch (`${origin.<name>}`). */
    context?: Record<string, string>;
}

/** How many follow-up switches a state remembers. */
export const MAX_ORIGIN_RECORDS = 20;

/** A phase or step left out, and why. */
export interface ProcessSkipRecord {
    phase: string;
    phaseIteration: number;
    /** The step left out; unset: the whole phase. */
    step?: string;
    reason: string;
    /** Its `when:` did not hold (the extension decided), the user's Leave out, the agent's judgement. */
    by: 'condition' | 'user' | 'agent';
    /** ISO time. */
    at: string;
}

/** How many skip records a level keeps. */
export const MAX_SKIP_RECORDS = 50;

/** A position as a jump record names it. */
export interface ProcessJumpEnd {
    phase: string;
    phaseIteration: number;
    step: string;
    stepIteration: number;
}

/** A jump a decision step made (vscimpb95). */
export interface ProcessJumpRecord {
    from: ProcessJumpEnd;
    to: ProcessJumpEnd;
    /** The target's label. */
    label: string;
    /** Why: the condition that held, the agent's reason, '' for the user. */
    reason: string;
    /** The extension (auto, a condition held), the agent (judge) or the user (the Decide… dialog). */
    by: 'condition' | 'agent' | 'user';
    /** ISO time. */
    at: string;
}

/** How many jump records a level keeps. */
export const MAX_JUMP_RECORDS = 50;

/** A phase iteration the process entered (vscimpb96). */
export interface ProcessPathEntry { phase: string; phaseIteration: number }

/** How many path entries a level keeps. */
export const MAX_PATH_ENTRIES = 100;

/** An agent's suggestion of a process the position lists. */
export interface StoredSuggestion {
    kind: NestedKind;
    process: string;
    reason: string;
    followUp?: NestedFollowUp;
    /** ISO time it was made. */
    at: string;
}

/** A position of a level, without its process. */
export interface LevelPosition {
    phase: string;
    phaseIteration: number;
    step: string;
    stepIteration: number;
    substep: string;
    substepIteration: number;
}

/** A subprocess or branch started from a level, and how it ended. */
export interface NestedRunRecord {
    process: string;
    kind: NestedKind;
    /** The position of the level it was started from. */
    from: LevelPosition;
    startedAt: string;
    endedAt: string;
    outcome: 'finished' | 'aborted';
    followUp: NestedFollowUp;
    /** Where the level stood when it ended (an aborted one was left there). */
    left: LevelPosition;
    /** The outputs it handed back (a finished subprocess). */
    outputs?: Record<string, string>;
}

/** Started as a subprocess (hands a result back) or a branch (hands nothing back). */
export type NestedKind = 'subprocess' | 'branch';

/**
 * What the parent step does when the level ends: `ask` — the decision Go on /
 * Run the step again; `go-on` — past the step, as if the level was its work;
 * `run-again` — the step stays, its next Proceed runs it again.
 */
export type NestedFollowUp = 'ask' | 'go-on' | 'run-again';

export interface NestedLevelInfo {
    kind: NestedKind;
    followUp: NestedFollowUp;
    /** ISO time it was started. */
    startedAt: string;
}

export interface NestedLevelEnd {
    process: string;
    kind: NestedKind;
    outcome: 'finished' | 'aborted';
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
    after = trackPhaseIterations(before, after);
    const samePhase = before.process === after.process && before.phase === after.phase
        && before.phaseIteration === after.phaseIteration && !!after.phase;
    if (!samePhase) { return withoutRecord(after); }
    const steps = { ...(recordOf(before)?.steps ?? {}) };
    if (before.step && before.step !== after.step) { steps[before.step] = before.stepIteration; }
    if (Object.keys(steps).length === 0) { return withoutRecord(after); }
    return { ...after, stepIterations: { phase: after.phase, phaseIteration: after.phaseIteration, steps } };
}

/**
 * `after` with the phases' last iterations (vscimpb93): within one process,
 * the phase `before` was in keeps the highest iteration it reached when the
 * move leaves it; another process starts without a record.
 */
function trackPhaseIterations(before: ProcessState, after: ProcessState): ProcessState {
    const { phaseIterations: _old, correction, phasePath: _p, ...tail } = after;
    // The path taken (vscimpb96): every phase iteration entered; a new process starts a new path.
    const sameProcess = !!after.process && before.process === after.process;
    const path = sameProcess ? [...(before.phasePath ?? [])] : [];
    const last = path[path.length - 1];
    if (after.process && after.phase && (!last || last.phase !== after.phase || last.phaseIteration !== after.phaseIteration)) {
        if (correction && path.length > 1 && path[path.length - 2].phase === after.phase) { path.pop(); } else { path.push({ phase: after.phase, phaseIteration: after.phaseIteration }); }
    }
    const rest: ProcessState = path.length ? { ...tail, phasePath: path.slice(-MAX_PATH_ENTRIES) } : tail;
    if (!after.process || before.process !== after.process) { return rest; }
    const phases = { ...(before.phaseIterations ?? {}) };
    // Back is a correction: the phase it leaves did not run its round.
    if (!correction && before.phase && (before.phase !== after.phase || before.phaseIteration !== after.phaseIteration)) {
        phases[before.phase] = Math.max(phases[before.phase] ?? 0, before.phaseIteration);
    }
    return Object.keys(phases).length ? { ...rest, phaseIterations: phases } : rest;
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
    /**
     * Set outputs of the running subprocess or branch (its process's declared
     * outputs), merged with those set before; applied by ProcessStateStore
     * before the rest of the change, so `{outputs, completed: true}` hands
     * them back as the level finishes.
     */
    outputs?: Record<string, string>;
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
// Conditions — optional and conditional phases and steps
// ============================================================================

/** Reads a variable a condition names; undefined (or '') when it is not set. */
export type ConditionLookup = (name: string) => string | undefined;

/** What the moves need to decide `when:` conditions. */
export interface ConditionOptions {
    /** The variables conditions read. Without it no condition is decided and nothing is passed by. */
    lookup?: ConditionLookup;
    /** The time skip records carry; default now. */
    now?: string;
    /** The other processes, for the follow-up options of a decision. Without it none is offered. */
    processOf?: (id: string) => ProcessDefinition | undefined;
}

/** `holds` / `fails`: the extension decided; `judge`: the agent judges it (a `judge:` condition, a variable not set). */
export type ConditionVerdict = 'holds' | 'fails' | 'judge';

export function isJudgeCondition(cond: ProcessCondition): cond is ProcessJudgeCondition {
    return typeof (cond as ProcessJudgeCondition).judge === 'string';
}

/** Decide `cond` from `lookup`; see {@link ProcessCondition}. */
export function evaluateCondition(cond: ProcessCondition, lookup?: ConditionLookup): ConditionVerdict {
    if (isJudgeCondition(cond)) { return 'judge'; }
    if (!lookup) { return 'judge'; }
    const value = lookup(cond.var) ?? '';
    const verdict = (b: boolean): ConditionVerdict => (b ? 'holds' : 'fails');
    if (cond.set !== undefined) { return verdict((value !== '') === cond.set); }
    if (value === '') { return 'judge'; }
    if (cond.equals !== undefined) { return verdict(value === cond.equals); }
    if (cond.notEquals !== undefined) { return verdict(value !== cond.notEquals); }
    if (cond.in !== undefined) { return verdict(cond.in.includes(value)); }
    return 'judge';
}

/** The condition as a reader says it: `` `spec-mode` is `change` ``, or the judge text. */
export function conditionText(cond: ProcessCondition): string {
    if (isJudgeCondition(cond)) { return cond.judge.trim(); }
    const v = `\`${cond.var}\``;
    if (cond.set !== undefined) { return cond.set ? `${v} is set` : `${v} is not set`; }
    if (cond.equals !== undefined) { return `${v} is \`${cond.equals}\``; }
    if (cond.notEquals !== undefined) { return `${v} is not \`${cond.notEquals}\``; }
    return `${v} is one of ${(cond.in ?? []).map((x) => `\`${x}\``).join(', ')}`;
}

/**
 * A lookup over variable values (chat variables as the placeholder engine
 * has them): a name as given, else as `custom.<name>` (or without `custom.`),
 * and `input.<name>` from the level's inputs.
 */
export function conditionLookup(values: Readonly<Record<string, string>>, state?: ProcessState): ConditionLookup {
    return (name) => {
        const v = name.startsWith('input.')
            ? state?.inputs?.[name.slice('input.'.length)]
            : values[name] ?? values[`custom.${name}`] ?? (name.startsWith('custom.') ? values[name.slice('custom.'.length)] : undefined);
        return v === '' ? undefined : v;
    };
}

function addSkip(state: ProcessState, record: ProcessSkipRecord): ProcessState {
    return { ...state, skipped: [...(state.skipped ?? []), record].slice(-MAX_SKIP_RECORDS) };
}

function withoutLeaveOut(state: ProcessState): ProcessState {
    if (!state.leaveOut) { return state; }
    const { leaveOut: _l, ...rest } = state;
    return rest;
}

/** The first position of the phase after `phase`; null after the last. */
function afterPhase(def: ProcessDefinition, state: ProcessState, phase: ProcessPhase, lookup?: ConditionLookup): ProcessState | null {
    const next = autoSuccessor(def, phase, lookup);
    return next ? enterPhase(state, next) : null;
}

/** The position after the whole step `stepId` of `phase` (the next step, else the next phase); null at the end. */
function afterStep(def: ProcessDefinition, state: ProcessState, phase: ProcessPhase, stepId: string, lookup?: ConditionLookup): ProcessState | null {
    const entries = phaseSteps(phase);
    const index = entries.findIndex((e) => e.step.id === stepId);
    if (index >= 0 && index < entries.length - 1) {
        const next = entries[index + 1].step;
        return withStep(state, next, reentryIteration(state, phase, next));
    }
    return afterPhase(def, state, phase, lookup);
}

/**
 * The phase graph (vscimpb96): for each phase the phases that may follow it —
 * its `next:` (the following phase by default) and the phases its decision
 * and goto steps jump to — and the phases after which the process may end.
 */
export function phaseGraph(phases: readonly ProcessPhase[]): { edges: Map<string, string[]>; ends: string[] } {
    const edges = new Map<string, string[]>();
    const ends: string[] = [];
    phases.forEach((phase, i) => {
        const out = new Set<string>();
        let ends_ = false;
        if (Array.isArray(phase.next)) {
            if (phase.next.length === 0) { ends_ = true; }
            for (const entry of phase.next) {
                if (typeof entry === 'string') { out.add(entry); } else if (entry && entry.end === true) { ends_ = true; } else if (entry && typeof entry.phase === 'string') { out.add(entry.phase); }
            }
        } else if (phases[i + 1]) {
            out.add(phases[i + 1].id);
        } else {
            ends_ = true;
        }
        for (const step of Array.isArray(phase.steps) ? phase.steps : []) {
            for (const t of decisionOf(step)?.targets ?? []) {
                const found = typeof t?.to === 'string' ? resolveDecisionTarget(phases, phase.id, t.to) : null;
                if (found && found.phase.id !== phase.id) { out.add(found.phase.id); }
            }
        }
        edges.set(phase.id, [...out]);
        if (ends_) { ends.push(phase.id); }
    });
    return { edges, ends };
}

/** A successor of a phase: the phase it leads to (null: the end of the process), its label and its `next:` index. */
export interface PhaseSuccessor { phase: ProcessPhase | null; label?: string; when?: ProcessCondition; index: number }

/** What may follow `phase` (vscimpb96): its `next:` entries in order, or the following phase (the end after the last). */
export function phaseSuccessors(def: ProcessDefinition, phase: ProcessPhase): PhaseSuccessor[] {
    if (!Array.isArray(phase.next)) {
        return [{ phase: def.phases[def.phases.indexOf(phase) + 1] ?? null, index: 0 }];
    }
    if (phase.next.length === 0) { return [{ phase: null, index: 0 }]; }
    return phase.next.map((entry, index) => {
        if (typeof entry === 'string') { return { phase: findPhase(def, entry) ?? null, index }; }
        return { phase: entry.end ? null : findPhase(def, entry.phase ?? '') ?? null, ...(entry.label ? { label: entry.label } : {}), ...(entry.when ? { when: entry.when } : {}), index };
    });
}

/** The successors the decision at the end of `phase` offers: those whose condition does not fail (all of them when every one fails). */
function offeredSuccessors(def: ProcessDefinition, phase: ProcessPhase, lookup?: ConditionLookup): PhaseSuccessor[] {
    const all = phaseSuccessors(def, phase);
    const open = all.filter((x) => !x.when || evaluateCondition(x.when, lookup) !== 'fails');
    return open.length ? open : all;
}

/** The successor a move that passes `phase` by (left out, its condition fails) takes: the first offered one. */
function autoSuccessor(def: ProcessDefinition, phase: ProcessPhase, lookup?: ConditionLookup): ProcessPhase | null {
    return offeredSuccessors(def, phase, lookup)[0]?.phase ?? null;
}

/** Whether the process may end after `phase` (its process follow-ups are offered there). */
function phaseMayEnd(def: ProcessDefinition, phase: ProcessPhase): boolean {
    return phaseSuccessors(def, phase).some((x) => x.phase === null);
}

/** The first position of `phase`, entered from `state` by a move on: its iteration counted on (phaseEntryIteration). */
function enterPhase(state: ProcessState, phase: ProcessPhase): ProcessState {
    return withStep(withoutRecord({ ...state, phase: phase.id, phaseIteration: phaseEntryIteration(state, phase) }), firstStepOf(phase), 1);
}

/**
 * The step and phase a decision target names (vscimpb95): `<phase>/<step>`,
 * `<phase>` (its first step), or a bare id — a step of the decision step's
 * own phase when it has one, else a phase. Null when nothing matches.
 */
export function resolveDecisionTarget(phases: readonly ProcessPhase[], fromPhase: string, to: string): { phase: ProcessPhase; step: ProcessStep } | null {
    const stepsOf = (p: ProcessPhase): ProcessStep[] => [...(Array.isArray(p.steps) ? p.steps : []), p.gate, ...(p.postGate ? [p.postGate] : [])]
        .filter((x): x is ProcessStep => !!x && typeof x === 'object' && typeof (x as ProcessStep).id === 'string');
    const [first, second] = to.split('/');
    if (second !== undefined) {
        const phase = phases.find((p) => p.id === first);
        const step = phase ? stepsOf(phase).find((x) => x.id === second) : undefined;
        return phase && step ? { phase, step } : null;
    }
    const own = phases.find((p) => p.id === fromPhase);
    const ownStep = own ? stepsOf(own).find((x) => x.id === first) : undefined;
    if (own && ownStep) { return { phase: own, step: ownStep }; }
    const phase = phases.find((p) => p.id === first);
    const start = phase ? stepsOf(phase)[0] : undefined;
    return phase && start ? { phase, step: start } : null;
}

/** The label of a decision target: its own, else `Go to <where>`. */
export function decisionTargetLabel(def: ProcessDefinition, fromPhase: string, target: ProcessDecisionTarget): string {
    if (target.label && target.label.trim()) { return target.label.trim(); }
    const found = resolveDecisionTarget(def.phases, fromPhase, target.to);
    if (!found) { return `Go to ${target.to}`; }
    return `Go to ${found.phase.id === fromPhase ? nameOf(found.step) : `${nameOf(found.phase)} › ${nameOf(found.step)}`}`;
}

/** The first target of an automatic decision whose `when:` holds (none: always); null when a condition cannot be decided or none holds. */
function autoDecisionTarget(spec: ProcessDecisionSpec, lookup: ConditionLookup): { index: number; reason: string } | null {
    for (let i = 0; i < spec.targets.length; i++) {
        const when = spec.targets[i].when;
        if (!when) { return { index: i, reason: 'the default target (no condition)' }; }
        const verdict = evaluateCondition(when, lookup);
        if (verdict === 'holds') { return { index: i, reason: `${conditionText(when)} holds` }; }
        if (verdict === 'judge') { return null; }
    }
    return null;
}

/**
 * The position a decision step's target `index` leads to, the jump recorded
 * (vscimpb95). Iterations count on: within the step's own phase iteration the
 * target step continues at its next iteration (the steps after it as they come
 * round again); another phase starts at the iteration after the one it was
 * last in (1 when it has not run), its steps at 1.
 */
function jumpTarget(def: ProcessDefinition, from: ProcessState, phase: ProcessPhase, step: ProcessStep, index: number, by: ProcessJumpRecord['by'], reason: string, now: string): ProcessState {
    const target = decisionOf(step)!.targets[index];
    const found = resolveDecisionTarget(def.phases, phase.id, target.to)!;
    const { decide: _d, decision: _x, ...base } = from;
    let to: ProcessState;
    if (found.phase.id === from.phase) {
        to = withStep(base, found.step, reentryIteration(base, found.phase, found.step));
    } else {
        to = withStep(withoutRecord({ ...base, phase: found.phase.id, phaseIteration: phaseEntryIteration(base, found.phase) }), found.step, 1);
    }
    const record: ProcessJumpRecord = {
        from: { phase: from.phase, phaseIteration: from.phaseIteration, step: from.step, stepIteration: from.stepIteration },
        to: { phase: to.phase, phaseIteration: to.phaseIteration, step: to.step, stepIteration: to.stepIteration },
        label: decisionTargetLabel(def, phase.id, target), reason, by, at: now,
    };
    return { ...to, jumps: [...(from.jumps ?? []), record].slice(-MAX_JUMP_RECORDS) };
}

/** The running step when it is a decision step: its phase, the step and its `decision:` block. */
export function decisionStepAt(def: ProcessDefinition | null, state: ProcessState): { phase: ProcessPhase; step: ProcessStep; spec: ProcessDecisionSpec; mode: ProcessDecisionMode } | null {
    if (!def || !state.process || state.completed) { return null; }
    const phase = findPhase(def, state.phase);
    const step = phase ? findStep(phase, state.step) : undefined;
    const spec = step && phase && step !== phase.gate && step !== phase.postGate ? decisionOf(step) : undefined;
    if (!phase || !step || !spec) { return null; }
    return { phase, step, spec, mode: spec.mode ?? 'user' };
}

/** The choices of a decision step's decision: one jump per target, each with where it leads (past what conditions leave out). */
function decisionStepOptions(def: ProcessDefinition, here: ProcessState, pos: Position, options: ConditionOptions): ProcessMove[] {
    const step = pos.entries[pos.stepIndex].step as ProcessStep;
    const now = options.now ?? new Date().toISOString();
    return decisionOf(step)!.targets.map((t, i) => ({
        kind: 'jump' as const,
        label: decisionTargetLabel(def, pos.phase.id, t),
        target: passExcluded(def, here, jumpTarget(def, here, pos.phase, step, i, 'user', '', now), options),
        key: `target:${i}`,
        branchOption: true as const,
    }));
}

/**
 * Where Proceed at a decision step leads: auto — the first target whose
 * condition holds; judge — the target the agent chose (`decide`); else, and
 * when nothing decides it, the decision (the user picks in the dialog).
 */
function decisionStepProceed(def: ProcessDefinition, state: ProcessState, here: ProcessState, pos: Position, options: ConditionOptions): ProcessState {
    const step = pos.entries[pos.stepIndex].step as ProcessStep;
    const spec = decisionOf(step)!;
    const mode = spec.mode ?? 'user';
    const now = options.now ?? new Date().toISOString();
    const take = (index: number, by: ProcessJumpRecord['by'], reason: string): ProcessState =>
        passExcluded(def, here, jumpTarget(def, here, pos.phase, step, index, by, reason, now), options);
    if (mode === 'auto' && options.lookup) {
        const chosen = autoDecisionTarget(spec, options.lookup);
        if (chosen) { return take(chosen.index, 'condition', chosen.reason); }
    }
    if (mode === 'judge' && state.decide && spec.targets[state.decide.target]) {
        return take(state.decide.target, 'agent', state.decide.reason);
    }
    const { decide: _d, ...rest } = here;
    return { ...rest, decision: true };
}

/** The target of a decision step a choice names: its label (any case) or its `to`; -1 when none. */
export function decisionTargetIndex(def: ProcessDefinition, fromPhase: string, spec: ProcessDecisionSpec, choice: string): number {
    const want = choice.trim().toLowerCase();
    return spec.targets.findIndex((t) => decisionTargetLabel(def, fromPhase, t).toLowerCase() === want || t.to.toLowerCase() === want);
}

/**
 * Where a forward move from `from` to `target` really leads: every phase it
 * enters and every step it enters whose `when:` the extension decides does
 * not hold is passed by, and recorded in `skipped`. Past the last phase the
 * process is finished. A decision position, a finished process, a condition
 * the agent judges and a move without `options.lookup` stay as they are.
 */
export function passExcluded(def: ProcessDefinition, from: ProcessState, target: ProcessState, options: ConditionOptions = {}): ProcessState {
    if (!options.lookup) { return target; }
    const now = options.now ?? new Date().toISOString();
    const decided = new Set<string>();
    let prev = from;
    let at = target;
    for (let guard = 0; guard < 10_000; guard++) {
        if (at.completed || at.decision) { return at; }
        const phase = findPhase(def, at.phase);
        if (!phase) { return at; }
        const entersPhase = at.phase !== prev.phase || at.phaseIteration !== prev.phaseIteration;
        let next: ProcessState | null | undefined;
        if (entersPhase && phase.when && evaluateCondition(phase.when, options.lookup) === 'fails') {
            at = addSkip(at, { phase: phase.id, phaseIteration: at.phaseIteration, reason: `runs only when ${conditionText(phase.when)}`, by: 'condition', at: now });
            next = afterPhase(def, at, phase, options.lookup);
        } else {
            const step = findStep(phase, at.step);
            const entersStep = entersPhase || at.step !== prev.step || at.stepIteration !== prev.stepIteration;
            if (!step || !entersStep || step === phase.gate) { return at; }
            if (step.when && evaluateCondition(step.when, options.lookup) === 'fails') {
                at = addSkip(at, { phase: phase.id, phaseIteration: at.phaseIteration, step: step.id, reason: `runs only when ${conditionText(step.when)}`, by: 'condition', at: now });
                next = afterStep(def, at, phase, step.id, options.lookup);
            } else if (decisionOf(step)) {
                // A decision step entered: auto decides now (each step once per pass), user decides in the dialog, judge at Proceed.
                const spec = decisionOf(step)!;
                const mode = spec.mode ?? 'user';
                if (mode === 'judge') { return at; }
                const where = `${phase.id}#${at.phaseIteration}/${step.id}`;
                const chosen = mode === 'auto' && !decided.has(where) ? autoDecisionTarget(spec, options.lookup) : null;
                if (!chosen) { return { ...at, decision: true }; }
                decided.add(where);
                next = jumpTarget(def, at, phase, step, chosen.index, 'condition', chosen.reason, now);
            } else {
                return at;
            }
        }
        if (!next) { return { ...at, completed: true }; }
        prev = at;
        at = next;
    }
    return at;
}

/** Whether the conditional fields of `node` make it something that may be left out. */
function leavable(node: ProcessConditional): boolean {
    return node.optional === true || node.when !== undefined;
}

/**
 * The Leave out moves at `pos`: the phase at its first position, the step
 * (not a gate) anywhere in it, when they are optional or conditional. The
 * record says who left it out: the agent when it judged the condition
 * (`state.leaveOut`), else the user.
 */
function leaveOutMoves(def: ProcessDefinition, state: ProcessState, here: ProcessState, pos: Position, options: ConditionOptions): ProcessMove[] {
    const now = options.now ?? new Date().toISOString();
    const moves: ProcessMove[] = [];
    const base = withoutLeaveOut(here);
    const record = (level: 'phase' | 'step', node: ProcessConditional): Pick<ProcessSkipRecord, 'reason' | 'by'> => {
        if (state.leaveOut?.level === level) { return { reason: state.leaveOut.reason || 'its condition does not hold', by: 'agent' }; }
        return { reason: node.when ? `left out by the user (runs only when ${conditionText(node.when)})` : 'left out by the user (optional)', by: 'user' };
    };
    const lead = (skipped: ProcessState, next: ProcessState | null): ProcessState => (next ? passExcluded(def, skipped, next, options) : { ...skipped, completed: true });
    if (pos.stepIndex === 0 && pos.substepIndex <= 0 && leavable(pos.phase)) {
        const skipped = addSkip(base, { phase: pos.phase.id, phaseIteration: here.phaseIteration, ...record('phase', pos.phase), at: now });
        moves.push({ kind: 'leave-out', level: 'phase', label: `Leave out the phase ${nameOf(pos.phase)}`, target: lead(skipped, afterPhase(def, skipped, pos.phase, options.lookup)) });
    }
    const entry = pos.entries[pos.stepIndex];
    const step = entry.step as ProcessStep;
    if (entry.kind !== 'gate' && leavable(step)) {
        const skipped = addSkip(base, { phase: pos.phase.id, phaseIteration: here.phaseIteration, step: step.id, ...record('step', step), at: now });
        moves.push({ kind: 'leave-out', level: 'step', label: `Leave out the step ${nameOf(step)}`, target: lead(skipped, afterStep(def, skipped, pos.phase, step.id, options.lookup)) });
    }
    return moves;
}

/**
 * What the agent can leave out at `state` (tomAi_setProcessState
 * `leaveOut`): the phase at its first position when its `when:` is for the
 * agent to judge, else the step when its `when:` is; null when neither.
 */
export function judgedLevelAt(def: ProcessDefinition | null, state: ProcessState, lookup?: ConditionLookup): { level: 'phase' | 'step'; condition: ProcessCondition; node: ProcessPhase | ProcessStep } | null {
    if (!def || !state.process || state.completed || state.decision) { return null; }
    const pos = positionOf(def, state);
    if (!pos) { return null; }
    if (pos.stepIndex === 0 && pos.substepIndex <= 0 && pos.phase.when && evaluateCondition(pos.phase.when, lookup) === 'judge') {
        return { level: 'phase', condition: pos.phase.when, node: pos.phase };
    }
    const entry = pos.entries[pos.stepIndex];
    const step = entry.step as ProcessStep;
    if (entry.kind !== 'gate' && step.when && evaluateCondition(step.when, lookup) === 'judge') {
        return { level: 'step', condition: step.when, node: step };
    }
    return null;
}

/** The skip records of the phase iteration `state` is in, oldest first. */
export function skippedInPhase(state: ProcessState): ProcessSkipRecord[] {
    return (state.skipped ?? []).filter((r) => r.phase === state.phase && r.phaseIteration === state.phaseIteration);
}

// ============================================================================
// Moves — what the PROCESS view's action bar offers
// ============================================================================

export type ProcessMoveKind = 'proceed' | 'finish' | 'repeat' | 'gate-passed' | 'gate-failed' | 'finish-process' | 'follow-up' | 'skip' | 'leave-out' | 'back' | 'back-phase' | 'phase-start' | 'jump';

/** The move kinds, in the order the action bar shows them. */
export const PROCESS_MOVE_KINDS: readonly ProcessMoveKind[] = ['proceed', 'finish', 'repeat', 'gate-passed', 'gate-failed', 'finish-process', 'follow-up', 'skip', 'leave-out', 'back', 'back-phase', 'phase-start', 'jump'];

export interface ProcessMove {
    kind: ProcessMoveKind;
    /** For `finish` the level that ends, for `repeat` the level that starts again, for `leave-out` the level left out. */
    level?: ProcessLevel;
    label: string;
    /** The state the move leads to. */
    target: ProcessState;
    /** One of the options of the decision the quest is at; chosen in the decision dialog, not shown in the action bar. */
    branchOption?: true;
    /**
     * A `follow-up` move: which follow-up (`key`, unique among the options,
     * e.g. `phase:0`) and what it says, so the switch can resolve its call
     * context and record the carried variables (completeFollowUpSwitch).
     */
    followUp?: { key: string; entry: ProcessFollowUp };
    /** A `jump` (a decision step's target, vscimpb95): which one, `target:<n>`. */
    key?: string;
}

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
    const nextPhase = autoSuccessor(def, pos.phase);
    return nextPhase ? enterPhase(state, nextPhase) : null;
}

/**
 * The iteration a phase is entered at by a move on (vscimpb95): the one after
 * the last it was in (`phaseIterations`, after a jump or a move back), so its
 * round folders continue — bounded by what it allows; 1 when it has not run.
 */
function phaseEntryIteration(state: ProcessState, phase: ProcessPhase): number {
    const last = state.phaseIterations?.[phase.id];
    return last === undefined ? 1 : clampIteration(phase, last + 1);
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
        const came = phaseCameFrom(def, state, pos);
        if (!came) { return null; }
        phase = came;
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
        // Into the previous phase: the iteration it was last in; Back is a correction, not a new round.
        phaseIteration: clampIteration(phase, phase === pos.phase ? state.phaseIteration : state.phaseIterations?.[phase.id] ?? state.phaseIteration),
        ...(phase === pos.phase ? {} : { correction: true as const }),
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
    return (entry.kind === 'step' && decisionOf(entry.step) !== undefined)
        || (entry.kind === 'gate' && stepEnds)
        || phaseEnds
        || subs[pos.substepIndex]?.repeatable === true
        || (stepEnds && entry.step.repeatable === true)
        || (stepEnds && ((entry.step as ProcessStep).followUps?.length ?? 0) > 0);
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
 * The phase before the current one (vscimpb96): one that leads to it in the
 * flow (its `next:`, by default the order) — of those, the one the process
 * last came through (its path), else the one before it in the definition.
 * A jump is not a way into a phase here. None in the first phase.
 */
function phaseCameFrom(def: ProcessDefinition, state: ProcessState, pos: Position): ProcessPhase | undefined {
    const preds = def.phases.filter((p) => p !== pos.phase && phaseSuccessors(def, p).some((x) => x.phase === pos.phase));
    if (!preds.length) { return undefined; }
    const path = state.phasePath ?? [];
    for (let i = path.length - 1; i >= 0; i--) {
        const p = preds.find((x) => x.id === path[i].phase);
        if (p) { return p; }
    }
    const before = def.phases[pos.phaseIndex - 1];
    return before && preds.includes(before) ? before : preds[0];
}

/**
 * The start of the phase before the current one (vscimpb93): its first step
 * (past what its conditions leave out), the phase's iteration counted on from
 * the one it was last in (bounded by its maxIterations; a phase not marked
 * repeatable stays at 1), so its round folders continue. Null in the first
 * phase.
 */
function previousPhaseStart(def: ProcessDefinition, here: ProcessState, pos: Position, options: ConditionOptions): { name: string; target: ProcessState } | null {
    const phase = phaseCameFrom(def, here, pos);
    if (!phase) { return null; }
    const iteration = clampIteration(phase, (here.phaseIterations?.[phase.id] ?? 1) + 1);
    const start = withStep(withoutRecord({ ...here, phase: phase.id, phaseIteration: iteration }), firstStepOf(phase), 1);
    return { name: nameOf(phase), target: passExcluded(def, here, start, options) };
}

/**
 * The start of the current phase (vscimpb94): its first step (past what its
 * conditions leave out) in the same phase iteration — a move, not a phase
 * repeat, so a phase not marked repeatable has it too — the step's iteration
 * counted on (the one after its last in this phase iteration, bounded by what
 * the step allows), so its round folders continue; the steps after it count on
 * as they come round again. Null at the phase's very start (its first step
 * and sub-step, not yet run).
 */
function currentPhaseStart(def: ProcessDefinition, here: ProcessState, pos: Position, atDecision: boolean, options: ConditionOptions): { name: string; target: ProcessState } | null {
    const first = firstStepOf(pos.phase);
    if (pos.stepIndex === 0 && pos.substepIndex <= 0 && !atDecision) { return null; }
    const iteration = first.id === here.step
        ? clampIteration(repeatView(pos.phase, first), here.stepIteration + 1)
        : reentryIteration(here, pos.phase, first);
    return { name: nameOf(pos.phase), target: passExcluded(def, here, withStep(here, first, iteration), options) };
}

/**
 * The options at the decision position after `pos`: go on (gate passed after
 * a gate; finish the process at its end), a repeat of each repeatable level
 * that ends there (below its maxIterations), and after a gate, gate failed —
 * back to the gate's `onFail` step, by default the gate run again.
 */
function decisionOptions(def: ProcessDefinition, here: ProcessState, pos: Position, forward: ProcessState | null, options: ConditionOptions): ProcessMove[] {
    const entry = pos.entries[pos.stepIndex];
    const subs = entry.step.substeps ?? [];
    const isGate = entry.kind === 'gate';
    const stepEnds = subs.length === 0 || pos.substepIndex === subs.length - 1;
    const phaseEnds = stepEnds && pos.stepIndex === pos.entries.length - 1;
    const onward = forward ? `go on to ${whereTo(def, here, forward)}` : '';
    const moves: ProcessMove[] = [];
    // The phase ends here and names what follows it (vscimpb96): one go-on per successor offered.
    const successors = phaseEnds && Array.isArray(pos.phase.next) ? offeredSuccessors(def, pos.phase, options.lookup) : null;
    if (successors) {
        const prefix = isGate ? 'Gate passed — ' : '';
        for (const succ of successors) {
            if (!succ.phase) {
                moves.push({ kind: 'finish-process', label: `${prefix}${succ.label ? `${succ.label} — ` : ''}${isGate ? 'finish the process' : 'Finish the process'}`, target: { ...here, completed: true }, key: `next:${succ.index}` });
                continue;
            }
            const target = passExcluded(def, here, enterPhase(here, succ.phase), options);
            const text = `go on to ${succ.label ?? (target.completed ? 'the end' : whereTo(def, here, target))}`;
            moves.push({ kind: isGate ? 'gate-passed' : 'finish', label: isGate ? `${prefix}${text}` : text.charAt(0).toUpperCase() + text.slice(1), target, key: `next:${succ.index}` });
        }
    } else if (!forward || forward.completed) {
        // The end of the process — or everything after this is left out by its conditions.
        moves.push({ kind: 'finish-process', label: isGate ? 'Gate passed — finish the process' : 'Finish the process', target: forward ?? { ...here, completed: true } });
    } else if (isGate && stepEnds) {
        moves.push({ kind: 'gate-passed', label: `Gate passed — ${onward}`, target: forward });
    } else {
        moves.push({ kind: 'finish', label: onward.charAt(0).toUpperCase() + onward.slice(1), target: forward });
    }
    if (isGate && stepEnds) {
        const gate = pos.phase.gate;
        const back = gate.onFail && gate.onFail !== gate.id ? findStep(pos.phase, gate.onFail) : undefined;
        moves.push(back
            ? { kind: 'gate-failed', label: `Gate failed — back to ${nameOf(back)}`, target: withStep(here, back, reentryIteration(here, pos.phase, back)) }
            : { kind: 'gate-failed', label: `Gate failed — run ${nameOf(gate)} again`, target: changeIteration(here, def, 'step', 1) });
    }
    const sub = subs[pos.substepIndex];
    if (sub && canRepeat(sub, here.substepIteration)) {
        moves.push({ kind: 'repeat', level: 'substep', label: `Repeat ${nameOf(sub)}`, target: changeIteration(here, def, 'substep', 1) });
    }
    if (stepEnds && !isGate && canRepeat(entry.step, here.stepIteration)) {
        moves.push({ kind: 'repeat', level: 'step', label: `Repeat the step ${nameOf(entry.step)}`, target: changeIteration(here, def, 'step', 1) });
    }
    if (phaseEnds && canRepeat(pos.phase, here.phaseIteration)) {
        moves.push({ kind: 'repeat', level: 'phase', label: `Repeat the phase ${nameOf(pos.phase)}`, target: passExcluded(def, here, changeIteration(here, def, 'phase', 1), options) });
    }
    // Back to the start of the current phase: at every decision inside the phase, after a gate as a way to fail it.
    const restart = currentPhaseStart(def, here, pos, true, options);
    if (restart) {
        moves.push({ kind: 'phase-start', label: `${isGate && stepEnds ? 'Gate failed — back' : 'Back'} to the start of the current phase (${restart.name})`, target: restart.target });
    }
    const previous = isGate && stepEnds ? previousPhaseStart(def, here, pos, options) : null;
    if (previous) { moves.push({ kind: 'back-phase', label: `Gate failed — back to the start of the previous phase (${previous.name})`, target: previous.target }); }
    moves.push(...followUpOptions(def, here, pos, stepEnds, phaseEnds, isGate, options));
    return moves.map((o) => ({ ...o, branchOption: true as const }));
}

/** Where a follow-up leads, for labels and messages: `process › phase › step` (what it names). */
export function followUpTarget(f: ProcessFollowUp): string {
    return [f.process, f.phase, f.step].filter(Boolean).join(' › ');
}

/**
 * The follow-up options of the decision after `pos` (vscimpb47): the step's
 * (when it ends there), the phase's and — at the end of the last phase — the
 * process's, each a switch to its process at its phase and step (the first
 * ones by default, past what their conditions leave out). Only the quest's
 * own process offers them (a subprocess or branch hands back to its step),
 * and only with `options.processOf`; a follow-up whose target is gone is not
 * offered.
 */
function followUpOptions(def: ProcessDefinition, here: ProcessState, pos: Position, stepEnds: boolean, phaseEnds: boolean, isGate: boolean, options: ConditionOptions): ProcessMove[] {
    if (!options.processOf || here.nested) { return []; }
    const offered: Array<{ level: ProcessOrigin['level']; list: ProcessFollowUp[] }> = [];
    if (stepEnds) { offered.push({ level: 'step', list: (pos.entries[pos.stepIndex].step as ProcessStep).followUps ?? [] }); }
    if (phaseEnds) { offered.push({ level: 'phase', list: pos.phase.followUps ?? [] }); }
    if (phaseEnds && phaseMayEnd(def, pos.phase)) { offered.push({ level: 'process', list: def.followUps ?? [] }); }
    const now = options.now ?? new Date().toISOString();
    const moves: ProcessMove[] = [];
    for (const { level, list } of offered) {
        list.forEach((entry, i) => {
            const target = entry.process === def.id ? def : options.processOf!(entry.process);
            const phase = target ? (entry.phase ? findPhase(target, entry.phase) : target.phases[0]) : undefined;
            const step = phase ? (entry.step ? findStep(phase, entry.step) : firstStepOf(phase)) : undefined;
            if (!target || !phase || !step) { return; }
            const origin: ProcessOrigin = {
                process: def.id, phase: here.phase, phaseIteration: here.phaseIteration, step: here.step, stepIteration: here.stepIteration, level, at: now,
            };
            const start = withStep({ ...EMPTY_PROCESS_STATE, process: target.id, phase: phase.id, phaseIteration: 1 }, step, 1);
            const moved = passExcluded(target, { ...EMPTY_PROCESS_STATE }, start, options);
            const origins = [...(here.origins ?? []), origin].slice(-MAX_ORIGIN_RECORDS);
            const where = [nameOf(target), nameOf(phase), entry.step ? nameOf(step) : ''].filter(Boolean).join(' › ');
            moves.push({
                kind: 'follow-up',
                label: `${isGate ? 'Gate passed — ' : ''}Continue in ${where}${entry.description ? ` (${entry.description})` : ''}`,
                target: { ...moved, origins },
                followUp: { key: `${level}:${i}`, entry },
            });
        });
    }
    return moves;
}

/**
 * The state a follow-up switch writes: the move's target with the call
 * context resolved (`resolve`, the placeholder engine as the decision sees
 * it) and the carried variables' values (`lookup`) in its newest origin.
 */
export function completeFollowUpSwitch(move: ProcessMove, resolve: (text: string) => string, lookup: (name: string) => string | undefined): ProcessState {
    const entry = move.followUp?.entry;
    const origins = move.target.origins ?? [];
    if (!entry || origins.length === 0) { return move.target; }
    const last = { ...origins[origins.length - 1] };
    const context = Object.fromEntries(Object.entries(entry.context ?? {}).map(([n, t]) => [n, resolve(t).trim()]));
    if (Object.keys(context).length) { last.context = context; }
    if (entry.carry?.length) { last.carried = Object.fromEntries(entry.carry.map((n) => [n, lookup(n) ?? ''])); }
    return { ...move.target, origins: [...origins.slice(0, -1), last] };
}

/** The variables a follow-up's prompts read: `process-origin` (`<process>/<phase>`) and `origin.<name>` (its call context). */
export function originVariables(state: ProcessState): Record<string, string> {
    const last = state.origins?.[state.origins.length - 1];
    if (!last) { return {}; }
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a chat-variable name
    const out: Record<string, string> = { 'process-origin': `${last.process}/${last.phase}` };
    for (const [n, v] of Object.entries(last.context ?? {})) { out[`origin.${n}`] = v; }
    return out;
}

/** The decisions-journal entry of a switch to a follow-up process: from where, to where, what it took along. */
export function followUpJournalEntry(from: ProcessState, fromPosition: string, to: ProcessState, toPosition: string, run: string, at: Date = new Date()): string {
    const origin = to.origins?.[to.origins.length - 1];
    const kv = (rec: Record<string, string> | undefined): string => Object.entries(rec ?? {}).map(([k, v]) => `\`${k}\` = ${v || '(not set)'}`).join(', ');
    return [
        `## ${at.toISOString()} — continued in the follow-up process ${to.process}`,
        '',
        `- **From:** ${from.process} › ${fromPosition}${origin ? ` (the ${origin.level}'s follow-up)` : ''}`,
        `- **To:** ${to.process} › ${toPosition}`,
        ...(run && run !== 'default' ? [`- **Run:** ${run}`] : []),
        ...(origin?.carried ? [`- **Carried:** ${kv(origin.carried)}`] : []),
        ...(origin?.context ? [`- **Call context:** ${kv(origin.context)}`] : []),
        '',
    ].join('\n');
}

/** The decisions journal entry of a move back to the start of the previous phase (vscimpb93) or of the current one (vscimpb94). */
export function backPhaseJournalEntry(label: string, from: ProcessState, fromPosition: string, to: ProcessState, toPosition: string, run: string, at: Date = new Date()): string {
    return [
        `## ${at.toISOString()} — ${label}`,
        '',
        `- **From:** ${from.process} › ${fromPosition}`,
        `- **To:** ${to.process} › ${toPosition} (phase iteration ${to.phaseIteration})`,
        ...(run && run !== 'default' ? [`- **Run:** ${run}`] : []),
        '',
    ].join('\n');
}

/** The follow-up chain of `state` as text, oldest first (`design › p1 → review`), '' without one. */
export function originChainText(state: ProcessState): string {
    if (!state.origins?.length) { return ''; }
    return [...state.origins.map((o) => `${o.process} › ${o.phase}${o.level === 'step' ? ` › ${o.step}` : ''}`), state.process].join(' → ');
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
 *   repeatable level ending there; `phase-start`, back to the start of the
 *   current phase; after a gate also `back-phase`, back to the start of the
 *   previous phase — then `back` (to the position itself).
 * - after `back`: `phase-start` ("Back to the start of the current phase
 *   (<phase>)") everywhere but at the phase's very start — its first step, the
 *   step's iteration counted on, the phase iteration kept — and `back-phase`
 *   ("Back to the start of the previous phase (<phase>)") everywhere but in the
 *   first phase: the previous phase's first step, its iteration counted on.
 *
 * Only a decision position repeats or decides. A finished process offers only
 * `back` ("Reopen"); no process, nothing.
 */
export function availableMoves(def: ProcessDefinition | null, state: ProcessState, options: ConditionOptions = {}): ProcessMove[] {
    if (!def || !state.process) { return []; }
    if (state.nestedEnded) { return nestedEndedMoves(def, state, options); }
    if (state.completed) { return [{ kind: 'back', label: 'Reopen', target: notRun({ ...state, completed: false }) }]; }
    const pos = positionOf(def, state);
    if (!pos) { return []; }
    const here = notRun(state);
    const forwardRaw = forwardTarget(def, here, pos);
    const forward = forwardRaw ? passExcluded(def, here, withoutLeaveOut(notRun(forwardRaw)), options) : null;
    const moves: ProcessMove[] = [];
    const decisionStep = pos.entries[pos.stepIndex].kind === 'step' && decisionOf(pos.entries[pos.stepIndex].step) !== undefined;
    if (state.decision && isDecisionPoint(pos)) {
        moves.push({ kind: 'proceed', label: 'Decide…', target: state });
        moves.push(...(decisionStep ? decisionStepOptions(def, here, pos, options) : decisionOptions(def, here, pos, forward, options)));
        moves.push({ kind: 'back', label: 'Back', target: here });
        moves.push(...phaseStartMove(def, here, pos, true, options));
        moves.push(...backPhaseMove(def, here, pos, options));
        return moves;
    }
    const next = isDecisionPoint(pos) || !forward ? { ...here, decision: true as const } : forward;
    // A decision step: Proceed decides (or runs the agent's judgement); Skip passes it by without a jump.
    moves.push({ kind: 'proceed', label: userActionAt(def, state) ? 'Confirm done' : 'Proceed', target: decisionStep ? decisionStepProceed(def, state, here, pos, options) : next });
    moves.push({ kind: 'skip', label: 'Skip', target: decisionStep ? forward ?? { ...here, completed: true } : next });
    moves.push(...leaveOutMoves(def, state, here, pos, options));
    const backRaw = backTarget(def, here, pos);
    if (backRaw) {
        const prev = positionOf(def, backRaw);
        moves.push({ kind: 'back', label: 'Back', target: prev && isDecisionPoint(prev) ? { ...notRun(backRaw), decision: true } : notRun(backRaw) });
    }
    moves.push(...phaseStartMove(def, here, pos, false, options));
    moves.push(...backPhaseMove(def, here, pos, options));
    return moves;
}

/** "Back to the start of the previous phase" for the action bar (vscimpb93); nothing in the first phase. */
function backPhaseMove(def: ProcessDefinition, here: ProcessState, pos: Position, options: ConditionOptions): ProcessMove[] {
    const previous = previousPhaseStart(def, here, pos, options);
    return previous ? [{ kind: 'back-phase', label: `Back to the start of the previous phase (${previous.name})`, target: previous.target }] : [];
}

/** "Back to the start of the current phase" for the action bar (vscimpb94); nothing at the phase's very start. */
function phaseStartMove(def: ProcessDefinition, here: ProcessState, pos: Position, atDecision: boolean, options: ConditionOptions): ProcessMove[] {
    const restart = currentPhaseStart(def, here, pos, atDecision, options);
    return restart ? [{ kind: 'phase-start', label: `Back to the start of the current phase (${restart.name})`, target: restart.target }] : [];
}

/**
 * The decision after a level above ended with "ask me at the end": Go on —
 * where Proceed at the step would have led (the next position, or the
 * decision after it) — or Run the step again (the step itself, its next
 * Proceed runs it).
 */
function nestedEndedMoves(def: ProcessDefinition, state: ProcessState, conditions: ConditionOptions = {}): ProcessMove[] {
    const { nestedEnded: ended, ...base } = state;
    const proceed = availableMoves(def, base, conditions).find((m) => m.kind === 'proceed');
    const what = `${ended!.kind === 'branch' ? 'the branch' : 'the subprocess'} ${ended!.process} ${ended!.outcome === 'aborted' ? 'was aborted' : 'finished'}`;
    const options: ProcessMove[] = [];
    if (proceed) {
        const onward = proceed.target.decision ? `go on to the decision after ${whereTo(def, base, base)}` : `go on to ${whereTo(def, base, proceed.target)}`;
        options.push({ kind: 'finish', label: `${what.charAt(0).toUpperCase()}${what.slice(1)} — ${onward}`, target: proceed.target, branchOption: true });
    }
    options.push({ kind: 'repeat', level: 'step', label: `Run the step ${whereTo(def, base, base)} again`, target: base, branchOption: true });
    return [{ kind: 'proceed', label: 'Decide…', target: state }, ...options];
}

/** The decision the quest is at — its options — or null when it is not at a decision position. */
export function decisionAt(def: ProcessDefinition | null, state: ProcessState, conditions: ConditionOptions = {}): { options: ProcessMove[] } | null {
    if (def && state.process && state.nestedEnded) { return { options: nestedEndedMoves(def, state, conditions).filter((m) => m.branchOption) }; }
    if (!def || !state.process || state.completed || !state.decision) { return null; }
    const pos = positionOf(def, state);
    if (!pos || !isDecisionPoint(pos)) { return null; }
    return { options: availableMoves(def, state, conditions).filter((m) => m.branchOption) };
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
    run?: string,
): Record<ProcessVariableKey, string> {
    const out = Object.fromEntries(PROCESS_VARIABLE_KEYS.map((k) => [k, ''])) as Record<ProcessVariableKey, string>;
    if (!state.process) { return out; }
    out.process = state.process;
    out.session = effectiveSession(def, state, run)?.name ?? '';
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
 * are filled in from `state`. In a process run other than `default` the name
 * is the run's session, `<session>@<run>` (src/utils/runSessions.ts), and so
 * is a `basedOn` that names another session of the process.
 */
export function effectiveSession(def: ProcessDefinition | null, state: ProcessState, run?: string): ProcessSession | null {
    if (!def) { return null; }
    const phase = findPhase(def, state.phase);
    const step = findStep(phase, state.step);
    const sub = findSubstep(step, state.substep);
    // The innermost wins: sub-step, step, phase, then the process.
    const spec = sessionSpec(sub?.session) ?? sessionSpec(step?.session) ?? sessionSpec(phase?.session) ?? sessionSpec(def.session);
    if (!spec) { return null; }
    const iteration: Record<string, number> = { phase: state.phaseIteration, step: state.stepIteration, substep: state.substepIteration };
    const fill = (name: string): string => name.replace(SESSION_PLACEHOLDER, (_m, level: string) => String(iteration[level] || 1));
    const name = runSessionName(fill(spec.name), run);
    if (!spec.basedOn) { return { ...spec, name }; }
    const basedOn = fill(spec.basedOn);
    // A base the process itself names belongs to the run too; another (a prepared context) is shared.
    const own = processSessionNames(def).some((n) => fill(n) === basedOn);
    return { ...spec, name, basedOn: own ? runSessionName(basedOn, run) : basedOn };
}

/** Every session name the definition gives (process, phases, steps with gate and post-gate, sub-steps), unfilled. */
function processSessionNames(def: ProcessDefinition): string[] {
    const names: string[] = [];
    const add = (spec: ProcessSessionSpec | undefined): void => { const s = sessionSpec(spec); if (s) { names.push(s.name); } };
    add(def.session);
    for (const phase of def.phases) {
        add(phase.session);
        for (const e of phaseSteps(phase)) {
            add(e.step.session);
            for (const sub of e.step.substeps ?? []) { add(sub.session); }
        }
    }
    return names;
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
/**
 * `inProceedRun`: the prompt runs for a step a Proceed started — the process
 * moves on by itself when the step's queued items are done (a process-move
 * marker), so the agent is told not to record the move.
 */
/** The inputs, outputs and handed-back outputs of the running level, for the context block. */
function ioContextLines(def: ProcessDefinition, state: ProcessState): string[] {
    const lines: string[] = [];
    const kind = (d: ProcessIoDecl | undefined): string => (d?.kind ? ` (${d.kind})` : '');
    if (state.nested) {
        lines.push(`Started as a **${state.nested.kind}** from the step of the process below it, which waits until this one finishes${state.nested.kind === 'subprocess' ? ' and gets its outputs back' : ''}.`);
    }
    const inputs = Object.entries(state.inputs ?? {});
    if (inputs.length) {
        lines.push('Inputs: ' + inputs.map(([n, v]) => `\`\${input.${n}}\`${kind(def.inputs?.find((d) => d.name === n))} = ${v}`).join('; '));
    }
    if (state.nested?.kind === 'subprocess' && def.outputs?.length) {
        const out = def.outputs.map((d) => {
            const set = state.outputs?.[d.name];
            return `\`${d.name}\`${kind(d)}${d.required ? ', required' : ''}${set ? ` — set: ${set}` : d.value ? ` — default: ${d.value}` : ' — not set'}`;
        });
        lines.push(`Outputs to hand back: ${out.join('; ')}. Set them with \`tomAi_setProcessState {outputs: {<name>: <value>}}\` before the process finishes.`);
    }
    const handed = Object.entries(state.subOutputs ?? {}).flatMap(([p, values]) => Object.entries(values).map(([n, v]) => `\`\${sub.${p}.${n}}\` = ${v}`));
    if (handed.length) { lines.push(`Outputs handed back by subprocesses: ${handed.join('; ')}`); }
    return lines;
}

export function processContextBlock(def: ProcessDefinition | null, state: ProcessState, processDescription: string, inProceedRun = false, conditions: ConditionOptions = {}, run?: string): string {
    if (!def || !state.process) { return ''; }
    const lines: string[] = [];
    const head = (node: { id: string; name?: string }, extra: string): string =>
        node.name ? `**${node.name}** (\`${node.id}\`${extra})` : `\`${node.id}\`${extra ? ` (${extra.replace(/^, /, '')})` : ''}`;
    lines.push(`Process: ${head(def, '')}${def.summary ? ` — ${def.summary}` : ''}`);
    // Switched to as a follow-up process (vscimpb47): where from, and what the switch took along.
    const origin = state.origins?.[state.origins.length - 1];
    if (origin) {
        const context = Object.keys(origin.context ?? {}).map((n) => `\`\${origin.${n}}\``).join(', ');
        lines.push(`Continued from: \`${origin.process}\` › \`${origin.phase}\`${origin.level === 'step' ? ` › \`${origin.step}\`` : ''} as its ${origin.level}'s follow-up (\`\${process-origin}\`; chain: ${originChainText(state)})${context ? `; call context ${context}` : ''}${origin.carried ? `; carried ${Object.keys(origin.carried).map((n) => `\`${n}\``).join(', ')}` : ''}`);
    }
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
        const session = effectiveSession(def, state, run);
        if (session) {
            const from = session.basedOn ? `from \`${session.basedOn}\`` : 'fresh';
            const how = session.mode === 'per-prompt' || session.mode === 'fork-from-base'
                ? ` (${from} for every prompt)`
                : session.mode === 'per-iteration' ? ` (${from} for every queue iteration)`
                    : session.basedOn ? ` (based on \`${session.basedOn}\`)` : '';
            lines.push(`Session: \`${session.name}\`${how} — prompts this step queues run in it unless they name another`);
        }
        const leftOut = skippedInPhase(state);
        const outline = entries.map((e) => {
            const id = e.step.id === state.step ? `**\`${e.step.id}\`**` : `\`${e.step.id}\``;
            const notes = [
                e.kind === 'step' ? '' : e.kind,
                (e.step as ProcessStep).optional ? 'optional' : '',
                (e.step as ProcessStep).when ? `when ${conditionText((e.step as ProcessStep).when!)}` : '',
                leftOut.some((r) => r.step === e.step.id) ? 'left out' : '',
            ].filter(Boolean);
            return notes.length ? `${id} (${notes.join(', ')})` : id;
        }).join(' → ');
        lines.push(`Steps of this phase: ${outline}`);
        const phaseNotes = [phase.optional ? 'optional' : '', phase.when ? `runs only when ${conditionText(phase.when)}` : ''].filter(Boolean);
        if (phaseNotes.length) { lines.push(`This phase is ${phaseNotes.join(' and ')}.`); }
        const earlier = (state.skipped ?? []).slice(-10);
        if (earlier.length) {
            lines.push(`Left out so far: ${earlier.map((r) => `${r.step ? `step \`${r.step}\` of ` : ''}phase \`${r.phase}\`${r.phaseIteration > 1 ? ` (iteration ${r.phaseIteration})` : ''} — ${r.reason}`).join('; ')}`);
        }
    }
    lines.push(...ioContextLines(def, state));
    if (step && entries.find((e) => e.step === step)?.kind === 'post-gate') {
        const post = step as ProcessPostGateStep;
        const todoLines = (post.todos ?? []).map((t) => `- ${t.title}${t.description ? ` — ${t.description}` : ''}`);
        if (todoLines.length || post.todoPrefix) {
            lines.push('', 'Todos of this step, to be done before the next phase starts:');
            lines.push(...todoLines);
            if (post.todoPrefix) { lines.push(`- and the quest todos with the id prefix \`${post.todoPrefix}\``); }
        }
    }
    const judged = judgedLevelAt(def, state, conditions.lookup);
    if (judged) {
        const what = judged.level === 'phase' ? 'phase' : 'step';
        const condition = isJudgeCondition(judged.condition)
            ? judged.condition.judge.trim()
            : `${conditionText(judged.condition)} (the variable is not set, so the extension cannot decide it)`;
        lines.push('', `**Condition** — this ${what} runs only when: ${condition}. Judge it before doing any of its work. When it holds, go on as usual. When it does not, do none of the ${what}'s work: call \`tomAi_setProcessState {leaveOut: "<why>"}\` and end your answer — the process then leaves the ${what} out and records why.`);
    }
    const decisionStep = decisionStepAt(def, state);
    if (decisionStep && !state.decision) {
        const targets = decisionStep.spec.targets.map((t, i) => `${i + 1}. ${decisionTargetLabel(def!, decisionStep.phase.id, t)} → \`${t.to}\`${t.when ? ` (${isJudgeCondition(t.when) ? t.when.judge.trim() : `when ${conditionText(t.when)}`})` : ''}`);
        if (decisionStep.mode === 'judge') {
            lines.push('', `**Decision step** — this step chooses where the process goes next; you judge it. Its targets:`, ...targets,
                `Choose one: call \`tomAi_setProcessState {decide: "<label>", reason: "<why>"}\` and end your answer — the process jumps there when this step's run ends. Choosing none leaves the decision to the user.`);
        } else {
            lines.push('', `**Decision step** — this step chooses where the process goes next (${decisionStep.mode === 'auto' ? 'the extension decides from the chat variables; the user when nothing holds' : 'the user decides in the PROCESS view'}). Its targets:`, ...targets, 'An agent does not decide it.');
        }
    }
    if (!state.completed && userActionAt(def, state)) {
        lines.push('', '**User action** — this position is done by the user, not by an agent: do not do its work and do not move past it; the user confirms it with Proceed in the PROCESS view.');
    }
    if (state.completed) { lines.push('', 'The process is finished: its last step is done.'); }
    const decision = decisionAt(def, state, conditions);
    if (decision) {
        lines.push('', `**Decision** — this position has run; the user decides here how the process goes on: ${decision.options.map((o) => o.label).join('; ')}. An agent does not decide it and does not move past it.`);
    }
    lines.push('', inProceedRun
        ? 'This prompt runs for a step started with Proceed in the PROCESS view: the process moves on by itself once this prompt and every queue item it queues are done. Do not record the move with `tomAi_setProcessState` — that would end the running step (`leaveOut` is the exception: it only records that the step is to be left out). Every item you queue for this step (tomAi_addQueueItem — its todo walks, its closing item) is the step\'s own work: pass `processItem: true`, so it does not count towards the quest refresh.'
        : 'When the work moves on — another step, sub-step, iteration or phase — record it with `tomAi_setProcessState`.');
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

function parsePhasePath(raw: unknown): { phasePath?: ProcessPathEntry[] } {
    if (!Array.isArray(raw)) { return {}; }
    const out = raw.filter(isObject).filter((x) => typeof x.phase === 'string').map((x): ProcessPathEntry => ({
        phase: x.phase as string,
        phaseIteration: Number.isInteger(x.phaseIteration) && (x.phaseIteration as number) >= 1 ? x.phaseIteration as number : 1,
    }));
    return out.length ? { phasePath: out.slice(-MAX_PATH_ENTRIES) } : {};
}

const JUMP_BY: readonly ProcessJumpRecord['by'][] = ['condition', 'agent', 'user'];

function parseJumpEnd(raw: unknown): ProcessJumpEnd | null {
    if (!isObject(raw) || typeof raw.phase !== 'string' || typeof raw.step !== 'string') { return null; }
    const n = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 1 ? v as number : 1);
    return { phase: raw.phase, phaseIteration: n(raw.phaseIteration), step: raw.step, stepIteration: n(raw.stepIteration) };
}

function parseJumps(raw: unknown): { jumps?: ProcessJumpRecord[] } {
    if (!Array.isArray(raw)) { return {}; }
    const out: ProcessJumpRecord[] = [];
    for (const x of raw) {
        if (!isObject(x)) { continue; }
        const from = parseJumpEnd(x.from);
        const to = parseJumpEnd(x.to);
        if (!from || !to) { continue; }
        out.push({
            from, to,
            label: typeof x.label === 'string' ? x.label : '',
            reason: typeof x.reason === 'string' ? x.reason : '',
            by: JUMP_BY.includes(x.by as ProcessJumpRecord['by']) ? x.by as ProcessJumpRecord['by'] : 'user',
            at: typeof x.at === 'string' ? x.at : '',
        });
    }
    return out.length ? { jumps: out.slice(-MAX_JUMP_RECORDS) } : {};
}

/** A jump as one line: `p1 #1 › work #1 → p2 #1 › check #1: label (by, reason)`. */
export function jumpRecordText(r: ProcessJumpRecord): string {
    const end = (e: ProcessJumpEnd): string => `${e.phase} #${e.phaseIteration} › ${e.step} #${e.stepIteration}`;
    const who = r.by === 'condition' ? 'automatic' : r.by === 'agent' ? 'the agent' : 'the user';
    return `${end(r.from)} → ${end(r.to)}: ${r.label} (${who}${r.reason ? `, ${r.reason}` : ''})`;
}

/** The decisions journal entry of a jump a decision step made (vscimpb95). */
export function jumpJournalEntry(r: ProcessJumpRecord, process: string, run: string): string {
    const end = (e: ProcessJumpEnd): string => `${process} › ${e.phase} #${e.phaseIteration} › ${e.step} #${e.stepIteration}`;
    return [
        `## ${r.at || new Date().toISOString()} — decision step: ${r.label}`,
        '',
        `- **From:** ${end(r.from)}`,
        `- **To:** ${end(r.to)}`,
        `- **By:** ${r.by === 'condition' ? 'the extension (its condition held)' : r.by === 'agent' ? 'the agent' : 'the user'}${r.reason ? ` — ${r.reason}` : ''}`,
        ...(run && run !== 'default' ? [`- **Run:** ${run}`] : []),
        '',
    ].join('\n');
}

function parsePhaseIterations(raw: unknown): { phaseIterations?: Record<string, number> } {
    if (!isObject(raw)) { return {}; }
    const phases: Record<string, number> = {};
    for (const [id, n] of Object.entries(raw)) {
        if (Number.isInteger(n) && (n as number) >= 1) { phases[id] = n as number; }
    }
    return Object.keys(phases).length ? { phaseIterations: phases } : {};
}

/**
 * The state file is a stack of levels, bottom first: each level is a process
 * position with its own iterations, and the top one (the last) is where the
 * quest is. Today a quest runs one process, so the stack holds one level;
 * nested processes push more. Every reader and writer of the position works
 * on the top level (parseProcessState, ProcessRepository.writeState).
 *
 *   levels:
 *     - process: tom_specs
 *       phase: phase2
 *       ...
 *   updated: 2026-11-05T16:08:44.593Z
 *
 * Older files held the one position at the top of the file (no `levels`);
 * they are read as a stack of that one level, and `npm run migrate:ai-formats`
 * rewrites them (isFlatProcessStateText).
 */
export interface ProcessStateStack {
    /** Bottom first; never empty — the top is the quest's position. */
    levels: ProcessState[];
}

function parseLevel(raw: Record<string, unknown>): ProcessState {
    const str = (k: string): string => (typeof raw[k] === 'string' ? raw[k] as string : '');
    const num = (k: string): number => (Number.isInteger(raw[k]) && (raw[k] as number) >= 1 ? raw[k] as number : 1);
    return {
        process: str('process'), phase: str('phase'), phaseIteration: num('phaseIteration'),
        step: str('step'), stepIteration: num('stepIteration'),
        substep: str('substep'), substepIteration: num('substepIteration'),
        completed: raw.completed === true,
        ...(raw.decision === true || raw.ran === true ? { decision: true as const } : {}),
        ...parseStepIterations(raw.stepIterations),
        ...parsePhaseIterations(raw.phaseIterations),
        ...parseJumps(raw.jumps),
        ...parsePhasePath(raw.phasePath),
        ...(isObject(raw.decide) && Number.isInteger(raw.decide.target) && (raw.decide.target as number) >= 0
            ? { decide: { target: raw.decide.target as number, reason: typeof raw.decide.reason === 'string' ? raw.decide.reason : '' } } : {}),
        ...parseNested(raw.nested),
        ...parseNestedEnded(raw.nestedEnded),
        ...textRecord('inputs', raw.inputs),
        ...textRecord('outputs', raw.outputs),
        ...parseSubOutputs(raw.subOutputs),
        ...(Array.isArray(raw.suggestions) ? { suggestions: (raw.suggestions as unknown[]).filter(isObject).filter((x) => typeof x.process === 'string' && NESTED_KINDS.includes(x.kind as NestedKind)).map((x) => ({
            kind: x.kind as NestedKind, process: x.process as string, reason: typeof x.reason === 'string' ? x.reason : '',
            ...(NESTED_FOLLOW_UPS.includes(x.followUp as NestedFollowUp) ? { followUp: x.followUp as NestedFollowUp } : {}),
            at: typeof x.at === 'string' ? x.at : '',
        })) } : {}),
        ...(isObject(raw.suggestionsDue) && typeof raw.suggestionsDue.kind === 'string' && (PROCESS_MOVE_KINDS as readonly string[]).includes(raw.suggestionsDue.kind)
            ? { suggestionsDue: {
                kind: raw.suggestionsDue.kind as ProcessMoveKind,
                ...(['phase', 'step', 'substep'].includes(raw.suggestionsDue.level as string) ? { level: raw.suggestionsDue.level as ProcessLevel } : {}),
                label: typeof raw.suggestionsDue.label === 'string' ? raw.suggestionsDue.label : '',
            } }
            : {}),
        ...(Array.isArray(raw.nestedRuns) ? { nestedRuns: (raw.nestedRuns as unknown[]).filter(isObject).filter((x) => typeof x.process === 'string') as unknown as NestedRunRecord[] } : {}),
        ...parseSkipped(raw.skipped),
        ...(isObject(raw.leaveOut) && (raw.leaveOut.level === 'phase' || raw.leaveOut.level === 'step')
            ? { leaveOut: { level: raw.leaveOut.level, reason: typeof raw.leaveOut.reason === 'string' ? raw.leaveOut.reason : '' } }
            : {}),
        ...parseOrigins(raw.origins),
    };
}

const ORIGIN_LEVELS: readonly ProcessOrigin['level'][] = ['process', 'phase', 'step'];

function parseOrigins(raw: unknown): { origins?: ProcessOrigin[] } {
    if (!Array.isArray(raw)) { return {}; }
    const out = raw.filter(isObject).filter((x) => typeof x.process === 'string' && typeof x.phase === 'string').map((x): ProcessOrigin => ({
        process: x.process as string,
        phase: x.phase as string,
        phaseIteration: Number.isInteger(x.phaseIteration) && (x.phaseIteration as number) >= 1 ? x.phaseIteration as number : 1,
        step: typeof x.step === 'string' ? x.step : '',
        stepIteration: Number.isInteger(x.stepIteration) && (x.stepIteration as number) >= 1 ? x.stepIteration as number : 1,
        level: ORIGIN_LEVELS.includes(x.level as ProcessOrigin['level']) ? x.level as ProcessOrigin['level'] : 'phase',
        at: typeof x.at === 'string' ? x.at : '',
        ...textRecord('carried', x.carried),
        ...textRecord('context', x.context),
    }));
    return out.length ? { origins: out.slice(-MAX_ORIGIN_RECORDS) } : {};
}

const SKIP_BY: readonly ProcessSkipRecord['by'][] = ['condition', 'user', 'agent'];

function parseSkipped(raw: unknown): { skipped?: ProcessSkipRecord[] } {
    if (!Array.isArray(raw)) { return {}; }
    const out = raw.filter(isObject).filter((x) => typeof x.phase === 'string').map((x): ProcessSkipRecord => ({
        phase: x.phase as string,
        phaseIteration: Number.isInteger(x.phaseIteration) && (x.phaseIteration as number) >= 1 ? x.phaseIteration as number : 1,
        ...(typeof x.step === 'string' && x.step ? { step: x.step } : {}),
        reason: typeof x.reason === 'string' ? x.reason : '',
        by: SKIP_BY.includes(x.by as ProcessSkipRecord['by']) ? x.by as ProcessSkipRecord['by'] : 'user',
        at: typeof x.at === 'string' ? x.at : '',
    }));
    return out.length ? { skipped: out.slice(-MAX_SKIP_RECORDS) } : {};
}

/** A `{name: text}` record of a state file; left out when empty or not one. */
function textRecord<K extends string>(key: K, raw: unknown): { [k in K]?: Record<string, string> } {
    if (!isObject(raw)) { return {}; }
    const out = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    return Object.keys(out).length ? { [key]: out } as { [k in K]?: Record<string, string> } : {};
}

function parseSubOutputs(raw: unknown): { subOutputs?: Record<string, Record<string, string>> } {
    if (!isObject(raw)) { return {}; }
    const out: Record<string, Record<string, string>> = {};
    for (const [process, values] of Object.entries(raw)) {
        const record = textRecord('v', values).v;
        if (record) { out[process] = record; }
    }
    return Object.keys(out).length ? { subOutputs: out } : {};
}

const NESTED_KINDS: readonly NestedKind[] = ['subprocess', 'branch'];
const NESTED_FOLLOW_UPS: readonly NestedFollowUp[] = ['ask', 'go-on', 'run-again'];

function parseNested(raw: unknown): { nested?: NestedLevelInfo } {
    if (!isObject(raw) || !NESTED_KINDS.includes(raw.kind as NestedKind)) { return {}; }
    const followUp = NESTED_FOLLOW_UPS.includes(raw.followUp as NestedFollowUp) ? raw.followUp as NestedFollowUp : 'ask';
    return { nested: { kind: raw.kind as NestedKind, followUp, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '' } };
}

function parseNestedEnded(raw: unknown): { nestedEnded?: NestedLevelEnd } {
    if (!isObject(raw) || typeof raw.process !== 'string' || !NESTED_KINDS.includes(raw.kind as NestedKind)) { return {}; }
    return { nestedEnded: { process: raw.process, kind: raw.kind as NestedKind, outcome: raw.outcome === 'aborted' ? 'aborted' : 'finished' } };
}

function levelRecord(state: ProcessState): Record<string, unknown> {
    return {
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
        ...(state.phaseIterations && Object.keys(state.phaseIterations).length ? { phaseIterations: state.phaseIterations } : {}),
        ...(state.jumps?.length ? { jumps: state.jumps } : {}),
        ...(state.phasePath?.length ? { phasePath: state.phasePath } : {}),
        ...(state.decide ? { decide: state.decide } : {}),
        ...(state.nested ? { nested: state.nested } : {}),
        ...(state.nestedEnded ? { nestedEnded: state.nestedEnded } : {}),
        ...(state.inputs && Object.keys(state.inputs).length ? { inputs: state.inputs } : {}),
        ...(state.outputs && Object.keys(state.outputs).length ? { outputs: state.outputs } : {}),
        ...(state.subOutputs && Object.keys(state.subOutputs).length ? { subOutputs: state.subOutputs } : {}),
        ...(state.suggestions?.length ? { suggestions: state.suggestions } : {}),
        ...(state.suggestionsDue ? { suggestionsDue: state.suggestionsDue } : {}),
        ...(state.nestedRuns?.length ? { nestedRuns: state.nestedRuns } : {}),
        ...(state.skipped?.length ? { skipped: state.skipped } : {}),
        ...(state.leaveOut ? { leaveOut: state.leaveOut } : {}),
        ...(state.origins?.length ? { origins: state.origins } : {}),
    };
}

/** Read a state file's text as its stack; anything unreadable is one empty level. */
export function parseProcessStateStack(text: string): ProcessStateStack {
    try {
        const raw = parse(text);
        if (!isObject(raw)) { return { levels: [{ ...EMPTY_PROCESS_STATE }] }; }
        if (Array.isArray(raw.levels)) {
            const levels = raw.levels.filter(isObject).map((l) => parseLevel(l as Record<string, unknown>));
            return { levels: levels.length ? levels : [{ ...EMPTY_PROCESS_STATE }] };
        }
        return { levels: [parseLevel(raw)] };
    } catch {
        return { levels: [{ ...EMPTY_PROCESS_STATE }] };
    }
}

/** Is this a state file of the older form, one position without `levels`? */
export function isFlatProcessStateText(text: string): boolean {
    try {
        const raw = parse(text);
        return isObject(raw) && !Array.isArray(raw.levels);
    } catch {
        return false;
    }
}

/** The `updated` time a state file records, '' when none. */
export function processStateUpdated(text: string): string {
    try {
        const raw = parse(text);
        return isObject(raw) && typeof raw.updated === 'string' ? raw.updated : '';
    } catch {
        return '';
    }
}

/** Read a state file's text: the top level's position; anything unreadable is the empty state. */
export function parseProcessState(text: string): ProcessState {
    const { levels } = parseProcessStateStack(text);
    return levels[levels.length - 1];
}

/** The text of a state file holding `stack`. */
export function stringifyProcessStateStack(stack: ProcessStateStack, updated: string): string {
    const levels = stack.levels.length ? stack.levels : [{ ...EMPTY_PROCESS_STATE }];
    return stringify({ levels: levels.map(levelRecord), updated });
}

/** The text of a state file whose top level is `state`, over the levels `below` (bottom first). */
export function stringifyProcessState(state: ProcessState, updated: string, below: ProcessState[] = []): string {
    return stringifyProcessStateStack({ levels: [...below, state] }, updated);
}
