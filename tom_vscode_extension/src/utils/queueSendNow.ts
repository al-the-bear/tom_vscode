/**
 * Send Now and the pause gate, as rules the queue manager applies.
 *
 * Send Now starts a pending or staged item, and starts a `sent` item again:
 * the whole item — its pre-prompts, every repetition or `prefix*` todo, its
 * follow-ups — runs from the beginning, so a finished prompt can be repeated
 * without copying it. Its run state is reset first ({@link resetItemRunState}),
 * which is also what a fresh start of a never-sent item does.
 *
 * The pause gate ({@link pausesBeforeNextDispatch}) holds an item between two
 * of its prompts while auto-send is off. It is checked just before a further
 * prompt of the item would go out, never when the item has nothing left: an
 * item whose last prompt was answered is done and becomes `sent`, auto-send
 * on or off. (Checking it on entry to the dispatcher kept every item that had
 * sent anything at all in `sending`, so a Send Now never reached `sent`.)
 */

import { itemHasInFlightProgress, type InFlightProgressItem } from './queueErrorTransitions';

/** The statuses Send Now acts on. */
export function canSendNow(status: string): boolean {
    return status === 'pending' || status === 'staged' || status === 'sent';
}

/** True when the item holds before its next prompt: auto-send is off and the item has already sent one. */
export function pausesBeforeNextDispatch(autoSendEnabled: boolean, item: InFlightProgressItem): boolean {
    return !autoSendEnabled && itemHasInFlightProgress(item);
}

/** The run-state fields of a queue item that a fresh start resets. */
export interface RunStateItem {
    prePrompts?: Array<{ status?: string; repeatIndex?: number; resolvedRepeatCount?: number }>;
    followUps?: Array<{ repeatIndex?: number; resolvedRepeatCount?: number }>;
    repeatIndex?: number;
    resolvedRepeatCount?: number;
    repeatTodoId?: string;
    requestId?: string;
    expectedRequestId?: string;
    followUpIndex?: number;
    reminderSentCount?: number;
    lastReminderAt?: string;
    error?: unknown;
    warning?: unknown;
    lastDispatched?: unknown;
    inFlightRepetition?: unknown;
    awaitingAnswer?: boolean;
}

/**
 * Reset everything a run of the item advanced, so the next dispatch starts at
 * its first pre-prompt (or main prompt) with every counter at zero. The
 * prompts, templates, repeat settings and transport are left as they are.
 */
export function resetItemRunState(item: RunStateItem): void {
    for (const pp of item.prePrompts ?? []) {
        pp.status = 'pending';
        pp.repeatIndex = 0;
        pp.resolvedRepeatCount = undefined;
    }
    for (const fu of item.followUps ?? []) {
        fu.repeatIndex = 0;
        fu.resolvedRepeatCount = undefined;
    }
    item.repeatIndex = 0;
    item.resolvedRepeatCount = undefined;
    item.repeatTodoId = undefined;
    item.requestId = undefined;
    item.expectedRequestId = undefined;
    item.followUpIndex = 0;
    item.reminderSentCount = 0;
    item.lastReminderAt = undefined;
    item.error = undefined;
    item.warning = undefined;
    item.lastDispatched = undefined;
    item.inFlightRepetition = undefined;
    item.awaitingAnswer = false;
}
