/**
 * The TAC operations (doc/tac_specification.md § 5) over the store, as the
 * local service offers them. Transport-free: the HTTP and WebSocket binding
 * (src/http) calls these methods, and the tests may call them directly.
 *
 * Every time is taken from `now()`, the service's own clock (§ 4.4).
 */
import { TacError } from '../protocol/errors';
import { keysConflict, parseResourceKey, parseSessionKeyText, sameSession, sessionKeyText, validateSessionKey } from '../protocol/keys';
import {
    FORMAT_VERSION, PROTOCOL_MAJOR, PROTOCOL_VERSION,
} from '../protocol/types';
import type {
    AckOutcome, BackendIdentity, Capability, Clone, CurrentItem, Delivery, Endpoint, EndpointAuth, EndpointScope, Group,
    GroupExport, GroupMode, GroupSettings, HelloResult, Hold, InfraResource, Lease, LeaseResource, LeaseState, Message,
    MisconfigurationWarning, Runtime, RuntimeKind, RuntimeStatus, Session, SessionKey, StreamFrame, Unit,
} from '../protocol/types';
import { Change, GroupState, Store } from '../store/store';
import { isUlid, ulid } from '../util/ulid';

export const LEASE_MINUTES = 60;
export const PRESENCE_GRACE_MS = 2 * 60_000;
export const COMMAND_DAYS = 7;
export const REQUEST_ID_HOURS = 24;
export const MISCONFIG_DAYS = 7;
/** Acknowledged commands are kept this long, so a late ack of a second runtime still learns who took it. */
export const ACKED_COMMAND_HOURS = 24;

const CAPABILITIES: Capability[] = ['runtimes', 'sessions', 'leases', 'units', 'messages', 'endpoints', 'migrate'];
const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface ServiceOptions {
    store: Store;
    now?: () => number;
    /** The largest serialized message payload (the local service has no quotas; this is its size limit). */
    maxPayloadBytes?: number;
    serviceInfo?: { name: string; version: string; pid: number; startedAt: string };
}

export type StreamSink = (frame: StreamFrame) => void;

export interface HelloRequest {
    protocolVersion?: string;
    client?: { name?: string; version?: string };
    groupId?: string;
    settings?: GroupSettings;
    customerId?: string;
    mode?: GroupMode;
}

export interface AcquireRequest {
    sessionKey: SessionKey;
    resources: (string | { key: string; branch?: string; worktree?: string })[];
    hold?: Hold;
    requestId: string;
}

export interface SendRequest {
    class: Message['class'];
    type: string;
    origin: Message['origin'];
    targets: Message['targets'];
    preferHost?: string;
    payload: Record<string, unknown>;
    requestId: string;
}

export interface PublishRequest {
    type: string;
    url: string;
    scope: EndpointScope;
    quest: string;
    host: string;
    runtimeId: string;
    protocol?: string;
    auth?: EndpointAuth;
    meta?: Record<string, unknown>;
    requestId: string;
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function ms(t: string): number {
    return Date.parse(t);
}

function str(v: unknown, what: string): string {
    if (typeof v !== 'string' || v.length === 0) {
        throw new TacError('invalid', `${what} must be a non-empty string`);
    }
    return v;
}

function strList(v: unknown, what: string): string[] {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new TacError('invalid', `${what} must be a list of strings`);
    }
    return v as string[];
}

function plainObject(v: unknown, what: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new TacError('invalid', `${what} must be an object`);
    }
    return v as Record<string, unknown>;
}

export class TacService {
    private readonly store: Store;
    readonly now: () => number;
    private readonly maxPayloadBytes: number;
    private readonly serviceInfo: ServiceOptions['serviceInfo'];
    /** groupId → runtimeId → sink of its open stream. */
    private readonly streams = new Map<string, Map<string, StreamSink>>();
    /** groupId → runtimeId → when its stream last closed (presence grace). */
    private readonly streamClosedAt = new Map<string, Map<string, number>>();

    constructor(opts: ServiceOptions) {
        this.store = opts.store;
        this.now = opts.now ?? Date.now;
        this.maxPayloadBytes = opts.maxPayloadBytes ?? 1024 * 1024;
        this.serviceInfo = opts.serviceInfo;
    }

    // ------------------------------------------------------------------ helpers

    private state(groupId: string): GroupState {
        const s = this.store.get(groupId);
        if (!s) {
            throw new TacError('notFound', `group ${groupId} does not exist`, { what: 'group' });
        }
        if (s.group.migratedTo) {
            throw new TacError('migrated', `group ${groupId} moved to another backend`, { migratedTo: s.group.migratedTo });
        }
        return s;
    }

    private nowIso(): string {
        return iso(this.now());
    }

    /** A lease's state now: `active` past its `expiresAt` reads as `stale` (§ 4.2). */
    effectiveState(lease: Lease): LeaseState {
        if (lease.state === 'active' && ms(lease.expiresAt) <= this.now()) {
            return 'stale';
        }
        return lease.state;
    }

    private withState(lease: Lease): Lease {
        return { ...lease, state: this.effectiveState(lease) };
    }

    private holds(lease: Lease): boolean {
        const s = this.effectiveState(lease);
        return s === 'active' || s === 'stale';
    }

    isConnected(groupId: string, runtimeId: string): boolean {
        return this.streams.get(groupId)?.has(runtimeId) ?? false;
    }

    /** Presence on the services (§ 5.2): an open stream, or within 2 minutes of its close or of a renewPresence. */
    isPresent(groupId: string, runtime: Runtime): boolean {
        if (this.isConnected(groupId, runtime.runtimeId)) { return true; }
        const now = this.now();
        const closed = this.streamClosedAt.get(groupId)?.get(runtime.runtimeId);
        if (closed !== undefined && now - closed <= PRESENCE_GRACE_MS) { return true; }
        return now - ms(runtime.presenceRenewedAt) <= PRESENCE_GRACE_MS;
    }

    private withPresence(groupId: string, r: Runtime): Runtime {
        return { ...r, present: this.isPresent(groupId, r) };
    }

