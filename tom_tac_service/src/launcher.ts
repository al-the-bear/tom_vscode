/**
 * How a runtime finds or starts its machine's local service
 * (agent_collaboration part-coordination-service § Two runtimes starting it at once):
 *
 * 1. Send `hello` to the port. A TAC service with the same major version: use it.
 * 2. Nothing answers: start the service as a detached child process with the
 *    runtime's own Node (`process.execPath`; in the VS Code extension host with
 *    `ELECTRON_RUN_AS_NODE=1`). Of two started at once exactly one binds the
 *    port; the other exits.
 * 3. Retry `hello` for up to 10 seconds.
 * 4. Something that is not TAC owns the port: refuse, the group is unreachable.
 *
 * A service with another major version is asked to hand over
 * (`POST /tac/1/admin/handover`) and replaced by this runtime's copy.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { TacError } from './protocol/errors';
import { PROTOCOL_VERSION } from './protocol/types';
import type { HelloResult } from './protocol/types';
import { DEFAULT_HOST, DEFAULT_PORT, defaultStoreDir, readKeyFile } from './local';

export interface EnsureOptions {
    host?: string;
    port?: number;
    storeDir?: string;
    /** The service's command line script; default this package's `dist/src/cli.js`. */
    cliPath?: string;
    /** The Node to run it with; default `process.execPath`. */
    execPath?: string;
    env?: NodeJS.ProcessEnv;
    /** How long to wait for a started service; default 10 s. */
    timeoutMs?: number;
    /** How long an older service may take to hand over; default 30 s. */
    handoverTimeoutMs?: number;
    /** Extra arguments for `serve` (e.g. `--idle-minutes`). */
    serveArgs?: string[];
}

export interface EnsureResult {
    status: 'found' | 'started';
    baseUrl: string;
    key: string;
    hello: HelloResult;
}

type Probe =
    | { kind: 'none' }
    | { kind: 'tac'; hello: HelloResult }
    | { kind: 'tacOtherMajor'; body: unknown }
    | { kind: 'tacUnauthorized' }
    | { kind: 'foreign'; detail: string };

async function probe(baseUrl: string, key: string | undefined): Promise<Probe> {
    let res: Response;
    try {
        res = await fetch(`${baseUrl}/tac/1/hello?protocolVersion=${encodeURIComponent(PROTOCOL_VERSION)}`, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(2_000),
        });
    } catch (e) {
        const code = ((e as Error & { cause?: { code?: string } }).cause?.code) ?? '';
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') { return { kind: 'none' }; }
        return { kind: 'foreign', detail: `${code || (e as Error).message}` };
    }
    let body: Record<string, unknown> | undefined;
    try { body = (await res.json()) as Record<string, unknown>; } catch { body = undefined; }
    if (res.ok && body && typeof body.protocolVersion === 'string' && body.protocolVersion.startsWith('tac/')) {
        return { kind: 'tac', hello: body as unknown as HelloResult };
    }
    if (body && body.code === 'versionMismatch') { return { kind: 'tacOtherMajor', body }; }
    if (body && body.code === 'unauthorized') { return { kind: 'tacUnauthorized' }; }
    return { kind: 'foreign', detail: `HTTP ${res.status}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureLocalService(opts: EnsureOptions = {}): Promise<EnsureResult> {
    const host = opts.host ?? DEFAULT_HOST;
    const port = opts.port ?? DEFAULT_PORT;
    const storeDir = opts.storeDir ?? defaultStoreDir();
    const baseUrl = `http://${host}:${port}`;
    const timeoutMs = opts.timeoutMs ?? 10_000;

    const first = await probe(baseUrl, readKeyFile(storeDir));
    const found = (p: Probe, status: EnsureResult['status']): EnsureResult | undefined => {
        if (p.kind !== 'tac') { return undefined; }
        const key = readKeyFile(storeDir);
        if (!key) {
            throw new TacError('unreachable', `a TAC service answers on ${host}:${port}, but ${path.join(storeDir, 'local.key')} is missing`);
        }
        return { status, baseUrl, key, hello: p.hello };
    };
    const direct = found(first, 'found');
    if (direct) { return direct; }
    if (first.kind === 'foreign') {
        throw new TacError('unreachable', `local coordination service: port ${port} is used by another program (${first.detail})`, { port });
    }
    if (first.kind === 'tacUnauthorized') {
        throw new TacError('unreachable', `local coordination service: the service on port ${port} does not accept this user's key (another OS user's service?)`, { port });
    }
    if (first.kind === 'tacOtherMajor') {
        const key = readKeyFile(storeDir);
        await fetch(`${baseUrl}/tac/1/admin/handover`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {} }).catch(() => undefined);
        const until = Date.now() + (opts.handoverTimeoutMs ?? 30_000);
        while ((await probe(baseUrl, key)).kind !== 'none') {
            if (Date.now() > until) {
                throw new TacError('unreachable', `the older coordination service on port ${port} did not stop within the handover time`, { port });
            }
            await sleep(200);
        }
    }

    const cliPath = opts.cliPath ?? path.join(__dirname, 'cli.js');
    const child = spawn(opts.execPath ?? process.execPath, [cliPath, 'serve', '--host', host, '--port', String(port), '--store', storeDir, ...(opts.serveArgs ?? [])], {
        detached: true,
        stdio: 'ignore',
        env: { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
    });
    child.unref();

    const until = Date.now() + timeoutMs;
    for (;;) {
        await sleep(100);
        const p = await probe(baseUrl, readKeyFile(storeDir));
        const r = found(p, 'started');
        if (r) { return r; }
        if (p.kind === 'foreign') {
            throw new TacError('unreachable', `local coordination service: port ${port} is used by another program (${p.detail})`, { port });
        }
        if (Date.now() > until) {
            throw new TacError('unreachable', `the local coordination service did not answer on ${host}:${port} within ${timeoutMs / 1000} s`, { port });
        }
    }
}
