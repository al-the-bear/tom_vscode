import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramPollLock } from '../telegramPollLock';

const TOKEN = '123456:ABCDEF-fake-bot-token';

let dir: string;

beforeEach(() => {
    // Keep scratch inside the project (out/utils/__tests__) rather than /tmp.
    dir = fs.mkdtempSync(path.join(__dirname, 'polllock-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A controllable clock so heartbeat/staleness can be tested deterministically. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

test('acquireOrRefresh claims a free token and writes the lock file', () => {
    const c = clock();
    const lock = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    assert.equal(lock.acquireOrRefresh(TOKEN), true);
    assert.equal(fs.readdirSync(dir).length, 1);
});

test('a second process is refused while the owner heartbeat is fresh', () => {
    const c = clock();
    const owner = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    const other = new TelegramPollLock({ dir, now: c.now, pid: 2, staleMs: 10_000 });

    assert.equal(owner.acquireOrRefresh(TOKEN), true);
    assert.equal(other.acquireOrRefresh(TOKEN), false);
    assert.equal(other.isHeldByOther(TOKEN), true);
    assert.equal(owner.isHeldByOther(TOKEN), false);
});

test('a stale lock can be taken over by another process', () => {
    const c = clock();
    const owner = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    const other = new TelegramPollLock({ dir, now: c.now, pid: 2, staleMs: 10_000 });

    assert.equal(owner.acquireOrRefresh(TOKEN), true);
    c.advance(10_001); // owner heartbeat goes stale
    assert.equal(other.isHeldByOther(TOKEN), false);
    assert.equal(other.acquireOrRefresh(TOKEN), true); // takeover
    // Now the original owner is the one refused.
    assert.equal(owner.acquireOrRefresh(TOKEN), false);
});

test('the owner keeps ownership by refreshing its heartbeat', () => {
    const c = clock();
    const owner = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    const other = new TelegramPollLock({ dir, now: c.now, pid: 2, staleMs: 10_000 });

    assert.equal(owner.acquireOrRefresh(TOKEN), true);
    c.advance(8_000);
    assert.equal(owner.acquireOrRefresh(TOKEN), true); // refresh before going stale
    c.advance(8_000); // 16s since first claim, but only 8s since refresh
    assert.equal(other.acquireOrRefresh(TOKEN), false);
});

test('release removes the lock only for the owning process', () => {
    const c = clock();
    const owner = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    const other = new TelegramPollLock({ dir, now: c.now, pid: 2, staleMs: 10_000 });

    assert.equal(owner.acquireOrRefresh(TOKEN), true);
    other.release(TOKEN); // not the owner — no-op
    assert.equal(other.acquireOrRefresh(TOKEN), false);
    owner.release(TOKEN); // owner releases
    assert.equal(other.acquireOrRefresh(TOKEN), true); // now free
});

test('a corrupt lock file is treated as free', () => {
    const c = clock();
    const lock = new TelegramPollLock({ dir, now: c.now, pid: 1, staleMs: 10_000 });
    // Pre-seed a corrupt file at the hashed path by acquiring then clobbering.
    lock.acquireOrRefresh(TOKEN);
    const file = fs.readdirSync(dir)[0];
    fs.writeFileSync(path.join(dir, file), 'not json');
    const other = new TelegramPollLock({ dir, now: c.now, pid: 2, staleMs: 10_000 });
    assert.equal(other.acquireOrRefresh(TOKEN), true);
});