    private requestResult(s: GroupState, op: string, requestId: string): unknown {
        const rec = s.requests.get(`${op}:${requestId}`);
        if (!rec) { return undefined; }
        if (this.now() - ms(rec.at) > REQUEST_ID_HOURS * 3_600_000) { return undefined; }
        return rec.result;
    }

    private requestChange(op: string, requestId: string, result: unknown): Change {
        return { c: 'requests', id: `${op}:${requestId}`, v: { at: this.nowIso(), result } };
    }

    // ------------------------------------------------------------- handshake

    hello(req: HelloRequest): HelloResult {
        const pv = req.protocolVersion ?? PROTOCOL_VERSION;
        const m = /^tac\/(\d+)\.(\d+)$/.exec(pv);
        if (!m) {
            throw new TacError('invalid', `protocolVersion must look like tac/<major>.<minor>, got ${pv}`);
        }
        if (Number(m[1]) !== PROTOCOL_MAJOR) {
            throw new TacError('versionMismatch', `this service speaks ${PROTOCOL_VERSION}; the client speaks ${pv}`, {
                client: pv,
                backend: PROTOCOL_VERSION,
                update: Number(m[1]) > PROTOCOL_MAJOR ? 'the service (a newer runtime starts its own copy after a handover)' : 'the client (update the runtime)',
            });
        }
        const result: HelloResult = {
            protocolVersion: PROTOCOL_VERSION,
            formatVersion: FORMAT_VERSION,
            capabilities: [...CAPABILITIES],
            groups: this.store.groupIds(),
        };
        if (this.serviceInfo) { result.service = this.serviceInfo; }
        if (req.groupId !== undefined) {
            if (!GROUP_ID_RE.test(req.groupId)) {
                throw new TacError('invalid', `groupId ${req.groupId} does not match ${GROUP_ID_RE}`);
            }
            let s = this.store.get(req.groupId);
            if (s?.group.migratedTo) {
                throw new TacError('migrated', `group ${req.groupId} moved to another backend`, { migratedTo: s.group.migratedTo });
            }
            if (!s) {
                if (!req.settings) {
                    throw new TacError('notFound', `group ${req.groupId} does not exist; a hello with its settings creates it`, { what: 'group' });
                }
                const customerId = req.customerId ?? 'local';
                if (!GROUP_ID_RE.test(customerId)) {
                    throw new TacError('invalid', `customerId ${customerId} does not match ${GROUP_ID_RE}`);
                }
                const group: Group = {
                    protocolVersion: PROTOCOL_VERSION,
                    groupId: req.groupId,
                    customerId,
                    mode: 'local',
                    settings: plainObject(req.settings, 'settings') as GroupSettings,
                    units: [],
                    infra: [],
                    createdAt: this.nowIso(),
                };
                this.store.commit(req.groupId, [{ c: 'group', id: req.groupId, v: group }]);
                s = this.store.get(req.groupId)!;
                result.groups = this.store.groupIds();
            }
            result.group = s.group;
        }
        return result;
    }

    // -------------------------------------------------------------- runtimes

    register(groupId: string, body: unknown): Runtime {
        const s = this.state(groupId);
        const b = plainObject(body, 'runtime');
        const runtimeId = b.runtimeId;
        if (!isUlid(runtimeId)) {
            throw new TacError('invalid', 'runtimeId must be a ULID generated by the runtime at process start');
        }
        const kind = b.kind as RuntimeKind;
        if (!['vscode', 'webforge', 'runtime-server'].includes(kind)) {
            throw new TacError('invalid', 'kind must be vscode, webforge or runtime-server');
        }
        const quests = strList(b.quests ?? [], 'quests');
        const hasQuest = b.hasQuest === undefined ? quests.length > 0 : b.hasQuest === true;
        if (!hasQuest && quests.length > 0) {
            throw new TacError('invalid', 'a runtime with hasQuest false serves no quests');
        }
        const existing = s.runtimes.get(runtimeId);
        const now = this.nowIso();
        const { present: _present, ...rest } = b;
        void _present;
        const runtime: Runtime = {
            ...rest,
            protocolVersion: PROTOCOL_VERSION,
            runtimeId,
            groupId,
            kind,
            host: str(b.host, 'host'),
            workspace: str(b.workspace, 'workspace'),
            workspaceRoot: str(b.workspaceRoot, 'workspaceRoot'),
            quests,
            hasQuest,
            clones: (b.clones ?? []) as Clone[],
            registeredAt: existing?.registeredAt ?? now,
            presenceRenewedAt: now,
        };
        if (!Array.isArray(runtime.clones)) {
            throw new TacError('invalid', 'clones must be a list');
        }
        this.store.commit(groupId, [{ c: 'runtimes', id: runtimeId, v: runtime }]);
        return this.withPresence(groupId, runtime);
    }

    renewPresence(groupId: string, runtimeId: string, body: unknown): Runtime {
        const s = this.state(groupId);
        const r = s.runtimes.get(runtimeId);
        if (!r) {
            throw new TacError('notFound', `runtime ${runtimeId} is not registered`, { what: 'runtime' });
        }
        const b = body === undefined || body === null ? {} : plainObject(body, 'presence');
        const next: Runtime = { ...r, presenceRenewedAt: this.nowIso() };
        if (b.clones !== undefined) {
            if (!Array.isArray(b.clones)) { throw new TacError('invalid', 'clones must be a list'); }
            next.clones = b.clones as Clone[];
        }
        if (b.status !== undefined) { next.status = plainObject(b.status, 'status') as RuntimeStatus; }
        this.store.commit(groupId, [{ c: 'runtimes', id: runtimeId, v: next }]);
        return this.withPresence(groupId, next);
    }

    deregister(groupId: string, runtimeId: string): void {
        const s = this.state(groupId);
        const changes: Change[] = [];
        if (s.runtimes.has(runtimeId)) { changes.push({ c: 'runtimes', id: runtimeId }); }
        for (const ep of s.endpoints.values()) {
            if (ep.runtimeId === runtimeId) { changes.push({ c: 'endpoints', id: ep.endpointId }); }
        }
        this.store.commit(groupId, changes);
        this.streamClosedAt.get(groupId)?.delete(runtimeId);
    }

