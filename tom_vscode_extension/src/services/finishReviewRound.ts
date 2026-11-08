/**
 * Finish review round: the click on the button of that name, which a review's
 * results carry in the MD Browser (tomAi_askInMdBrowser with
 * `finishReviewRound`). It confirms the review — the user-action step the
 * process is at — and moves the process on: the next step's prompt is queued
 * (as Proceed queues it), or, when the next position is a decision, the
 * decision opens. The panel clicked is closed by the caller.
 *
 * The results are usually shown by the closing item of the agent's step that
 * produced them, while that step is still running: its process-move marker
 * would move the process to the review once the item ends. The button is
 * therefore also offered when the running step leads to a user-action step,
 * and the click first completes that step (its marker's move) — the review has
 * begun, so it can be finished.
 *
 * vscode-free: the store, the queue and the dialog come in as {@link FinishReviewDeps}.
 */

import { decisionAt, userActionAt, type ProcessDefinition, type ProcessState } from '../utils/processDefinition';

export interface FinishReviewDeps {
    definition(): ProcessDefinition | null;
    state(): ProcessState;
    /** Where the running step's process-move marker leads, when a step of the quest is running. */
    runningStepTarget(): ProcessState | undefined;
    /** Complete the running step now: its marker goes and its move is made. */
    completeRunningStep(): Promise<{ ok: boolean; error?: string }>;
    /** Proceed at the current position, as the PROCESS view does (a user action: confirmed; else: its prompt queued). */
    proceed(): Promise<{ ok: true; queued: boolean; label: string } | { ok: false; error: string }>;
    /** Open the decision dialog; answers the option picked (undefined: dismissed). */
    decide(): Promise<string | undefined>;
    /** A position for people. */
    where(state: ProcessState): string;
}

export type FinishReviewNext = 'queued' | 'decision' | 'userAction' | 'finished';

export type FinishReviewOutcome =
    | { ok: true; confirmed: string; next: FinishReviewNext; where: string; decided?: string }
    | { ok: false; error: string };

/** Why the button cannot be offered now; undefined when it can. */
export function finishReviewUnavailable(deps: Pick<FinishReviewDeps, 'definition' | 'state' | 'runningStepTarget'>): string | undefined {
    const def = deps.definition();
    const state = deps.state();
    if (!def || !state.process) { return 'the quest has no process set'; }
    if (state.completed) { return 'the process is finished'; }
    if (userActionAt(def, state) && !state.decision) { return undefined; }
    const target = deps.runningStepTarget();
    if (target && userActionAt(def, target)) { return undefined; }
    return 'the process is not at a review (a user-action step), and the step running now does not lead to one';
}

/** The click: confirm the review, move on, then queue the next step's prompt or open the decision. */
export async function finishReviewRound(deps: FinishReviewDeps): Promise<FinishReviewOutcome> {
    const unavailable = finishReviewUnavailable(deps);
    if (unavailable) { return { ok: false, error: unavailable }; }
    const def = deps.definition()!;
    if (!userActionAt(def, deps.state())) {
        // The closing item of the step before the review: that step is done.
        const completed = await deps.completeRunningStep();
        if (!completed.ok) { return { ok: false, error: `the step before the review could not be completed: ${completed.error ?? 'unknown error'}` }; }
        if (!userActionAt(def, deps.state())) { return { ok: false, error: 'the process did not arrive at the review' }; }
    }
    const confirmed = await deps.proceed();
    if (!confirmed.ok) { return { ok: false, error: `the review could not be confirmed: ${confirmed.error}` }; }
    const after = deps.state();
    const where = (): string => deps.where(deps.state());
    if (after.completed) { return { ok: true, confirmed: confirmed.label, next: 'finished', where: where() }; }
    if (decisionAt(def, after)) {
        const decided = await deps.decide();
        return { ok: true, confirmed: confirmed.label, next: 'decision', where: where(), ...(decided ? { decided } : {}) };
    }
    // The next step is the user's again: nothing to queue.
    if (userActionAt(def, after)) { return { ok: true, confirmed: confirmed.label, next: 'userAction', where: where() }; }
    const queued = await deps.proceed();
    if (!queued.ok) { return { ok: false, error: `the review was confirmed, but the next step's prompt could not be queued: ${queued.error}` }; }
    return { ok: true, confirmed: confirmed.label, next: 'queued', where: where() };
}

/** One line for the agent's answer. */
export function finishReviewSummary(outcome: FinishReviewOutcome): string {
    if (!outcome.ok) { return `Finish review round failed: ${outcome.error}`; }
    switch (outcome.next) {
        case 'queued': return `The review is confirmed; the process is at ${outcome.where} and its prompt is queued.`;
        case 'decision': return `The review is confirmed; the process is at a decision (${outcome.where})${outcome.decided ? ` and the user chose: ${outcome.decided}` : ', which the user takes in the PROCESS view'}.`;
        case 'userAction': return `The review is confirmed; the process is at ${outcome.where}, which is the user's to do.`;
        default: return 'The review is confirmed; the process is finished.';
    }
}
