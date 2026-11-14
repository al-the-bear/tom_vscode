/**
 * The HTTP and WebSocket binding of TAC (doc/tac_specification.md § 9) for
 * the local service.
 */
import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { TacError } from '../protocol/errors';
import { PROTOCOL_MAJOR } from '../protocol/types';
import type { LeaseState, StreamFrame } from '../protocol/types';
import type { TacService } from '../service/service';
import { completeHandshake, WsConnection } from './websocket';

/** The largest request body accepted. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const PING_MS = 30_000;
export const SILENT_MS = 90_000;
/** The subprotocol a stream selects; the key may be offered as `tac.key.<key>` beside it. */
export const STREAM_PROTOCOL = 'tac.v1';
export const KEY_PROTOCOL_PREFIX = 'tac.key.';

export interface AdminHooks {
    /** The service's state for `GET /tac/1/admin/status`. */
    status(): Record<string, unknown>;
    /** Stop the service (handover to a newer one, or the page's Stop). Called after the answer is sent. */
    stop(reason: 'handover' | 'stop'): void;
}

export interface ServerOptions {
    /** The service; undefined while the store is still being opened (requests answer `unavailable`). */
    service: () => TacService | undefined;
    key: string;
    host?: string;
    port?: number;
    admin?: AdminHooks;
    /** Called on every request and stream frame (the idle stop's notion of "accessed"). */
    onAccess?: () => void;
    pingMs?: number;
    silentMs?: number;
}

interface Route {
    method: string;
    pattern: RegExp;
    handle: (svc: TacService, m: string[], q: URLSearchParams, body: unknown) => unknown;
    status?: number;
}

function q2(q: URLSearchParams, name: string): string | undefined {
    const v = q.get(name);
    return v === null || v === '' ? undefined : v;
}

function list<T>(items: T[]): { items: T[] } {
    return { items };
}

const G = '/tac/1/groups/([^/]+)';