    listRuntimes(groupId: string, filter: { quest?: string; host?: string; presentOnly?: boolean } = {}): { items: Runtime[]; warnings: MisconfigurationWarning[] } {
        const s = this.state(groupId);
        const items = [...s.runtimes.values()]
            .map((r) => this.withPresence(groupId, r))
            .filter((r) => (filter.quest === undefined || r.quests.includes(filter.quest))
                && (filter.host === undefined || r.host === filter.host)
                && (!filter.presentOnly || r.present));
        const ids = new Set(s.runtimes.keys());
        const warnings = this.misconfigurations().filter((w) => w.runtimes.some((id) => ids.has(id)));
        return { items, warnings };
    }

    /**
     * The misconfiguration check (§ 6.4) over every group of this machine's
     * store, for registrations present or seen in the last 7 days.
     */
    misconfigurations(): MisconfigurationWarning[] {
        const cutoff = this.now() - MISCONFIG_DAYS * 86_400_000;
        const runtimes: Runtime[] = [];
        for (const st of this.store.all()) {
            for (const r of st.runtimes.values()) {
                if (ms(r.presenceRenewedAt) >= cutoff || this.isPresent(st.group.groupId, r)) { runtimes.push(r); }
            }
        }
        const ident = (b: BackendIdentity | undefined, r: Runtime) => {
            const id = b ?? { mode: 'local', groupId: r.groupId };
            return id.mode === 'local' || id.mode === 'off' ? id.mode : `${id.mode}:${id.repository ?? id.serverUrl ?? ''}:${id.groupId ?? ''}`;
        };
        const warnings: MisconfigurationWarning[] = [];
        const byRepo = new Map<string, Map<string, string[]>>();
        const byGroup = new Map<string, Map<string, string[]>>();
        for (const r of runtimes) {
            const i = ident(r.backend, r);
            for (const repo of r.repositories ?? []) {
                const m = byRepo.get(repo) ?? new Map<string, string[]>();
                m.set(i, [...(m.get(i) ?? []), r.runtimeId]);
                byRepo.set(repo, m);
                if (!r.clones.some((c) => c.repository === repo)) {
                    warnings.push({
                        kind: 'cloneMissingOrMismatched',
                        message: `${r.workspace} lists ${repo}, but no clone with that origin is on ${r.host}`,
                        runtimes: [r.runtimeId],
                        repository: repo,
                    });
                }
            }
            const gid = r.backend?.groupId;
            if (gid && r.backend!.mode !== 'off') {
                const m = byGroup.get(gid) ?? new Map<string, string[]>();
                m.set(i, [...(m.get(i) ?? []), r.runtimeId]);
                byGroup.set(gid, m);
            }
        }
        for (const [repo, m] of byRepo) {
            if (m.size > 1) {
                warnings.push({
                    kind: 'repositoryUnderTwoBackends',
                    message: `${repo} is coordinated under ${m.size} different backends (${[...m.keys()].join(', ')}): their claims never meet — name the same backend in every agent.workspace.yaml holding it`,
                    runtimes: [...m.values()].flat(),
                    repository: repo,
                });
            }
        }
        for (const [gid, m] of byGroup) {
            if (m.size > 1) {
                warnings.push({
                    kind: 'groupWithTwoBackends',
                    message: `group ${gid} is named with ${m.size} different backends (${[...m.keys()].join(', ')}): a half-done migration?`,
                    runtimes: [...m.values()].flat(),
                    groupId: gid,
                });
            }
        }
        return warnings;
    }

    // -------------------------------------------------------------- sessions

    openSession(groupId: string, body: unknown): Session {
        const s = this.state(groupId);
        const b = plainObject(body, 'session');
        const sessionKey = validateSessionKey(b.sessionKey);
        const runtimeId = str(b.runtimeId, 'runtimeId');
        if (!s.runtimes.has(runtimeId)) {
            throw new TacError('notFound', `runtime ${runtimeId} is not registered`, { what: 'runtime' });
        }
        const id = sessionKeyText(sessionKey);
        const existing = s.sessions.get(id);
        const now = this.nowIso();
        const session: Session = {
            ...(existing ?? {}),
            protocolVersion: PROTOCOL_VERSION,
            sessionKey,
            runtimeId,
            lastActivity: now,
            openedAt: existing?.openedAt ?? now,
        };
        this.store.commit(groupId, [{ c: 'sessions', id, v: session }]);
        return session;
    }

    touchSession(groupId: string, keyText: string, body: unknown): Session {
        const s = this.state(groupId);
        const id = sessionKeyText(parseSessionKeyText(keyText));
        const existing = s.sessions.get(id);
        if (!existing) {
            throw new TacError('notFound', `session ${keyText} is not open`, { what: 'session' });
        }
        const b = body === undefined || body === null ? {} : plainObject(body, 'touch');
        const next: Session = { ...existing, lastActivity: this.nowIso() };
        if (b.currentItem === null) {
            delete next.currentItem;
        } else if (b.currentItem !== undefined) {
            const ci = plainObject(b.currentItem, 'currentItem');
            next.currentItem = { itemId: str(ci.itemId, 'currentItem.itemId'), ...(ci.todoId ? { todoId: String(ci.todoId) } : {}) } as CurrentItem;
        }
        this.store.commit(groupId, [{ c: 'sessions', id, v: next }]);
        return next;
    }

    closeSession(groupId: string, keyText: string): void {
        const s = this.state(groupId);
        const id = sessionKeyText(parseSessionKeyText(keyText));
        if (s.sessions.has(id)) {
            this.store.commit(groupId, [{ c: 'sessions', id }]);
        }
    }

    listSessions(groupId: string, filter: { quest?: string; host?: string; runtimeId?: string } = {}): Session[] {
        const s = this.state(groupId);
        return [...s.sessions.values()].filter((x) => (filter.quest === undefined || x.sessionKey.quest === filter.quest)
            && (filter.host === undefined || x.sessionKey.host === filter.host)
            && (filter.runtimeId === undefined || x.runtimeId === filter.runtimeId));
    }

