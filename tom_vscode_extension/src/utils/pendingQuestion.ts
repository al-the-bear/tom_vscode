/**
 * A queue item whose turn waits for the user's answer, and what Continue
 * offers on a running item.
 *
 * Continue never acts blindly (the user's decision on vscimpb55): it asks
 * first. **Answer now** (open the question) is offered only while the item's
 * turn waits for an answer; **Resend this stage** and **Skip** are offered
 * always — an item can be stuck for reasons nobody can see. Cancel is the
 * dialog's own.
 *
 * Pure: imports neither `vscode` nor the queue.
 */

/** What Continue does on a running item. */
export type ContinueAction = 'answer' | 'waitWithoutLimit' | 'keepWaiting' | 'stopWaiting' | 'resend' | 'skip';

export interface ContinueOption {
    action: ContinueAction;
    label: string;
}

/** The note the resent stage starts with: the agent sees that its turn was interrupted. */
export const RESEND_INTERRUPTED_NOTE =
    '[Resent by the user: your previous turn on this prompt was interrupted before it finished. ' +
    'Look at what you already did (your trail and the files) and go on from there.]';

/** The answer of a question closed because the user resent its stage. */
export const QUESTION_CLOSED_BY_RESEND =
    'The user resent this prompt; this question was closed unanswered. The prompt runs again from its start.';

/** The answer of a question closed because the user stopped its prompt. */
export const QUESTION_CLOSED_BY_STOP =
    'The user stopped this prompt; this question was closed unanswered.';

/** The answer of a question closed because the user skipped its stage. */
export const QUESTION_CLOSED_BY_SKIP =
    'The user skipped to the next stage; this question was closed unanswered.';

/**
 * The options Continue offers, in order (Cancel is the dialog's own). While
 * the item's turn waits for its background work (`backgroundLimit`: the
 * limit as text, e.g. `6 h`) it also offers the wait's three choices.
 */
export function continueOptions(o: { waitingForAnswer: boolean; canResend: boolean; walk: boolean; backgroundLimit?: string }): ContinueOption[] {
    const options: ContinueOption[] = [];
    if (o.waitingForAnswer) { options.push({ action: 'answer', label: 'Answer now' }); }
    if (o.backgroundLimit !== undefined) {
        options.push(
            { action: 'waitWithoutLimit', label: 'Wait without limit' },
            { action: 'keepWaiting', label: `Keep waiting up to ${o.backgroundLimit}` },
            { action: 'stopWaiting', label: 'Stop waiting' },
        );
    }
    if (o.canResend) { options.push({ action: 'resend', label: 'Resend this stage' }); }
    options.push({ action: 'skip', label: o.walk ? 'Skip to the next todo' : 'Skip to the next stage' });
    return options;
}

/** The dialog's message and detail. */
export function continuePrompt(o: { waitingSince?: string; walk: boolean; backgroundWait?: string }): { message: string; detail: string } {
    const skip = o.walk ? 'Skip ends the turn and goes on with the next todo' : 'Skip ends the turn and goes on with the next stage';
    if (o.backgroundWait && !o.waitingSince) {
        return {
            message: `This item's turn is waiting for its background work (${o.backgroundWait}).`,
            detail: `Wait without limit waits until the work ends. Keep waiting starts the limit again from now. Stop waiting ends the turn now (its answer names what still runs) and the queue goes on. Resend ends the turn and sends the same prompt again. ${skip}.`,
        };
    }
    if (o.waitingSince) {
        return {
            message: `This item's turn is waiting for your answer (${o.waitingSince}).`,
            detail: `Answer now opens the question; the turn goes on with your answer. Resend ends the turn and sends the same prompt again. ${skip}. Resend and Skip close the question unanswered.`,
        };
    }
    return {
        message: 'This item is still running.',
        detail: `Resend ends the turn and sends the same prompt again (the agent is told it was interrupted). ${skip}.`,
    };
}

function twoDigits(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** `since 20:31 (9 h 25 min)` — local clock time and how long it has waited. */
export function waitingSinceLabel(createdAt: number, now: number): string {
    const at = new Date(createdAt);
    const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
    const waited = minutes < 1 ? 'under a minute'
        : minutes < 60 ? `${minutes} min`
            : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    return `since ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())} (${waited})`;
}