const ROUTES: Route[] = [
    // handshake
    {
        method: 'GET', pattern: /^\/tac\/1\/hello$/,
        handle: (s, _m, q) => {
            const client = q2(q, 'client');
            return s.hello({
                protocolVersion: q2(q, 'protocolVersion'),
                client: client ? { name: client.split('/')[0], version: client.split('/')[1] } : undefined,
                groupId: q2(q, 'groupId'),
            });
        },
    },
    { method: 'POST', pattern: /^\/tac\/1\/hello$/, handle: (s, _m, _q, b) => s.hello((b ?? {}) as never) },
    // runtimes
    { method: 'POST', pattern: new RegExp(`^${G}/runtimes$`), handle: (s, m, _q, b) => s.register(m[1], b), status: 201 },
    { method: 'PUT', pattern: new RegExp(`^${G}/runtimes/([^/]+)/presence$`), handle: (s, m, _q, b) => s.renewPresence(m[1], m[2], b) },
    { method: 'DELETE', pattern: new RegExp(`^${G}/runtimes/([^/]+)$`), handle: (s, m) => { s.deregister(m[1], m[2]); return undefined; } },
    {
        method: 'GET', pattern: new RegExp(`^${G}/runtimes$`),
        handle: (s, m, q) => s.listRuntimes(m[1], { quest: q2(q, 'quest'), host: q2(q, 'host'), presentOnly: q.get('presentOnly') === 'true' }),
    },
    // sessions
    { method: 'POST', pattern: new RegExp(`^${G}/sessions$`), handle: (s, m, _q, b) => s.openSession(m[1], b) },
    { method: 'PATCH', pattern: new RegExp(`^${G}/sessions/([^/]+)$`), handle: (s, m, _q, b) => s.touchSession(m[1], m[2], b) },
    { method: 'DELETE', pattern: new RegExp(`^${G}/sessions/([^/]+)$`), handle: (s, m) => { s.closeSession(m[1], m[2]); return undefined; } },
    {
        method: 'GET', pattern: new RegExp(`^${G}/sessions$`),
        handle: (s, m, q) => list(s.listSessions(m[1], { quest: q2(q, 'quest'), host: q2(q, 'host'), runtimeId: q2(q, 'runtimeId') })),
    },
    // leases
    { method: 'POST', pattern: new RegExp(`^${G}/leases$`), handle: (s, m, _q, b) => s.acquire(m[1], b) },
    { method: 'POST', pattern: new RegExp(`^${G}/leases/([^/]+)/renew$`), handle: (s, m, _q, b) => s.renew(m[1], m[2], b) },
    { method: 'POST', pattern: new RegExp(`^${G}/leases/([^/]+)/release$`), handle: (s, m, _q, b) => s.release(m[1], m[2], b) },
    { method: 'POST', pattern: new RegExp(`^${G}/leases/([^/]+)/free$`), handle: (s, m, _q, b) => s.free(m[1], m[2], b) },
    {
        method: 'GET', pattern: new RegExp(`^${G}/leases$`),
        handle: (s, m, q) => list(s.listLeases(m[1], {
            sessionKey: q2(q, 'sessionKey'),
            key: q2(q, 'key'),
            states: q2(q, 'states')?.split(',') as LeaseState[] | undefined,
        })),
    },
    {
        method: 'GET', pattern: new RegExp(`^${G}/tokens/([^/]+)$`),
        handle: (s, m, q) => {
            const t = q2(q, 'token');
            if (t === undefined || !/^\d+$/.test(t)) { throw new TacError('invalid', 'the query needs token=<integer>'); }
            return s.checkToken(m[1], m[2], Number(t));
        },
    },
    // units
    { method: 'GET', pattern: new RegExp(`^${G}/units$`), handle: (s, m) => s.listUnits(m[1]) },
    { method: 'PUT', pattern: new RegExp(`^${G}/units$`), handle: (s, m, _q, b) => s.setUnits(m[1], b) },
    // messages
    { method: 'POST', pattern: new RegExp(`^${G}/messages$`), handle: (s, m, _q, b) => s.send(m[1], b), status: 201 },
    { method: 'GET', pattern: new RegExp(`^${G}/runtimes/([^/]+)/commands$`), handle: (s, m) => list(s.pendingCommands(m[1], m[2])) },
    { method: 'POST', pattern: new RegExp(`^${G}/messages/([^/]+)/ack$`), handle: (s, m, _q, b) => s.ack(m[1], m[2], b) },
    {
        method: 'GET', pattern: new RegExp(`^${G}/messages/undelivered$`),
        handle: (s, m, q) => list(s.listUndelivered(m[1], { quest: q2(q, 'quest'), states: q2(q, 'states')?.split(',') })),
    },
    { method: 'POST', pattern: new RegExp(`^${G}/messages/([^/]+)/resend$`), handle: (s, m, _q, b) => s.resend(m[1], m[2], b) },
    { method: 'DELETE', pattern: new RegExp(`^${G}/messages/([^/]+)$`), handle: (s, m) => { s.drop(m[1], m[2]); return undefined; } },
    // endpoints
    { method: 'POST', pattern: new RegExp(`^${G}/endpoints$`), handle: (s, m, _q, b) => s.publish(m[1], b), status: 201 },
    { method: 'DELETE', pattern: new RegExp(`^${G}/endpoints/(.+)$`), handle: (s, m) => { s.withdraw(m[1], m[2]); return undefined; } },
    {
        method: 'GET', pattern: new RegExp(`^${G}/endpoints$`),
        handle: (s, m, q) => list(s.listEndpoints(m[1], { type: q2(q, 'type'), quest: q2(q, 'quest'), host: q2(q, 'host') })),
    },
    // migration
    { method: 'POST', pattern: new RegExp(`^${G}/migrate/export$`), handle: (s, m) => s.exportGroup(m[1]) },
    { method: 'POST', pattern: /^\/tac\/1\/groups$/, handle: (s, _m, _q, b) => s.importGroup(b), status: 201 },
    { method: 'POST', pattern: new RegExp(`^${G}/migrate/mark$`), handle: (s, m, _q, b) => s.markMigrated(m[1], b) },
];

export class TacHttpServer {
    private readonly server: http.Server;
    private readonly connections = new Set<WsConnection>();
    private pingTimer: NodeJS.Timeout | undefined;
    private readonly keyBuf: Buffer;

