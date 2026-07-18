export interface RepeatDecision {
    shouldRepeat: boolean;
    nextRepeatIndex: number;
    progressLabel: string;
}

export interface RepetitionAffixInput {
    originalText: string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    repeatCount?: number | string;
    repeatIndex?: number;
}

/**
 * Compute repeat decision. repeatCount can be a number or a string.
 * If string, expects caller to have already resolved it via resolveRepeatCount().
 */
export function computeRepeatDecision(input: { repeatCount?: number | string; repeatIndex?: number }, resolvedCount?: number): RepeatDecision {
    // If resolvedCount is provided, use it; otherwise try to parse repeatCount directly
    let repeatCount: number;
    if (resolvedCount !== undefined) {
        repeatCount = Math.max(1, Math.round(resolvedCount));
    } else if (typeof input.repeatCount === 'number') {
        repeatCount = Math.max(1, Math.round(input.repeatCount || 1));
    } else {
        // String value - try to parse as number, default to 1
        const parsed = parseInt(String(input.repeatCount || '1'), 10);
        repeatCount = Math.max(1, isNaN(parsed) ? 1 : parsed);
    }
    const repeatIndex = Math.max(0, Math.round(input.repeatIndex || 0));
    if (repeatCount <= 1) {
        return {
            shouldRepeat: false,
            nextRepeatIndex: repeatIndex,
            progressLabel: '1/1',
        };
    }

    // repeatCount is total number of sends (including the original)
    // repeatIndex is 0-based: first send is index 0
    // shouldRepeat is true if we haven't yet reached the target count
    const currentSendNumber = repeatIndex + 1; // 1-based send number
    const shouldRepeat = currentSendNumber < repeatCount;
    const nextRepeatIndex = repeatIndex + 1;
    return {
        shouldRepeat,
        nextRepeatIndex,
        progressLabel: `${currentSendNumber}/${repeatCount}`,
    };
}

export function shouldAutoPauseOnEmpty(autoSendEnabled: boolean, pendingCount: number, autoPauseEnabled = true): boolean {
    return autoPauseEnabled && autoSendEnabled && pendingCount <= 0;
}

/** Outcome of removing one queue item — see {@link computeRemovalEffect}. */
export interface QueueRemovalEffect<T> {
    /** The items array with the target id filtered out. */
    items: T[];
    /** The removed item, or `undefined` when the id matched nothing. */
    removed: T | undefined;
    /** True when the removed item was the one currently `sending`. */
    wasSending: boolean;
    /**
     * Auto-send state the caller should adopt after the removal. Deleting the
     * `sending` item forces it OFF so the queue does not immediately dispatch
     * the next pending item after the user interrupted the running one;
     * otherwise the incoming value is preserved.
     */
    nextAutoSendEnabled: boolean;
}

/**
 * Pure decision for removing a queue item.
 *
 * Deleting the item that is currently `sending` must interrupt execution:
 * the caller has to abort the in-flight dispatch (signalled by `wasSending`)
 * and drop auto-send to OFF (`nextAutoSendEnabled`). Without this, the handler
 * keeps executing a prompt that no longer exists in the queue and the stop
 * button can't reach it (the sending item is gone), while auto-send would fire
 * the next pending prompt as if nothing happened.
 *
 * Kept pure/context-free so it can be unit tested without the vscode-coupled
 * PromptQueueManager (mirrors the `applyCrashRecovery` / `convertStagedToPending`
 * pattern).
 */
export function computeRemovalEffect<T extends { id: string; status: string }>(
    items: readonly T[],
    id: string,
    autoSendEnabled: boolean,
): QueueRemovalEffect<T> {
    const removed = items.find(i => i.id === id);
    const wasSending = removed?.status === 'sending';
    return {
        items: items.filter(i => i.id !== id),
        removed,
        wasSending,
        nextAutoSendEnabled: wasSending ? false : autoSendEnabled,
    };
}

export function convertStagedToPending(items: Array<{ status: string }>): number {
    let changed = 0;
    for (const item of items) {
        if (item.status === 'staged') {
            item.status = 'pending';
            changed += 1;
        }
    }
    return changed;
}

function fillRepetitionPlaceholders(template: string, repeatCount: number, repeatIndex: number): string {
    // Placeholder expansion is handled by the standard resolver in PromptQueueManager.
    // Keep this utility pure and context-free for deterministic unit tests.
    return template;
}

/**
 * Subset of a sending queue item the next-template-iteration builder
 * needs to read. Mirrors `QueuedPrompt` from `promptQueueManager.ts` for
 * the fields that survive across template iterations; kept local so the
 * pure helper has no dependency on the manager type.
 */
