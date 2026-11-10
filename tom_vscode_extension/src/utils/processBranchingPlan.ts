/**
 * The process branching editor's cards: the processes the running step lists
 * (`subprocesses:` and `branches:`, processStack.positionProcessLists) — the
 * lists are closed, so nothing else is offered — each with what it is, where
 * it starts, the inputs the step fills, and the follow-up offered first. An
 * agent's suggestion (ccparity_e_process-8) adds its reason and recommended
 * follow-up to the card of the process it names; a suggestion for a process
 * the step does not list is dropped.
 *
 * vscode-free.
 */

import { selectProcess, type NestedFollowUp, type NestedKind, type ProcessDefinition, type ProcessState } from './processDefinition';
import { positionProcessLists } from './processStack';

/** An agent's suggestion of a listed process. */
export interface ProcessSuggestion {
    kind: NestedKind;
    process: string;
    reason: string;
    followUp?: NestedFollowUp;
}

export interface BranchingCard {
    kind: NestedKind;
    process: string;
    /** The process's name, else its id. */
    name: string;
    /** The process's summary (one line). */
    summary: string;
    /** The list entry's description. */
    description: string;
    /** Where the process starts, e.g. "Prepare › Distribute"; '' when it is not defined. */
    startsAt: string;
    /** The process's declared inputs and the text the step fills each with ('' when it does not). */
    inputs: Array<{ name: string; kind?: string; required: boolean; from: string }>;
    /** Whether the process is defined and valid (a card that is not cannot start). */
    valid: boolean;
    /** The agent's reason, when it suggested this process. */
    reason?: string;
    /** The follow-up offered first: the agent's recommendation, else `ask`. */
    followUp: NestedFollowUp;
    recommended: boolean;
}

/**
 * The cards for the step `state` is at, both lists, the suggested ones first
 * (in the agent's order), then the others in the definition's order.
 * `positionText` names a position of a process (processActionPrompt.positionText).
 */
export function branchingCards(
    def: ProcessDefinition | null,
    state: ProcessState,
    defs: ReadonlyMap<string, ProcessDefinition>,
    positionText: (def: ProcessDefinition, state: ProcessState) => string,
    suggestions: readonly ProcessSuggestion[] = [],
): BranchingCard[] {
    const lists = positionProcessLists(def, state);
    const entries = [
        ...lists.subprocesses.map((e) => ({ ...e, kind: 'subprocess' as const })),
        ...lists.branches.map((e) => ({ ...e, kind: 'branch' as const })),
    ];
    const cards = entries.map((e): BranchingCard => {
        const target = defs.get(e.process);
        const suggestion = suggestions.find((s) => s.kind === e.kind && s.process === e.process);
        return {
            kind: e.kind,
            process: e.process,
            name: target?.name || e.process,
            summary: target?.summary ?? '',
            description: e.description ?? '',
            startsAt: target ? positionText(target, selectProcess(target)) : '',
            inputs: (target?.inputs ?? []).map((d) => ({ name: d.name, ...(d.kind ? { kind: d.kind } : {}), required: d.required === true, from: e.inputs?.[d.name] ?? '' })),
            valid: !!target,
            ...(suggestion ? { reason: suggestion.reason } : {}),
            followUp: suggestion?.followUp ?? 'ask',
            recommended: !!suggestion?.followUp,
        };
    });
    const rank = (c: BranchingCard): number => {
        const i = suggestions.findIndex((s) => s.kind === c.kind && s.process === c.process);
        return i < 0 ? suggestions.length : i;
    };
    return cards.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}
