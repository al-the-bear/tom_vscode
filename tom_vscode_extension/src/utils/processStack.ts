/**
 * Nested processes: subprocesses and branches on a quest's process stack
 * (process-state.<quest>.yaml holds the levels, bottom first; the top level
 * runs).
 *
 * - A step (or sub-step) lists the processes that may start from it:
 *   `subprocesses:` (a level that hands a result back) and `branches:` (a
 *   level that hands nothing back). The lists are closed: nothing else is
 *   started from a position, by the agent or the user; an arbitrary process
 *   is reached only by switching the quest's own process.
 * - Starting one pushes a level at the process's first position: any depth,
 *   the same process may recur, each level keeps its own position and
 *   iterations. A start that takes the nesting beyond the maximum depth
 *   (default 5, a Status Page setting) needs a confirmation.
 * - The level below waits at its step, also for a branch; only the top level
 *   moves and feeds the queue.
 * - When the top level finishes (its process is completed) or is aborted, it
 *   is removed and the level below goes on with the follow-up chosen when it
 *   started: `go-on` (past the step), `run-again` (the step stays), `ask`
 *   (the decision Go on / Run the step again).
 *
 * Pure rules over ProcessState levels; ProcessStateStore applies them.
 * vscode-free.
 */

import {
    availableMoves,
    findPhase,
    findStep,
    findSubstep,
    notRun,
    selectProcess,
    trackStepIterations,
    type NestedFollowUp,
    type NestedKind,
    type ProcessDefinition,
    type ProcessListEntry,
    type ProcessState,
} from './processDefinition';

/** The default nesting depth above which a start asks for a confirmation. */
export const DEFAULT_MAX_PROCESS_DEPTH = 5;

/** The follow-ups, with their labels (the start's choice). */
/* eslint-disable @typescript-eslint/naming-convention -- the follow-up ids are the stored values */
export const NESTED_FOLLOW_UP_LABELS: Record<NestedFollowUp, string> = {
    ask: 'Ask me at the end (Go on / Run the step again)',
    'go-on': 'Go on past the step',
    'run-again': 'Run the step again',
};
/* eslint-enable @typescript-eslint/naming-convention */

/** A list entry, read. */
export interface ProcessListItem {
    process: string;
    description?: string;
    /** Input name → the text that fills it (resolved when the level starts). */
    inputs?: Record<string, string>;
}

function listItems(raw: ProcessListEntry[] | undefined): ProcessListItem[] {
    return (Array.isArray(raw) ? raw : [])
        .map((e): ProcessListItem | undefined => (typeof e === 'string'
            ? { process: e }
            : e && typeof e === 'object' && typeof e.process === 'string'
                ? {
                    process: e.process,
                    ...(e.description ? { description: e.description } : {}),
                    ...(e.inputs && typeof e.inputs === 'object' ? { inputs: Object.fromEntries(Object.entries(e.inputs).filter(([, v]) => typeof v === 'string')) } : {}),
                }
                : undefined))
        .filter((e): e is ProcessListItem => !!e && e.process !== '');
}

/**
 * The closed lists of the position `state` is at: its sub-step's, or — when
 * the sub-step names none — its step's. Empty without a definition or step.
 */
export function positionProcessLists(def: ProcessDefinition | null, state: ProcessState): { subprocesses: ProcessListItem[]; branches: ProcessListItem[] } {
    const step = def ? findStep(findPhase(def, state.phase), state.step) : undefined;
    const sub = findSubstep(step, state.substep);
    const own = sub && (sub.subprocesses !== undefined || sub.branches !== undefined) ? sub : step;
    return { subprocesses: listItems(own?.subprocesses), branches: listItems(own?.branches) };
}

/** How many levels are nested above the quest's own process. */
export function nestingDepth(levels: readonly ProcessState[]): number {
    return Math.max(0, levels.length - 1);
}

/** Whether starting one more level goes beyond `maxDepth` (then the start is confirmed first). */
export function startNeedsConfirmation(levels: readonly ProcessState[], maxDepth: number = DEFAULT_MAX_PROCESS_DEPTH): boolean {
    return nestingDepth(levels) + 1 > Math.max(0, maxDepth);
}

/** The top level. */
export function topLevel(levels: readonly ProcessState[]): ProcessState {
    return levels[levels.length - 1];
}

export type NestedStartCheck = { ok: true; def: ProcessDefinition } | { ok: false; error: string };

/**
 * Whether `processId` may start now as a `kind` from the top level: it is at
 * a position (not at a decision, not finished), its position lists the
 * process in the list of that kind, and the process is defined and valid.
 */
