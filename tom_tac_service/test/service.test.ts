import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { TacError } from '../src/protocol/errors';
import type { StreamFrame } from '../src/protocol/types';
import { FakeClock, newService, removeDir, runtimeBody, scratchDir, sk } from './helpers';

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

function setup(name: string) {
    const dir = scratchDir(name);
    dirs.push(dir);
    const clock = new FakeClock();
    const ctx = newService(dir, clock);
    ctx.svc.hello({ groupId: 'g1', settings: { autoUpdate: false } });
    return ctx;
}

function code(c: string) {
    return (e: unknown) => e instanceof TacError && e.code === c;
}

const REPO = 'github/al-the-bear/tom_vscode';

test('SV-1 hello: versions, capabilities, creating a group, versionMismatch, notFound', () => {
    const { svc } = setup('sv1');
    const h = svc.hello({ protocolVersion: 'tac/1.3', groupId: 'g1' });
    assert.equal(h.protocolVersion, 'tac/1.0');
    assert.equal(h.formatVersion, 1);
    assert.ok(h.capabilities.includes('messages'));
    assert.equal(h.group?.groupId, 'g1');
    assert.equal(h.group?.customerId, 'local');
    assert.throws(() => svc.hello({ protocolVersion: 'tac/2.0' }), (e: unknown) => e instanceof TacError && e.code === 'versionMismatch'
        && (e.details as Record<string, unknown>).client === 'tac/2.0');
    assert.throws(() => svc.hello({ groupId: 'nope' }), code('notFound'));
    assert.throws(() => svc.hello({ groupId: 'Bad Id', settings: {} }), code('invalid'));
    svc.hello({ groupId: 'g2', settings: {}, customerId: 'acme' });
    assert.deepEqual(svc.hello({}).groups, ['g1', 'g2']);
});

test('SV-2 acquire is all-or-none, names the holders, and tokens only grow', () => {
    const { svc } = setup('sv2');
    const a = sk('qa');
    const b = sk('qb');
    const ra = svc.acquire('g1', { sessionKey: a, resources: [`${REPO}:ext`, 'ai:quests/qa'], requestId: 'r1' });
    assert.equal(ra.lease.state, 'active');
    assert.deepEqual(ra.lease.resources.map((r) => [r.key, r.token]), [['ai:quests/qa', 1], [`${REPO}:ext`, 1]]);
    // b wants a unit inside a's unit plus a free key: refused as a whole
    assert.throws(() => svc.acquire('g1', { sessionKey: b, resources: ['ai:quests/qb', `${REPO}:ext/src`], requestId: 'r2' }), (e: unknown) => {
        if (!(e instanceof TacError) || e.code !== 'conflict') { return false; }
        const h = (e.details!.holders as Record<string, unknown>[])[0];
        return h.key === `${REPO}:ext/src` && h.heldKey === `${REPO}:ext` && h.leaseId === ra.lease.leaseId && h.state === 'active';
    });
    assert.equal(svc.listLeases('g1', { sessionKey: 'qb#default@default/mbp/ws' }).length, 0, 'nothing granted to b');
    // the whole repository conflicts with a's unit too
    assert.throws(() => svc.acquire('g1', { sessionKey: b, resources: [REPO], requestId: 'r3' }), code('conflict'));
    // a releases; b gets it with the next token
    svc.release('g1', ra.lease.leaseId, { sessionKey: a });
    const rb = svc.acquire('g1', { sessionKey: b, resources: [`${REPO}:ext/src`, `${REPO}:ext`], requestId: 'r4' });
    assert.deepEqual(rb.lease.resources.map((r) => [r.key, r.token]), [[`${REPO}:ext`, 2], [`${REPO}:ext/src`, 1]]);
});

test('SV-3 a request id makes a retried acquire answer the same lease; a session adds resources to its one lease', () => {
    const { svc } = setup('sv3');
    const a = sk('qa');
    const first = svc.acquire('g1', { sessionKey: a, resources: [REPO], requestId: 'same' });
    const retry = svc.acquire('g1', { sessionKey: a, resources: [REPO], requestId: 'same' });
    assert.deepEqual(retry, first);
    const more = svc.acquire('g1', { sessionKey: a, resources: ['ai:quests/qa', REPO], hold: 'group', requestId: 'more' });
    assert.equal(more.lease.leaseId, first.lease.leaseId, 'one lease per session');
    assert.equal(more.lease.resources.find((r) => r.key === REPO)!.token, 1, 'a key already held keeps its token');
    assert.ok(more.lease.resources.every((r) => r.hold === 'group'));
    assert.equal(svc.listLeases('g1').length, 1);
});

