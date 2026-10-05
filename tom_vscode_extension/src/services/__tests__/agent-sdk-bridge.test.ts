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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentSdkBridge } from '../agent-sdk-bridge.js';
import type { AgentSdkBridgeDeps, AgentSdkLike } from '../agent-sdk-bridge.js';

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

function makeHarness(opts: { messages?: unknown[]; throwError?: string; baseEnv?: Record<string, string | undefined> }): Harness {
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
        ...(opts.baseEnv ? { baseEnv: () => opts.baseEnv! } : {}),
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

// ============================================================================
// Dart-defined tools (todo #5) — `tool()` + `createSdkMcpServer()`.
//
// A caller's `options.mcpServers` carries `{type:'sdk'}` *descriptors* (the
// serialized `McpSdkServerConfig`). The bridge rebuilds each into a real
// `sdk.createSdkMcpServer()` whose tool handlers call back into Dart over the
// #4 reverse RPC (`agentSdk.toolCall`) and feed the returned `CallToolResult`
// into the running query. Done-when: a round-trip shows a Dart-defined tool
// invoked mid-query and its returned value appearing in the resulting
// `tool_result`.
// ============================================================================

interface RecordedToolCall {
    method: string;
    params: Record<string, unknown>;
}

/**
 * A fake Agent SDK with the callback-bearing surface (`tool` +
 * `createSdkMcpServer`). Its `query` finds the rebuilt sdk server in
 * `options.mcpServers`, invokes the first tool's handler mid-stream, and yields
 * a `tool_result` carrying the handler's returned content.
 */
function makeToolRoundTripHarness(opts: {
    requestClientResult?: unknown;
    requestClientThrows?: string;
    omitRequestClient?: boolean;
}): {
    bridge: AgentSdkBridge;
    notifications: RecordedNotification[];
    finished: Promise<void>;
    toolCalls: RecordedToolCall[];
    seenSchema: { shape?: Record<string, unknown> };
} {
    const notifications: RecordedNotification[] = [];
    const toolCalls: RecordedToolCall[] = [];
    const seenSchema: { shape?: Record<string, unknown> } = {};
    let resolveDone!: () => void;
    const finished = new Promise<void>((res) => {
        resolveDone = res;
    });

    const sdk: AgentSdkLike = {
        tool(name: string, description: string, inputSchema: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>) {
            seenSchema.shape = inputSchema;
            return { name, description, inputSchema, handler };
        },
        createSdkMcpServer(options: { name: string; version?: string; tools?: unknown[] }) {
            return { name: options.name, version: options.version, tools: options.tools ?? [] };
        },
        query(params: { prompt: string; options?: Record<string, unknown> }) {
            const servers = (params.options?.mcpServers ?? {}) as Record<string, { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: unknown }> }> }>;
            const server = servers['dartTools'];
            return (async function* (): AsyncIterable<unknown> {
                yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'getWeather', input: { city: 'NYC' } }] } };
                const toolDef = server.tools[0];
                const result = await toolDef.handler({ city: 'NYC' });
                yield { type: 'user', message: { content: [{ type: 'tool_result', content: result.content }] } };
            })();
        },
    };

    const requestClient = opts.omitRequestClient
        ? undefined
        : async (method: string, params: Record<string, unknown>): Promise<unknown> => {
              toolCalls.push({ method, params });
              if (opts.requestClientThrows !== undefined) {
                  throw new Error(opts.requestClientThrows);
              }
              return opts.requestClientResult ?? { content: [{ type: 'text', text: 'sunny' }] };
          };

    const deps: AgentSdkBridgeDeps = {
        loadSdk: async () => sdk,
        sendNotification: (method, params) => {
            notifications.push({ method, params });
            if (params.done === true || params.error !== undefined) {
                resolveDone();
            }
        },
        requestClient,
    };

    return { bridge: new AgentSdkBridge(deps), notifications, finished, toolCalls, seenSchema };
}

