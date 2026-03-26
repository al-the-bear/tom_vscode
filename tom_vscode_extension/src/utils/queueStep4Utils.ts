import * as path from 'path';

export interface BuildAnswerFilePathInput {
    folder: string;
    sessionId: string;
    machineId: string;
    requestId?: string;
}

export interface HealthCheckInput {
    hasAnswerWatcher: boolean;
    autoSendEnabled: boolean;
    pendingCount: number;
    sendingCount: number;
    answerDirectoryExists: boolean;
    sendingSentAtIso?: string;
    responseFileTimeoutMinutes?: number;
    nowMs?: number;
}

export interface HealthCheckDecisions {
    shouldRestartWatcher: boolean;
    shouldTriggerSendNext: boolean;
    shouldEnsureDirectory: boolean;
}

export interface DetectedRequestId {
    requestId?: string;
    source: 'filename' | 'content' | 'none';
}

export function buildAnswerFilePath(input: BuildAnswerFilePathInput): string {
    if (input.requestId && input.requestId.trim().length > 0) {
        return path.join(input.folder, `${input.requestId.trim()}_answer.json`);
    }
    const session = input.sessionId.substring(0, 8);
    const machine = input.machineId.substring(0, 8);
    return path.join(input.folder, `${session}_${machine}_answer.json`);
}

export function shouldWatchAnswerFile(filename?: string): boolean {
    return !!filename && filename.endsWith('_answer.json');
}

export function extractRequestIdFromAnswerFilename(filename?: string): string | undefined {
    if (!filename || !shouldWatchAnswerFile(filename)) {
        return undefined;
    }
    return filename.substring(0, filename.length - '_answer.json'.length) || undefined;
}

export function findMatchingAnswerFile(files: string[], expectedRequestId?: string): string | undefined {
    if (!expectedRequestId) {
        return undefined;
    }
    return files.find(f => shouldWatchAnswerFile(f) && f.startsWith(expectedRequestId));
}

export function resolveDetectedRequestId(filenameRequestId?: string, contentRequestId?: string): DetectedRequestId {
    if (filenameRequestId && filenameRequestId.trim().length > 0) {
        return { requestId: filenameRequestId.trim(), source: 'filename' };
    }
    if (contentRequestId && contentRequestId.trim().length > 0) {
        return { requestId: contentRequestId.trim(), source: 'content' };
    }
    return { requestId: undefined, source: 'none' };
}

export function computeHealthCheckDecisions(input: HealthCheckInput): HealthCheckDecisions {
    const shouldEnsureDirectory = !input.answerDirectoryExists;
    let shouldRestartForStaleSending = false;
    if (input.sendingCount > 0 && input.sendingSentAtIso && (input.responseFileTimeoutMinutes || 0) > 0) {
        const nowMs = input.nowMs ?? Date.now();
        const sentAtMs = new Date(input.sendingSentAtIso).getTime();
        if (!Number.isNaN(sentAtMs)) {
            const staleMs = (input.responseFileTimeoutMinutes || 0) * 2 * 60_000;
            shouldRestartForStaleSending = nowMs - sentAtMs > staleMs;
        }
    }

    const shouldRestartWatcher = !input.hasAnswerWatcher || shouldEnsureDirectory || shouldRestartForStaleSending;
    const shouldTriggerSendNext =
        input.autoSendEnabled &&
        input.pendingCount > 0 &&
        input.sendingCount === 0;

    return {
        shouldRestartWatcher,
        shouldTriggerSendNext,
        shouldEnsureDirectory,
    };
}