test('SV-4 lifecycle: stale after 60 minutes, renew brings it back, free ends it and bumps the tokens', () => {
    const { svc, clock } = setup('sv4');
    const a = sk('qa');
    const b = sk('qb');
    const { lease } = svc.acquire('g1', { sessionKey: a, resources: [REPO], requestId: 'x' });
    clock.advance(59);
    assert.equal(svc.listLeases('g1')[0].state, 'active');
    clock.advance(1);
    assert.equal(svc.listLeases('g1')[0].state, 'stale');
    // stale is only shown: nobody takes it over
    assert.throws(() => svc.acquire('g1', { sessionKey: b, resources: [REPO], requestId: 'y' }), (e: unknown) =>
        e instanceof TacError && e.code === 'conflict' && (e.details!.holders as Record<string, unknown>[])[0].state === 'stale');
    assert.equal(svc.checkToken('g1', REPO, 1).current, true, 'a stale holder\'s token is still current');
    const renewed = svc.renew('g1', lease.leaseId, { sessionKey: a });
    assert.equal(renewed.state, 'active');
    assert.equal(Date.parse(renewed.expiresAt) - clock.t, 60 * 60_000);
    assert.throws(() => svc.renew('g1', lease.leaseId, { sessionKey: b }), code('notHolder'));
    clock.advance(61);
    const freed = svc.free('g1', lease.leaseId, { by: 'user' });
    assert.equal(freed.state, 'freed');
    assert.equal(svc.checkToken('g1', REPO, 1).current, false, 'the freed holder finds out at its pre-flight');
    assert.throws(() => svc.renew('g1', lease.leaseId, { sessionKey: a }), code('notHolder'));
    assert.throws(() => svc.release('g1', lease.leaseId, { sessionKey: a }), code('notHolder'));
    const rb = svc.acquire('g1', { sessionKey: b, resources: [REPO], requestId: 'z' });
    assert.equal(rb.lease.resources[0].token, 3, 'free raised nextToken (2 → 3)');
    assert.deepEqual(svc.checkToken('g1', REPO, 3), { current: true, holder: { sessionKey: b, leaseId: rb.lease.leaseId, token: 3 } });
});

test('SV-5 acquire by a session whose lease is stale renews it; partial release keeps the rest', () => {
    const { svc, clock } = setup('sv5');
    const a = sk('qa');
    const { lease } = svc.acquire('g1', { sessionKey: a, resources: [REPO, 'ai:quests/qa'], requestId: '1' });
    clock.advance(90);
    const back = svc.acquire('g1', { sessionKey: a, resources: ['ai:processes/p'], requestId: '2' });
    assert.equal(back.lease.leaseId, lease.leaseId);
    assert.equal(back.lease.state, 'active');
    const partial = svc.release('g1', lease.leaseId, { sessionKey: a, resources: [REPO, 'not/held/key'] });
    assert.equal(partial.state, 'active');
    assert.deepEqual(partial.resources.map((r) => r.key), ['ai:processes/p', 'ai:quests/qa']);
    const all = svc.release('g1', lease.leaseId, { sessionKey: a });
    assert.equal(all.state, 'released');
    assert.equal(svc.release('g1', lease.leaseId, { sessionKey: a }).state, 'released', 'a retried release is a no-op');
});

test('SV-6 a window reload re-attaches the session to its lease, tokens unchanged', () => {
    const { svc } = setup('sv6');
    const r1 = svc.register('g1', runtimeBody(['qa']));
    const a = sk('qa');
    svc.openSession('g1', { sessionKey: a, runtimeId: r1.runtimeId });
    const { lease } = svc.acquire('g1', { sessionKey: a, resources: [REPO], requestId: '1' });
    const r2 = svc.register('g1', runtimeBody(['qa']));
    const s = svc.openSession('g1', { sessionKey: a, runtimeId: r2.runtimeId });
    assert.equal(s.runtimeId, r2.runtimeId);
    const leases = svc.listLeases('g1', { sessionKey: 'qa#default@default/mbp/ws' });
    assert.equal(leases[0].leaseId, lease.leaseId);
    assert.equal(leases[0].resources[0].token, 1);
    const touched = svc.touchSession('g1', 'qa#default@default/mbp/ws', { currentItem: { itemId: 'i1', todoId: 't1' } });
    assert.deepEqual(touched.currentItem, { itemId: 'i1', todoId: 't1' });
    svc.closeSession('g1', 'qa#default@default/mbp/ws');
    assert.equal(svc.listSessions('g1').length, 0);
    assert.equal(svc.listLeases('g1')[0].state, 'active', 'closing a session leaves its lease');
});