export interface NextTemplateIterationSource {
    originalText: string;
    template?: string;
    answerWrapper?: boolean;
    answerWaitMinutes?: number;
    type?: string;
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    prePrompts?: Array<{
        text: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    followUps?: Array<{
        originalText: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
}

/**
 * Parameters for `PromptQueueManager.enqueue()` plus a `progressLabel`
 * the caller uses when logging. Returned by `buildNextTemplateIterationParams`
 * when another template iteration is required.
 */
export interface NextTemplateIterationParams {
    originalText: string;
    template?: string;
    answerWrapper?: boolean;
    answerWaitMinutes?: number;
    type?: string;
    repeatCount?: number | string;
    repeatIndex: 0;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    prePrompts: Array<{
        text: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    followUps: Array<{
        originalText: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    initialStatus: 'pending';
    deferSend: true;
    /** Decision metadata — for logging. Not consumed by `enqueue()`. */
    progressLabel: string;
}

/**
 * Build the params to enqueue the next iteration of a template-repeat
 * sequence, or `null` when the sequence has reached its target count.
 *
 * Pure / unit-testable. Extracted from three identical inline blocks in
 * `PromptQueueManager` (answer-file, answer-wait timer, manual continue)
 * so the Anthropic-direct completion paths can share the same logic —
 * without this, items with `templateRepeatCount > 1` dispatched via the
 * synchronous Anthropic transport never spawned the second iteration
 * (the next-iteration enqueue lived only on Copilot/manual paths).
 */
export function buildNextTemplateIterationParams(
    sending: NextTemplateIterationSource,
    resolvedTemplateRepeatCount: number,
): NextTemplateIterationParams | null {
    const decision = computeRepeatDecision({
        repeatCount: sending.templateRepeatCount,
        repeatIndex: sending.templateRepeatIndex,
    }, resolvedTemplateRepeatCount);

    if (!decision.shouldRepeat) {
        return null;
    }

    return {
        originalText: sending.originalText,
        template: sending.template,
        answerWrapper: sending.answerWrapper,
        answerWaitMinutes: sending.answerWaitMinutes,
        type: sending.type,
        repeatCount: sending.repeatCount,
        repeatIndex: 0,
        repeatPrefix: sending.repeatPrefix,
        repeatSuffix: sending.repeatSuffix,
        templateRepeatCount: sending.templateRepeatCount,
        templateRepeatIndex: decision.nextRepeatIndex,
        reminderTemplateId: sending.reminderTemplateId,
        reminderTimeoutMinutes: sending.reminderTimeoutMinutes,
        reminderRepeat: sending.reminderRepeat,
        reminderEnabled: sending.reminderEnabled,
        prePrompts: (sending.prePrompts || []).map(pp => ({
            text: pp.text,
            template: pp.template,
            repeatCount: pp.repeatCount,
            answerWaitMinutes: pp.answerWaitMinutes,
            reminderTemplateId: pp.reminderTemplateId,
            reminderTimeoutMinutes: pp.reminderTimeoutMinutes,
            reminderRepeat: pp.reminderRepeat,
            reminderEnabled: pp.reminderEnabled,
        })),
        followUps: (sending.followUps || []).map(f => ({
            originalText: f.originalText,
            template: f.template,
            repeatCount: f.repeatCount,
            answerWaitMinutes: f.answerWaitMinutes,
            reminderTemplateId: f.reminderTemplateId,
            reminderTimeoutMinutes: f.reminderTimeoutMinutes,
            reminderRepeat: !!f.reminderRepeat,
            reminderEnabled: !!f.reminderEnabled,
        })),
        initialStatus: 'pending',
        deferSend: true,
        progressLabel: decision.progressLabel,
    };
}

export function applyRepetitionAffixes(input: RepetitionAffixInput): string {
    const rawCount = typeof input.repeatCount === 'string' ? parseInt(input.repeatCount, 10) || 0 : (input.repeatCount || 0);
    const repeatCount = Math.max(0, Math.round(rawCount));
    const repeatIndex = Math.max(0, Math.round(input.repeatIndex || 0));
    const prefix = (input.repeatPrefix || '').trim();
    const suffix = (input.repeatSuffix || '').trim();

    const segments: string[] = [];
    if (prefix.length > 0) {
        segments.push(fillRepetitionPlaceholders(prefix, repeatCount, repeatIndex));
    }

    segments.push(input.originalText);

    if (suffix.length > 0) {
        segments.push(fillRepetitionPlaceholders(suffix, repeatCount, repeatIndex));
    }

    return segments.join('\n\n');
}
