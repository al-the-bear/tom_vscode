/**
 * A thin typed client of the HTTP and WebSocket binding (§ 9): one method per
 * TAC operation, errors as `TacError`. It holds no coordination logic (the
 * runtime's client adds renewal timers, the outbox and the state machine);
 * it is what that client's service adapter and the tests talk through.
 *
 * Uses the global `fetch` and `WebSocket` of Node 22 or later.
 */
import { TacError } from './protocol/errors';
import type { TacErrorBody } from './protocol/errors';
import { sessionKeyText } from './protocol/keys';
import { PROTOCOL_VERSION } from './protocol/types';
import type {
    AckOutcome, Endpoint, Group, GroupExport, GroupMode, GroupSettings, HelloResult, Hold, InfraResource, Lease, LeaseState,
    Message, MisconfigurationWarning, Runtime, Session, SessionKey, StreamFrame, Unit,
} from './protocol/types';
import { ulid } from './util/ulid';

export interface ClientOptions {
    baseUrl: string;
    key: string;
    timeoutMs?: number;
}

export interface Subscription {
    close(): void;
    readonly opened: Promise<void>;
    readonly closed: Promise<{ code: number; reason: string }>;
}

export interface SubscribeHandlers {
    onNotification?: (m: Message) => void;
    onCommand?: (m: Message) => void;
}

const enc = encodeURIComponent;

export class TacClient {
    private readonly base: string;

    constructor(private readonly opts: ClientOptions) {
        this.base = opts.baseUrl.replace(/\/$/, '');
    }