export function checkNestedStart(
    levels: readonly ProcessState[],
    defs: ReadonlyMap<string, ProcessDefinition>,
    kind: NestedKind,
    processId: string,
): NestedStartCheck {
    const top = topLevel(levels);
    const def = top?.process ? defs.get(top.process) : undefined;
    if (!top?.process || !def) { return { ok: false, error: 'no process is running at the top of the quest\'s process stack' }; }
    if (top.completed) { return { ok: false, error: `the process ${top.process} is finished` }; }
    if (top.decision || top.nestedEnded) { return { ok: false, error: 'the process is at a decision: decide first, then start it from a step' }; }
    const lists = positionProcessLists(def, top);
    const list = kind === 'subprocess' ? lists.subprocesses : lists.branches;
    const listName = kind === 'subprocess' ? 'subprocesses' : 'branches';
    if (!list.some((e) => e.process === processId)) {
        const offered = list.map((e) => e.process).join(', ');
        return { ok: false, error: `the step lists no ${kind} "${processId}" (its ${listName}: ${offered || 'none'}); only the listed processes start from a step` };
    }
    const target = defs.get(processId);
    if (!target) { return { ok: false, error: `the process "${processId}" is not defined (or its definition is invalid)` }; }
    return { ok: true, def: target };
}

/** The stack with a new level for `def` on top, started as a `kind` with `followUp` and its filled `inputs`. */
export function pushNestedLevel(
    levels: readonly ProcessState[],
    def: ProcessDefinition,
    kind: NestedKind,
    followUp: NestedFollowUp,
    now: Date = new Date(),
    inputs: Record<string, string> = {},
): ProcessState[] {
    return [...levels, {
        ...selectProcess(def),
        nested: { kind, followUp, startedAt: now.toISOString() },
        ...(Object.keys(inputs).length ? { inputs } : {}),
    }];
}

// ---- Inputs and outputs (CC-61) --------------------------------------------

/** The list entry of `kind` for `processId` at the top level's position, if listed. */
export function listedEntry(def: ProcessDefinition | null, state: ProcessState, kind: NestedKind, processId: string): ProcessListItem | undefined {
    const lists = positionProcessLists(def, state);
    return (kind === 'subprocess' ? lists.subprocesses : lists.branches).find((e) => e.process === processId);
}

/**
 * The inputs a level of `target` starts with: the entry's mapping, each text
 * resolved by `resolve` (the placeholder engine at the starting position).
 * Refused: a mapped name the process does not declare, a required input left
 * empty. A declared input without a mapping starts empty.
 */
export function fillNestedInputs(
    target: ProcessDefinition,
    entry: ProcessListItem | undefined,
    resolve: (text: string) => string,
): { ok: true; inputs: Record<string, string> } | { ok: false; error: string } {
    const declared = target.inputs ?? [];
    const mapping = entry?.inputs ?? {};
    const unknown = Object.keys(mapping).filter((n) => !declared.some((d) => d.name === n));
    if (unknown.length) {
        return { ok: false, error: `the step fills ${unknown.map((n) => `"${n}"`).join(', ')}, which ${target.id} does not declare (its inputs: ${declared.map((d) => d.name).join(', ') || 'none'})` };
    }
    const inputs: Record<string, string> = {};
    for (const decl of declared) {
        const raw = mapping[decl.name];
        const value = raw === undefined ? '' : resolve(raw).trim();
        if (decl.required && !value) { return { ok: false, error: `the input "${decl.name}" of ${target.id} is required, and the step ${raw === undefined ? 'does not fill it' : 'fills it with an empty value'}` }; }
        if (value) { inputs[decl.name] = value; }
    }
    return { ok: true, inputs };
}

/** `${input.<name>}` in an output's default value, filled from the level's inputs (unknown names stay as written). */
export function fillInputPlaceholders(text: string, inputs: Record<string, string> = {}): string {
    return text.replace(/\$\{input\.([A-Za-z0-9][A-Za-z0-9_-]*)\}/g, (all, name: string) => (name in inputs ? inputs[name] : all));
}

/** A level's declared outputs as they stand: set values, else the default `value` filled from its inputs. */
export function levelOutputs(def: ProcessDefinition | null, level: ProcessState): { values: Record<string, string>; missing: string[] } {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const decl of def?.outputs ?? []) {
        const set = level.outputs?.[decl.name];
        const value = set !== undefined && set !== '' ? set : decl.value ? fillInputPlaceholders(decl.value, level.inputs) : '';
        if (value) { values[decl.name] = value; } else if (decl.required) { missing.push(decl.name); }
    }
    return { values, missing };
}