    // ---------------------------------------------------------------- leases

    private sessionLease(s: GroupState, key: SessionKey): Lease | undefined {
        for (const l of s.leases.values()) {
            if (sameSession(l.sessionKey, key) && this.holds(l)) { return l; }
        }
        return undefined;
    }

    acquire(groupId: string, body: unknown): { granted: true; lease: Lease } {
        const s = this.state(groupId);
        const b = plainObject(body, 'acquire') as unknown as AcquireRequest;
        const requestId = str(b.requestId, 'requestId');
        const replay = this.requestResult(s, 'acquire', requestId);
        if (replay !== undefined) { return replay as { granted: true; lease: Lease }; }
        const sessionKey = validateSessionKey(b.sessionKey);
        const hold: Hold = b.hold ?? 'item';
        if (hold !== 'item' && hold !== 'group') {
            throw new TacError('invalid', 'hold must be item or group');
        }
        if (!Array.isArray(b.resources) || b.resources.length === 0) {
            throw new TacError('invalid', 'resources must be a non-empty list');
        }
        const wanted = new Map<string, { branch?: string; worktree?: string }>();
        for (const r of b.resources) {
            const entry = typeof r === 'string' ? { key: r } : plainObject(r, 'resource') as { key: string; branch?: string; worktree?: string };
            const key = str(entry.key, 'resource key');
            const parsed = parseResourceKey(key);
            if (parsed.kind === 'infra' && !s.group.infra.some((i) => i.name === parsed.name)) {
                throw new TacError('invalid', `infra:${parsed.name} is not a declared infrastructure resource of group ${groupId}`);
            }
            wanted.set(key, { branch: entry.branch, worktree: entry.worktree });
        }
        const own = this.sessionLease(s, sessionKey);
        const ownKeys = new Set(own?.resources.map((r) => r.key) ?? []);
        // Conflicts with every other session's held resources.
        const holders: Record<string, unknown>[] = [];
        for (const key of [...wanted.keys()].sort()) {
            if (ownKeys.has(key)) { continue; }
            for (const l of s.leases.values()) {
                if (own && l.leaseId === own.leaseId) { continue; }
                if (!this.holds(l) || sameSession(l.sessionKey, sessionKey)) { continue; }
                for (const res of l.resources) {
                    if (keysConflict(key, res.key, s.group.units)) {
                        const state = this.effectiveState(l);
                        holders.push({
                            key,
                            heldKey: res.key,
                            sessionKey: l.sessionKey,
                            leaseId: l.leaseId,
                            state,
                            since: state === 'stale' ? l.expiresAt : res.acquiredAt,
                        });
                    }
                }
            }
        }
        if (holders.length > 0) {
            const first = holders[0];
            throw new TacError('conflict', `${first.key} is held by ${sessionKeyText(first.sessionKey as SessionKey)}${first.state === 'stale' ? ' (stale)' : ''}`, { holders });
        }
        const nowMs = this.now();
        const now = iso(nowMs);
        const changes: Change[] = [];
        const resources: LeaseResource[] = own ? own.resources.map((r) => ({ ...r })) : [];
        for (const key of [...wanted.keys()].sort()) {
            const extra = wanted.get(key)!;
            const held = resources.find((r) => r.key === key);
            if (held) {
                held.hold = hold;
                if (extra.branch !== undefined) { held.branch = extra.branch; }
                if (extra.worktree !== undefined) { held.worktree = extra.worktree; }
                continue;
            }
            const token = s.tokens.get(key) ?? 1;
            changes.push({ c: 'tokens', id: key, v: token + 1 });
            const res: LeaseResource = { key, token, acquiredAt: now, hold };
            if (extra.branch !== undefined) { res.branch = extra.branch; }
            if (extra.worktree !== undefined) { res.worktree = extra.worktree; }
            resources.push(res);
        }
        resources.sort((a, b2) => a.key.localeCompare(b2.key));
        const lease: Lease = {
            ...(own ?? {}),
            protocolVersion: PROTOCOL_VERSION,
            leaseId: own?.leaseId ?? ulid(nowMs),
            groupId,
            sessionKey,
            resources,
            acquiredAt: own?.acquiredAt ?? now,
            renewedAt: now,
            expiresAt: iso(nowMs + LEASE_MINUTES * 60_000),
            state: 'active',
        };
        const result = { granted: true as const, lease };
        changes.push({ c: 'leases', id: lease.leaseId, v: lease });
        changes.push(this.requestChange('acquire', requestId, result));
        this.store.commit(groupId, changes);
        return result;
    }

    private ownLease(s: GroupState, leaseId: string, sessionKey: unknown): Lease {
        const lease = s.leases.get(leaseId);
        if (!lease) {
            throw new TacError('notFound', `lease ${leaseId} does not exist`, { what: 'lease' });
        }
        const key = validateSessionKey(sessionKey);
        if (!sameSession(lease.sessionKey, key)) {
            throw new TacError('notHolder', `lease ${leaseId} belongs to another session`, { leaseId, state: this.effectiveState(lease) });
        }
        return lease;
    }

    renew(groupId: string, leaseId: string, body: unknown): Lease {
        const s = this.state(groupId);
        const b = plainObject(body, 'renew');
        const lease = this.ownLease(s, leaseId, b.sessionKey);
        if (!this.holds(lease)) {
            throw new TacError('notHolder', `lease ${leaseId} is ${lease.state}`, { leaseId, state: lease.state });
        }
        const nowMs = this.now();
        const next: Lease = { ...lease, renewedAt: iso(nowMs), expiresAt: iso(nowMs + LEASE_MINUTES * 60_000), state: 'active' };
        this.store.commit(groupId, [{ c: 'leases', id: leaseId, v: next }]);
        return next;
    }

