/**
 * The prompt queue's claim on a quest todo — the one status write the runner
 * makes, and the rule for taking it back.
 *
 * In `prefix*` todo iteration the runner writes `status: in-progress` onto the
 * todo it is about to dispatch, BEFORE the send: an in-progress todo no longer
 * qualifies, which is what makes the walk terminate. That write is a claim the
 * runner owes an outcome for. When the run stops, is interrupted or errors
 * before the answer for that dispatch arrives, nobody started the todo — and a
 * todo left `in-progress` says somebody did. It happened twice in consecutive
 * quest refreshes before this existed.
 *
 * So a claim records what it overwrote, and is either:
 *
 *  - **settled** — the dispatch concluded (its answer arrived and the runner
 *    moved on). The claim is dropped; the todo keeps whatever status it has,
 *    which is the agent's to set.
 *  - **released** — the run ended without an answer. The prior status is put
 *    back, but ONLY if the todo still holds the value the runner wrote. If the
 *    agent (or the user) changed it meanwhile — completed it, blocked it — that
 *    write is theirs and is left alone. The runner resets its own write and
 *    nothing else.
 *
 * A released claim stays on the item marked `released`, so a Resend of that
 * same main-stage prompt can claim the todo again (when it is still at the
 * status the release put back).
 *
 * The logic is pure over a small read/write port so it can be tested without
 * the vscode-coupled PromptQueueManager.
 */

/** The status the runner writes when it claims a todo. */
export const CLAIM_STATUS = 'in-progress';

/** The status a todo is assumed to have had when the source carried none. */
const DEFAULT_PRIOR_STATUS = 'not-started';

export interface TodoClaim {
    questId: string;
    todoId: string;
    /** The status the claim overwrote — what a release puts back. */
    priorStatus: string;
    /** ISO time of the claim. */
    claimedAt: string;
    /** Set once the claim was released (prior status restored or left). */
    released?: boolean;
}

/** Read/write access to a quest todo's status. */
export interface TodoStatusPort {
    /** Current status of the todo, or `undefined` when it cannot be read. */
    readStatus(questId: string, todoId: string): string | undefined;
    /** Write a status; `false` when the write did not stick. */
    writeStatus(questId: string, todoId: string, status: string): boolean;
}

function normaliseStatus(status: string | undefined): string | undefined {
    const s = status?.trim().toLowerCase().replace(/[\s_]+/g, '-');
    return s ? s : undefined;
}

/**
 * Claim a todo: write {@link CLAIM_STATUS} and return the claim, or
 * `undefined` when the write did not stick (the caller must then not dispatch).
 * `priorStatus` is what the dispatcher saw when it picked the todo.
 */
export function claimTodo(
    port: TodoStatusPort,
    questId: string,
    todoId: string,
    priorStatus: string | undefined,
    now: Date = new Date(),
): TodoClaim | undefined {
    if (!port.writeStatus(questId, todoId, CLAIM_STATUS)) { return undefined; }
    return {
        questId,
        todoId,
        priorStatus: normaliseStatus(priorStatus) ?? DEFAULT_PRIOR_STATUS,
        claimedAt: now.toISOString(),
    };
}

export type ReleaseOutcome =
    /** No live claim — nothing to do. */
    | 'none'
    /** The todo still held the runner's write; the prior status is back. */
    | 'restored'
    /** The todo no longer holds the runner's write; it was left as it is. */
    | 'left'
    /** The todo could not be read or the restore did not stick. */
    | 'failed';

export interface ReleaseResult {
    outcome: ReleaseOutcome;
    /** The claim to keep on the item afterwards (marked released), or undefined. */
    claim: TodoClaim | undefined;
    /** The status the todo was found at (when read). */
    found?: string;
}

/**
 * Release a claim whose dispatch ended without an answer: restore the prior
 * status iff the todo still holds {@link CLAIM_STATUS}.
 */
export function releaseTodoClaim(port: TodoStatusPort, claim: TodoClaim | undefined): ReleaseResult {
    if (!claim || claim.released) { return { outcome: 'none', claim }; }
    const found = normaliseStatus(port.readStatus(claim.questId, claim.todoId));
    const released: TodoClaim = { ...claim, released: true };
    if (found === undefined) { return { outcome: 'failed', claim: released }; }
    if (found !== CLAIM_STATUS) { return { outcome: 'left', claim: released, found }; }
    const ok = port.writeStatus(claim.questId, claim.todoId, claim.priorStatus);
    return { outcome: ok ? 'restored' : 'failed', claim: released, found };
}

/**
 * Re-claim the todo of a released claim for a Resend of the same main-stage
 * prompt. Only when the todo is still at the status the release put back —
 * anything else means somebody else has moved it since, and it is theirs.
 * Returns the fresh claim, or the input unchanged when nothing was claimed.
 */
export function reclaimForResend(
    port: TodoStatusPort,
    claim: TodoClaim | undefined,
    now: Date = new Date(),
): TodoClaim | undefined {
    if (!claim || !claim.released) { return claim; }
    const found = normaliseStatus(port.readStatus(claim.questId, claim.todoId));
    if (found !== claim.priorStatus) { return claim; }
    return claimTodo(port, claim.questId, claim.todoId, claim.priorStatus, now) ?? claim;
}

/* eslint-disable @typescript-eslint/naming-convention -- the persisted YAML keys are kebab-case, like every other queue-file key. */
/** The YAML shape a claim is persisted in (on the main prompt, `todo-claim`). */
export interface TodoClaimYaml {
    quest: string;
    todo: string;
    'prior-status': string;
    'claimed-at': string;
    released?: boolean;
}

export function todoClaimToYaml(claim: TodoClaim | undefined): TodoClaimYaml | undefined {
    if (!claim) { return undefined; }
    return {
        quest: claim.questId,
        todo: claim.todoId,
        'prior-status': claim.priorStatus,
        'claimed-at': claim.claimedAt,
        ...(claim.released ? { released: true } : {}),
    };
}

export function todoClaimFromYaml(raw: unknown): TodoClaim | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    if (typeof r.quest !== 'string' || !r.quest || typeof r.todo !== 'string' || !r.todo) { return undefined; }
    return {
        questId: r.quest,
        todoId: r.todo,
        priorStatus: normaliseStatus(typeof r['prior-status'] === 'string' ? r['prior-status'] : undefined) ?? DEFAULT_PRIOR_STATUS,
        claimedAt: typeof r['claimed-at'] === 'string' ? r['claimed-at'] : new Date(0).toISOString(),
        ...(r.released === true ? { released: true } : {}),
    };
}
/* eslint-enable @typescript-eslint/naming-convention */