test('SV-7 units: shared paths conflict with nothing; infra keys must be declared', () => {
    const { svc } = setup('sv7');
    svc.setUnits('g1', { units: [{ repository: REPO, path: 'ext', shared: ['ext/CHANGELOG.md'] }], infra: [{ name: 'vsix-release' }] });
    assert.deepEqual(svc.listUnits('g1').infra, [{ name: 'vsix-release' }]);
    svc.acquire('g1', { sessionKey: sk('qa'), resources: [`${REPO}:ext`, 'infra:vsix-release'], requestId: '1' });
    svc.acquire('g1', { sessionKey: sk('qb'), resources: [`${REPO}:ext/CHANGELOG.md`], requestId: '2' });
    assert.throws(() => svc.acquire('g1', { sessionKey: sk('qc'), resources: ['infra:pub'], requestId: '3' }), code('invalid'));
    assert.throws(() => svc.acquire('g1', { sessionKey: sk('qc'), resources: ['infra:vsix-release'], requestId: '4' }), code('conflict'));
});

test('SV-8 notifications are live only and skip the origin; commands are stored, the first ack takes them', () => {
    const { svc, store } = setup('sv8');
    const ra = svc.register('g1', runtimeBody(['qa']));
    const rb1 = svc.register('g1', runtimeBody(['qb'], { host: 'mbp' }));
    const rb2 = svc.register('g1', runtimeBody(['qb'], { host: 'bomber' }));
    const got: Record<string, StreamFrame[]> = { a: [], b1: [], b2: [] };
    svc.attachStream('g1', ra.runtimeId, (f) => got.a.push(f));
    svc.attachStream('g1', rb1.runtimeId, (f) => got.b1.push(f));
    const origin = { quest: 'qa', host: 'mbp', runtimeId: ra.runtimeId };
    svc.send('g1', { class: 'notification', type: 'todo_completed', origin, targets: 'all', payload: { v: 1, summary: 's' }, requestId: 'n1' });
    assert.equal(got.a.length, 0, 'not pushed back to its origin');
    assert.equal(got.b1.length, 1);
    assert.equal(store.get('g1')!.commands.size, 0, 'a notification is never stored');
    const { messageId } = svc.send('g1', { class: 'command', type: 'on_done', origin, targets: ['qb'], payload: { v: 1 }, requestId: 'c1' });
    assert.equal(got.b1.filter((f) => f.kind === 'command').length, 1, 'pushed to the connected runtime of qb');
    assert.equal(svc.listUndelivered('g1')[0].deliveries![0].state, 'delivered');
    // rb2 connects later: it gets the open command on connect
    svc.attachStream('g1', rb2.runtimeId, (f) => got.b2.push(f));
    assert.equal(got.b2.filter((f) => f.kind === 'command').length, 1);
    assert.deepEqual(svc.ack('g1', messageId, { runtimeId: rb2.runtimeId, outcome: 'taken' }), { acknowledged: true, by: rb2.runtimeId });
    assert.deepEqual(svc.ack('g1', messageId, { runtimeId: rb1.runtimeId, outcome: 'taken' }), { acknowledged: false, by: rb2.runtimeId });
    assert.equal(svc.listUndelivered('g1').length, 0);
    assert.equal(svc.pendingCommands('g1', rb1.runtimeId).length, 0);
    assert.throws(() => svc.send('g1', { class: 'command', type: 'x', origin, targets: 'all', payload: {}, requestId: 'c2' }), code('invalid'));
});

