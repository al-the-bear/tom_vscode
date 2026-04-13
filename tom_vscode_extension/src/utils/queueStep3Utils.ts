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