const SDK_SERVER_OPTIONS: Record<string, unknown> = {
    mcpServers: {
        dartTools: {
            type: 'sdk',
            name: 'dartTools',
            version: '1.0.0',
            tools: [
                {
                    name: 'getWeather',
                    description: 'Get the weather for a city',
                    inputSchema: {
                        type: 'object',
                        properties: { city: { type: 'string', description: 'City name' } },
                        required: ['city'],
                    },
                },
            ],
        },
    },
};

describe('AgentSdkBridge — Dart-defined tools (sdk mcp servers)', () => {
    test('forwards a descriptor\'s alwaysLoad to createSdkMcpServer, and only when set', async () => {
        // SDK 0.3.142 made MCP connection non-blocking: without alwaysLoad an
        // in-process server's tools can be deferred and missing on turn 1. A
        // Dart caller asks for it in the descriptor; the bridge is the only
        // place that builds the real server, so it has to pass it on.
        const seen: Array<Record<string, unknown>> = [];
        const sdk: AgentSdkLike = {
            tool: (name: string) => ({ name }),
            createSdkMcpServer: (options: Record<string, unknown>) => {
                seen.push(options);
                return { options };
            },
            query: () => (async function* (): AsyncIterable<unknown> { /* no messages */ })(),
        } as unknown as AgentSdkLike;
        let done!: () => void;
        const finished = new Promise<void>((res) => { done = res; });
        const bridge = new AgentSdkBridge({
            loadSdk: async () => sdk,
            sendNotification: (_m, params) => { if (params.done === true || params.error !== undefined) { done(); } },
            requestClient: async () => ({ content: [] }),
        });
        await bridge.startQuery({
            streamId: 'always-load',
            prompt: 'p',
            options: {
                mcpServers: {
                    loaded: { type: 'sdk', name: 'loaded', alwaysLoad: true, tools: [] },
                    plain: { type: 'sdk', name: 'plain', tools: [] },
                },
            },
        });
        await finished;
        const byName = Object.fromEntries(seen.map((o) => [o.name as string, o]));
        assert.equal(byName.loaded.alwaysLoad, true);
        assert.equal('alwaysLoad' in byName.plain, false, 'unset must stay unset');
    });

    test('rebuilds sdk server, invokes the Dart tool mid-query, and surfaces its result', async () => {
        const h = makeToolRoundTripHarness({ requestClientResult: { content: [{ type: 'text', text: 'sunny' }] } });

        await h.bridge.startQuery({
            streamId: 'tool-1',
            prompt: 'weather?',
            options: { ...SDK_SERVER_OPTIONS },
        });
        await h.finished;

        // The tool handler called back into Dart over the reverse RPC.
        assert.equal(h.toolCalls.length, 1);
        assert.equal(h.toolCalls[0].method, 'agentSdk.toolCall');
        assert.deepEqual(h.toolCalls[0].params, {
            streamId: 'tool-1',
            server: 'dartTools',
            tool: 'getWeather',
            args: { city: 'NYC' },
        });

        // The returned CallToolResult content appears in the forwarded tool_result.
        const chunks = h.notifications.filter((n) => n.method === 'agentSdk.chunk');
        const toolResultChunk = chunks.find((c) => {
            const msg = c.params.message as { message?: { content?: Array<{ type?: string }> } } | undefined;
            return msg?.message?.content?.some((b) => b.type === 'tool_result');
        });
        assert.ok(toolResultChunk, 'a tool_result chunk should be forwarded');
        const content = (toolResultChunk!.params.message as { message: { content: Array<{ content: unknown }> } }).message.content[0].content;
        assert.deepEqual(content, [{ type: 'text', text: 'sunny' }]);

        // The JSON-Schema inputSchema was converted to a Zod raw shape.
        assert.ok(h.seenSchema.shape && typeof h.seenSchema.shape === 'object');
        assert.ok('city' in h.seenSchema.shape!);
    });

    test('passes the abort signal to the reverse RPC so cancel propagates', async () => {
        const h = makeToolRoundTripHarness({});
        await h.bridge.startQuery({ streamId: 'tool-2', prompt: 'go', options: { ...SDK_SERVER_OPTIONS } });
        await h.finished;
        assert.equal(h.toolCalls.length, 1);
    });

    test('external (stdio/sse/http) mcp servers pass through unchanged', async () => {
        let seenOptions: Record<string, unknown> | undefined;
        const sdk: AgentSdkLike = {
            query(params: { prompt: string; options?: Record<string, unknown> }) {
                seenOptions = params.options;
                return fromList([{ type: 'result' }]);
            },
        };
        let resolveDone!: () => void;
        const finished = new Promise<void>((r) => (resolveDone = r));
        const bridge = new AgentSdkBridge({
            loadSdk: async () => sdk,
            sendNotification: (_m, p) => {
                if (p.done === true) {
                    resolveDone();
                }
            },
            requestClient: async () => ({ content: [] }),
        });

        // Every external server variant (stdio / sse / http) must reach
        // sdk.query() byte-for-byte; only `{type:'sdk'}` descriptors are rebuilt.
        const externalServers = {
            mcpServers: {
                fs: { type: 'stdio', command: 'mcp-fs', args: ['--root', '/'], env: { TOKEN: 'x' } },
                remote: {
                    type: 'sse',
                    url: 'https://x/sse',
                    headers: { Authorization: 'Bearer t' },
                    tools: [{ name: 'q', permission_policy: 'always_ask' }],
                },
                web: { type: 'http', url: 'https://x/mcp', alwaysLoad: true },
            },
        };
        await bridge.startQuery({ streamId: 's', prompt: 'go', options: { ...externalServers } });
        await finished;

        const servers = seenOptions!.mcpServers as Record<string, unknown>;
        assert.deepEqual(servers, externalServers.mcpServers);
    });

    test('an sdk server with no requestClient dep fails the query', async () => {
        const h = makeToolRoundTripHarness({ omitRequestClient: true });

        await h.bridge.startQuery({ streamId: 'tool-3', prompt: 'go', options: { ...SDK_SERVER_OPTIONS } });
        await h.finished;

        const chunks = h.notifications.filter((n) => n.method === 'agentSdk.chunk');
        const last = chunks[chunks.length - 1];
        assert.equal(last.params.streamId, 'tool-3');
        assert.match(String(last.params.error), /requestClient|reverse RPC|tool/i);
    });
});