/** Set outputs on the running level: only a nested level, only declared names; merged with those set before. */
export function setLevelOutputs(def: ProcessDefinition | null, level: ProcessState, values: Record<string, string>): { ok: true; state: ProcessState } | { ok: false; error: string } {
    if (!level.nested) { return { ok: false, error: 'outputs belong to a subprocess or branch; the running level is the quest\'s own process' }; }
    const declared = (def?.outputs ?? []).map((d) => d.name);
    const unknown = Object.keys(values).filter((n) => !declared.includes(n));
    if (unknown.length) { return { ok: false, error: `${level.process} declares no output ${unknown.map((n) => `"${n}"`).join(', ')} (its outputs: ${declared.join(', ') || 'none'})` }; }
    const bad = Object.entries(values).filter(([, v]) => typeof v !== 'string').map(([n]) => n);
    if (bad.length) { return { ok: false, error: `outputs are text: ${bad.join(', ')}` }; }
    return { ok: true, state: { ...level, outputs: { ...(level.outputs ?? {}), ...values } } };
}

/** The I/O variables of a level: `input.<name>` and `sub.<process>.<name>`. */
export function ioVariables(level: ProcessState): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [n, v] of Object.entries(level.inputs ?? {})) { out[`input.${n}`] = v; }
    for (const [p, values] of Object.entries(level.subOutputs ?? {})) {
        for (const [n, v] of Object.entries(values)) { out[`sub.${p}.${n}`] = v; }
    }
    return out;
}

/** What ending the top level did. */
export interface NestedEndResult {
    levels: ProcessState[];
    /** The level that ended. */
    ended: ProcessState;
    /** The level below as it was, and as it goes on. */
    parentBefore: ProcessState;
    parentAfter: ProcessState;
}

/**
 * The parent level after the level above it ended: `go-on` — where Proceed at
 * its step leads; `run-again` — the step itself; `ask` — the decision Go on /
 * Run the step again.
 */
export function parentAfterNested(
    parentDef: ProcessDefinition | null,
    parent: ProcessState,
    ended: ProcessState,
    outcome: 'finished' | 'aborted',
): ProcessState {
    const here = notRun({ ...parent });
    delete here.nestedEnded;
    const followUp = ended.nested?.followUp ?? 'ask';
    if (followUp === 'run-again') { return here; }
    if (followUp === 'go-on') {
        const proceed = availableMoves(parentDef, here).find((m) => m.kind === 'proceed');
        return proceed ? trackStepIterations(here, proceed.target) : here;
    }
    return { ...here, nestedEnded: { process: ended.process, kind: ended.nested?.kind ?? 'subprocess', outcome } };
}

/** End the top level (finished or aborted); refused at the quest's own process. */
export function endNestedLevel(
    levels: readonly ProcessState[],
    defs: ReadonlyMap<string, ProcessDefinition>,
    outcome: 'finished' | 'aborted',
): NestedEndResult | { error: string } {
    if (levels.length < 2) { return { error: 'no subprocess or branch is running: the top level is the quest\'s own process' }; }
    const ended = topLevel(levels);
    const parentBefore = levels[levels.length - 2];
    let parentAfter = parentAfterNested(defs.get(parentBefore.process) ?? null, parentBefore, ended, outcome);
    // A finished subprocess hands its outputs back to the level below (a branch and an aborted level hand nothing back).
    if (outcome === 'finished' && ended.nested?.kind === 'subprocess') {
        const { values } = levelOutputs(defs.get(ended.process) ?? null, ended);
        parentAfter = { ...parentAfter, subOutputs: { ...(parentAfter.subOutputs ?? {}), [ended.process]: values } };
    }
    return { levels: [...levels.slice(0, -2), parentAfter], ended, parentBefore, parentAfter };
}

/** A level's name in messages: "the subprocess team_review", "the branch x", "the process tom_specs". */
export function levelName(level: ProcessState): string {
    if (!level.nested) { return `the process ${level.process}`; }
    return `the ${level.nested.kind} ${level.process}`;
}

/** The decisions-journal entry of an aborted level (CC-42): which level, where it stood, the follow-up. */
export function abortedLevelJournalEntry(ended: ProcessState, position: string, parent: ProcessState, parentPosition: string, at: Date = new Date()): string {
    return [
        `## ${at.toISOString()} — aborted ${levelName(ended)}`,
        '',
        `- **Stood at:** ${position || '(no position)'}`,
        `- **Started from:** ${parent.process} › ${parentPosition}`,
        `- **Follow-up:** ${NESTED_FOLLOW_UP_LABELS[ended.nested?.followUp ?? 'ask']}`,
        '',
    ].join('\n');
}
