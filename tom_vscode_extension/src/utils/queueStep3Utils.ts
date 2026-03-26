export interface RepeatDecision {
    shouldRepeat: boolean;
    nextRepeatIndex: number;
    progressLabel: string;
}

export interface RepetitionAffixInput {
    originalText: string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    repeatCount?: number;
    repeatIndex?: number;
}

export function computeRepeatDecision(input: { repeatCount?: number; repeatIndex?: number }): RepeatDecision {
    const repeatCount = Math.max(0, Math.round(input.repeatCount || 0));
    const repeatIndex = Math.max(0, Math.round(input.repeatIndex || 0));
    if (repeatCount <= 0) {
        return {
            shouldRepeat: false,
            nextRepeatIndex: repeatIndex,
            progressLabel: '0/0',
        };
    }

    const shouldRepeat = repeatIndex < repeatCount;
    const nextRepeatIndex = shouldRepeat ? repeatIndex + 1 : repeatIndex;
    return {
        shouldRepeat,
        nextRepeatIndex,
        progressLabel: `${Math.min(nextRepeatIndex, repeatCount)}/${repeatCount}`,
    };
}

export function shouldAutoPauseOnEmpty(autoSendEnabled: boolean, pendingCount: number): boolean {
    return autoSendEnabled && pendingCount <= 0;
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
    const repeatNumber = repeatIndex + 1;
    return template
        .replace(/\{\{repeatCount\}\}/g, String(repeatCount))
        .replace(/\{\{repeatIndex\}\}/g, String(repeatIndex))
        .replace(/\{\{repeatNumber\}\}/g, String(repeatNumber));
}

export function applyRepetitionAffixes(input: RepetitionAffixInput): string {
    const repeatCount = Math.max(0, Math.round(input.repeatCount || 0));
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
