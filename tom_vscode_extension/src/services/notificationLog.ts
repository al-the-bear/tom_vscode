/**
 * The machine's notification log (vscimpb124): one file under the extension's
 * global storage (`<globalStorage>/notifications/events.jsonl`, one JSON event
 * per line), shared by every window on this machine. Each window appends the
 * queue and todo events it sees; each window's NOTIFICATIONS view reads it
 * when it changes.
 *
 * - **Append-safe for concurrent writers:** every append and every trim runs
 *   under a lock directory (`events.jsonl.lock`, created atomically by
 *   `mkdir`); a lock older than {@link STALE_LOCK_MS} is taken over (its
 *   writer died).
 * - **Size-capped:** once the file holds more than `cap + slack` events it is
 *   cut to the last `cap` (default 1000), written to a temporary file and
 *   renamed over it.
 * - **Never fails its caller:** an event that cannot be written is dropped
 *   (with a console warning); the queue and the todo write go on.
 *
 * Events are emitted with {@link emitNotifications}: the window, its quest,
 * the run and who did it come from the context registered at activation
 * ({@link configureNotificationLog}). vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { NotificationEvent, NotificationWho } from '../utils/notificationEvents';

export const NOTIFICATION_LOG_CAP = 1000;
const DEFAULT_SLACK = 100;
const STALE_LOCK_MS = 5_000;
const LOCK_TIMEOUT_MS = 3_000;

/** What an emitted event takes from where it is emitted. */
export interface NotificationContext {
    windowId: string;
    /** The window's quest. */
    quest(): string;
    /** The run the calling turn works in. */
    run(): string;
    /** Who is calling: an agent (tool context), the user, or the extension. */
    who(): NotificationWho;
}

let logFile: string | undefined;
let context: NotificationContext | undefined;

/** Register the log file and the window's context (activation). */
export function configureNotificationLog(file: string | undefined, ctx: NotificationContext | undefined): void {
    logFile = file;
    context = ctx;
}

/** The log file, when configured. */
export function notificationLogFile(): string | undefined {
    return logFile;
}

/** An event as an emitter gives it: what happened; when, where and who are filled in. */
export type NotificationDraft = Omit<NotificationEvent, 'id' | 'at' | 'windowId' | 'quest' | 'run' | 'who'> & { run?: string; who?: NotificationWho };

let counter = 0;

/** Append events from this window (the log and context configured); best effort. */
export function emitNotifications(drafts: readonly NotificationDraft[]): void {
    if (!logFile || !context || !drafts.length) { return; }
    try {
        const now = new Date();
        const who = context.who();
        const events: NotificationEvent[] = drafts.map((d) => ({
            ...d,
            id: `${now.getTime().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            at: now.toISOString(),
            windowId: context!.windowId,
            quest: context!.quest(),
            run: d.run ?? context!.run(),
            who: d.who ?? who,
        }));
        appendNotificationEvents(logFile, events);
    } catch (e) {
        console.warn('[notifications] event not written:', e);
    }
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the log's lock. */
function withLock<T>(file: string, fn: () => T): T {
    const lock = `${file}.lock`;
    const start = Date.now();
    for (;;) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { throw e; }
            try {
                if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) { fs.rmdirSync(lock); continue; }
            } catch { continue; /* released meanwhile */ }
            if (Date.now() - start > LOCK_TIMEOUT_MS) { throw new Error(`notification log locked: ${lock}`); }
            sleepSync(5 + Math.floor(Math.random() * 10));
        }
    }
    try {
        return fn();
    } finally {
        try { fs.rmdirSync(lock); } catch { /* already gone */ }
    }
}

/** Append `events` to the log at `file` (created with its folder), cut to the last `cap` once over `cap + slack`. */
export function appendNotificationEvents(file: string, events: readonly NotificationEvent[], opts: { cap?: number; slack?: number } = {}): void {
    if (!events.length) { return; }
    const cap = opts.cap ?? NOTIFICATION_LOG_CAP;
    const slack = opts.slack ?? DEFAULT_SLACK;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withLock(file, () => {
        fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf-8');
        const text = fs.readFileSync(file, 'utf-8');
        let lines = 0;
        for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) { lines++; } }
        if (lines > cap + slack) {
            const kept = text.split('\n').filter((l) => l.trim()).slice(-cap);
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf-8');
            fs.renameSync(tmp, file);
        }
    });
}

/** The events of the log, oldest first (unreadable lines left out). */
export function readNotificationEvents(file: string): NotificationEvent[] {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    const out: NotificationEvent[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) { continue; }
        try {
            const e = JSON.parse(line) as NotificationEvent;
            if (e && typeof e.type === 'string' && typeof e.at === 'string') { out.push(e); }
        } catch { /* a line cut by a crash */ }
    }
    return out;
}
