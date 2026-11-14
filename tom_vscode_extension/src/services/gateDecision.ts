/**
 * The gate decision from the gate's own prompt (vscimpb85): a gate's prompt
 * shows its result document in the MD Browser with the buttons of the
 * decision that follows the gate — gate passed / gate failed, go on / repeat
 * (tomAi_askInMdBrowser with `gateDecision`). The decision itself only opens
 * once the gate's prompt and everything it queued are done (the process-move
 * marker), so the buttons are the choices of the decision the running gate
 * step leads to. A click ends the gate's step — its marker goes and its move
 * is made, so the process is at the decision — and then takes the choice, as
 * picking it in the PROCESS view's Decide… would. Nothing waits on the queue.
 *
 * At the gate's decision already (the gate's prompt has ended), the buttons
 * are that decision's choices and a click takes one.
 *
 * vscode-free: the store, the queue and the move come in as {@link GateDecisionDeps}.
 */

import { decisionDialog } from '../utils/processActionPrompt';
import { findPhase, type ConditionOptions, type ProcessDefinition, type ProcessState } from '../utils/processDefinition';

export interface GateDecisionDeps {
    definition(): ProcessDefinition | null;
    state(): ProcessState;
    conditions?(): ConditionOptions;
    /** Where the running step's process-move marker leads, when a step of the quest is running. */
    runningStepTarget(): ProcessState | undefined;
    /** Complete the running step now: its marker goes and its move is made. */
    completeRunningStep(): Promise<{ ok: boolean; error?: string }>;
    /** Take the decision's option `label`, as the Decide… dialog does. */
    take(label: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** A position for people. */
    where(state: ProcessState): string;
}

export type GateDecisionOutcome =
    | { ok: true; decided: string; gate: string; where: string }
    | { ok: false; error: string };

/** Whether `state` is at the gate step of its phase. */
function atGate(def: ProcessDefinition, state: ProcessState): boolean {
    const phase = findPhase(def, state.phase);
    return !!phase && !!state.step && phase.gate.id === state.step;
}

/** The decision the buttons offer: the gate's decision now, else the one the running gate step leads to. */
function gateDecisionState(deps: Pick<GateDecisionDeps, 'definition' | 'state' | 'runningStepTarget' | 'conditions'>):
    { state: ProcessState; running: boolean } | { error: string } {
    const def = deps.definition();
    const state = deps.state();
    if (!def || !state.process) { return { error: 'the quest has no process set' }; }
    if (state.completed) { return { error: 'the process is finished' }; }
    if (!atGate(def, state)) { return { error: 'the process is not at a gate' }; }
    const conditions = deps.conditions?.() ?? {};
    if (state.decision) {
        return decisionDialog(def, state, conditions) ? { state, running: false } : { error: 'the gate has no decision' };
    }
    const target = deps.runningStepTarget();
    if (!target) { return { error: 'the gate\'s step is not running (start it with Proceed), so no decision follows it here' }; }
    if (!decisionDialog(def, target, conditions)) { return { error: 'the running gate step does not lead to a decision' }; }
    return { state: target, running: true };
}

/** Why the gate decision cannot be offered now; undefined when it can. */
export function gateDecisionUnavailable(deps: Pick<GateDecisionDeps, 'definition' | 'state' | 'runningStepTarget' | 'conditions'>): string | undefined {
    const at = gateDecisionState(deps);
    return 'error' in at ? at.error : undefined;
}

/** The choices of the gate's decision, as Decide… shows them ([] when it cannot be offered). */
export function gateDecisionOptions(deps: Pick<GateDecisionDeps, 'definition' | 'state' | 'runningStepTarget' | 'conditions'>): string[] {
    const at = gateDecisionState(deps);
    const def = deps.definition();
    if ('error' in at || !def) { return []; }
    return decisionDialog(def, at.state, deps.conditions?.() ?? {})?.options.map((o) => o.label) ?? [];
}

/** The click: end the gate's step when it is still running, then take the choice `label`. */
export async function takeGateDecision(deps: GateDecisionDeps, label: string): Promise<GateDecisionOutcome> {
    const at = gateDecisionState(deps);
    if ('error' in at) { return { ok: false, error: at.error }; }
    if (!gateDecisionOptions(deps).includes(label)) { return { ok: false, error: `the gate's decision does not offer "${label}"` }; }
    const gate = deps.where(deps.state());
    if (at.running) {
        const completed = await deps.completeRunningStep();
        if (!completed.ok) { return { ok: false, error: `the gate's step could not be ended: ${completed.error ?? 'unknown error'}` }; }
        const def = deps.definition();
        const now = deps.state();
        if (!def || !now.decision || !decisionDialog(def, now, deps.conditions?.() ?? {})) {
            return { ok: false, error: 'the process did not arrive at the gate\'s decision' };
        }
    }
    const taken = await deps.take(label);
    if (!taken.ok) { return { ok: false, error: `the decision could not be taken: ${taken.error}` }; }
    return { ok: true, decided: label, gate, where: deps.where(deps.state()) };
}

/** One line for the agent's answer. */
export function gateDecisionSummary(outcome: GateDecisionOutcome): string {
    if (!outcome.ok) { return `The gate decision failed: ${outcome.error}. The decision stays the user's in the PROCESS view (Decide…).`; }
    const state = outcome.where ? `; the process is at ${outcome.where}` : '';
    return `The user decided at ${outcome.gate}: ${outcome.decided}${state}.`;
}
