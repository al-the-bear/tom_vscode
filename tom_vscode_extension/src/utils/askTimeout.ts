/**
 * The deadline rule shared by the two "ask the user" tools (`tomAi_askUser`
 * and `tomAi_askUserPicker`).
 *
 * An ask blocks the LLM round, and therefore the prompt queue, until it
 * resolves — so how long it may block is the single most consequential knob on
 * these tools. Two parties have a say, and they are **not** symmetric:
 *
 *   - the **user's ceiling** (`maxWaitMinutes` in the Chat questions settings)
 *     is the longest an ask may ever block, whatever the model asks for. `0`
 *     means "no ceiling", matching `parseChatQuestionsConfig`.
 *   - the **model's request** (`timeoutMinutes` on the tool call) is what *this*
 *     particular ask wants — typically because the model has a reasonable
 *     default it can fall back to and would rather not stall on a nicety.
 *
 * Neither present means **wait indefinitely**: a question the user has not read
 * yet must not answer itself. Both present means the shorter one wins — the
 * ceiling caps the request, the request may voluntarily go below the ceiling.
 */

/** Whole minutes ≥ 1, or `undefined` when the value does not ask for a deadline. */
function asRequestedMinutes(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) { return undefined; }
    // A sub-minute request still wants *a* deadline — flooring 0.5 to 0 would
    // silently turn an explicit timeout into an infinite wait.
    return Math.max(1, Math.floor(value));
}

/** Whole minutes ≥ 1, or `undefined` when there is no ceiling. */
function asCeilingMinutes(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) { return undefined; }
    // A ceiling rounds down: erring towards the shorter wait is the safe side
    // for a limit whose whole job is to stop an ask blocking too long.
    const floored = Math.floor(value);
    return floored >= 1 ? floored : undefined;
}

/**
 * Resolve the effective deadline for an ask, in milliseconds, or `undefined`
 * when it should wait indefinitely.
 *
 * @param ceilingMinutes The user's configured `maxWaitMinutes` (0 / absent = none).
 * @param requestedMinutes The model's per-call `timeoutMinutes` (absent = none).
 */
export function resolveAskTimeoutMs(
    ceilingMinutes: number | undefined,
    requestedMinutes: number | undefined,
): number | undefined {
    const ceiling = asCeilingMinutes(ceilingMinutes);
    const requested = asRequestedMinutes(requestedMinutes);
    const minutes = ceiling === undefined
        ? requested
        : requested === undefined ? ceiling : Math.min(ceiling, requested);
    return minutes === undefined ? undefined : minutes * 60_000;
}