    constructor(private readonly opts: ServerOptions) {
        this.keyBuf = Buffer.from(opts.key, 'utf8');
        this.server = http.createServer((req, res) => { void this.onRequest(req, res); });
        this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
        this.server.keepAliveTimeout = 5_000;
    }

    /** Bind the port. Rejects with the `EADDRINUSE` error when another process holds it. */
    listen(): Promise<number> {
        return new Promise((resolve, reject) => {
            const onError = (e: Error) => { this.server.off('listening', onListening); reject(e); };
            const onListening = () => {
                this.server.off('error', onError);
                this.pingTimer = setInterval(() => this.pingAll(), this.opts.pingMs ?? PING_MS);
                this.pingTimer.unref();
                resolve((this.server.address() as AddressInfo).port);
            };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(this.opts.port ?? 19890, this.opts.host ?? '127.0.0.1');
        });
    }

    get port(): number {
        return (this.server.address() as AddressInfo | null)?.port ?? 0;
    }

    /** Close every stream (the runtimes reconnect) and stop listening. */
    close(): Promise<void> {
        if (this.pingTimer) { clearInterval(this.pingTimer); }
        for (const c of this.connections) { c.close(1001, 'service stopping'); }
        this.connections.clear();
        return new Promise((resolve) => {
            this.server.close(() => resolve());
            this.server.closeAllConnections();
        });
    }

    private authorized(header: string | undefined): boolean {
        if (!header || !header.startsWith('Bearer ')) { return false; }
        return this.keyMatches(header.slice(7).trim());
    }

    private keyMatches(given: string): boolean {
        const buf = Buffer.from(given, 'utf8');
        return buf.length === this.keyBuf.length && timingSafeEqual(buf, this.keyBuf);
    }

