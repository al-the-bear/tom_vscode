import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { TacClient } from '../src/client';
import { defaultConfig, readServiceJson, startLocalService } from '../src/local';
import type { LocalConfig, RunningService } from '../src/local';
import { TacError } from '../src/protocol/errors';
import type { Message } from '../src/protocol/types';
import { ulid } from '../src/util/ulid';
import { removeDir, scratchDir, sk, sleep, waitFor } from './helpers';

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

const REPO = 'github/al-the-bear/tom_vscode';

function config(name: string, extra: Partial<LocalConfig> = {}): LocalConfig {
    const storeDir = scratchDir(name);
    dirs.push(storeDir);
    return { ...defaultConfig(), port: 0, storeDir, ...extra };
}

async function start(cfg: LocalConfig, opts = {}): Promise<{ handle: RunningService; client: () => TacClient; base: string }> {
    const r = await startLocalService(cfg, opts);
    assert.equal(r.status, 'running');
    const handle = (r as { handle: RunningService }).handle;
    const base = `http://127.0.0.1:${handle.port}`;
    const key = fs.readFileSync(path.join(cfg.storeDir, 'local.key'), 'utf8').trim();
    return { handle, base, client: () => new TacClient({ baseUrl: base, key }) };
}

function code(c: string) {
    return (e: unknown) => e instanceof TacError && e.code === c;
}

function runtime(quests: string[], host = 'mbp') {
    return { runtimeId: ulid(), kind: 'vscode' as const, host, workspace: 'ws', workspaceRoot: '/w', quests, clones: [] };
}

test('HT-1 two clients coordinate a lease through the service: wait, release, take over with the next token', async () => {
    const cfg = config('ht1');
    const { handle, client } = await start(cfg);
    try {
        const a = client();
        const b = client();
        await a.hello('fleet', { settings: { autoUpdate: false } });
        const h = await b.hello('fleet');
        assert.equal(h.group?.groupId, 'fleet');
        const ra = await a.register('fleet', runtime(['qa']));
        const rb = await b.register('fleet', runtime(['qb'], 'bomber'));
        await a.openSession('fleet', sk('qa'), ra.runtimeId);
        await b.openSession('fleet', sk('qb', 'default', 'default', 'bomber'), rb.runtimeId);

        const granted = await a.acquire('fleet', { sessionKey: sk('qa'), resources: [`${REPO}:tom_vscode_extension`] });
        await assert.rejects(b.acquire('fleet', { sessionKey: sk('qb', 'default', 'default', 'bomber'), resources: [REPO] }), (e: unknown) =>
            e instanceof TacError && e.code === 'conflict' && (e.details!.holders as { leaseId: string }[])[0].leaseId === granted.lease.leaseId);
        assert.equal((await b.checkToken('fleet', `${REPO}:tom_vscode_extension`, 1)).current, true);
        await a.release('fleet', granted.lease.leaseId, sk('qa'));
        const taken = await b.acquire('fleet', { sessionKey: sk('qb', 'default', 'default', 'bomber'), resources: [REPO] });
        assert.equal(taken.lease.resources[0].token, 1);
        assert.equal((await a.checkToken('fleet', `${REPO}:tom_vscode_extension`, 1)).current, false);
        const leases = await a.listLeases('fleet', { key: REPO });
        assert.deepEqual(leases.map((l) => l.state).sort(), ['active', 'released']);
        const renewed = await b.renew('fleet', taken.lease.leaseId, sk('qb', 'default', 'default', 'bomber'));
        assert.equal(renewed.state, 'active');
        const freed = await a.free('fleet', taken.lease.leaseId, 'alexis');
        assert.equal(freed.freedBy, 'alexis');
        await assert.rejects(b.renew('fleet', taken.lease.leaseId, sk('qb', 'default', 'default', 'bomber')), code('notHolder'));
        assert.equal((await a.listSessions('fleet', { host: 'bomber' })).length, 1);
    } finally {
        await handle.stop();
    }
});

