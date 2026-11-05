/**
 * The final answer of a todo walk, kept on the todo (todo schema
 * `last_answer`).
 *
 * In a `<prefix>*` walk the queue claims each todo before its main prompt goes
 * out (queueTodoClaim.ts). When that dispatch concludes the claim is settled;
 * at that moment the main prompt's answer is the todo's execution answer. When
 * the todo is completed by then, the answer is written onto it, replacing any
 * earlier one, so the result can be read from the todo (the todo panel shows
 * it for completed todos). A todo the run did not complete gets nothing, and
 * the archive strips the field (todoArchive.ts).
 *
 * Pure over a small port, so it is tested without the vscode-coupled queue.
 */

import type { TodoClaim } from './queueTodoClaim';

/** Read a todo's status, write its last answer. */
export interface TodoAnswerPort {
    readStatus(questId: string, todoId: string): string | undefined;
    /** `false` when the write did not stick. */
    writeLastAnswer(questId: string, todoId: string, answer: string): boolean;
}

export type TodoAnswerOutcome = 'written' | 'not-completed' | 'no-answer' | 'no-claim' | 'write-failed';

/**
 * Settle a claim with its dispatch's answer: write it onto the todo when the
 * todo is completed. `answer` is the main prompt's answer (undefined when the
 * concluded dispatch was not the claim's main prompt).
 */
export function recordTodoAnswer(port: TodoAnswerPort, claim: TodoClaim | undefined, answer: string | undefined): TodoAnswerOutcome {
    if (!claim || claim.released) { return 'no-claim'; }
    const text = answer?.trim() ? answer : undefined;
    if (!text) { return 'no-answer'; }
    if (port.readStatus(claim.questId, claim.todoId)?.trim().toLowerCase() !== 'completed') { return 'not-completed'; }
    return port.writeLastAnswer(claim.questId, claim.todoId, text) ? 'written' : 'write-failed';
}