    private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`${this.base}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.opts.key}`,
                    'Tac-Protocol-Version': PROTOCOL_VERSION,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
            });
        } catch (e) {
            throw new TacError('unreachable', `the TAC service at ${this.base} cannot be reached: ${(e as Error).message}`, { cause: (e as Error).message });
        }
        if (res.status === 204) { return undefined as T; }
        const text = await res.text();
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        if (!res.ok) {
            const b = json as TacErrorBody | undefined;
            if (b && typeof b.code === 'string') { throw new TacError(b.code, b.message, b.details); }
            throw new TacError('unreachable', `${this.base} answered ${res.status}, not as a TAC service`, { status: res.status });
        }
        return json as T;
    }

    private g(groupId: string): string {
        return `/tac/1/groups/${enc(groupId)}`;
    }

    // handshake
    hello(groupId?: string, create?: { settings: GroupSettings; customerId?: string; mode?: GroupMode }): Promise<HelloResult> {
        if (create) {
            return this.call('POST', '/tac/1/hello', { protocolVersion: PROTOCOL_VERSION, groupId, ...create });
        }
        const q = new URLSearchParams({ protocolVersion: PROTOCOL_VERSION });
        if (groupId) { q.set('groupId', groupId); }
        return this.call('GET', `/tac/1/hello?${q}`);
    }

    // runtimes
    register(groupId: string, runtime: Partial<Runtime> & Pick<Runtime, 'runtimeId' | 'kind' | 'host' | 'workspace' | 'workspaceRoot' | 'quests'>): Promise<Runtime> {
        return this.call('POST', `${this.g(groupId)}/runtimes`, runtime);
    }
    renewPresence(groupId: string, runtimeId: string, change: Partial<Pick<Runtime, 'clones' | 'status'>> = {}): Promise<Runtime> {
        return this.call('PUT', `${this.g(groupId)}/runtimes/${enc(runtimeId)}/presence`, change);
    }
    deregister(groupId: string, runtimeId: string): Promise<void> {
        return this.call('DELETE', `${this.g(groupId)}/runtimes/${enc(runtimeId)}`);
    }
    listRuntimes(groupId: string, filter: { quest?: string; host?: string; presentOnly?: boolean } = {}): Promise<{ items: Runtime[]; warnings: MisconfigurationWarning[] }> {
        return this.call('GET', `${this.g(groupId)}/runtimes${query(filter)}`);
    }

    // sessions
    openSession(groupId: string, sessionKey: SessionKey, runtimeId: string): Promise<Session> {
        return this.call('POST', `${this.g(groupId)}/sessions`, { sessionKey, runtimeId });
    }
    touchSession(groupId: string, sessionKey: SessionKey, currentItem?: Session['currentItem'] | null): Promise<Session> {
        return this.call('PATCH', `${this.g(groupId)}/sessions/${enc(sessionKeyText(sessionKey))}`, { currentItem });
    }
    closeSession(groupId: string, sessionKey: SessionKey): Promise<void> {
        return this.call('DELETE', `${this.g(groupId)}/sessions/${enc(sessionKeyText(sessionKey))}`);
    }
    async listSessions(groupId: string, filter: { quest?: string; host?: string; runtimeId?: string } = {}): Promise<Session[]> {
        return (await this.call<{ items: Session[] }>('GET', `${this.g(groupId)}/sessions${query(filter)}`)).items;
    }

    // leases
    acquire(groupId: string, req: { sessionKey: SessionKey; resources: (string | { key: string; branch?: string; worktree?: string })[]; hold?: Hold; requestId?: string }): Promise<{ granted: true; lease: Lease }> {
        return this.call('POST', `${this.g(groupId)}/leases`, { ...req, requestId: req.requestId ?? ulid() });
    }
    renew(groupId: string, leaseId: string, sessionKey: SessionKey): Promise<Lease> {
        return this.call('POST', `${this.g(groupId)}/leases/${enc(leaseId)}/renew`, { sessionKey });
    }
    release(groupId: string, leaseId: string, sessionKey: SessionKey, resources?: string[]): Promise<Lease> {
        return this.call('POST', `${this.g(groupId)}/leases/${enc(leaseId)}/release`, { sessionKey, resources });
    }
    free(groupId: string, leaseId: string, by?: string): Promise<Lease> {
        return this.call('POST', `${this.g(groupId)}/leases/${enc(leaseId)}/free`, { by });
    }
    async listLeases(groupId: string, filter: { sessionKey?: SessionKey; key?: string; states?: LeaseState[] } = {}): Promise<Lease[]> {
        const q = { sessionKey: filter.sessionKey ? sessionKeyText(filter.sessionKey) : undefined, key: filter.key, states: filter.states?.join(',') };
        return (await this.call<{ items: Lease[] }>('GET', `${this.g(groupId)}/leases${query(q)}`)).items;
    }
    checkToken(groupId: string, key: string, token: number): Promise<{ current: boolean; holder?: { sessionKey: SessionKey; leaseId: string; token: number } }> {
        return this.call('GET', `${this.g(groupId)}/tokens/${enc(key)}?token=${token}`);
    }

    // units
    listUnits(groupId: string): Promise<{ units: Unit[]; infra: InfraResource[] }> {
        return this.call('GET', `${this.g(groupId)}/units`);
    }
    setUnits(groupId: string, units: Unit[], infra?: InfraResource[]): Promise<{ units: Unit[]; infra: InfraResource[] }> {
        return this.call('PUT', `${this.g(groupId)}/units`, { units, infra });
    }

    // messages
    send(groupId: string, msg: Pick<Message, 'class' | 'type' | 'origin' | 'targets' | 'payload'> & { preferHost?: string; requestId?: string }): Promise<{ messageId: string; createdAt: string }> {
        return this.call('POST', `${this.g(groupId)}/messages`, { ...msg, requestId: msg.requestId ?? ulid() });
    }
    async pendingCommands(groupId: string, runtimeId: string): Promise<Message[]> {
        return (await this.call<{ items: Message[] }>('GET', `${this.g(groupId)}/runtimes/${enc(runtimeId)}/commands`)).items;
    }
    ack(groupId: string, messageId: string, runtimeId: string, outcome: AckOutcome, reason?: string, quest?: string): Promise<{ acknowledged: boolean; by: string }> {
        return this.call('POST', `${this.g(groupId)}/messages/${enc(messageId)}/ack`, { runtimeId, outcome, reason, quest });
    }
    async listUndelivered(groupId: string, filter: { quest?: string; states?: string[] } = {}): Promise<Message[]> {
        return (await this.call<{ items: Message[] }>('GET', `${this.g(groupId)}/messages/undelivered${query({ quest: filter.quest, states: filter.states?.join(',') })}`)).items;
    }
    resend(groupId: string, messageId: string, quest?: string): Promise<Message> {
        return this.call('POST', `${this.g(groupId)}/messages/${enc(messageId)}/resend`, { quest });
    }
    drop(groupId: string, messageId: string): Promise<void> {
        return this.call('DELETE', `${this.g(groupId)}/messages/${enc(messageId)}`);
    }

    // endpoints
    publish(groupId: string, ep: Omit<Endpoint, 'endpointId' | 'publishedAt' | 'auth'> & { auth?: Endpoint['auth']; requestId?: string }): Promise<Endpoint> {
        return this.call('POST', `${this.g(groupId)}/endpoints`, { ...ep, requestId: ep.requestId ?? ulid() });
    }
    withdraw(groupId: string, endpointId: string): Promise<void> {
        return this.call('DELETE', `${this.g(groupId)}/endpoints/${enc(endpointId)}`);
    }
    async listEndpoints(groupId: string, filter: { type?: string; quest?: string; host?: string } = {}): Promise<Endpoint[]> {
        return (await this.call<{ items: Endpoint[] }>('GET', `${this.g(groupId)}/endpoints${query(filter)}`)).items;
    }

    // migration
    exportGroup(groupId: string): Promise<GroupExport> {
        return this.call('POST', `${this.g(groupId)}/migrate/export`, {});
    }
    importGroup(exp: GroupExport): Promise<Group> {
        return this.call('POST', '/tac/1/groups', exp);
    }
    markMigrated(groupId: string, migratedTo: Group['migratedTo']): Promise<Group> {
        return this.call('POST', `${this.g(groupId)}/migrate/mark`, { migratedTo });
    }

    // admin (local service)
    adminStatus(): Promise<Record<string, unknown>> {
        return this.call('GET', '/tac/1/admin/status');
    }
    adminStop(handover = false): Promise<{ stopping: boolean }> {
        return this.call('POST', handover ? '/tac/1/admin/handover' : '/tac/1/admin/stop', {});
    }

    /** Open the runtime's stream (`subscribe`); notifications and commands arrive through the handlers. */
    subscribe(groupId: string, runtimeId: string, handlers: SubscribeHandlers): Subscription & { ack(messageId: string, outcome: AckOutcome, reason?: string): void } {
        const wsUrl = `${this.base.replace(/^http/, 'ws')}${this.g(groupId)}/stream?runtimeId=${enc(runtimeId)}`;
        const ws = new WebSocket(wsUrl, ['tac.v1', `tac.key.${this.opts.key}`]);
        let resolveOpen!: () => void;
        let rejectOpen!: (e: Error) => void;
        const opened = new Promise<void>((res, rej) => { resolveOpen = res; rejectOpen = rej; });
        const closed = new Promise<{ code: number; reason: string }>((res) => {
            ws.addEventListener('close', (ev) => {
                rejectOpen(new TacError('unreachable', `the stream closed before it opened (${ev.code})`));
                res({ code: ev.code, reason: ev.reason });
            });
        });
        opened.catch(() => undefined);
        ws.addEventListener('open', () => resolveOpen());
        ws.addEventListener('message', (ev) => {
            let frame: StreamFrame;
            try { frame = JSON.parse(String(ev.data)); } catch { return; }
            if (frame.kind === 'notification') { handlers.onNotification?.(frame.message); }
            if (frame.kind === 'command') { handlers.onCommand?.(frame.message); }
        });
        return {
            opened,
            closed,
            close: () => ws.close(1000, 'done'),
            ack: (messageId, outcome, reason) => ws.send(JSON.stringify({ kind: 'ack', messageId, outcome, reason })),
        };
    }
}

function query(o: Record<string, string | boolean | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) {
        if (v !== undefined && v !== '') { q.set(k, String(v)); }
    }
    const s = q.toString();
    return s ? `?${s}` : '';
}