test('HT-2 two clients exchange messages: notifications live on the stream, a command acknowledged by its target', async () => {
    const cfg = config('ht2');
    const { handle, client } = await start(cfg);
    try {
        const a = client();
        const b = client();
        await a.hello('fleet', { settings: {} });
        const ra = await a.register('fleet', runtime(['qa']));
        const rb = await b.register('fleet', runtime(['qb']));
        const gotB: Message[] = [];
        const cmdB: Message[] = [];
        const gotA: Message[] = [];
        const subA = a.subscribe('fleet', ra.runtimeId, { onNotification: (m) => gotA.push(m) });
        const subB = b.subscribe('fleet', rb.runtimeId, { onNotification: (m) => gotB.push(m), onCommand: (m) => cmdB.push(m) });
        await Promise.all([subA.opened, subB.opened]);
        assert.equal((await a.listRuntimes('fleet', { presentOnly: true })).items.length, 2, 'open streams are presence');

        const origin = { quest: 'qa', host: 'mbp', runtimeId: ra.runtimeId };
        await a.send('fleet', { class: 'notification', type: 'todo_completed', origin, targets: ['qb'], payload: { v: 1, summary: 'done' } });
        await waitFor(() => gotB.length === 1, 3000, 'the notification');
        assert.equal(gotB[0].payload.summary, 'done');
        assert.equal(gotA.length, 0, 'not pushed to its origin');

        const { messageId } = await a.send('fleet', { class: 'command', type: 'on_done', origin, targets: ['qb'], payload: { v: 1, todoId: 't1' } });
        await waitFor(() => cmdB.length === 1, 3000, 'the command');
        assert.equal(cmdB[0].messageId, messageId);
        subB.ack(messageId, 'taken');
        await waitForAsync(async () => (await a.listUndelivered('fleet')).length === 0, 'the ack over the stream');
        assert.deepEqual(await b.ack('fleet', messageId, rb.runtimeId, 'taken'), { acknowledged: true, by: rb.runtimeId }, 'a repeated ack is idempotent');

        // a command for a quest with no runtime stays pending; a runtime registering later receives it on connect
        const pending = await a.send('fleet', { class: 'command', type: 'on_done', origin, targets: ['qc'], payload: {} });
        const rc = await b.register('fleet', runtime(['qc']));
        assert.equal((await b.pendingCommands('fleet', rc.runtimeId)).length, 1);
        const cmdC: Message[] = [];
        const subC = b.subscribe('fleet', rc.runtimeId, { onCommand: (m) => cmdC.push(m) });
        await subC.opened;
        await waitFor(() => cmdC.length === 1, 3000, 'the pending command on connect');
        assert.equal(cmdC[0].messageId, pending.messageId);
        await b.ack('fleet', pending.messageId, rc.runtimeId, 'refused', 'no such run');
        const undelivered = await a.listUndelivered('fleet');
        assert.equal(undelivered[0].deliveries![0].outcome, 'refused');
        await a.drop('fleet', pending.messageId);

        subA.close();
        subB.close();
        subC.close();
        await Promise.all([subA.closed, subB.closed, subC.closed]);
    } finally {
        await handle.stop();
    }
});

async function waitForAsync(cond: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!(await cond())) {
        if (Date.now() > until) { throw new Error(`timed out waiting for ${what}`); }
        await sleep(20);
    }
}

test('HT-3 access: the key is required (HTTP and stream), errors carry their code and HTTP status', async () => {
    const cfg = config('ht3');
    const { handle, client, base } = await start(cfg);
    try {
        const wrong = new TacClient({ baseUrl: base, key: 'nope' });
        await assert.rejects(wrong.hello(), code('unauthorized'));
        const res = await fetch(`${base}/tac/1/hello`);
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code: string }).code, 'unauthorized');
        const c = client();
        const key = fs.readFileSync(path.join(cfg.storeDir, 'local.key'), 'utf8').trim();
        const statusOf = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
            const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: r.status, body: r.status === 204 ? undefined : await r.json() as { code?: string } };
        };
        assert.equal((await statusOf('GET', '/tac/1/groups/none/leases')).status, 404);
        assert.equal((await statusOf('GET', '/tac/1/hello?protocolVersion=tac/2.0')).status, 426);
        assert.equal((await statusOf('GET', '/tac/1/hello', undefined, { 'Tac-Protocol-Version': 'tac/2.1' })).status, 426);
        await c.hello('g', { settings: {} });
        assert.equal((await statusOf('POST', '/tac/1/groups/g/leases', { sessionKey: sk('q'), resources: [], requestId: 'x' })).status, 400);
        const ra = await c.register('g', runtime(['q']));
        await c.acquire('g', { sessionKey: sk('q'), resources: [REPO] });
        const conflict = await statusOf('POST', '/tac/1/groups/g/leases', { sessionKey: sk('other'), resources: [REPO], requestId: 'y' });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body?.code, 'conflict');
        const l = (await c.listLeases('g'))[0];
        assert.equal((await statusOf('POST', `/tac/1/groups/g/leases/${l.leaseId}/renew`, { sessionKey: sk('other') })).status, 403);
        assert.equal((await statusOf('POST', '/tac/1/groups/g/nothing')).status, 404);
        assert.equal((await statusOf('POST', '/tac/1/groups/g/units', {})).status, 400, 'a method not allowed on a path');
        // the stream refuses a wrong key before the handshake
        const ws = new WebSocket(`${base.replace('http', 'ws')}/tac/1/groups/g/stream?runtimeId=${ra.runtimeId}`, ['tac.v1', 'tac.key.wrong']);
        const closed = await new Promise<string>((resolve) => { ws.addEventListener('error', () => resolve('error')); ws.addEventListener('open', () => resolve('open')); });
        assert.equal(closed, 'error');
        // unknown runtime on the stream
        const ws2 = new WebSocket(`${base.replace('http', 'ws')}/tac/1/groups/g/stream?runtimeId=${ulid()}`, ['tac.v1', `tac.key.${key}`]);
        assert.equal(await new Promise<string>((resolve) => { ws2.addEventListener('error', () => resolve('error')); ws2.addEventListener('open', () => resolve('open')); }), 'error');
    } finally {
        await handle.stop();
    }
});

