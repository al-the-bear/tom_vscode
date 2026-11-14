/**
 * The service's store: the whole state per agent group, persisted as an
 * append-only journal per group plus a snapshot (agent_collaboration
 * part-coordination-service § What it persists and where).
 *
 * - A change is acknowledged only after its journal line is flushed (`fsync`).
 * - At start the last snapshot is loaded and the journal after it replayed.
 * - The snapshot is written to a temporary file and renamed into place.
 * - A torn last journal line (a crash during the write) is dropped: that
 *   change was never acknowledged.
 * - `store.json` carries the store's `formatVersion`; a newer one than this
 *   service knows refuses the start.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TacError } from '../protocol/errors';
import { FORMAT_VERSION } from '../protocol/types';
import type { Endpoint, Group, Lease, Message, Runtime, Session } from '../protocol/types';

export interface RequestRecord {
    at: string;
    result: unknown;
}

export interface GroupState {
    group: Group;
    runtimes: Map<string, Runtime>;
    sessions: Map<string, Session>;
    leases: Map<string, Lease>;
    tokens: Map<string, number>;
    commands: Map<string, Message>;
    endpoints: Map<string, Endpoint>;
    requests: Map<string, RequestRecord>;
}

export type Collection = 'runtimes' | 'sessions' | 'leases' | 'tokens' | 'commands' | 'endpoints' | 'requests';

/** One change: put `v` under `id` of `c` (or the group record for `c: 'group'`); `v` absent deletes. */
export interface Change {
    c: Collection | 'group';
    id: string;
    v?: unknown;
}

const COLLECTIONS: Collection[] = ['runtimes', 'sessions', 'leases', 'tokens', 'commands', 'endpoints', 'requests'];

/** Journal lines after which a snapshot is written. */
const SNAPSHOT_EVERY = 500;

interface GroupFiles {
    dir: string;
    journalFd: number | undefined;
    seq: number;
    linesSinceSnapshot: number;
}

export class Store {
    private readonly groups = new Map<string, GroupState>();
    private readonly files = new Map<string, GroupFiles>();
    private closed = false;
    /** Called once when the store folder disappeared under the running service. */
    onFatal: ((reason: string) => void) | undefined;

    private constructor(readonly dir: string) {}

    /** Open (or create) the store in `dir`; loads every group. */
    static open(dir: string): Store {
        fs.mkdirSync(dir, { recursive: true });
        const meta = path.join(dir, 'store.json');
        if (fs.existsSync(meta)) {
            const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { formatVersion?: number };
            const fv = m.formatVersion ?? 1;
            if (fv > FORMAT_VERSION) {
                throw new TacError('unavailable', `the store in ${dir} has formatVersion ${fv}; this service reads up to ${FORMAT_VERSION} — start a newer TAC service`, { formatVersion: fv, supported: FORMAT_VERSION });
            }
        } else {
            writeFileAtomic(meta, JSON.stringify({ formatVersion: FORMAT_VERSION }, null, 2) + '\n');
        }
        const store = new Store(dir);
        const groupsDir = path.join(dir, 'groups');
        fs.mkdirSync(groupsDir, { recursive: true });
        for (const name of fs.readdirSync(groupsDir)) {
            const gdir = path.join(groupsDir, name);
            if (fs.statSync(gdir).isDirectory()) {
                store.loadGroup(name, gdir);
            }
        }
        return store;
    }

    groupIds(): string[] {
        return [...this.groups.keys()].sort();
    }

    get(groupId: string): GroupState | undefined {
        return this.groups.get(groupId);
    }

    /** Every group's state (read-only use). */
    all(): GroupState[] {
        return [...this.groups.values()];
    }

    /**
     * Apply `changes` to group `groupId` as one transaction: the journal line is
     * written and flushed first, then the changes are applied in memory. A
     * failed write changes nothing and answers `unavailable`.
     */
    commit(groupId: string, changes: Change[]): void {
        if (changes.length === 0) { return; }
        if (this.closed) {
            throw new TacError('unavailable', 'the store is closed');
        }
        if (!fs.existsSync(this.dir)) {
            const reason = `the store folder ${this.dir} was removed`;
            this.onFatal?.(reason);
            throw new TacError('unavailable', reason, { reason: 'storeRemoved' });
        }
        let files = this.files.get(groupId);
        if (!files) {
            const creates = changes.some((ch) => ch.c === 'group' && ch.v !== undefined);
            if (!creates) {
                throw new TacError('notFound', `group ${groupId} does not exist`, { what: 'group' });
            }
            const dir = path.join(this.dir, 'groups', groupId);
            files = { dir, journalFd: undefined, seq: 0, linesSinceSnapshot: 0 };
        }
        const line = JSON.stringify({ seq: files.seq + 1, changes }) + '\n';
        try {
            fs.mkdirSync(files.dir, { recursive: true });
            if (files.journalFd === undefined) {
                files.journalFd = fs.openSync(path.join(files.dir, 'journal.jsonl'), 'a');
            }
            fs.writeSync(files.journalFd, line);
            fs.fsyncSync(files.journalFd);
        } catch (e) {
            throw new TacError('unavailable', `the store cannot be written: ${(e as Error).message}`, { reason: (e as NodeJS.ErrnoException).code ?? 'writeFailed' });
        }
        files.seq += 1;
        files.linesSinceSnapshot += 1;
        this.files.set(groupId, files);
        this.apply(groupId, changes);
        if (files.linesSinceSnapshot >= SNAPSHOT_EVERY) {
            try { this.snapshot(groupId); } catch { /* the journal holds it; the next snapshot retries */ }
        }
    }