    private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
        if (body === undefined) {
            res.writeHead(status === 200 ? 204 : status, headers);
            res.end();
            return;
        }
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
        res.end(text);
    }

    private sendError(res: http.ServerResponse, e: unknown): void {
        const err = e instanceof TacError ? e : new TacError('invalid', (e as Error)?.message ?? String(e));
        const headers: Record<string, string> = {};
        const retryAfter = err.details?.retryAfter;
        if (err.code === 'quotaExceeded' && retryAfter !== undefined) { headers['Retry-After'] = String(retryAfter); }
        this.send(res, err.httpStatus, err.toBody(), headers);
    }

    private readBody(req: http.IncomingMessage): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on('data', (c: Buffer) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new TacError('invalid', `the request body is larger than ${MAX_BODY_BYTES} bytes`));
                    req.destroy();
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => {
                if (size === 0) { resolve(undefined); return; }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                    reject(new TacError('invalid', 'the request body is not JSON'));
                }
            });
            req.on('error', reject);
        });
    }

    private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        this.opts.onAccess?.();
        try {
            if (!this.authorized(req.headers.authorization)) {
                throw new TacError('unauthorized', 'a valid bearer key is required (the local service: the content of local.key)');
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const pv = req.headers['tac-protocol-version'];
            if (typeof pv === 'string') {
                const m = /^tac\/(\d+)\./.exec(pv);
                if (m && Number(m[1]) !== PROTOCOL_MAJOR) {
                    throw new TacError('versionMismatch', `this service speaks tac/${PROTOCOL_MAJOR}.x; the request is ${pv}`, { client: pv, backend: `tac/${PROTOCOL_MAJOR}` });
                }
            }
            const method = req.method ?? 'GET';
            const pathname = url.pathname;
            if (pathname.startsWith('/tac/1/admin/')) {
                await this.onAdmin(method, pathname, req, res);
                return;
            }
            const body = method === 'GET' || method === 'DELETE' ? undefined : await this.readBody(req);
            let pathExists = false;
            for (const r of ROUTES) {
                const m = r.pattern.exec(pathname);
                if (!m) { continue; }
                pathExists = true;
                if (r.method !== method) { continue; }
                const svc = this.opts.service();
                if (!svc) { throw new TacError('unavailable', 'the service is starting', { reason: 'starting' }); }
                const groups = m.map((x, i) => (i === 0 ? x : decodeURIComponent(x)));
                const result = r.handle(svc, groups, url.searchParams, body);
                this.send(res, r.status ?? 200, result);
                return;
            }
            throw new TacError(pathExists ? 'invalid' : 'notFound', pathExists ? `${method} is not allowed on ${pathname}` : `no TAC operation at ${pathname}`, { what: 'path' });
        } catch (e) {
            this.sendError(res, e);
        }
    }

    private async onAdmin(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const admin = this.opts.admin;
        if (!admin) { throw new TacError('unsupported', 'this service has no admin operations', { area: 'admin' }); }
        if (method === 'GET' && pathname === '/tac/1/admin/status') {
            this.send(res, 200, admin.status());
            return;
        }
        if (method === 'POST' && (pathname === '/tac/1/admin/handover' || pathname === '/tac/1/admin/stop')) {
            await this.readBody(req);
            const reason = pathname.endsWith('handover') ? 'handover' : 'stop';
            res.on('finish', () => admin.stop(reason));
            this.send(res, 202, { stopping: true, reason });
            return;
        }
        throw new TacError('notFound', `no admin operation at ${pathname}`, { what: 'path' });
    }

    private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        this.opts.onAccess?.();
        const reject = (status: number, err: TacError) => {
            const text = JSON.stringify(err.toBody());
            socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
        };
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = new RegExp(`^${G}/stream$`).exec(url.pathname);
        const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        const keyProto = offered.find((p) => p.startsWith(KEY_PROTOCOL_PREFIX));
        const ok = this.authorized(req.headers.authorization) || (keyProto !== undefined && this.keyMatches(keyProto.slice(KEY_PROTOCOL_PREFIX.length)));
        if (!ok) { reject(401, new TacError('unauthorized', 'a valid bearer key is required')); return; }
        if (!m) { reject(404, new TacError('notFound', `no stream at ${url.pathname}`, { what: 'path' })); return; }
        const svc = this.opts.service();
        if (!svc) { reject(503, new TacError('unavailable', 'the service is starting')); return; }
        const groupId = decodeURIComponent(m[1]);
        const runtimeId = url.searchParams.get('runtimeId') ?? '';
        // Check before the handshake, so a refusal is a plain HTTP answer.
        try {
            const known = svc.listRuntimes(groupId).items.some((r) => r.runtimeId === runtimeId);
            if (!known) { throw new TacError('notFound', `runtime ${runtimeId} is not registered in group ${groupId}`, { what: 'runtime' }); }
        } catch (e) {
            const err = e instanceof TacError ? e : new TacError('invalid', String(e));
            reject(err.httpStatus, err);
            return;
        }
        const protocol = offered.length > 0 ? (offered.includes(STREAM_PROTOCOL) ? STREAM_PROTOCOL : offered.find((p) => !p.startsWith(KEY_PROTOCOL_PREFIX)) ?? STREAM_PROTOCOL) : undefined;
        if (!completeHandshake(req, socket, protocol)) { return; }
        const conn = new WsConnection(socket, head);
        this.connections.add(conn);
        const sink = (frame: StreamFrame) => { conn.send(JSON.stringify(frame)); };
        conn.on('message', (text: string) => {
            this.opts.onAccess?.();
            let frame: StreamFrame;
            try { frame = JSON.parse(text); } catch { return; }
            if (frame.kind === 'ack') {
                try { svc.ack(groupId, frame.messageId, { runtimeId, outcome: frame.outcome, reason: frame.reason }); } catch { /* a bad ack is ignored on the stream; the HTTP ack answers errors */ }
            }
        });
        conn.on('pong', () => this.opts.onAccess?.());
        conn.on('close', () => {
            this.connections.delete(conn);
            svc.detachStream(groupId, runtimeId, sink);
            this.opts.onAccess?.();
        });
        try {
            svc.attachStream(groupId, runtimeId, sink);
        } catch {
            conn.close(1011, 'attach failed');
        }
    }

    private pingAll(): void {
        const silent = this.opts.silentMs ?? SILENT_MS;
        const now = Date.now();
        for (const c of this.connections) {
            if (now - c.lastSeen > silent) {
                c.terminate();
            } else {
                c.ping();
            }
        }
    }
}