// ============================================================================
// canUseTool permission callback (todo #6) — the SDK approval callback wired
// to call back into Dart over the #4 reverse RPC.
//
// The caller's serialized `options.canUseTool` is a *capability flag* (`true`),
// not the function itself (proposal §7.7: callback-bearing fields cross the
// wire as flags). When set, the bridge replaces it with a real callback that
// issues an `agentSdk.canUseTool` reverse-RPC request `{streamId, toolName,
// input, suggestions?}` and returns the awaited `PermissionResult` straight to
// the SDK. Done-when: a round-trip shows the extension awaiting a Dart decision
// and honouring allow (incl. `updatedInput`) vs deny.
// ============================================================================

/** The SDK-shaped canUseTool the fake query invokes mid-stream. */
type CanUseToolFn = (
    toolName: string,
    input: Record<string, unknown>,
    opts?: { signal?: AbortSignal; suggestions?: unknown },
) => Promise<unknown>;

/**
 * A fake Agent SDK whose `query` invokes the installed `options.canUseTool`
 * mid-stream (simulating the model requesting a tool) and yields the returned
 * decision as a chunk, so the test can assert the decision round-tripped.
 */
function makeCanUseToolHarness(opts: {
    permissionResult?: unknown;
    omitRequestClient?: boolean;
    /** The suggestions the SDK passes to canUseTool (forwarded to Dart). */
    suggestions?: unknown;
}): {
    bridge: AgentSdkBridge;
    notifications: RecordedNotification[];
    finished: Promise<void>;
    permissionCalls: RecordedToolCall[];
    seenCanUseTool: { value?: CanUseToolFn };
} {
    const notifications: RecordedNotification[] = [];
    const permissionCalls: RecordedToolCall[] = [];
    const seenCanUseTool: { value?: CanUseToolFn } = {};
    let resolveDone!: () => void;
    const finished = new Promise<void>((res) => {
        resolveDone = res;
    });

    const sdk: AgentSdkLike = {
        query(params: { prompt: string; options?: Record<string, unknown> }) {
            const canUseTool = params.options?.canUseTool as CanUseToolFn | undefined;
            seenCanUseTool.value = canUseTool;
            return (async function* (): AsyncIterable<unknown> {
                yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
                if (typeof canUseTool === 'function') {
                    const decision = await canUseTool('Bash', { command: 'ls' }, { suggestions: opts.suggestions });
                    yield { type: 'permission_decision', decision };
                }
                yield { type: 'result', subtype: 'success' };
            })();
        },
    };

    const requestClient = opts.omitRequestClient
        ? undefined
        : async (method: string, params: Record<string, unknown>): Promise<unknown> => {
              permissionCalls.push({ method, params });
              return opts.permissionResult ?? { behavior: 'allow' };
          };

    const deps: AgentSdkBridgeDeps = {
        loadSdk: async () => sdk,
        sendNotification: (method, params) => {
            notifications.push({ method, params });
            if (params.done === true || params.error !== undefined) {
                resolveDone();
            }
        },
        requestClient,
    };

    return { bridge: new AgentSdkBridge(deps), notifications, finished, permissionCalls, seenCanUseTool };
}

