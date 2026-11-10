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
}

function listItems(raw: ProcessListEntry[] | undefined): ProcessListItem[] {
    return (Array.isArray(raw) ? raw : [])
        .map((e): ProcessListItem | undefined => (typeof e === 'string'
            ? { process: e }
            : e && typeof e === 'object' && typeof e.process === 'string'
                ? { process: e.process, ...(e.description ? { description: e.description } : {}) }
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

/** The stack with a new level for `def` on top, started as a `kind` with `followUp`. */
export function pushNestedLevel(
    levels: readonly ProcessState[],
    def: ProcessDefinition,
    kind: NestedKind,
    followUp: NestedFollowUp,
    now: Date = new Date(),
): ProcessState[] {
    return [...levels, { ...selectProcess(def), nested: { kind, followUp, startedAt: now.toISOString() } }];
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
    const parentAfter = parentAfterNested(defs.get(parentBefore.process) ?? null, parentBefore, ended, outcome);
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
