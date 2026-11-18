/**
 * Writing a configuration file every window shares (`tom_vscode_extension.json`
 * at the root, BP-18) so that no save loses another's and no reader sees a
 * partial file.
 *
 * A save:
 * 1. resolves the file with `fs.realpathSync` — a workspace folder's
 *    `.tom/tom_vscode_extension.json` may be a symbolic link onto the root's,
 *    and renaming onto the link would replace the link with a file;
 * 2. takes the lock `<real file>.lock` (exclusive create, holding pid, host,
 *    time and a token); a lock older than {@link CONFIG_LOCK_STALE_MS} is
 *    taken over, a fresh one is waited for;
 * 3. re-reads the file under the lock and applies only the caller's change
 *    to what it holds now (a save of another window or a hand edit of another
 *    key in between is kept);
 * 4. writes it atomically (`writeFileAtomic`: a temporary file, then rename)
 *    and removes its lock.
 *
 * Synchronous: the lock is held for the few milliseconds of a read and a
 * write. vscode-free.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { realPathOf } from './pathCompare';

/** A lock older than this is a crashed writer's: taken over. */
export const CONFIG_LOCK_STALE_MS = 5000;

/** How long a reader waits before it reads a file that did not parse once more. */
export const CONFIG_PARSE_RETRY_MS = 50;

export interface ConfigFileFormat {
    /** The content, or undefined when the text does not parse. */
    parse(raw: string): Record<string, unknown> | undefined;
    stringify(content: Record<string, unknown>): string;
}

export interface LockedWriteOptions {
    /** Default {@link CONFIG_LOCK_STALE_MS}. */
    staleMs?: number;
    /** The longest a save waits for a fresh lock before it fails. Default: twice the stale time and a second. */
    maxWaitMs?: number;
    /** Default {@link CONFIG_PARSE_RETRY_MS}. */
    parseRetryMs?: number;
}

export interface LockedWriteResult {
    /** The file written (the real path). */
    realPath: string;
    /** What the file holds now. */
    content: Record<string, unknown>;
    /** False when the change left the file as it was (nothing written). */
    written: boolean;
}

let tokens = 0;

function sleep(ms: number): void {
    if (ms > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
}

/** The lock file of the configuration file at the real path `realFile`. */
export function configLockPath(realFile: string): string {
    return `${realFile}.lock`;
}

interface LockRecord { pid: number; host: string; at: string; token: string }

function readLock(lockFile: string): LockRecord | undefined {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockRecord; } catch { return undefined; }
}

/**
 * Take the lock of `realFile`; answers the function that releases it (only
 * while it is still this caller's). Throws when a fresh lock is not released
 * within `maxWaitMs`.
 */
export function acquireConfigLock(realFile: string, opts: LockedWriteOptions = {}): () => void {
    const staleMs = opts.staleMs ?? CONFIG_LOCK_STALE_MS;
    const maxWaitMs = opts.maxWaitMs ?? staleMs * 2 + 1000;
    const lockFile = configLockPath(realFile);
    const token = `${process.pid}-${Date.now()}-${++tokens}`;
    const record: LockRecord = { pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token };
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
        try {
            const fd = fs.openSync(lockFile, 'wx');
            try { fs.writeSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
            return () => {
                if (readLock(lockFile)?.token === token) {
                    try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
                }
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
        }
        let age: number;
        try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; /* released meanwhile */ }
        if (age > staleMs) {
            // A crashed writer's lock: taken over (removed, then created again above).
            try { fs.unlinkSync(lockFile); } catch { /* another writer took it over first */ }
            continue;
        }
        if (Date.now() - started > maxWaitMs) {
            const holder = readLock(lockFile);
            throw new Error(`the lock ${lockFile} is held${holder ? ` by pid ${holder.pid} on ${holder.host} since ${holder.at}` : ''}`);
        }
        sleep(Math.min(5 + attempt * 2, 25));
    }
}

/**
 * Read the configuration file (a file that does not parse is read once more
 * after `retryMs`: a hand edit may be in progress). `exists: false` when there
 * is none; `content` undefined when it still does not parse.
 */
export function readConfigFileOnce(
    filePath: string, format: ConfigFileFormat, retryMs = CONFIG_PARSE_RETRY_MS,
): { exists: boolean; content?: Record<string, unknown> } {
    for (let attempt = 0; attempt < 2; attempt++) {
        let raw: string;
        try { raw = fs.readFileSync(filePath, 'utf8'); } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { exists: false }; }
            throw err;
        }
        const content = raw.trim() ? format.parse(raw) : {};
        if (content && typeof content === 'object') { return { exists: true, content }; }
        if (attempt === 0) { sleep(retryMs); }
    }
    return { exists: true };
}

/**
 * Change the configuration file at `filePath` under its lock: `apply` gets
 * what the file holds now (`{}` when there is none) and answers the new
 * content. Throws — nothing written — when the file does not parse, the lock
 * is not had, or the write fails.
 */
export function updateConfigFileLocked(
    filePath: string,
    apply: (current: Record<string, unknown>) => Record<string, unknown>,
    format: ConfigFileFormat,
    opts: LockedWriteOptions = {},
): LockedWriteResult {
    const realPath = realPathOf(filePath);
    fs.mkdirSync(path.dirname(realPath), { recursive: true });
    const release = acquireConfigLock(realPath, opts);
    try {
        const read = readConfigFileOnce(realPath, format, opts.parseRetryMs);
        if (read.exists && !read.content) {
            throw new Error('the file does not parse; fix it first, then save again');
        }
        const current = read.content ?? {};
        const next = apply(current);
        const text = format.stringify(next);
        if (read.exists && text === format.stringify(current)) {
            return { realPath, content: current, written: false };
        }
        writeFileAtomic(realPath, text);
        return { realPath, content: next, written: true };
    } finally {
        release();
    }
}