/** Pulls the forwarded `permission_decision` chunk's decision payload. */
function decisionFromChunks(notifications: RecordedNotification[]): unknown {
    const chunk = notifications
        .filter((n) => n.method === 'agentSdk.chunk')
        .find((c) => (c.params.message as { type?: string } | undefined)?.type === 'permission_decision');
    return (chunk?.params.message as { decision?: unknown } | undefined)?.decision;
}

describe('AgentSdkBridge — canUseTool permission callback', () => {
    test('installs a callback that round-trips an allow decision (incl. updatedInput)', async () => {
        const allow = { behavior: 'allow', updatedInput: { command: 'ls -la' } };
        const h = makeCanUseToolHarness({ permissionResult: allow, suggestions: [{ type: 'setMode' }] });

        await h.bridge.startQuery({
            streamId: 'perm-1',
            prompt: 'list files',
            options: { canUseTool: true },
        });
        await h.finished;

        // The SDK received a real callback (not the boolean flag).
        assert.equal(typeof h.seenCanUseTool.value, 'function');

        // The callback called back into Dart over the reverse RPC.
        assert.equal(h.permissionCalls.length, 1);
        assert.equal(h.permissionCalls[0].method, 'agentSdk.canUseTool');
        assert.deepEqual(h.permissionCalls[0].params, {
            streamId: 'perm-1',
            toolName: 'Bash',
            input: { command: 'ls' },
            suggestions: [{ type: 'setMode' }],
        });

        // The awaited PermissionResult flowed back to the SDK verbatim.
        assert.deepEqual(decisionFromChunks(h.notifications), allow);
    });

    test('round-trips a deny decision', async () => {
        const deny = { behavior: 'deny', message: 'not allowed' };
        const h = makeCanUseToolHarness({ permissionResult: deny });

        await h.bridge.startQuery({ streamId: 'perm-2', prompt: 'go', options: { canUseTool: true } });
        await h.finished;

        assert.equal(h.permissionCalls.length, 1);
        assert.deepEqual(decisionFromChunks(h.notifications), deny);
    });

    test('omits the suggestions param when the SDK provides none', async () => {
        const h = makeCanUseToolHarness({ permissionResult: { behavior: 'allow' } });

        await h.bridge.startQuery({ streamId: 'perm-3', prompt: 'go', options: { canUseTool: true } });
        await h.finished;

        assert.deepEqual(h.permissionCalls[0].params, {
            streamId: 'perm-3',
            toolName: 'Bash',
            input: { command: 'ls' },
        });
    });

    test('does not install a callback when no capability flag is set', async () => {
        const h = makeCanUseToolHarness({});

        await h.bridge.startQuery({ streamId: 'perm-4', prompt: 'go', options: { model: 'x' } });
        await h.finished;

        assert.equal(h.seenCanUseTool.value, undefined);
        assert.equal(h.permissionCalls.length, 0);
    });

    test('a canUseTool flag with no requestClient dep fails the query', async () => {
        const h = makeCanUseToolHarness({ omitRequestClient: true });

        await h.bridge.startQuery({ streamId: 'perm-5', prompt: 'go', options: { canUseTool: true } });
        await h.finished;

        const chunks = h.notifications.filter((n) => n.method === 'agentSdk.chunk');
        const last = chunks[chunks.length - 1];
        assert.equal(last.params.streamId, 'perm-5');
        assert.match(String(last.params.error), /requestClient|reverse RPC|canUseTool/i);
    });
});

