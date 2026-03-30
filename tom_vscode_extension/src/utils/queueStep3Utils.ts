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
    const repeatCount = Math.max(1, Math.round(input.repeatCount || 1));
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
    const repeatNumber = repeatIndex + 1;
    return template
    // Mustache style
    .replace(/\{\{\s*repeatCount\s*\}\}/g, String(repeatCount))
    .replace(/\{\{\s*repeatIndex\s*\}\}/g, String(repeatIndex))
    .replace(/\{\{\s*repeatNumber\s*\}\}/g, String(repeatNumber))
    // ${...} style used in other template systems in this extension
    .replace(/\$\{\s*repeatCount\s*\}/g, String(repeatCount))
    .replace(/\$\{\s*repeatIndex\s*\}/g, String(repeatIndex))
    .replace(/\$\{\s*repeatNumber\s*\}/g, String(repeatNumber));
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