    release(groupId: string, leaseId: string, body: unknown): Lease {
        const s = this.state(groupId);
        const b = plainObject(body, 'release');
        const lease = this.ownLease(s, leaseId, b.sessionKey);
        if (lease.state === 'released') { return lease; } // a retried release
        if (lease.state === 'freed') {
            throw new TacError('notHolder', `lease ${leaseId} was freed`, { leaseId, state: 'freed' });
        }
        const only = b.resources === undefined ? undefined : new Set(strList(b.resources, 'resources'));
        const remaining = only ? lease.resources.filter((r) => !only.has(r.key)) : [];
        const next: Lease = remaining.length === 0
            ? { ...lease, resources: lease.resources, state: 'released' }
            : { ...lease, resources: remaining };
        this.store.commit(groupId, [{ c: 'leases', id: leaseId, v: next }]);
        return this.withState(next);
    }

    free(groupId: string, leaseId: string, body: unknown): Lease {
        const s = this.state(groupId);
        const b = body === undefined || body === null ? {} : plainObject(body, 'free');
        const lease = s.leases.get(leaseId);
        if (!lease) {
            throw new TacError('notFound', `lease ${leaseId} does not exist`, { what: 'lease' });
        }
        if (lease.state === 'freed' || lease.state === 'released') { return lease; }
        const now = this.nowIso();
        const changes: Change[] = [];
        for (const r of lease.resources) {
            changes.push({ c: 'tokens', id: r.key, v: (s.tokens.get(r.key) ?? r.token + 1) + 1 });
        }
        const next: Lease = { ...lease, state: 'freed', freedAt: now, freedBy: typeof b.by === 'string' ? b.by : 'user' };
        changes.push({ c: 'leases', id: leaseId, v: next });
        this.store.commit(groupId, changes);
        return next;
    }

    listLeases(groupId: string, filter: { sessionKey?: string; key?: string; states?: LeaseState[] } = {}): Lease[] {
        const s = this.state(groupId);
        const sk = filter.sessionKey ? parseSessionKeyText(filter.sessionKey) : undefined;
        if (filter.key) { parseResourceKey(filter.key); }
        return [...s.leases.values()]
            .map((l) => this.withState(l))
            .filter((l) => (!sk || sameSession(l.sessionKey, sk))
                && (!filter.states || filter.states.includes(l.state))
                && (!filter.key || l.resources.some((r) => keysConflict(filter.key!, r.key, s.group.units))));
    }

    checkToken(groupId: string, key: string, token: number): { current: boolean; holder?: { sessionKey: SessionKey; leaseId: string; token: number } } {
        const s = this.state(groupId);
        parseResourceKey(key);
        if (!Number.isInteger(token)) {
            throw new TacError('invalid', 'token must be an integer');
        }
        let holder: { sessionKey: SessionKey; leaseId: string; token: number } | undefined;
        for (const l of s.leases.values()) {
            if (!this.holds(l)) { continue; }
            const r = l.resources.find((x) => x.key === key);
            if (r) {
                holder = { sessionKey: l.sessionKey, leaseId: l.leaseId, token: r.token };
                break;
            }
        }
        return holder ? { current: holder.token === token, holder } : { current: false };
    }

    // ----------------------------------------------------------------- units

    listUnits(groupId: string): { units: Unit[]; infra: InfraResource[] } {
        const s = this.state(groupId);
        return { units: s.group.units, infra: s.group.infra };
    }

    setUnits(groupId: string, body: unknown): { units: Unit[]; infra: InfraResource[] } {
        const s = this.state(groupId);
        const b = plainObject(body, 'units');
        if (!Array.isArray(b.units)) { throw new TacError('invalid', 'units must be a list'); }
        const units: Unit[] = b.units.map((u, i) => {
            const o = plainObject(u, `units[${i}]`);
            const repository = str(o.repository, `units[${i}].repository`);
            const path = str(o.path, `units[${i}].path`);
            parseResourceKey(`${repository}:${path}`);
            const unit: Unit = { repository, path };
            if (o.shared !== undefined) { unit.shared = strList(o.shared, `units[${i}].shared`); }
            if (typeof o.description === 'string') { unit.description = o.description; }
            return unit;
        });
        let infra = s.group.infra;
        if (b.infra !== undefined) {
            if (!Array.isArray(b.infra)) { throw new TacError('invalid', 'infra must be a list'); }
            infra = b.infra.map((x, i) => {
                const o = plainObject(x, `infra[${i}]`);
                const name = str(o.name, `infra[${i}].name`);
                parseResourceKey(`infra:${name}`);
                return typeof o.description === 'string' ? { name, description: o.description } : { name };
            });
        }
        const group: Group = { ...s.group, units, infra };
        this.store.commit(groupId, [{ c: 'group', id: groupId, v: group }]);
        return { units, infra };
    }

    // -------------------------------------------------------------- messages

    attachStream(groupId: string, runtimeId: string, sink: StreamSink): void {
        const s = this.state(groupId);
        if (!s.runtimes.has(runtimeId)) {
            throw new TacError('notFound', `runtime ${runtimeId} is not registered`, { what: 'runtime' });
        }
        const m = this.streams.get(groupId) ?? new Map<string, StreamSink>();
        m.set(runtimeId, sink);
        this.streams.set(groupId, m);
        this.streamClosedAt.get(groupId)?.delete(runtimeId);
        // On connect the runtime's pending commands are pushed once (§ 9.3).
        this.dispatchCommands(groupId, runtimeId);
    }

    detachStream(groupId: string, runtimeId: string, sink?: StreamSink): void {
        const m = this.streams.get(groupId);
        if (!m) { return; }
        if (sink && m.get(runtimeId) !== sink) { return; } // a newer stream replaced it
        m.delete(runtimeId);
        const c = this.streamClosedAt.get(groupId) ?? new Map<string, number>();
        c.set(runtimeId, this.now());
        this.streamClosedAt.set(groupId, c);
    }

    openStreamCount(): number {
        let n = 0;
        for (const m of this.streams.values()) { n += m.size; }
        return n;
    }

