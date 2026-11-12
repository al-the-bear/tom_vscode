/**
 * After each iteration of a `<prefix>*` walk the queue reads the walked todo
 * before it moves on (the Q&A of 2026-11-11, Q3 (a)). A todo that is not
 * completed, with nothing in it saying why — not `blocked` or
 * `decision-needed`, no open decision written into it, no question waiting —
 * gets a continuation in the same session: the agent ended its turn before its
 * work was done ("I'm waiting to get notified"). At most N continuations
 * (default 2); then the item stops as *needs attention* instead of walking on.
 *
 * The iteration's answer is its last turn's; the earlier answers are kept on
 * the repetition answer (`earlier`, shown folded under the final one), and the
 * continuation prompt is no answer.
 *
 * Pure.
 */

/** How many continuations a walk iteration gets when neither the item nor the queue says otherwise. */
export const DEFAULT_WALK_CONTINUATIONS = 2;

/** What the check reads of the walked todo. */
export interface WalkedTodo {
    status?: string;
    decisions?: ReadonlyArray<{ decision?: unknown }>;
}

export type CompletionVerdict =
    /** Completed (or done for this round: a repeated todo waiting for its next run, or cancelled). */
    | { kind: 'done' }
    /** Not completed, and the todo or the queue says why: no continuation. */
    | { kind: 'reason'; why: string }
    /** Not completed and nothing says why: a continuation. */
    | { kind: 'continue'; status: string }
    /** The todo is gone (archived, deleted, renamed): nothing to check. */
    | { kind: 'missing' };

function hasOpenDecision(todo: WalkedTodo): boolean {
    return (todo.decisions ?? []).some((d) => {
        const v = d?.decision;
        return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    });
}

/** What follows a walk iteration for its todo (`pendingQuestion`: the item's turn waits in a question). */
export function completionVerdict(todo: WalkedTodo | undefined, pendingQuestion: boolean): CompletionVerdict {
    if (!todo) { return { kind: 'missing' }; }
    const status = (todo.status ?? '').trim();
    if (status === 'completed' || status === 'waiting-for-repeat' || status === 'cancelled') { return { kind: 'done' }; }
    if (status === 'blocked') { return { kind: 'reason', why: 'the todo is blocked' }; }
    if (status === 'decision-needed') { return { kind: 'reason', why: 'the todo waits for a decision' }; }
    if (hasOpenDecision(todo)) { return { kind: 'reason', why: 'the todo has an open decision' }; }
    if (pendingQuestion) { return { kind: 'reason', why: 'a question waits for the user' }; }
    return { kind: 'continue', status: status || 'not-started' };
}

/** The continuation prompt, sent into the iteration's own session. */
export function continuationPrompt(todoId: string): string {
    return `The todo ${todoId} is not completed. If you started something, wait for it actively and finish the todo; if it cannot be finished, say why and set its status.`;
}

/** Why the item stopped as needs attention. */
export function needsAttentionReason(todoId: string, status: string, continuations: number): string {
    return `The todo ${todoId} is still ${status} after ${continuations} continuation${continuations === 1 ? '' : 's'}; the walk stopped instead of going on. Look at it, then turn auto-send on to go on with the next todo (or Resend this one).`;
}

/** `1 continuation`, `2 continuations` — the mark on the iteration's answer chip. */
export function continuationMark(n: number): string {
    return `${n} continuation${n === 1 ? '' : 's'}`;
}

/** The number of continuations as given (a whole number, 0 or more), else undefined. */
export function validContinuations(raw: unknown): number | undefined {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}