test('SV-9 a command with no runtime waits, expires after 7 days, can be resent, refused or dropped', () => {
    const { svc, clock } = setup('sv9');
    const ra = svc.register('g1', runtimeBody(['qa']));
    const origin = { quest: 'qa', host: 'mbp', runtimeId: ra.runtimeId };
    const { messageId } = svc.send('g1', { class: 'command', type: 'on_done', origin, targets: ['qz'], payload: {}, requestId: 'c' });
    assert.equal(svc.listUndelivered('g1', { quest: 'qz' })[0].deliveries![0].state, 'pending');
    clock.advance(7 * 24 * 60);
    assert.equal(svc.listUndelivered('g1')[0].deliveries![0].state, 'expired');
    svc.sweep();
    const resent = svc.resend('g1', messageId, {});
    assert.equal(resent.deliveries![0].state, 'pending');
    const rz = svc.register('g1', runtimeBody(['qz']));
    assert.equal(svc.pendingCommands('g1', rz.runtimeId).length, 1, 'a runtime of the quest registering finds it');
    svc.ack('g1', messageId, { runtimeId: rz.runtimeId, outcome: 'refused', reason: 'unknown run' });
    const refused = svc.listUndelivered('g1')[0].deliveries![0];
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.reason, 'unknown run');
    svc.drop('g1', messageId);
    assert.equal(svc.listUndelivered('g1').length, 0);
    assert.throws(() => svc.drop('g1', messageId), code('notFound'));
});

test('SV-10 preferHost: delivered only to that host\'s runtime while one is present; filed acks name their quest', () => {
    const { svc } = setup('sv10');
    const ra = svc.register('g1', runtimeBody(['qa']));
    const mbp = svc.register('g1', runtimeBody(['qb'], { host: 'mbp' }));
    const bomber = svc.register('g1', runtimeBody(['qb'], { host: 'bomber' }));
    const pushed: string[] = [];
    svc.attachStream('g1', mbp.runtimeId, () => pushed.push('mbp'));
    svc.attachStream('g1', bomber.runtimeId, () => pushed.push('bomber'));
    const origin = { quest: 'qa', host: 'mbp', runtimeId: ra.runtimeId };
    svc.send('g1', { class: 'command', type: 't', origin, targets: ['qb'], preferHost: 'bomber', payload: {}, requestId: 'c' });
    assert.deepEqual(pushed, ['bomber']);
    assert.equal(svc.pendingCommands('g1', mbp.runtimeId).length, 0);
    const other = svc.send('g1', { class: 'command', type: 't', origin, targets: ['qx'], payload: {}, requestId: 'c2' });
    assert.throws(() => svc.ack('g1', other.messageId, { runtimeId: ra.runtimeId, outcome: 'filed' }), code('invalid'));
    assert.deepEqual(svc.ack('g1', other.messageId, { runtimeId: ra.runtimeId, outcome: 'filed', quest: 'qx' }), { acknowledged: true, by: ra.runtimeId });
});

test('SV-11 endpoints: numbered per runtime and type; withdrawn when the runtime\'s presence ends', () => {
    const { svc, clock } = setup('sv11');
    const r = svc.register('g1', runtimeBody(['qa']));
    const base = { type: 'mcp', url: 'http://10.8.0.7:19920/', scope: 'vpn' as const, quest: 'qa', host: 'mbp', runtimeId: r.runtimeId };
    const e1 = svc.publish('g1', { ...base, auth: { kind: 'bearer', keyEnv: 'TOM_MCP_KEY' }, requestId: 'p1' });
    const e2 = svc.publish('g1', { ...base, url: 'http://10.8.0.7:19921/', requestId: 'p2' });
    assert.equal(e1.endpointId, `${r.runtimeId}/mcp/1`);
    assert.equal(e2.endpointId, `${r.runtimeId}/mcp/2`);
    assert.deepEqual(svc.publish('g1', { ...base, requestId: 'p1' }), e1, 'a retried publish answers the same endpoint');
    assert.equal(svc.listEndpoints('g1', { type: 'mcp' }).length, 2);
    svc.attachStream('g1', r.runtimeId, () => undefined);
    clock.advance(30);
    assert.equal(svc.listEndpoints('g1').length, 2, 'an open stream is presence');
    svc.detachStream('g1', r.runtimeId);
    clock.advance(1);
    assert.equal(svc.listEndpoints('g1').length, 2, 'within the 2-minute grace');
    clock.advance(2);
    assert.equal(svc.listEndpoints('g1').length, 0);
    svc.sweep();
    assert.equal(svc.listRuntimes('g1').items[0].present, false);
    svc.renewPresence('g1', r.runtimeId, { status: { openQuestions: 2 } });
    assert.equal(svc.listRuntimes('g1').items[0].present, true);
    assert.equal(svc.listRuntimes('g1').items[0].status?.openQuestions, 2);
    assert.equal(svc.listEndpoints('g1').length, 0, 'the sweep withdrew them for good');
});

