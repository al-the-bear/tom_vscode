/**
 * A queue stage stopped because the API credit balance is too low: how it is
 * recognised, what the queue does about it, and the prompt it sends when the
 * work continues on another profile.
 *
 * The direct API refuses every request with a 400 invalid_request_error
 * ("Your credit balance is too low to access the Anthropic API") until credit
 * is bought, so retrying is pointless and an unattended walk stops. A profile
 * may name the profile to continue on (`outOfBudget.fallbackProfileId`) and
 * switch to it by itself (`outOfBudget.autoSwitch`); otherwise the user picks:
 * continue on a profile, or resend the very last request once credit is back.
 *
 * vscode-free.
 */

/** A profile's policy for running out of credit. */
export interface OutOfBudgetPolicy {
    /** The profile the work continues on. */
    fallbackProfileId?: string;
    /** Continue there without asking. */
    autoSwitch?: boolean;
}

/** What the queue item records when a stage stopped for lack of credit. */
export interface OutOfBudgetMark {
    /** The profile that ran out. */
    profileId: string;
    profileName?: string;
    model?: string;
    /** The session the stage ran in. */
    session: string;
    /** The API's message. */
    message: string;
    /** ISO time it stopped. */
    at: string;
    /** The profile the picker starts on: the stopped profile's fallback. */
    suggestedProfileId?: string;
}

export type OutOfBudgetDecision =
    | { kind: 'switch'; profileId: string }
    | { kind: 'ask'; suggestedProfileId?: string };

const OUT_OF_BUDGET = /credit balance is too low|credit_balance_too_low/i;

/** An item that continues on another profile after running out of credit. */
export interface BudgetFallback {
    fromProfileId: string;
    toProfileId: string;
    /** The session to run in when the item's own cannot take `toProfileId`. */
    session?: string;
}

/**
 * A stage's resolved transport once its item continues on another profile:
 * a stage that would run on the profile that ran out runs on the fallback
 * (with that profile's own configuration, and in the fallback session when
 * one is named); any other stage is left as it is.
 */
export function applyBudgetFallback<T extends { anthropicProfileId?: string; anthropicConfigId?: string; session?: string }>(
    resolved: T,
    budgetFallback: BudgetFallback | undefined,
): T {
    if (!budgetFallback || resolved.anthropicProfileId !== budgetFallback.fromProfileId) { return resolved; }
    return {
        ...resolved,
        anthropicProfileId: budgetFallback.toProfileId,
        anthropicConfigId: undefined,
        ...(budgetFallback.session ? { session: budgetFallback.session } : {}),
    };
}

/** Did a send fail because the credit balance is too low? */
export function isOutOfBudgetFailure(text: string | undefined): boolean {
    return !!text && OUT_OF_BUDGET.test(text);
}

/**
 * What to do when `profileId` ran out: switch when the profile switches by
 * itself to another profile that exists, else ask — suggesting its fallback
 * when that is a real other profile.
 */
export function decideOutOfBudget(
    profileId: string | undefined,
    profiles: ReadonlyArray<{ id: string; outOfBudget?: OutOfBudgetPolicy } | null | undefined>,
): OutOfBudgetDecision {
    const policy = profiles.find((p) => p?.id === profileId)?.outOfBudget;
    const fallback = policy?.fallbackProfileId;
    const usable = !!fallback && fallback !== profileId && profiles.some((p) => p?.id === fallback);
    if (!usable) { return { kind: 'ask' }; }
    return policy?.autoSwitch === true
        ? { kind: 'switch', profileId: fallback! }
        : { kind: 'ask', suggestedProfileId: fallback };
}

/**
 * The prompt sent on the other profile: what stopped, where, where its trail
 * is, and the original prompt — so the new run continues the work instead of
 * starting it again.
 */
export function outOfBudgetPrompt(
    mark: OutOfBudgetMark,
    opts: { quest?: string; toProfileName: string; runsInSession: string; originalPrompt: string },
): string {
    const ran = `profile "${mark.profileName ?? mark.profileId}" (${mark.profileId}${mark.model ? `, model ${mark.model}` : ''}) in session "${mark.session}"`;
    const where = opts.runsInSession === mark.session
        ? ''
        : ` It runs in session "${opts.runsInSession}": session "${mark.session}" keeps its conversation where profile "${opts.toProfileName}" cannot continue it.`;
    const trail = opts.quest
        ? `\`_ai/quests/${opts.quest}/history/sessions/${mark.session}/live-trail.md\``
        : `the live trail of session "${mark.session}"`;
    return [
        `**Out of budget — continuing on profile "${opts.toProfileName}".**`,
        '',
        `The prompt below was running on ${ran} and stopped at ${mark.at}: ${mark.message}`,
        `It is sent again on profile "${opts.toProfileName}".${where}`,
        '',
        `What the stopped run had already done is in that session's live trail, ${trail}; changes it made and did not commit are in the working trees (\`git status\`). Read them first and continue the work from where it stopped — do not start it over.`,
        '',
        '---',
        '',
        opts.originalPrompt,
    ].join('\n');
}