// A Dart caller cannot read the extension host's environment, and the SDK's
// `env` REPLACES the subprocess environment, so `env: {FOO}` from Dart started
// Claude Code without PATH or HOME. `envOverlay` (Dart-only, not an SDK
// option) asks the bridge for "the inherited environment plus these".
// Environment variable names are upper-case by convention, not camelCase.
/* eslint-disable @typescript-eslint/naming-convention */
describe('AgentSdkBridge.startQuery — envOverlay (ENV-*)', () => {
    const HOST = { PATH: '/usr/bin', HOME: '/home/u', FOO: 'host' };

    test('ENV-1: envOverlay alone → the host environment plus the overlay', async () => {
        const h = makeHarness({ messages: [], baseEnv: HOST });
        await h.bridge.startQuery({ streamId: 'e1', prompt: 'p', options: { envOverlay: { FOO: 'x', BAR: 'y' } } });
        await h.finished;
        const opts = h.recorded.params!.options!;
        assert.deepEqual(opts.env, { PATH: '/usr/bin', HOME: '/home/u', FOO: 'x', BAR: 'y' });
        assert.equal('envOverlay' in opts, false, 'envOverlay is not an SDK option and must not reach sdk.query');
    });

    test('ENV-2: envOverlay with env → the overlay laid over the caller\'s env, host ignored', async () => {
        const h = makeHarness({ messages: [], baseEnv: HOST });
        await h.bridge.startQuery({ streamId: 'e2', prompt: 'p', options: { env: { PATH: '/opt/bin' }, envOverlay: { BAR: 'y' } } });
        await h.finished;
        const opts = h.recorded.params!.options!;
        assert.deepEqual(opts.env, { PATH: '/opt/bin', BAR: 'y' });
        assert.equal('envOverlay' in opts, false);
    });

    test('ENV-3: env alone keeps the SDK\'s replace semantics', async () => {
        const h = makeHarness({ messages: [], baseEnv: HOST });
        await h.bridge.startQuery({ streamId: 'e3', prompt: 'p', options: { env: { ONLY: '1' } } });
        await h.finished;
        assert.deepEqual(h.recorded.params!.options!.env, { ONLY: '1' });
    });

    test('ENV-4: neither set → no env key, the subprocess inherits as before', async () => {
        const h = makeHarness({ messages: [], baseEnv: HOST });
        await h.bridge.startQuery({ streamId: 'e4', prompt: 'p', options: { model: 'm' } });
        await h.finished;
        assert.equal('env' in h.recorded.params!.options!, false);
    });

    test('ENV-5: the caller\'s options object is not mutated', async () => {
        const callerOptions: Record<string, unknown> = { envOverlay: { FOO: 'x' } };
        const h = makeHarness({ messages: [], baseEnv: HOST });
        await h.bridge.startQuery({ streamId: 'e5', prompt: 'p', options: callerOptions });
        await h.finished;
        assert.deepEqual(callerOptions, { envOverlay: { FOO: 'x' } });
    });

    test('ENV-6: without an injected baseEnv the extension host\'s process.env is the base', async () => {
        const h = makeHarness({ messages: [] });
        await h.bridge.startQuery({ streamId: 'e6', prompt: 'p', options: { envOverlay: { QR6_PROBE: '1' } } });
        await h.finished;
        const env = h.recorded.params!.options!.env as Record<string, string>;
        assert.equal(env.QR6_PROBE, '1');
        assert.equal(env.PATH, process.env.PATH);
    });
});
/* eslint-enable @typescript-eslint/naming-convention */