test('SV-12 migration: export, import keeps the tokens growing, markMigrated answers migrated', () => {
    const src = setup('sv12a');
    const dst = setup('sv12b');
    src.svc.setUnits('g1', { units: [{ repository: REPO, path: 'ext' }] });
    const { lease } = src.svc.acquire('g1', { sessionKey: sk('qa'), resources: [REPO], requestId: '1' });
    src.svc.release('g1', lease.leaseId, { sessionKey: sk('qa') });
    const exp = src.svc.exportGroup('g1');
    assert.equal(exp.tokens[REPO], 2);
    assert.throws(() => dst.svc.importGroup(exp), code('conflict'), 'g1 exists on the target already');
    const renamed = { ...exp, group: { ...exp.group, groupId: 'g9' } };
    dst.svc.importGroup(renamed);
    const again = dst.svc.acquire('g9', { sessionKey: sk('qa'), resources: [REPO], requestId: '1' });
    assert.equal(again.lease.resources[0].token, 2, 'tokens continue, an old one never looks current');
    assert.deepEqual(dst.svc.listUnits('g9').units, [{ repository: REPO, path: 'ext' }]);
    src.svc.markMigrated('g1', { migratedTo: { mode: 'github', repository: 'al-the-bear/tom_coordination', groupId: 'g1' } });
    assert.throws(() => src.svc.hello({ groupId: 'g1' }), code('migrated'));
    assert.throws(() => src.svc.listLeases('g1'), code('migrated'));
});

test('SV-13 the misconfiguration check: one repository under two backends, a group under two backends, a missing clone', () => {
    const { svc } = setup('sv13');
    svc.hello({ groupId: 'g2', settings: {} });
    svc.register('g1', runtimeBody(['qa'], {
        workspace: 'w1', backend: { mode: 'local' }, repositories: [REPO],
        clones: [{ repository: REPO, path: '/w1/tom_vscode' }],
    }));
    svc.register('g2', runtimeBody(['qb'], {
        workspace: 'w2', backend: { mode: 'github', repository: 'o/coord', groupId: 'fleet' }, repositories: [REPO, 'github/o/other'],
        clones: [{ repository: REPO, path: '/w2/tom_vscode' }],
    }));
    svc.register('g2', runtimeBody(['qc'], { workspace: 'w3', backend: { mode: 'server', serverUrl: 'https://x', groupId: 'fleet' }, repositories: [] }));
    const kinds = svc.listRuntimes('g1').warnings.map((w) => w.kind).sort();
    assert.deepEqual(kinds, ['repositoryUnderTwoBackends']);
    const all = svc.misconfigurations().map((w) => w.kind).sort();
    assert.deepEqual(all, ['cloneMissingOrMismatched', 'groupWithTwoBackends', 'repositoryUnderTwoBackends']);
});

test('SV-14 validation: malformed input answers invalid; unknown records notFound', () => {
    const { svc } = setup('sv14');
    assert.throws(() => svc.register('g1', { ...runtimeBody(['q']), runtimeId: 'not-a-ulid' }), code('invalid'));
    assert.throws(() => svc.register('g1', { ...runtimeBody(['q']), hasQuest: false }), code('invalid'));
    assert.ok(svc.register('g1', runtimeBody([], { hasQuest: false, workspace: 'webwork-app' })).hasQuest === false);
    assert.throws(() => svc.acquire('g1', { sessionKey: { quest: 'q' } as never, resources: [REPO], requestId: '1' }), code('invalid'));
    assert.throws(() => svc.acquire('g1', { sessionKey: sk('q'), resources: [], requestId: '1' }), code('invalid'));
    assert.throws(() => svc.acquire('g1', { sessionKey: sk('q'), resources: ['tom_vscode'], requestId: '1' }), code('invalid'));
    assert.throws(() => svc.renew('g1', 'nope', { sessionKey: sk('q') }), code('notFound'));
    assert.throws(() => svc.listLeases('nogroup'), code('notFound'));
    assert.throws(() => svc.send('g1', { class: 'notification', type: 't', origin: { quest: 'q', host: 'h', runtimeId: 'r' }, targets: 'all', payload: { big: 'x'.repeat(2 * 1024 * 1024) }, requestId: 'b' }), code('invalid'));
});
