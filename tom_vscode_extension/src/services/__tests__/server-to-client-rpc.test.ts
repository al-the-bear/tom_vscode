/**
 * Tests for the server→client RPC primitive (todo #4) — the awaited,
 * id-correlated request channel that lets the extension issue a request to a
 * connected Dart client and resolve with the client's reply.
 *
 * Coverage (the todo's Done-when):
 *   - round-trip: request() sends a correlated JSON-RPC request frame and the
 *     promise resolves with the matching response's `result`.
 *   - timeout: a request with no reply rejects after its timeout window.
 *   - cancel: aborting the request's AbortSignal rejects the pending promise
 *     and stops it from later resolving.
 *   - error reply: a response carrying `error` rejects with that error.
 *   - unmatched id: handleResponse for an unknown id returns false and does not
 *     throw (so the caller can fall through to its own response routing).
 *
 * The send sink and timer are injected, so the module under test imports
 * neither `vscode` nor `process` and loads directly under `node --test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { ServerToClientRpc } from '../server-to-client-rpc.js';
import type { ServerToClientRpcDeps } from '../server-to-client-rpc.js';

interface SentFrame {
    jsonrpc: string;
    id: string;
    method: string;
    params?: unknown;
}

interface Harness {
    rpc: ServerToClientRpc;
    sent: SentFrame[];
    /** Manually fire all pending fake timers. */
    fireTimers: () => void;
}

function makeHarness(opts?: { defaultTimeoutMs?: number }): Harness {
    const sent: SentFrame[] = [];
    const timers: Array<() => void> = [];

    const deps: ServerToClientRpcDeps = {
        sendRequest: (frame) => {
            sent.push(frame as unknown as SentFrame);
        },
        defaultTimeoutMs: opts?.defaultTimeoutMs ?? 30000,
        setTimer: (cb) => {
            timers.push(cb);
            return timers.length - 1;
        },
        clearTimer: (handle) => {
            const idx = handle as number;
            if (idx >= 0 && idx < timers.length) {
                timers[idx] = () => {};
            }
        },
    };

    return {
        rpc: new ServerToClientRpc(deps),
        sent,
        fireTimers: () => {
            for (const t of timers) {
                t();
            }
        },
    };
}

describe('ServerToClientRpc.request — round trip', () => {
    test('resolves with the matching response result', async () => {
        const h = makeHarness();
        const p = h.rpc.request<{ ok: boolean }>('client.doThing', { x: 1 });

        assert.equal(h.sent.length, 1);
        const frame = h.sent[0];
        assert.equal(frame.jsonrpc, '2.0');
        assert.equal(frame.method, 'client.doThing');
        assert.deepEqual(frame.params, { x: 1 });
        assert.ok(typeof frame.id === 'string' && frame.id.length > 0);

        const matched = h.rpc.handleResponse({ jsonrpc: '2.0', id: frame.id, result: { ok: true } });
        assert.equal(matched, true);
        assert.deepEqual(await p, { ok: true });
    });

    test('correlates concurrent requests independently', async () => {
        const h = makeHarness();
        const p1 = h.rpc.request<number>('m1');
        const p2 = h.rpc.request<number>('m2');
        const [id1, id2] = h.sent.map((f) => f.id);
        assert.notEqual(id1, id2);

        // Reply out of order.
        h.rpc.handleResponse({ jsonrpc: '2.0', id: id2, result: 2 });
        h.rpc.handleResponse({ jsonrpc: '2.0', id: id1, result: 1 });
        assert.equal(await p1, 1);
        assert.equal(await p2, 2);
    });
});

describe('ServerToClientRpc.request — timeout', () => {
    test('rejects when no reply arrives within the timeout window', async () => {
        const h = makeHarness({ defaultTimeoutMs: 5 });
        const p = h.rpc.request('client.slow');
        h.fireTimers();
        await assert.rejects(p, /timed out/i);
    });

    test('a late reply after timeout is ignored as unmatched', async () => {
        const h = makeHarness({ defaultTimeoutMs: 5 });
        const p = h.rpc.request('client.slow');
        const id = h.sent[0].id;
        h.fireTimers();
        await assert.rejects(p, /timed out/i);
        // The id is gone; a late reply must report unmatched.
        assert.equal(h.rpc.handleResponse({ jsonrpc: '2.0', id, result: 'late' }), false);
    });
});

describe('ServerToClientRpc.request — cancel via AbortSignal', () => {
    test('aborting rejects the pending request', async () => {
        const h = makeHarness();
        const ac = new AbortController();
        const p = h.rpc.request('client.cancelable', undefined, { signal: ac.signal });
        const id = h.sent[0].id;
        ac.abort();
        await assert.rejects(p, /cancel|abort/i);
        // A subsequent reply for the cancelled id is unmatched.
        assert.equal(h.rpc.handleResponse({ jsonrpc: '2.0', id, result: 'x' }), false);
    });

    test('an already-aborted signal rejects immediately without sending', async () => {
        const h = makeHarness();
        const ac = new AbortController();
        ac.abort();
        const p = h.rpc.request('client.dead', undefined, { signal: ac.signal });
        await assert.rejects(p, /cancel|abort/i);
        assert.equal(h.sent.length, 0);
    });
});

describe('ServerToClientRpc.handleResponse — error + unmatched', () => {
    test('rejects with the response error', async () => {
        const h = makeHarness();
        const p = h.rpc.request('client.fails');
        const id = h.sent[0].id;
        h.rpc.handleResponse({ jsonrpc: '2.0', id, error: { code: -1, message: 'nope' } });
        await assert.rejects(p, /nope/);
    });

    test('returns false for an unknown id', () => {
        const h = makeHarness();
        assert.equal(h.rpc.handleResponse({ jsonrpc: '2.0', id: 'never', result: 1 }), false);
    });
});
