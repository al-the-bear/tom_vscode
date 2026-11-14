import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { TacClient } from '../src/client';
import { ensureLocalService } from '../src/launcher';
import { TacError } from '../src/protocol/errors';
import { freePort, removeDir, scratchDir, sleep } from './helpers';

const dirs: string[] = [];
const toStop: TacClient[] = [];
after(async () => {
    for (const c of toStop) { await c.adminStop().catch(() => undefined); }
    await sleep(300);
    dirs.forEach(removeDir);
});

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

test('LA-1 a runtime starts the service as a detached process; the next one finds it', async () => {
    const storeDir = scratchDir('la1');
    dirs.push(storeDir);
    const port = await freePort();
    const first = await ensureLocalService({ port, storeDir, cliPath: CLI });
    assert.equal(first.status, 'started');
    toStop.push(new TacClient({ baseUrl: first.baseUrl, key: first.key }));
    assert.notEqual(first.hello.service?.pid, process.pid, 'it runs in its own process');
    const second = await ensureLocalService({ port, storeDir, cliPath: CLI });
    assert.equal(second.status, 'found');
    assert.equal(second.hello.service?.pid, first.hello.service?.pid);
});

test('LA-2 two runtimes starting it at once end up on the one service that bound the port', async () => {
    const storeDir = scratchDir('la2');
    dirs.push(storeDir);
    const port = await freePort();
    const [a, b] = await Promise.all([
        ensureLocalService({ port, storeDir, cliPath: CLI }),
        ensureLocalService({ port, storeDir, cliPath: CLI }),
    ]);
    toStop.push(new TacClient({ baseUrl: a.baseUrl, key: a.key }));
    assert.equal(a.hello.service?.pid, b.hello.service?.pid);
    assert.equal(a.key, b.key);
});

test('LA-3 a port held by another program is refused, not taken', async () => {
    const storeDir = scratchDir('la3');
    dirs.push(storeDir);
    const foreign = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello'); });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
    const port = (foreign.address() as { port: number }).port;
    try {
        await assert.rejects(ensureLocalService({ port, storeDir, cliPath: CLI }), (e: unknown) =>
            e instanceof TacError && e.code === 'unreachable' && /used by another program/.test(e.message));
    } finally {
        foreign.close();
    }
});

test('LA-4 the started service stops by itself when idle (no stream open, no request)', async () => {
    const storeDir = scratchDir('la4');
    dirs.push(storeDir);
    const port = await freePort();
    const r = await ensureLocalService({ port, storeDir, cliPath: CLI, serveArgs: ['--idle-minutes', '0.01'] });
    assert.equal(r.status, 'started');
    const until = Date.now() + 10_000;
    let gone = false;
    while (!gone && Date.now() < until) {
        await sleep(200);
        // probe without the key: an unauthorized answer still counts as access, so only look at the socket
        gone = await new Promise<boolean>((resolve) => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(false); });
            sock.once('error', () => resolve(true));
        });
    }
    assert.ok(gone, 'the idle service exited');
    assert.ok(fs.existsSync(path.join(storeDir, 'local.key')));
    assert.ok(!fs.existsSync(path.join(storeDir, 'service.json')), 'its clean stop removed service.json');
});

test('LA-5 an older service of another major version is asked to hand over and replaced', async () => {
    const storeDir = scratchDir('la5');
    dirs.push(storeDir);
    let handedOver = false;
    const old = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/tac/1/admin/handover') {
            handedOver = true;
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('{"stopping":true}', () => { old.close(); old.closeAllConnections(); });
            return;
        }
        res.writeHead(426, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'versionMismatch', message: 'tac/0.9', details: { client: 'tac/1.0', backend: 'tac/0.9' } }));
    });
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', () => r()));
    const port = (old.address() as { port: number }).port;
    const r = await ensureLocalService({ port, storeDir, cliPath: CLI, handoverTimeoutMs: 5000 });
    toStop.push(new TacClient({ baseUrl: r.baseUrl, key: r.key }));
    assert.ok(handedOver);
    assert.equal(r.status, 'started');
    assert.equal(r.hello.protocolVersion, 'tac/1.0');
});

test('LA-6 a TAC service that refuses this user\'s key is reported, not replaced', async () => {
    const storeDir = scratchDir('la6');
    dirs.push(storeDir);
    const other = http.createServer((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'unauthorized', message: 'a valid bearer key is required' }));
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const port = (other.address() as { port: number }).port;
    try {
        await assert.rejects(ensureLocalService({ port, storeDir, cliPath: CLI }), (e: unknown) =>
            e instanceof TacError && e.code === 'unreachable' && /does not accept this user's key/.test(e.message));
    } finally {
        other.close();
    }
});