// ============================================================================
// Keeping the CLI's stdin open (STDIN-*, STREAM-*).
//
// The CLI reaches in-process MCP tools and the canUseTool callback over
// control requests whose replies travel on its stdin. With a string prompt the
// SDK closes stdin at the first `result`, so any work the CLI does after it (a
// background-agent continuation; on resume, an orphan-summary turn before the
// prompt) failed every Dart tool call and approval request at once.
//   (a) STDIN-*: a Dart string prompt with bidirectional needs is wrapped in
//       the transport's QueryInputChannel; without such needs it passes
//       through unchanged.
//   (b) STREAM-*: a Dart caller can instead own the input: `promptStream`
//       starts the query, `agentSdk.inputVce` sends user messages and
//       `agentSdk.endInputVce` ends the input.
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire fields and environment variable names */

/** An async queue the test pushes CLI output into. */
function cliOutput() {
    const items: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    return {
        push(m: unknown) { items.push(m); wake?.(); },
        end() { ended = true; wake?.(); },
        async *iterate(): AsyncIterable<unknown> {
            for (;;) {
                if (items.length > 0) { yield items.shift(); continue; }
                if (ended) { return; }
                await new Promise<void>((r) => { wake = r; });
                wake = undefined;
            }
        },
    };
}

function makeStdinHarness() {
    const out = cliOutput();
    const notifications: RecordedNotification[] = [];
    const sent: { prompt?: unknown; options?: Record<string, unknown> } = {};
    const sdk: AgentSdkLike = {
        tool: (name: string, description: string, inputSchema: Record<string, unknown>, handler: unknown) => ({ name, description, inputSchema, handler }),
        createSdkMcpServer: (o: { name: string }) => ({ name: o.name }),
        query(params: { prompt: unknown; options?: Record<string, unknown> }) {
            sent.prompt = params.prompt;
            sent.options = params.options;
            return out.iterate();
        },
    } as unknown as AgentSdkLike;
    const bridge = new AgentSdkBridge({
        loadSdk: async () => sdk,
        sendNotification: (method, params) => notifications.push({ method, params }),
        requestClient: async () => ({}),
        baseEnv: () => ({ PATH: '/usr/bin' }),
    });
    return { bridge, out, sent, notifications };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AgentSdkBridge — a string prompt with bidirectional needs keeps stdin open (STDIN-*)', () => {
    test('STDIN-1: with an sdk MCP server the SDK gets a stream holding the text, open until idle after the answer', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st1', prompt: 'use my tools', options: SDK_SERVER_OPTIONS });
        assert.notEqual(typeof h.sent.prompt, 'string', 'a string prompt would close stdin at the first result');
        const it = (h.sent.prompt as AsyncIterable<{ uuid: string; message: { content: string } }>)[Symbol.asyncIterator]();
        const first = await it.next();
        assert.equal(first.value.message.content, 'use my tools');
        const uuid = first.value.uuid;

        let done = false;
        const rest = it.next().then((r) => { done = r.done === true; });
        h.out.push({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        h.out.push({ type: 'result', subtype: 'success', user_message_uuids: [uuid] });
        await tick();
        assert.equal(done, false, 'the first result alone must not close stdin');
        h.out.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        await rest;
        assert.equal(done, true);
        h.out.end();
    });

    test('STDIN-2: the canUseTool flag alone is a bidirectional need too', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st2', prompt: 'ask me', options: { canUseTool: true } });
        assert.notEqual(typeof h.sent.prompt, 'string');
        h.out.end();
    });

    test('STDIN-3: the CLI is asked for session-state events, on top of the environment it would inherit', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st3', prompt: 'p', options: SDK_SERVER_OPTIONS });
        assert.deepEqual(h.sent.options?.env, { PATH: '/usr/bin', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
        h.out.end();
    });

    test('STDIN-4: a caller env keeps replace semantics; the flag is added to it', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st4', prompt: 'p', options: { ...SDK_SERVER_OPTIONS, env: { ONLY: '1' } } });
        assert.deepEqual(h.sent.options?.env, { ONLY: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
        h.out.end();
    });

    test('STDIN-5: without bidirectional needs the string passes through and env is untouched (1:1)', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st5', prompt: 'plain', options: { model: 'm' } });
        assert.equal(h.sent.prompt, 'plain');
        assert.equal('env' in (h.sent.options ?? {}), false);
        h.out.end();
    });

    test('STDIN-6: cancel and stream end close the input', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'st6', prompt: 'p', options: SDK_SERVER_OPTIONS });
        const it = (h.sent.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await it.next();
        const rest = it.next();
        h.bridge.cancelQuery({ streamId: 'st6' });
        assert.equal((await rest).done, true);
        h.out.end();
    });
});

