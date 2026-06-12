/**
 * Cross-process single-consumer guard for Telegram `getUpdates` polling.
 *
 * Telegram allows only **one** `getUpdates` consumer per bot token; a second one
 * makes the API return 409 Conflict to whichever call is superseded, so two
 * pollers on the same token produce an alternating success/409 storm and neither
 * receives reliably.
 *
 * Within a single extension host the static `activePollTokens` set in
 * `TelegramChannel` already prevents two poll loops. But each VS Code **window**
 * is a *separate* extension-host process, and multiple windows (e.g. one per
 * quest workspace) commonly share the same bot token via a common
 * `botTokenEnv`. Those separate processes cannot see each other's in-memory
 * state, so they all poll and 409-conflict.
 *
 * This lock coordinates them through a small lock file on the local filesystem
 * (all windows run on the same machine). The file records the owning process id
 * and a heartbeat timestamp that the owner refreshes on every poll tick. Other
 * processes see a *fresh* heartbeat owned by someone else and **skip the API
 * call entirely** (so no 409 is produced); when the owner stops or dies its
 * heartbeat goes stale and the next process to tick takes over. Sending is
 * unaffected — only `getUpdates` is gated.
 *
 * The class is deliberately I/O-only (no `vscode`) and takes an injectable clock
 * and directory so it can be unit-tested.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** On-disk lock record. */
interface LockRecord {
    /** Owning process id. */
    pid: number;
    /** Last heartbeat, in epoch milliseconds. */
    heartbeat: number;
}

/** Construction options (all optional; sensible defaults for production use). */
export interface PollLockOptions {
    /** Directory for the lock file. Default: the OS temp dir. */
    dir?: string;
    /** Clock, for tests. Default: `Date.now`. */
    now?: () => number;
    /**
     * Age (ms) past which a lock is considered stale and may be taken over.
     * Default 15000. Should comfortably exceed the poll interval so a live owner
     * is never mistaken for dead.
     */
    staleMs?: number;
    /** Owning process id, for tests. Default: `process.pid`. */
    pid?: number;
}

export class TelegramPollLock {
    private readonly dir: string;
    private readonly now: () => number;
    private readonly staleMs: number;
    private readonly pid: number;

    constructor(opts: PollLockOptions = {}) {
        this.dir = opts.dir ?? os.tmpdir();
        this.now = opts.now ?? (() => Date.now());
        this.staleMs = opts.staleMs ?? 15000;
        this.pid = opts.pid ?? process.pid;
    }

    /** Absolute path of the lock file for a given bot token (token is hashed). */
    private file(token: string): string {
        const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
        return path.join(this.dir, `tom-telegram-poll-${hash}.lock`);
    }

    /** Read and validate the lock record, or `null` when absent/corrupt. */
    private read(token: string): LockRecord | null {
        try {
            const raw = fs.readFileSync(this.file(token), 'utf8');
            const rec = JSON.parse(raw) as Partial<LockRecord>;
            if (typeof rec.pid === 'number' && typeof rec.heartbeat === 'number') {
                return { pid: rec.pid, heartbeat: rec.heartbeat };
            }
            return null;
        } catch {
            return null;
        }
    }

    /** Whether a record's heartbeat is still within the stale window. */
    private isFresh(rec: LockRecord): boolean {
        return this.now() - rec.heartbeat < this.staleMs;
    }

    /** Write our ownership record with a fresh heartbeat. Best-effort. */
    private write(token: string): void {
        const rec: LockRecord = { pid: this.pid, heartbeat: this.now() };
        try {
            fs.writeFileSync(this.file(token), JSON.stringify(rec));
        } catch {
            /* best-effort — a failed write just means we retry next tick */
        }
    }

    /**
     * Claim or refresh the poll lock for `token`. Returns `true` when this
     * process may poll (the lock was free, stale, or already ours — in which
     * case the heartbeat is refreshed), and `false` when another live process
     * currently owns it (so the caller must skip the API call).
     */
    acquireOrRefresh(token: string): boolean {
        const rec = this.read(token);
        if (rec && rec.pid !== this.pid && this.isFresh(rec)) {
            return false;
        }
        this.write(token);
        return true;
    }

    /** Whether another live process currently holds the lock for `token`. */
    isHeldByOther(token: string): boolean {
        const rec = this.read(token);
        return !!rec && rec.pid !== this.pid && this.isFresh(rec);
    }

    /** Release the lock for `token` — but only if we still own it. */
    release(token: string): void {
        const rec = this.read(token);
        if (rec && rec.pid === this.pid) {
            try {
                fs.unlinkSync(this.file(token));
            } catch {
                /* ignore — already gone, or another process cleaned up */
            }
        }
    }
}
