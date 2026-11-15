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
    /** Queue per run on: whether a lane could start an item now (decides the drain instead of the sending count). */
    laneStartPossible?: boolean;
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
    return path.join(input.folder, `${windowAnswerFileStem(input.sessionId, input.machineId)}_answer.json`);
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
    return files.find(f => f === `${expectedRequestId}_answer.json`);
}

/** The stem of this window's own answer file (`<sessionId[0..8]>_<machineId[0..8]>`), written when a prompt names no request id. */
export function windowAnswerFileStem(sessionId: string, machineId: string): string {
    return `${sessionId.substring(0, 8)}_${machineId.substring(0, 8)}`;
}

/**
 * The answer folder is shared by every window, so every window sees every
 * answer file. Whether one sending stage may take a file, from its name alone
 * (before the file is read):
 * - `request`: the file is the one for the stage's request
 *   (`<expectedRequestId>_answer.json`) — the stage owns it;
 * - `window`: the file is this window's own window-named file — the stage owns
 *   it only when the request id in its CONTENT is the expected one
 *   ({@link ownsAnswerFile});
 * - `none`: not the stage's (`reason` says why) — ignore it unread.
 * Only a Copilot stage waiting for an answer file (it has an expected request
 * id) takes one; an Anthropic stage gets its answer from its send.
 */
export type AnswerFileClaim =
    | { claim: 'request' }
    | { claim: 'window' }
    | { claim: 'none'; reason: string };

export interface AnswerFileClaimInput {
    /** The answer file's name (no folder). */
    fileName: string;
    /** The transport the sending item's current stage runs on. */
    stageTransport: 'copilot' | 'anthropic' | undefined;
    /** The request id the stage waits for. */
    expectedRequestId?: string;
    /** This window's own answer-file stem ({@link windowAnswerFileStem}). */
    windowFileStem: string;
}

export function answerFileClaim(input: AnswerFileClaimInput): AnswerFileClaim {
    const stem = extractRequestIdFromAnswerFilename(input.fileName);
    if (!stem) { return { claim: 'none', reason: 'not an answer file' }; }
    if (input.stageTransport !== 'copilot') { return { claim: 'none', reason: 'the stage does not run on Copilot' }; }
    const expected = input.expectedRequestId?.trim();
    if (!expected) { return { claim: 'none', reason: 'the stage waits for no answer file' }; }
    if (stem === expected) { return { claim: 'request' }; }
    if (stem === input.windowFileStem) { return { claim: 'window' }; }
    return { claim: 'none', reason: `another request's or another window's file (expected ${expected})` };
}

/** The whole rule: the stage owns the file by its name, or as this window's own file whose content names the expected request. */
export function ownsAnswerFile(input: AnswerFileClaimInput, contentRequestId: string | undefined): boolean {
    const c = answerFileClaim(input);
    if (c.claim === 'request') { return true; }
    if (c.claim === 'window') { return !!contentRequestId && contentRequestId.trim() === input.expectedRequestId?.trim(); }
    return false;
}

/**
 * The request id an answer file is for: its name's stem, except for a
 * window-named file (`windowFileStem`, whose name is the window, not a
 * request), whose id is taken from its content only.
 */
export function resolveDetectedRequestId(filenameRequestId?: string, contentRequestId?: string, windowFileStem?: string): DetectedRequestId {
    if (filenameRequestId && windowFileStem && filenameRequestId.trim() === windowFileStem) {
        filenameRequestId = undefined;
    }
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
    // With lanes (Queue per run) one lane can be idle while another sends: then the drain is due when an item could start.
    const shouldTriggerSendNext =
        input.autoSendEnabled &&
        (input.laneStartPossible !== undefined
            ? input.laneStartPossible
            : input.pendingCount > 0 && input.sendingCount === 0);

    return {
        shouldRestartWatcher,
        shouldTriggerSendNext,
        shouldEnsureDirectory,
    };
}