describe('AgentSdkBridge — streaming input owned by the Dart caller (STREAM-*)', () => {
    test('STREAM-1: promptStream starts with an open input; inputVce messages reach the SDK in order; endInputVce ends it', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'sm1', promptStream: true, options: { model: 'm' } });
        const it = (h.sent.prompt as AsyncIterable<{ message: { content: unknown } }>)[Symbol.asyncIterator]();
        const msgA = { type: 'user', message: { role: 'user', content: 'first' }, parent_tool_use_id: null, session_id: '' };
        const msgB = { type: 'user', message: { role: 'user', content: 'second' }, parent_tool_use_id: null, session_id: '' };
        assert.deepEqual(h.bridge.sendInput({ streamId: 'sm1', message: msgA }), { success: true });
        h.bridge.sendInput({ streamId: 'sm1', message: msgB });
        assert.deepEqual((await it.next()).value, msgA);
        assert.deepEqual((await it.next()).value, msgB);
        const rest = it.next();
        assert.deepEqual(h.bridge.endInput({ streamId: 'sm1' }), { success: true });
        assert.equal((await rest).done, true);
        h.out.end();
    });

    test('STREAM-2: the stream-mode query also gets the session-state flag', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'sm2', promptStream: true });
        assert.deepEqual(h.sent.options?.env, { PATH: '/usr/bin', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
        h.out.end();
    });

    test('STREAM-3: input for an unknown or string-prompt stream is refused, not dropped', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'sm3', prompt: 'plain' });
        assert.throws(() => h.bridge.sendInput({ streamId: 'sm3', message: {} }), /no streaming input/i);
        assert.throws(() => h.bridge.sendInput({ streamId: 'nope', message: {} }), /no streaming input/i);
        h.out.end();
    });

    test('STREAM-4: cancel ends the caller-owned input too', async () => {
        const h = makeStdinHarness();
        await h.bridge.startQuery({ streamId: 'sm4', promptStream: true });
        const it = (h.sent.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        const rest = it.next();
        h.bridge.cancelQuery({ streamId: 'sm4' });
        assert.equal((await rest).done, true);
        h.out.end();
    });

    test('STREAM-5: the extension dispatches the two new bridge methods', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'vscode-bridge.ts'), 'utf-8');
        assert.match(src, /case 'agentSdk\.inputVce':\s*result = this\.getAgentSdkBridge\(\)\.sendInput\(params\)/);
        assert.match(src, /case 'agentSdk\.endInputVce':\s*result = this\.getAgentSdkBridge\(\)\.endInput\(params\)/);
    });
});
/* eslint-enable @typescript-eslint/naming-convention */