    /** Write the snapshot of one group (or all) and truncate its journal. */
    snapshot(groupId?: string): void {
        const ids = groupId ? [groupId] : [...this.groups.keys()];
        for (const id of ids) {
            const state = this.groups.get(id);
            const files = this.files.get(id);
            if (!state || !files) { continue; }
            const snap = { formatVersion: FORMAT_VERSION, seq: files.seq, state: serialize(state) };
            fs.mkdirSync(files.dir, { recursive: true });
            writeFileAtomic(path.join(files.dir, 'snapshot.json'), JSON.stringify(snap) + '\n');
            // The snapshot holds everything up to `seq`; a crash before the
            // truncation is harmless, because replay skips lines with seq <= it.
            if (files.journalFd !== undefined) {
                fs.ftruncateSync(files.journalFd, 0);
                fs.fsyncSync(files.journalFd);
            } else {
                // Not written since the start: the journal replayed at load is in the snapshot now.
                const journal = path.join(files.dir, 'journal.jsonl');
                if (fs.existsSync(journal)) { fs.truncateSync(journal, 0); }
            }
            files.linesSinceSnapshot = 0;
        }
    }

    /** Snapshot every group and close the journals. */
    close(): void {
        if (this.closed) { return; }
        try {
            if (fs.existsSync(this.dir)) { this.snapshot(); }
        } finally {
            for (const f of this.files.values()) {
                if (f.journalFd !== undefined) {
                    try { fs.closeSync(f.journalFd); } catch { /* already gone */ }
                    f.journalFd = undefined;
                }
            }
            this.closed = true;
        }
    }

    /** The size of the store on disk, in bytes (for the Coordination page). */
    sizeOnDisk(): number {
        let total = 0;
        const walk = (p: string) => {
            if (!fs.existsSync(p)) { return; }
            const st = fs.statSync(p);
            if (st.isDirectory()) {
                for (const n of fs.readdirSync(p)) { walk(path.join(p, n)); }
            } else {
                total += st.size;
            }
        };
        walk(this.dir);
        return total;
    }

    private apply(groupId: string, changes: Change[]): void {
        for (const ch of changes) {
            if (ch.c === 'group') {
                if (ch.v === undefined) {
                    this.groups.delete(groupId);
                    continue;
                }
                const existing = this.groups.get(groupId);
                if (existing) {
                    existing.group = ch.v as Group;
                } else {
                    this.groups.set(groupId, emptyState(ch.v as Group));
                }
                continue;
            }
            const state = this.groups.get(groupId);
            if (!state) { continue; }
            const map = state[ch.c] as Map<string, unknown>;
            if (ch.v === undefined) {
                map.delete(ch.id);
            } else {
                map.set(ch.id, ch.v);
            }
        }
    }

    private loadGroup(groupId: string, gdir: string): void {
        let seq = 0;
        const snapPath = path.join(gdir, 'snapshot.json');
        if (fs.existsSync(snapPath)) {
            const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { formatVersion?: number; seq: number; state: SerializedState };
            if ((snap.formatVersion ?? 1) > FORMAT_VERSION) {
                throw new TacError('unavailable', `group ${groupId} has formatVersion ${snap.formatVersion}; this service reads up to ${FORMAT_VERSION}`);
            }
            this.groups.set(groupId, deserialize(snap.state));
            seq = snap.seq;
        }
        const journalPath = path.join(gdir, 'journal.jsonl');
        let linesSinceSnapshot = 0;
        if (fs.existsSync(journalPath)) {
            const text = fs.readFileSync(journalPath, 'utf8');
            const lines = text.split('\n');
            let goodBytes = 0;
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                const isLast = i === lines.length - 1;
                if (raw.length === 0) {
                    if (!isLast) { goodBytes += 1; }
                    continue;
                }
                let entry: { seq: number; changes: Change[] };
                try {
                    if (isLast) { throw new Error('torn'); } // a line without its newline was never acknowledged
                    entry = JSON.parse(raw);
                } catch {
                    if (isLast || lines.slice(i + 1).every((l) => l.length === 0)) {
                        break; // torn last line: drop it
                    }
                    throw new TacError('unavailable', `the journal of group ${groupId} is corrupt at line ${i + 1}`);
                }
                goodBytes += Buffer.byteLength(raw, 'utf8') + 1;
                if (entry.seq <= seq) { continue; }
                this.apply(groupId, entry.changes);
                seq = entry.seq;
                linesSinceSnapshot += 1;
            }
            const size = fs.statSync(journalPath).size;
            if (goodBytes < size) {
                fs.truncateSync(journalPath, goodBytes);
            }
        }
        if (this.groups.has(groupId)) {
            this.files.set(groupId, { dir: gdir, journalFd: undefined, seq, linesSinceSnapshot });
        }
    }
}

type SerializedState = { group: Group } & Record<Collection, Record<string, unknown>>;

function emptyState(group: Group): GroupState {
    return {
        group,
        runtimes: new Map(),
        sessions: new Map(),
        leases: new Map(),
        tokens: new Map(),
        commands: new Map(),
        endpoints: new Map(),
        requests: new Map(),
    };
}

function serialize(s: GroupState): SerializedState {
    const out = { group: s.group } as SerializedState;
    for (const c of COLLECTIONS) {
        out[c] = Object.fromEntries(s[c] as Map<string, unknown>);
    }
    return out;
}

function deserialize(s: SerializedState): GroupState {
    const st = emptyState(s.group);
    for (const c of COLLECTIONS) {
        const map = st[c] as Map<string, unknown>;
        for (const [k, v] of Object.entries(s[c] ?? {})) { map.set(k, v); }
    }
    return st;
}

/** Write `file` by a temporary file renamed into place, flushed, so a crash never leaves half a file. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', mode);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}