    /** Close every stream (handover, shutdown); `close` is called per sink owner. */
    connectedRuntimes(): { groupId: string; runtimeId: string }[] {
        const out: { groupId: string; runtimeId: string }[] = [];
        for (const [groupId, m] of this.streams) {
            for (const runtimeId of m.keys()) { out.push({ groupId, runtimeId }); }
        }
        return out;
    }

    private push(groupId: string, runtimeId: string, frame: StreamFrame): boolean {
        const sink = this.streams.get(groupId)?.get(runtimeId);
        if (!sink) { return false; }
        try {
            sink(frame);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Whether `r` may carry `msg`'s delivery for `quest` (§ 5.6): it serves the
     * quest, and with `preferHost` it is on that host or no runtime of that
     * host serving the quest is present.
     */
    private mayCarry(groupId: string, s: GroupState, msg: Message, quest: string, r: Runtime): boolean {
        if (!r.quests.includes(quest)) { return false; }
        if (!msg.preferHost || r.host === msg.preferHost) { return true; }
        return ![...s.runtimes.values()].some((x) => x.host === msg.preferHost && x.quests.includes(quest) && this.isPresent(groupId, x));
    }

    private deliveryOpen(d: Delivery): boolean {
        return (d.state === 'pending' || d.state === 'delivered') && ms(d.expiresAt) > this.now();
    }

    /** Push open command deliveries to connected eligible runtimes (all, or only `onlyRuntime`). */
    private dispatchCommands(groupId: string, onlyRuntime?: string, onlyMessage?: string): void {
        const s = this.store.get(groupId);
        if (!s) { return; }
        const changes: Change[] = [];
        const pushes: { runtimeId: string; message: Message }[] = [];
        for (const msg of s.commands.values()) {
            if (onlyMessage && msg.messageId !== onlyMessage) { continue; }
            let changed = false;
            const deliveries = (msg.deliveries ?? []).map((d) => ({ ...d, deliveredTo: [...d.deliveredTo] }));
            for (const d of deliveries) {
                if (!this.deliveryOpen(d)) { continue; }
                for (const r of s.runtimes.values()) {
                    if (onlyRuntime && r.runtimeId !== onlyRuntime) { continue; }
                    if (!this.isConnected(groupId, r.runtimeId) || !this.mayCarry(groupId, s, msg, d.quest, r)) { continue; }
                    if (onlyRuntime === undefined && d.deliveredTo.includes(r.runtimeId)) { continue; }
                    if (!pushes.some((p) => p.runtimeId === r.runtimeId && p.message.messageId === msg.messageId)) {
                        pushes.push({ runtimeId: r.runtimeId, message: msg });
                    }
                    if (!d.deliveredTo.includes(r.runtimeId)) { d.deliveredTo.push(r.runtimeId); }
                    if (d.state === 'pending') { d.state = 'delivered'; }
                    changed = true;
                }
            }
            if (changed) {
                const next = { ...msg, deliveries };
                changes.push({ c: 'commands', id: msg.messageId, v: next });
                for (const p of pushes) { if (p.message.messageId === msg.messageId) { p.message = next; } }
            }
        }
        if (changes.length > 0) {
            try { this.store.commit(groupId, changes); } catch { return; } // not recorded: they stay pending and go out again
        }
        for (const p of pushes) {
            this.push(groupId, p.runtimeId, { kind: 'command', message: p.message });
        }
    }

    send(groupId: string, body: unknown): { messageId: string; createdAt: string } {
        const s = this.state(groupId);
        const b = plainObject(body, 'message') as unknown as SendRequest;
        const requestId = str(b.requestId, 'requestId');
        const replay = this.requestResult(s, 'send', requestId);
        if (replay !== undefined) { return replay as { messageId: string; createdAt: string }; }
        if (b.class !== 'notification' && b.class !== 'command') {
            throw new TacError('invalid', 'class must be notification or command');
        }
        const type = str(b.type, 'type');
        const origin = plainObject(b.origin, 'origin') as unknown as Message['origin'];
        str(origin.quest, 'origin.quest');
        str(origin.host, 'origin.host');
        str(origin.runtimeId, 'origin.runtimeId');
        let targets: Message['targets'];
        if (b.targets === 'all') {
            if (b.class === 'command') { throw new TacError('invalid', 'a command names its target quests, never all'); }
            targets = 'all';
        } else {
            targets = strList(b.targets, 'targets');
            if (targets.length === 0) { throw new TacError('invalid', 'targets must not be empty'); }
        }
        const payload = plainObject(b.payload ?? {}, 'payload');
        const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        if (size > this.maxPayloadBytes) {
            throw new TacError('invalid', `the payload has ${size} bytes; the limit is ${this.maxPayloadBytes}`, { maxPayloadBytes: this.maxPayloadBytes, size });
        }
        const nowMs = this.now();
        const message: Message = {
            protocolVersion: PROTOCOL_VERSION,
            messageId: ulid(nowMs),
            class: b.class,
            type,
            origin,
            targets,
            payload,
            createdAt: iso(nowMs),
        };
        if (b.preferHost !== undefined) { message.preferHost = str(b.preferHost, 'preferHost'); }
        const result = { messageId: message.messageId, createdAt: message.createdAt };
        if (b.class === 'notification') {
            // Live only: never stored (§ 3.9). The request id is kept so a retry does not push twice.
            this.store.commit(groupId, [this.requestChange('send', requestId, result)]);
            for (const r of s.runtimes.values()) {
                if (r.runtimeId === origin.runtimeId) { continue; }
                if (targets === 'all' || r.quests.some((q) => (targets as string[]).includes(q))) {
                    this.push(groupId, r.runtimeId, { kind: 'notification', message });
                }
            }
            return result;
        }
        message.deliveries = (targets as string[]).map((quest) => ({
            quest, state: 'pending', deliveredTo: [], expiresAt: iso(nowMs + COMMAND_DAYS * 86_400_000),
        }));
        this.store.commit(groupId, [{ c: 'commands', id: message.messageId, v: message }, this.requestChange('send', requestId, result)]);
        this.dispatchCommands(groupId, undefined, message.messageId);
        return result;
    }

    pendingCommands(groupId: string, runtimeId: string): Message[] {
        const s = this.state(groupId);
        const r = s.runtimes.get(runtimeId);
        if (!r) {
            throw new TacError('notFound', `runtime ${runtimeId} is not registered`, { what: 'runtime' });
        }
        return [...s.commands.values()]
            .filter((msg) => (msg.deliveries ?? []).some((d) => this.deliveryOpen(d) && this.mayCarry(groupId, s, msg, d.quest, r)))
            .map((msg) => this.withExpiry(msg));
    }

    private withExpiry(msg: Message): Message {
        if (!msg.deliveries) { return msg; }
        return {
            ...msg,
            deliveries: msg.deliveries.map((d) => ((d.state === 'pending' || d.state === 'delivered') && ms(d.expiresAt) <= this.now()
                ? { ...d, state: 'expired' as const } : d)),
        };
    }

    ack(groupId: string, messageId: string, body: unknown): { acknowledged: boolean; by: string } {
        const s = this.state(groupId);
        const b = plainObject(body, 'ack');
        const runtimeId = str(b.runtimeId, 'runtimeId');
        const outcome = b.outcome as AckOutcome;
        if (!['taken', 'refused', 'filed'].includes(outcome)) {
            throw new TacError('invalid', 'outcome must be taken, refused or filed');
        }
        const msg = s.commands.get(messageId);
        if (!msg || !msg.deliveries) {
            throw new TacError('notFound', `command ${messageId} does not exist`, { what: 'message' });
        }
        const runtime = s.runtimes.get(runtimeId);
        let quest = typeof b.quest === 'string' ? b.quest : undefined;
        if (quest === undefined) {
            quest = msg.deliveries.find((d) => runtime?.quests.includes(d.quest) && d.state !== 'acknowledged')?.quest
                ?? msg.deliveries.find((d) => runtime?.quests.includes(d.quest))?.quest;
        }
        const idx = msg.deliveries.findIndex((d) => d.quest === quest);
        if (idx < 0) {
            throw new TacError('invalid', `runtime ${runtimeId} serves none of the command's target quests; name the quest it acknowledges for`, { targets: msg.targets });
        }
        const d = msg.deliveries[idx];
        if (d.state === 'acknowledged') {
            return { acknowledged: d.acknowledgedBy === runtimeId, by: d.acknowledgedBy! };
        }
        const next: Delivery = { ...d, state: 'acknowledged', acknowledgedBy: runtimeId, acknowledgedAt: this.nowIso(), outcome };
        if (outcome === 'refused' && typeof b.reason === 'string') { next.reason = b.reason; }
        const deliveries = msg.deliveries.map((x, i) => (i === idx ? next : x));
        this.store.commit(groupId, [{ c: 'commands', id: messageId, v: { ...msg, deliveries } }]);
        return { acknowledged: true, by: runtimeId };
    }

    listUndelivered(groupId: string, filter: { quest?: string; states?: string[] } = {}): Message[] {
        const s = this.state(groupId);
        return [...s.commands.values()]
            .map((m) => this.withExpiry(m))
            .filter((m) => (m.deliveries ?? []).some((d) => (d.state !== 'acknowledged' || d.outcome === 'refused')
                && (!filter.quest || d.quest === filter.quest)
                && (!filter.states || filter.states.includes(d.state))));
    }

    resend(groupId: string, messageId: string, body: unknown): Message {
        const s = this.state(groupId);
        const msg = s.commands.get(messageId);
        if (!msg || !msg.deliveries) {
            throw new TacError('notFound', `command ${messageId} does not exist`, { what: 'message' });
        }
        const b = body === undefined || body === null ? {} : plainObject(body, 'resend');
        const quest = typeof b.quest === 'string' ? b.quest : undefined;
        const nowMs = this.now();
        const deliveries = this.withExpiry(msg).deliveries!.map((d) => {
            if (quest && d.quest !== quest) { return d; }
            if (d.state === 'expired' || (d.state === 'acknowledged' && d.outcome === 'refused')) {
                return { quest: d.quest, state: 'pending' as const, deliveredTo: [], expiresAt: iso(nowMs + COMMAND_DAYS * 86_400_000) };
            }
            return d;
        });
        const next = { ...msg, deliveries };
        this.store.commit(groupId, [{ c: 'commands', id: messageId, v: next }]);
        this.dispatchCommands(groupId, undefined, messageId);
        return this.withExpiry(this.store.get(groupId)!.commands.get(messageId)!);
    }

    drop(groupId: string, messageId: string): void {
        const s = this.state(groupId);
        if (!s.commands.has(messageId)) {
            throw new TacError('notFound', `command ${messageId} does not exist`, { what: 'message' });
        }
        this.store.commit(groupId, [{ c: 'commands', id: messageId }]);
    }

    // ------------------------------------------------------------- endpoints

    publish(groupId: string, body: unknown): Endpoint {
        const s = this.state(groupId);
        const b = plainObject(body, 'endpoint') as unknown as PublishRequest;
        const requestId = str(b.requestId, 'requestId');
        const replay = this.requestResult(s, 'publish', requestId);
        if (replay !== undefined) { return replay as Endpoint; }
        const runtimeId = str(b.runtimeId, 'runtimeId');
        if (!s.runtimes.has(runtimeId)) {
            throw new TacError('notFound', `runtime ${runtimeId} is not registered`, { what: 'runtime' });
        }
        const type = str(b.type, 'type');
        if (type.includes('/')) { throw new TacError('invalid', 'an endpoint type contains no /'); }
        const url = str(b.url, 'url');
        try { new URL(url); } catch { throw new TacError('invalid', `url is not a URL: ${url}`); }
        if (!['loopback', 'vpn', 'public'].includes(b.scope)) {
            throw new TacError('invalid', 'scope must be loopback, vpn or public');
        }
        const auth = b.auth ?? { kind: 'none' };
        if (auth.kind !== 'none' && auth.kind !== 'bearer') {
            throw new TacError('invalid', 'auth.kind must be none or bearer');
        }
        if (auth.kind === 'bearer') { str(auth.keyEnv, 'auth.keyEnv'); }
        const prefix = `${runtimeId}/${type}/`;
        let n = 0;
        for (const id of s.endpoints.keys()) {
            if (id.startsWith(prefix)) { n = Math.max(n, Number(id.slice(prefix.length)) || 0); }
        }
        const { requestId: _r, ...rest } = b;
        void _r;
        const endpoint: Endpoint = {
            ...rest,
            protocolVersion: PROTOCOL_VERSION,
            endpointId: `${prefix}${n + 1}`,
            type,
            url,
            scope: b.scope,
            quest: str(b.quest, 'quest'),
            host: str(b.host, 'host'),
            runtimeId,
            auth,
            publishedAt: this.nowIso(),
        };
        this.store.commit(groupId, [{ c: 'endpoints', id: endpoint.endpointId, v: endpoint }, this.requestChange('publish', requestId, endpoint)]);
        return endpoint;
    }

    withdraw(groupId: string, endpointId: string): void {
        const s = this.state(groupId);
        if (s.endpoints.has(endpointId)) {
            this.store.commit(groupId, [{ c: 'endpoints', id: endpointId }]);
        }
    }

    listEndpoints(groupId: string, filter: { type?: string; quest?: string; host?: string } = {}): Endpoint[] {
        const s = this.state(groupId);
        return [...s.endpoints.values()].filter((e) => {
            const r = s.runtimes.get(e.runtimeId);
            return r !== undefined && this.isPresent(groupId, r)
                && (!filter.type || e.type === filter.type)
                && (!filter.quest || e.quest === filter.quest)
                && (!filter.host || e.host === filter.host);
        });
    }

    // ------------------------------------------------------------- migration

    exportGroup(groupId: string): GroupExport {
        const s = this.state(groupId);
        return {
            formatVersion: FORMAT_VERSION,
            group: s.group,
            tokens: Object.fromEntries(s.tokens),
            commands: this.listUndelivered(groupId),
            runtimes: [...s.runtimes.values()],
        };
    }

    importGroup(body: unknown): Group {
        const b = plainObject(body, 'export') as unknown as GroupExport;
        if ((b.formatVersion ?? 1) > FORMAT_VERSION) {
            throw new TacError('invalid', `the export has formatVersion ${b.formatVersion}; this service reads up to ${FORMAT_VERSION}`);
        }
        const g = plainObject(b.group, 'group') as unknown as Group;
        const groupId = str(g.groupId, 'group.groupId');
        if (!GROUP_ID_RE.test(groupId)) { throw new TacError('invalid', `groupId ${groupId} does not match ${GROUP_ID_RE}`); }
        if (this.store.get(groupId)) {
            throw new TacError('conflict', `group ${groupId} already exists on this backend`, { holders: [] });
        }
        const { migratedTo: _m, ...groupRest } = g;
        void _m;
        const group: Group = { ...groupRest, mode: 'local', units: g.units ?? [], infra: g.infra ?? [] };
        const changes: Change[] = [{ c: 'group', id: groupId, v: group }];
        for (const [key, next] of Object.entries(b.tokens ?? {})) {
            parseResourceKey(key);
            if (!Number.isInteger(next) || next < 1) { throw new TacError('invalid', `tokens.${key} must be a positive integer`); }
            changes.push({ c: 'tokens', id: key, v: next });
        }
        for (const msg of b.commands ?? []) {
            if (msg.class === 'command' && isUlid(msg.messageId)) { changes.push({ c: 'commands', id: msg.messageId, v: msg }); }
        }
        this.store.commit(groupId, changes);
        return group;
    }

    markMigrated(groupId: string, body: unknown): Group {
        const s = this.store.get(groupId);
        if (!s) {
            throw new TacError('notFound', `group ${groupId} does not exist`, { what: 'group' });
        }
        const b = plainObject(body, 'markMigrated');
        const migratedTo = plainObject(b.migratedTo, 'migratedTo') as unknown as BackendIdentity;
        str(migratedTo.mode, 'migratedTo.mode');
        const group: Group = { ...s.group, migratedTo };
        this.store.commit(groupId, [{ c: 'group', id: groupId, v: group }]);
        return group;
    }

    // ------------------------------------------------------------------ sweep

    /**
     * Housekeeping, run every few seconds by the server and directly by tests:
     * withdraw the endpoints of runtimes whose presence ended, expire command
     * deliveries, forget request ids after 24 hours and acknowledged commands
     * after a day.
     */
    sweep(): void {
        const now = this.now();
        for (const s of this.store.all()) {
            const groupId = s.group.groupId;
            const changes: Change[] = [];
            for (const ep of s.endpoints.values()) {
                const r = s.runtimes.get(ep.runtimeId);
                if (!r || !this.isPresent(groupId, r)) { changes.push({ c: 'endpoints', id: ep.endpointId }); }
            }
            for (const msg of s.commands.values()) {
                const ds = msg.deliveries ?? [];
                if (ds.some((d) => (d.state === 'pending' || d.state === 'delivered') && ms(d.expiresAt) <= now)) {
                    changes.push({ c: 'commands', id: msg.messageId, v: this.withExpiry(msg) });
                    continue;
                }
                const acked = ds.length > 0 && ds.every((d) => d.state === 'acknowledged' && d.outcome !== 'refused');
                const last = Math.max(...ds.map((d) => ms(d.acknowledgedAt ?? msg.createdAt)));
                if (acked && now - last > ACKED_COMMAND_HOURS * 3_600_000) {
                    changes.push({ c: 'commands', id: msg.messageId });
                }
            }
            for (const [id, rec] of s.requests) {
                if (now - ms(rec.at) > REQUEST_ID_HOURS * 3_600_000) { changes.push({ c: 'requests', id }); }
            }
            if (changes.length > 0) {
                try { this.store.commit(groupId, changes); } catch { /* retried at the next sweep */ }
            }
        }
    }
}