test('HT-4 a restart keeps leases, tokens, commands and units; service.json and local.key are written', async () => {
    const cfg = config('ht4');
    let s = await start(cfg);
    const c = s.client();
    await c.hello('g', { settings: {} });
    const ra = await c.register('g', runtime(['qa']));
    await c.setUnits('g', [{ repository: REPO, path: 'ext' }]);
    const granted = await c.acquire('g', { sessionKey: sk('qa'), resources: [REPO] });
    await c.send('g', { class: 'command', type: 'x', origin: { quest: 'qa', host: 'mbp', runtimeId: ra.runtimeId }, targets: ['qz'], payload: {} });
    const sj = readServiceJson(cfg.storeDir);
    assert.equal(sj?.pid, process.pid);
    assert.equal(sj?.port, s.handle.port);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(cfg.storeDir, 'local.key')).mode & 0o777, 0o600);
    }
    await s.handle.stop();
    assert.equal(readServiceJson(cfg.storeDir), undefined, 'a clean stop removes service.json');
    s = await start(cfg);
    try {
        const c2 = s.client();
        const leases = await c2.listLeases('g');
        assert.equal(leases[0].leaseId, granted.lease.leaseId);
        assert.equal((await c2.listUndelivered('g')).length, 1);
        assert.deepEqual((await c2.listUnits('g')).units, [{ repository: REPO, path: 'ext' }]);
        assert.equal((await c2.adminStatus()).groups instanceof Array, true);
    } finally {
        await s.handle.stop();
    }
});

test('HT-5 a second start finds the first: the port is the lock', async () => {
    const cfg = config('ht5');
    const s = await start(cfg);
    try {
        const second = await startLocalService({ ...cfg, port: s.handle.port });
        assert.deepEqual(second, { status: 'alreadyRunning', port: s.handle.port });
        assert.equal((await s.client().hello()).protocolVersion, 'tac/1.0', 'the first keeps serving');
    } finally {
        await s.handle.stop();
    }
});

test('HT-6 the idle stop: once no stream is open and nothing accessed it, the service persists and stops', async () => {
    const cfg = config('ht6', { idleMinutes: 0.005 }); // 300 ms
    const s = await start(cfg, { idleCheckMs: 50 });
    const c = s.client();
    await c.hello('g', { settings: {} });
    const r = await c.register('g', runtime(['q']));
    const sub = c.subscribe('g', r.runtimeId, {});
    await sub.opened;
    await sleep(600);
    assert.equal((await c.adminStatus()).openStreams, 1, 'an open stream keeps it running');
    sub.close();
    await sub.closed;
    const reason = await Promise.race([s.handle.stopped, sleep(3000).then(() => 'still running')]);
    assert.equal(reason, 'idle');
    assert.ok(fs.existsSync(path.join(cfg.storeDir, 'groups', 'g', 'snapshot.json')), 'a final snapshot was written');
});

test('HT-7 keepRunning skips the idle stop; admin stop ends it', async () => {
    const cfg = config('ht7', { idleMinutes: 0.001, keepRunning: true });
    const s = await start(cfg, { idleCheckMs: 20 });
    await sleep(300);
    const status = await s.client().adminStatus();
    assert.equal(status.keepRunning, true);
    await s.client().adminStop();
    assert.equal(await Promise.race([s.handle.stopped, sleep(3000).then(() => 'still running')]), 'stop');
});

test('HT-8 endpoints and migration over HTTP', async () => {
    const cfg = config('ht8');
    const s = await start(cfg);
    try {
        const c = s.client();
        await c.hello('g', { settings: {} });
        const r = await c.register('g', runtime(['qa']));
        const ep = await c.publish('g', { type: 'remote-control', url: 'tcp+jsonrpc://127.0.0.1:19930', scope: 'loopback', quest: 'qa', host: 'mbp', runtimeId: r.runtimeId, protocol: 'tom-runtime/1' });
        assert.equal((await c.listEndpoints('g', { type: 'remote-control' }))[0].endpointId, ep.endpointId);
        await c.withdraw('g', ep.endpointId);
        assert.equal((await c.listEndpoints('g')).length, 0);
        const exp = await c.exportGroup('g');
        await assert.rejects(c.importGroup(exp), code('conflict'));
        await c.importGroup({ ...exp, group: { ...exp.group, groupId: 'g-copy' } });
        await c.markMigrated('g', { mode: 'server', serverUrl: 'https://coord', groupId: 'g' });
        await assert.rejects(c.hello('g'), code('migrated'));
        assert.ok((await c.hello()).groups.includes('g-copy'));
    } finally {
        await s.handle.stop();
    }
});
