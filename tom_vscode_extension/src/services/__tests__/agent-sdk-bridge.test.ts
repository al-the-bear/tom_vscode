/**
 * Tests for the Agent SDK bridge — the thin pass-through half of the 1:1
 * Agent SDK mirror (todo #3). Backs the `agentSdk.queryVce` /
 * `agentSdk.cancelVce` bridge methods.
 *
 * Coverage (the todo's TS Done-when):
 *   - startQuery passes the caller's Options to `sdk.query()` UNCHANGED,
 *     adding only the bridge-managed `abortController` (proposal §7.0.5);
 *     the caller's options object is not mutated.
 *   - each SDKMessage is forwarded verbatim as a `streamId`-keyed
 *     `agentSdk.chunk` notification, followed by a terminal `{done:true}`.
 *   - a stream error becomes a terminal `{error}` chunk.
 *   - cancelQuery aborts the underlying SDK query's AbortController.
 *
 * The SDK loader and notification sink are injected, so the module under
 * test imports neither `vscode` nor the real Agent SDK and loads directly
 * under `node --test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { AgentSdkBridge } from '../agent-sdk-bridge.js';
import type { AgentSdkBridgeDeps } from '../agent-sdk-bridge.js';

interface RecordedNotification {
    method: string;
    params: Record<string, unknown>;
}

async function* fromList(items: unknown[]): AsyncIterable<unknown> {
    for (const it of items) {
        yield it;
    }
}

interface Harness {
    bridge: AgentSdkBridge;
    notifications: RecordedNotification[];
    /** Resolves once a terminal (`done` or `error`) chunk is emitted. */
    finished: Promise<void>;
    /** The `{prompt, options}` the mock SDK received. */
    recorded: { params?: { prompt: string; options?: Record<string, unknown> } };
}

function makeHarness(opts: { messages?: unknown[]; throwError?: string }): Harness {
    const notifications: RecordedNotification[] = [];
    const recorded: Harness['recorded'] = {};
    let resolveDone!: () => void;
    const finished = new Promise<void>((res) => {
        resolveDone = res;
    });

    const deps: AgentSdkBridgeDeps = {
        loadSdk: async () => ({
            query(params: { prompt: string; options?: Record<string, unknown> }) {
                recorded.params = params;
                if (opts.throwError !== undefined) {
                    const msg = opts.throwError;
                    return (async function* (): AsyncIterable<unknown> {
                        throw new Error(msg);
                    })();
                }
                return fromList(opts.messages ?? []);
            },
        }),
        sendNotification: (method, params) => {
            notifications.push({ method, params });
            if (params.done === true || params.error !== undefined) {
                resolveDone();
            }
        },
    };

    return { bridge: new AgentSdkBridge(deps), notifications, finished, recorded };
}

describe('AgentSdkBridge.startQuery — options pass-through', () => {
    test('passes caller Options unchanged, adding only abortController', async () => {
        const callerOptions: Record<string, unknown> = {
            model: 'claude-x',
            maxTurns: 3,
            permissionMode: 'default',
            systemPrompt: 'sys',
            settingSources: ['project'],
        };
        const h = makeHarness({ messages: [{ type: 'assistant' }] });

        const res = await h.bridge.startQuery({
            streamId: 's1',
            prompt: 'hello',
            options: callerOptions,
        });
        assert.deepEqual(res, { success: true, streamId: 's1' });
        await h.finished;

        const sent = h.recorded.params;
        assert.ok(sent, 'sdk.query should have been called');
        assert.equal(sent!.prompt, 'hello');
        const opts = sent!.options ?? {};
        assert.equal(opts.model, 'claude-x');
        assert.equal(opts.maxTurns, 3);
        assert.equal(opts.permissionMode, 'default');
        assert.equal(opts.systemPrompt, 'sys');
        assert.deepEqual(opts.settingSources, ['project']);
        assert.ok(opts.abortController instanceof AbortController);

        // The caller's options object must not be mutated.
        assert.equal('abortController' in callerOptions, false);
    });

    test('works with no options (prompt-only)', async () => {
        const h = makeHarness({ messages: [{ type: 'result' }] });
        await h.bridge.startQuery({ streamId: 's2', prompt: 'go' });
        await h.finished;

        const opts = h.recorded.params!.options ?? {};
        assert.ok(opts.abortController instanceof AbortController);
    });
});

describe('AgentSdkBridge.startQuery — chunk forwarding', () => {
    test('forwards each SDKMessage verbatim as a correlated chunk, then done', async () => {
        const messages = [
            { type: 'assistant', session_id: 's', message: { content: [] } },
            { type: 'result', subtype: 'success', result: 'ok' },
        ];
        const h = makeHarness({ messages });

        await h.bridge.startQuery({ streamId: 'abc', prompt: 'go' });
        await h.finished;

        const chunks = h.notifications.filter((n) => n.method === 'agentSdk.chunk');
        assert.equal(chunks.length, 3);
        assert.deepEqual(chunks[0].params, { streamId: 'abc', message: messages[0] });
        assert.deepEqual(chunks[1].params, { streamId: 'abc', message: messages[1] });
        assert.deepEqual(chunks[2].params, { streamId: 'abc', done: true });
    });

    test('surfaces a stream error as a terminal error chunk', async () => {
        const h = makeHarness({ throwError: 'boom' });

        await h.bridge.startQuery({ streamId: 'e1', prompt: 'go' });
        await h.finished;

        const chunks = h.notifications.filter((n) => n.method === 'agentSdk.chunk');
        const last = chunks[chunks.length - 1];
        assert.equal(last.params.streamId, 'e1');
        assert.match(String(last.params.error), /boom/);
        // No spurious `done` chunk after an error.
        assert.equal(chunks.some((c) => c.params.done === true), false);
    });
});

describe('AgentSdkBridge.cancelQuery', () => {
    test('aborts the underlying SDK query AbortController', async () => {
        let capturedSignal: AbortSignal | undefined;
        const deps: AgentSdkBridgeDeps = {
            loadSdk: async () => ({
                query(params: { prompt: string; options?: Record<string, unknown> }) {
                    const controller = params.options?.abortController as AbortController;
                    capturedSignal = controller.signal;
                    return (async function* (): AsyncIterable<unknown> {
                        await new Promise<void>((res) => {
                            if (capturedSignal!.aborted) {
                                res();
                            } else {
                                capturedSignal!.addEventListener('abort', () => res(), { once: true });
                            }
                        });
                    })();
                },
            }),
            sendNotification: () => {},
        };
        const bridge = new AgentSdkBridge(deps);

        await bridge.startQuery({ streamId: 'c1', prompt: 'go' });
        // Let the pump start and the mock capture the signal.
        await new Promise<void>((r) => setImmediate(r));
        assert.ok(capturedSignal, 'abortController should have been passed to sdk.query');
        assert.equal(capturedSignal!.aborted, false);

        const res = bridge.cancelQuery({ streamId: 'c1' });
        assert.deepEqual(res, { success: true });
        assert.equal(capturedSignal!.aborted, true);
    });

    test('cancelling an unknown streamId is a no-op success', () => {
        const bridge = new AgentSdkBridge({ loadSdk: async () => ({ query: () => fromList([]) }), sendNotification: () => {} });
        assert.deepEqual(bridge.cancelQuery({ streamId: 'nope' }), { success: true });
    });
});
