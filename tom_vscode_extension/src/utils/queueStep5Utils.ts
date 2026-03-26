export interface QueueEntryFileNameInput {
    hostname: string;
    timestamp: Date;
    quest: string;
    type: string;
    entrySuffix: string;
}

export interface TimedFileNames {
    nextFileName: string;
    legacyFileName: string;
}

export interface TimedPathSelectionInput {
    nextPath: string;
    legacyPath: string;
    nextExists: boolean;
    legacyExists: boolean;
}

export interface TimedMigrationInput {
    nextExists: boolean;
    legacyExists: boolean;
}

export function sanitizeHostnameForFile(hostname: string): string {
    const trimmed = (hostname || '').trim().toLowerCase();
    return trimmed.replace(/[^a-z0-9_-]/g, '_') || 'unknown';
}

function sanitizeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

export function buildQueueEntryFileName(input: QueueEntryFileNameInput): string {
    const now = input.timestamp;
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const q = sanitizeFilePart(input.quest || 'default');
    const t = sanitizeFilePart(input.type || 'prompt');
    const host = sanitizeHostnameForFile(input.hostname);
    return `${host}_${yy}${mm}${dd}_${hh}${min}${ss}_${q}.${t}${input.entrySuffix}`;
}

export function buildTimedFileNames(hostname: string, workspaceName: string): TimedFileNames {
    const host = sanitizeHostnameForFile(hostname);
    const ws = sanitizeFilePart(workspaceName || 'default');
    return {
        nextFileName: `${host}_${ws}.timed.yaml`,
        legacyFileName: `${ws}.timed.yaml`,
    };
}

export function pickTimedReadPath(input: TimedPathSelectionInput): string | undefined {
    if (input.nextExists) {
        return input.nextPath;
    }
    if (input.legacyExists) {
        return input.legacyPath;
    }
    return undefined;
}

export function shouldMigrateTimedFileOnWrite(input: TimedMigrationInput): boolean {
    return !input.nextExists && input.legacyExists;
}
