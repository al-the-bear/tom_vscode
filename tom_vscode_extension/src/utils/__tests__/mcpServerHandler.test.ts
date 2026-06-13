/**
 * Tests for the standalone MCP server handler (plan §7, todo #16).
 *
 * #16 builds a real `@modelcontextprotocol/sdk` `McpServer`, registers the
 * effective tool set, and wraps each tool's executor with a trail-writing
 * layer — reusing the `runWithToolContext` + `def.execute` + `toRawShape`
 * primitives that the Agent SDK path's `buildMcpServer` uses, but for an
 * external (non-chat) consumer.
 *
 * "Done when: registered tools execute with trail entries written." The
 * registered tool's behaviour IS the callback produced by `makeMcpToolCallback`,
 * so these tests pin:
 *   1. executing the callback writes a request entry then an answer entry, and
 *      returns the executor's output as MCP text content;
 *   2. the executor runs inside `runWithToolContext` (tools can read the source);
 *   3. a throwing executor produces an error answer entry + `isError` result;
 *   4. `buildToolMcpServer` registers every supplied tool on a real `McpServer`.
 *
 * The trail target is injected (`McpToolTrailSink`) so the handler stays
 * decoupled from `TrailService` and the (not-yet-existing) `{type:'mcp'}` trail
 * subsystem — the production sink is wired in #19. This also keeps the module
 * free of `vscode`, so it runs under plain `node:test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The handler reuses `resolveProfileTools` (todo #17), which lives in
// `tool-executors.ts` and imports `vscode`. Install the shared stub BEFORE
// importing the handler so its transitive `require('vscode')` resolves.
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';
import { ALL_SHARED_TOOLS } from '../../tools/tool-executors.js';
import type { ResolvedMcpServerSettings } from '../sendToChatConfig.js';
import { getCurrentToolContext } from '../../services/tool-execution-context.js';
import {
    McpToolTrailSink,
    McpTrailWriter,
    NULL_MCP_TRAIL_SINK,
    RunningMcpServer,
    BuiltMcpServer,
    makeMcpToolCallback,
    createTrailServiceMcpSink,
    buildToolMcpServer,
    isMcpAuthenticated,
    resolveEffectiveTools,
    resolveEffectiveMcpTools,
    resolveMcpRequestTools,
    extractBearerToken,
    bindFirstFreePort,
    startMcpHttpServer,
    McpServerController,
    setActiveMcpServerController,
    getMcpServerStatus,
} from '../../handlers/mcpServer-handler.js';
import { MCP_SUBSYSTEM } from '../../services/trailSubsystems.js';
import type { TrailSubsystem } from '../../services/trailService.js';
import type { McpServerRuntimeStatus } from '../mcpServerCard.js';

/** A trail sink that records every request/answer for assertions. */
function spySink(): McpToolTrailSink & {
    requests: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    answers: Array<{ name: string; result: string; durationMs: number; error?: string }>;
} {
    const requests: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const answers: Array<{ name: string; result: string; durationMs: number; error?: string }> = [];
    return {
        requests,
        answers,
        writeRequest: (e) => { requests.push(e); },
        writeAnswer: (e) => { answers.push(e); },
    };
}

/** Build a minimal tool definition with a custom executor. */
function fakeTool(
    name: string,
    execute: (input: Record<string, unknown>) => Promise<string>,
    overrides: Partial<SharedToolDefinition> = {},
): SharedToolDefinition {
    return {
        name,
        displayName: name,
        description: `desc-${name}`,
        inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: [] },
        tags: [],
        readOnly: true,
        execute,
        ...overrides,
    };
}

describe('makeMcpToolCallback — trail + execution', () => {
    test('writes a request then an answer entry and returns text content', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_echo', async (input) => `echoed:${input.x}`);
        const cb = makeMcpToolCallback(def, sink);

        const result = await cb({ x: 'hi' });

        assert.equal(sink.requests.length, 1);
        assert.equal(sink.requests[0].name, 'tomAi_echo');
        assert.deepEqual(sink.requests[0].input, { x: 'hi' });
        assert.ok(sink.requests[0].id.includes('tomAi_echo'));

        assert.equal(sink.answers.length, 1);
        assert.equal(sink.answers[0].name, 'tomAi_echo');
        assert.equal(sink.answers[0].result, 'echoed:hi');
        assert.equal(sink.answers[0].error, undefined);
        assert.ok(typeof sink.answers[0].durationMs === 'number');

        assert.equal(result.isError, false);
        assert.deepEqual(result.content, [{ type: 'text', text: 'echoed:hi' }]);
    });

    test('runs the executor inside runWithToolContext with source "mcp" (tools can read the source)', async () => {
        const sink = spySink();
        let seenSource: string | undefined;
        const def = fakeTool('tomAi_ctx', async () => {
            seenSource = getCurrentToolContext()?.source;
            return 'ok';
        });

        await makeMcpToolCallback(def, sink)({});

        // External MCP tool calls are attributable as 'mcp' (todo #3), not the
        // Agent-SDK 'anthropic' source the in-process path uses.
        assert.equal(seenSource, 'mcp');
        // Context is popped after execution.
        assert.equal(getCurrentToolContext(), undefined);
    });

    test('a throwing executor yields an error answer + isError result', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_boom', async () => { throw new Error('kaboom'); });

        const result = await makeMcpToolCallback(def, sink)({});

        assert.equal(sink.answers.length, 1);
        assert.equal(sink.answers[0].error, 'kaboom');
        assert.equal(sink.answers[0].result, 'Error: kaboom');
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: 'text', text: 'Error: kaboom' }]);
    });

    test('tolerates an undefined args object', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_noargs', async () => 'done');

        const result = await makeMcpToolCallback(def, sink)(undefined);

        assert.deepEqual(sink.requests[0].input, {});
        assert.equal(result.isError, false);
    });
});

describe('buildToolMcpServer — registration', () => {
    test('registers every supplied tool and returns their names', () => {
        const sink = spySink();
        const tools = [
            fakeTool('tomAi_a', async () => 'a'),
            fakeTool('tomAi_b', async () => 'b'),
        ];

        const built = buildToolMcpServer(tools, sink);

        assert.deepEqual(built.toolNames.sort(), ['tomAi_a', 'tomAi_b']);
        // The underlying object is a real MCP server exposing connect/close.
        assert.equal(typeof built.server.connect, 'function');
        assert.equal(typeof built.server.close, 'function');
    });

    test('an empty tool set yields a server with no tool names', () => {
        const built = buildToolMcpServer([], spySink());
        assert.deepEqual(built.toolNames, []);
        assert.equal(typeof built.server.connect, 'function');
    });
});

// ---------------------------------------------------------------------------
// Trail-backed sink (todo #3). The production sink forwards each request/answer
// to `TrailService` against the `{type:'mcp'}` subsystem (added in #1), so an
// external MCP tool call produces a real `mcp/` trail request+answer pair. The
// `TrailService` writer is injected so the factory is tested without standing up
// the vscode-bound singleton; extension.ts composes it with the real instance.
// ---------------------------------------------------------------------------

describe('createTrailServiceMcpSink — forwards entries to TrailService', () => {
    /** A TrailService writer double recording every forwarded call. */
    function spyWriter(): McpTrailWriter & {
        requests: Array<{ subsystem: TrailSubsystem; request: object; windowId: string; questId?: string }>;
        answers: Array<{ subsystem: TrailSubsystem; response: object; windowId: string; questId?: string }>;
    } {
        const requests: Array<{ subsystem: TrailSubsystem; request: object; windowId: string; questId?: string }> = [];
        const answers: Array<{ subsystem: TrailSubsystem; response: object; windowId: string; questId?: string }> = [];
        return {
            requests,
            answers,
            writeRawToolRequest: (subsystem, request, windowId, questId) => {
                requests.push({ subsystem, request, windowId, questId });
            },
            writeRawToolAnswer: (subsystem, response, windowId, questId) => {
                answers.push({ subsystem, response, windowId, questId });
            },
        };
    }

    test('writeRequest forwards to writeRawToolRequest with MCP_SUBSYSTEM and threaded ids', () => {
        const writer = spyWriter();
        const sink = createTrailServiceMcpSink('win_abc', 'quest_x', writer);

        const entry = { id: 'tomAi_echo-1', name: 'tomAi_echo', input: { x: 'hi' } };
        sink.writeRequest(entry);

        assert.equal(writer.requests.length, 1);
        assert.deepEqual(writer.requests[0].subsystem, MCP_SUBSYSTEM);
        assert.equal(writer.requests[0].subsystem.type, 'mcp');
        assert.deepEqual(writer.requests[0].request, entry);
        assert.equal(writer.requests[0].windowId, 'win_abc');
        assert.equal(writer.requests[0].questId, 'quest_x');
        assert.equal(writer.answers.length, 0);
    });

    test('writeAnswer forwards to writeRawToolAnswer with MCP_SUBSYSTEM and threaded ids', () => {
        const writer = spyWriter();
        const sink = createTrailServiceMcpSink('win_abc', 'quest_x', writer);

        const entry = { name: 'tomAi_echo', result: 'echoed:hi', durationMs: 3 };
        sink.writeAnswer(entry);

        assert.equal(writer.answers.length, 1);
        assert.deepEqual(writer.answers[0].subsystem, MCP_SUBSYSTEM);
        assert.equal(writer.answers[0].subsystem.type, 'mcp');
        assert.deepEqual(writer.answers[0].response, entry);
        assert.equal(writer.answers[0].windowId, 'win_abc');
        assert.equal(writer.answers[0].questId, 'quest_x');
        assert.equal(writer.requests.length, 0);
    });

    test('a tool call through buildToolMcpServer writes a request+answer pair to the trail', async () => {
        const writer = spyWriter();
        const sink = createTrailServiceMcpSink('win_abc', 'quest_x', writer);
        const echo = fakeTool('tomAi_echo', async (input) => `echoed:${input.x}`);
        const { server } = buildToolMcpServer([echo], sink);
        const client = await connectInMemory(server);

        try {
            await client.callTool({ name: 'tomAi_echo', arguments: { x: 'hi' } });

            assert.equal(writer.requests.length, 1);
            assert.equal((writer.requests[0].request as { name: string }).name, 'tomAi_echo');
            assert.equal(writer.requests[0].subsystem.type, 'mcp');
            assert.equal(writer.answers.length, 1);
            assert.equal((writer.answers[0].response as { result: string }).result, 'echoed:hi');
            assert.equal(writer.answers[0].subsystem.type, 'mcp');
        } finally {
            await client.close();
            await server.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Effective-set resolution (todo #17). The MCP server's exposed tool set is
// gated by inbound auth + the read-only floor:
//   authenticated                       ⇒ configured allow-list (writes too)
//   unauth + allowWriteWithoutAuth=true ⇒ configured allow-list (writes too)
//   unauth + allowWriteWithoutAuth=false⇒ configured ∩ readOnly
//   wrong/absent bearer                 ⇒ treated as unauthenticated
// The pure pieces (`isMcpAuthenticated`, `resolveEffectiveTools`) take injected
// doubles; `resolveEffectiveMcpTools` wires them to `resolveProfileTools` + env.
// ---------------------------------------------------------------------------

describe('isMcpAuthenticated — bearer must match a configured token', () => {
    test('no expected token configured ⇒ never authenticated', () => {
        assert.equal(isMcpAuthenticated('', 'anything'), false);
    });
    test('absent bearer ⇒ unauthenticated', () => {
        assert.equal(isMcpAuthenticated('secret', undefined), false);
        assert.equal(isMcpAuthenticated('secret', ''), false);
    });
    test('wrong bearer ⇒ unauthenticated', () => {
        assert.equal(isMcpAuthenticated('secret', 'nope'), false);
    });
    test('matching bearer ⇒ authenticated', () => {
        assert.equal(isMcpAuthenticated('secret', 'secret'), true);
    });
});

describe('resolveEffectiveTools — auth + read-only floor (injected configured set)', () => {
    const ro = (name: string): SharedToolDefinition => fakeTool(name, async () => 'r', { readOnly: true });
    const rw = (name: string): SharedToolDefinition => fakeTool(name, async () => 'w', { readOnly: false });
    const configured = [ro('read_a'), rw('write_b'), ro('read_c')];
    const names = (list: SharedToolDefinition[]): string[] => list.map((t) => t.name).sort();

    test('authenticated ⇒ full configured set (writes included)', () => {
        const eff = resolveEffectiveTools(configured, { authenticated: true, allowWriteWithoutAuth: false });
        assert.deepEqual(names(eff), ['read_a', 'read_c', 'write_b']);
    });

    // Fourth 2×2 cell (#20): auth ∨ checkbox is an OR, not an XOR — ticking
    // allowWriteWithoutAuth must never *reduce* an authenticated client's set.
    test('authenticated + allowWriteWithoutAuth=true ⇒ full configured set (checkbox is a no-op when authed)', () => {
        const eff = resolveEffectiveTools(configured, { authenticated: true, allowWriteWithoutAuth: true });
        assert.deepEqual(names(eff), ['read_a', 'read_c', 'write_b']);
    });

    test('unauthenticated + allowWriteWithoutAuth=true ⇒ full configured set', () => {
        const eff = resolveEffectiveTools(configured, { authenticated: false, allowWriteWithoutAuth: true });
        assert.deepEqual(names(eff), ['read_a', 'read_c', 'write_b']);
    });

    test('unauthenticated + allowWriteWithoutAuth=false ⇒ configured ∩ readOnly', () => {
        const eff = resolveEffectiveTools(configured, { authenticated: false, allowWriteWithoutAuth: false });
        assert.deepEqual(names(eff), ['read_a', 'read_c']);
    });
});

describe('resolveEffectiveMcpTools — full matrix against the real registry', () => {
    const allCount = ALL_SHARED_TOOLS.length;
    const readOnlyCount = ALL_SHARED_TOOLS.filter((t) => t.readOnly).length;

    // Env vars are conventionally UPPER_CASE; reference the name via a constant
    // and a computed key so the camelCase naming-convention lint rule (which
    // targets literal property names) doesn't flag the fixture.
    const ENV_KEY = 'TOM_MCP_KEY';
    const env = (token?: string): NodeJS.ProcessEnv => (token === undefined ? {} : { [ENV_KEY]: token });

    const settings = (over: Partial<ResolvedMcpServerSettings> = {}): ResolvedMcpServerSettings => ({
        enabled: true,
        host: '0.0.0.0',
        basePort: 19920,
        apiKeyEnv: ENV_KEY,
        allowWriteWithoutAuth: false,
        toolsEnabled: true,
        enabledTools: [],
        ...over,
    });

    test('authenticated (matching bearer) ⇒ all configured tools', () => {
        const eff = resolveEffectiveMcpTools(settings(), 'sekret', env('sekret'));
        assert.equal(eff.length, allCount);
    });

    // Fourth 2×2 cell (#20): a matching bearer AND the checkbox both on — auth
    // already grants the full set, so the checkbox changes nothing.
    test('authenticated + allowWriteWithoutAuth=true ⇒ all configured tools (auth supersedes the checkbox)', () => {
        const eff = resolveEffectiveMcpTools(
            settings({ allowWriteWithoutAuth: true }), 'sekret', env('sekret'),
        );
        assert.equal(eff.length, allCount);
    });

    test('unauthenticated (wrong bearer) ⇒ read-only floor', () => {
        const eff = resolveEffectiveMcpTools(settings(), 'WRONG', env('sekret'));
        assert.ok(eff.every((t) => t.readOnly));
        assert.equal(eff.length, readOnlyCount);
        assert.ok(eff.length < allCount);
    });

    test('unauthenticated + allowWriteWithoutAuth=true ⇒ all configured tools', () => {
        const eff = resolveEffectiveMcpTools(
            settings({ allowWriteWithoutAuth: true }), undefined, env('sekret'),
        );
        assert.equal(eff.length, allCount);
    });

    test('no apiKeyEnv configured ⇒ unauthenticated even with a bearer (read-only floor)', () => {
        const eff = resolveEffectiveMcpTools(settings({ apiKeyEnv: '' }), 'anything', env());
        assert.ok(eff.every((t) => t.readOnly));
        assert.equal(eff.length, readOnlyCount);
    });

    test('apiKeyEnv names a var absent from the environment ⇒ unauthenticated', () => {
        const eff = resolveEffectiveMcpTools(settings(), 'sekret', env());
        assert.ok(eff.every((t) => t.readOnly));
        assert.equal(eff.length, readOnlyCount);
    });

    test('configured allow-list narrows the set before the floor applies', () => {
        const readName = ALL_SHARED_TOOLS.find((t) => t.readOnly)!.name;
        const writeName = ALL_SHARED_TOOLS.find((t) => !t.readOnly)!.name;
        const eff = resolveEffectiveMcpTools(
            settings({ toolsEnabled: false, enabledTools: [readName, writeName] }),
            'WRONG',
            env('sekret'),
        );
        // Unauthenticated floor keeps only the read-only member of the allow-list.
        assert.deepEqual(eff.map((t) => t.name), [readName]);
    });
});

// ---------------------------------------------------------------------------
// Per-request auth-decision logging (todo #4). `resolveMcpRequestTools` composes
// `resolveEffectiveMcpTools` + `isMcpAuthenticated` and logs the access decision
// (authenticated → full set vs read-only floor) WITHOUT ever emitting the token.
// It returns the same tool set the resolver would, so the gate is unchanged.
// ---------------------------------------------------------------------------

describe('resolveMcpRequestTools — logs the auth decision, never the token', () => {
    const ENV_KEY = 'TOM_MCP_KEY';
    const env = (token?: string): NodeJS.ProcessEnv => (token === undefined ? {} : { [ENV_KEY]: token });
    const settings = (over: Partial<ResolvedMcpServerSettings> = {}): ResolvedMcpServerSettings => ({
        enabled: true,
        host: '0.0.0.0',
        basePort: 19920,
        apiKeyEnv: ENV_KEY,
        allowWriteWithoutAuth: false,
        toolsEnabled: true,
        enabledTools: [],
        ...over,
    });

    test('authenticated request logs an "authenticated" decision and returns the full set', () => {
        const logs: string[] = [];
        const eff = resolveMcpRequestTools(settings(), 'sekret', (l) => logs.push(l), env('sekret'));
        assert.equal(eff.length, ALL_SHARED_TOOLS.length);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /authenticated/i);
        assert.doesNotMatch(logs[0], /sekret/);
    });

    test('unauthenticated request logs a "read-only floor" decision, no token leak', () => {
        const logs: string[] = [];
        const eff = resolveMcpRequestTools(settings(), 'WRONG', (l) => logs.push(l), env('sekret'));
        assert.ok(eff.every((t) => t.readOnly));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /read-only floor/i);
        // Neither the presented nor the expected token may appear in the log.
        assert.doesNotMatch(logs[0], /WRONG/);
        assert.doesNotMatch(logs[0], /sekret/);
    });
});

// ---------------------------------------------------------------------------
// Streamable HTTP transport + port probing + bearer auth (todo #18).
//
// The pure pieces are tested directly: `extractBearerToken` (header parsing)
// and `bindFirstFreePort` (probe-upward logic with an injected binder, so the
// base-free / base-busy / all-busy / fatal-error cases are deterministic and
// socket-free). The real `startMcpHttpServer` is then exercised against actual
// loopback sockets to prove the "two windows ⇒ consecutive free ports"
// done-when: a second server started on the first's bound port lands on the
// next port. The full MCP wire round-trip + the vscode toast/card reporting are
// #21/#19 respectively (see completion_steps).
// ---------------------------------------------------------------------------

describe('extractBearerToken — Authorization header parsing', () => {
    test('absent header ⇒ undefined', () => {
        assert.equal(extractBearerToken(undefined), undefined);
        assert.equal(extractBearerToken(''), undefined);
    });
    test('Bearer scheme ⇒ the token', () => {
        assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
    });
    test('scheme match is case-insensitive and tolerates surrounding space', () => {
        assert.equal(extractBearerToken('bearer abc123'), 'abc123');
        assert.equal(extractBearerToken('  Bearer   abc123  '), 'abc123');
    });
    test('non-Bearer scheme ⇒ undefined', () => {
        assert.equal(extractBearerToken('Basic abc123'), undefined);
    });
    test('bare token without a scheme ⇒ undefined', () => {
        assert.equal(extractBearerToken('abc123'), undefined);
    });
});

describe('bindFirstFreePort — probe upward to the first free port', () => {
    /** An EADDRINUSE-shaped error, signalling "try the next port". */
    const inUse = (): NodeJS.ErrnoException => Object.assign(new Error('addr in use'), { code: 'EADDRINUSE' });

    test('base port free ⇒ binds basePort on the first attempt', async () => {
        const attempted: number[] = [];
        const r = await bindFirstFreePort(19920, 100, async (p) => { attempted.push(p); return `srv@${p}`; });
        assert.equal(r.port, 19920);
        assert.equal(r.resource, 'srv@19920');
        assert.deepEqual(attempted, [19920]);
    });

    test('base busy ⇒ probes upward to the next free port', async () => {
        const attempted: number[] = [];
        const r = await bindFirstFreePort(19920, 100, async (p) => {
            attempted.push(p);
            if (p < 19922) { throw inUse(); }
            return `srv@${p}`;
        });
        assert.equal(r.port, 19922);
        assert.deepEqual(attempted, [19920, 19921, 19922]);
    });

    test('all probed ports busy ⇒ rejects after the capped number of attempts', async () => {
        const attempted: number[] = [];
        await assert.rejects(
            bindFirstFreePort(19920, 3, async (p) => { attempted.push(p); throw inUse(); }),
            /no free port/i,
        );
        assert.deepEqual(attempted, [19920, 19921, 19922]);
    });

    test('a non-EADDRINUSE error aborts immediately (no further probing)', async () => {
        const attempted: number[] = [];
        await assert.rejects(
            bindFirstFreePort(19920, 100, async (p) => {
                attempted.push(p);
                throw new Error('EACCES: permission denied');
            }),
            /EACCES/,
        );
        assert.deepEqual(attempted, [19920]);
    });

    test('logs each busy probe and the chosen port (todo #4)', async () => {
        const logs: string[] = [];
        const r = await bindFirstFreePort(
            19920, 100,
            async (p) => { if (p < 19922) { throw inUse(); } return `srv@${p}`; },
            (line) => logs.push(line),
        );
        assert.equal(r.port, 19922);
        // Two busy ports announced, then the bound port.
        assert.ok(logs.some((l) => l.includes('19920') && /in use/i.test(l)));
        assert.ok(logs.some((l) => l.includes('19921') && /in use/i.test(l)));
        assert.ok(logs.some((l) => l.includes('19922') && /bound/i.test(l)));
    });
});

describe('startMcpHttpServer — real loopback binding + consecutive ports', () => {
    test('two servers on the same basePort land on consecutive free ports', async () => {
        const deps = { resolveTools: () => [], sink: NULL_MCP_TRAIL_SINK };
        const first = await startMcpHttpServer({ host: '127.0.0.1', basePort: 19920 }, deps);
        try {
            // A second window probing from the first's bound port must skip it.
            const second = await startMcpHttpServer({ host: '127.0.0.1', basePort: first.port }, deps);
            try {
                assert.equal(second.port, first.port + 1);
                assert.equal(first.host, '127.0.0.1');
                assert.equal(first.url, `http://127.0.0.1:${first.port}`);
            } finally {
                await second.close();
            }
        } finally {
            await first.close();
        }
    });

    test('close() releases the port for a subsequent bind', async () => {
        const deps = { resolveTools: () => [], sink: NULL_MCP_TRAIL_SINK };
        const a = await startMcpHttpServer({ host: '127.0.0.1', basePort: 19940 }, deps);
        const boundPort = a.port;
        await a.close();
        // After close, probing from the same base reclaims the freed port.
        const b = await startMcpHttpServer({ host: '127.0.0.1', basePort: boundPort }, deps);
        try {
            assert.equal(b.port, boundPort);
        } finally {
            await b.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Lifecycle controller (todo #19). The controller is the vscode-free state
// machine that owns the running server: it must never leak a listener (no
// double-bind while running), dispose cleanly, and notify on every state change
// so the extension can push the live bound port to the Status-Page card. The
// vscode wiring (commands, activation, toast, config-change) lives in
// extension.ts and is not unit-testable here; the controller logic IS.
// ---------------------------------------------------------------------------

/** A fake bound server recording how many times it was closed. */
function fakeRunning(port: number): RunningMcpServer & { closed: number } {
    const r = {
        host: '0.0.0.0',
        port,
        url: `http://0.0.0.0:${port}`,
        closed: 0,
        close: async (): Promise<void> => { r.closed += 1; },
    };
    return r;
}

/** Minimal settings object — opaque to the controller (passed to the starter). */
const fakeSettings = {} as ResolvedMcpServerSettings;

describe('McpServerController — lifecycle state machine', () => {
    test('start binds once, exposes the running status, and notifies', async () => {
        const changes: McpServerRuntimeStatus[] = [];
        let calls = 0;
        const srv = fakeRunning(19920);
        const controller = new McpServerController({
            start: async () => { calls += 1; return srv; },
            onChange: (s) => { changes.push(s); },
        });

        const running = await controller.start(fakeSettings);

        assert.equal(calls, 1);
        assert.equal(running, srv);
        assert.equal(controller.isRunning, true);
        assert.deepEqual(controller.status, { running: true, host: '0.0.0.0', port: 19920 });
        assert.equal(changes.length, 1);
        assert.deepEqual(changes[0], { running: true, host: '0.0.0.0', port: 19920 });
    });

    test('starting while already running does not bind a second listener', async () => {
        let calls = 0;
        const controller = new McpServerController({ start: async () => { calls += 1; return fakeRunning(19920 + calls); } });

        const first = await controller.start(fakeSettings);
        const second = await controller.start(fakeSettings);

        assert.equal(calls, 1);
        assert.equal(second, first);
    });

    test('concurrent starts share one bind', async () => {
        let calls = 0;
        const controller = new McpServerController({
            start: async () => { calls += 1; await Promise.resolve(); return fakeRunning(19920); },
        });

        const [a, b] = await Promise.all([controller.start(fakeSettings), controller.start(fakeSettings)]);

        assert.equal(calls, 1);
        assert.equal(a, b);
    });

    test('stop closes the server, clears state, and notifies', async () => {
        const changes: McpServerRuntimeStatus[] = [];
        const srv = fakeRunning(19920);
        const controller = new McpServerController({ start: async () => srv, onChange: (s) => { changes.push(s); } });

        await controller.start(fakeSettings);
        await controller.stop();

        assert.equal(srv.closed, 1);
        assert.equal(controller.isRunning, false);
        assert.deepEqual(controller.status, { running: false });
        assert.deepEqual(changes.at(-1), { running: false });
    });

    test('stop while stopped is a no-op (no close, no notify)', async () => {
        const changes: McpServerRuntimeStatus[] = [];
        const controller = new McpServerController({ start: async () => fakeRunning(1), onChange: (s) => { changes.push(s); } });

        await controller.stop();

        assert.equal(changes.length, 0);
    });

    test('restart closes the old server and binds a fresh one', async () => {
        const servers: Array<RunningMcpServer & { closed: number }> = [];
        let calls = 0;
        const controller = new McpServerController({
            start: async () => { const s = fakeRunning(19920 + calls); calls += 1; servers.push(s); return s; },
        });

        await controller.start(fakeSettings);
        const restarted = await controller.restart(fakeSettings);

        assert.equal(calls, 2);
        assert.equal(servers[0].closed, 1);            // old one closed
        assert.equal(restarted, servers[1]);           // fresh one returned
        assert.equal(controller.status.port, servers[1].port);
    });

    test('dispose stops the running server', async () => {
        const srv = fakeRunning(19920);
        const controller = new McpServerController({ start: async () => srv });

        await controller.start(fakeSettings);
        await controller.dispose();

        assert.equal(srv.closed, 1);
        assert.equal(controller.isRunning, false);
    });

    test('logs "started on <url>" on start and "stopped" on stop (todo #4)', async () => {
        const logs: string[] = [];
        const srv = fakeRunning(19920);
        const controller = new McpServerController({
            start: async () => srv,
            log: (line) => logs.push(line),
        });

        await controller.start(fakeSettings);
        await controller.stop();

        assert.ok(logs.some((l) => l.includes('started') && l.includes(srv.url)));
        assert.ok(logs.some((l) => /stopped/i.test(l)));
    });
});

describe('getMcpServerStatus — module-level accessor for the Status Page', () => {
    test('no active controller ⇒ stopped', () => {
        setActiveMcpServerController(undefined);
        assert.deepEqual(getMcpServerStatus(), { running: false });
    });

    test('reflects the active controller’s live status', async () => {
        const controller = new McpServerController({ start: async () => fakeRunning(19921) });
        setActiveMcpServerController(controller);
        try {
            assert.deepEqual(getMcpServerStatus(), { running: false });
            await controller.start(fakeSettings);
            assert.deepEqual(getMcpServerStatus(), { running: true, host: '0.0.0.0', port: 19921 });
        } finally {
            await controller.dispose();
            setActiveMcpServerController(undefined);
        }
    });
});

// ---------------------------------------------------------------------------
// Wire round-trip (todo #21). The per-callback trail/execution is pinned above;
// this proves the SAME behaviour survives a real MCP protocol exchange. A linked
// in-memory transport pair (no socket) connects a real `Client` to the server
// built by `buildToolMcpServer`, so `tools/list` advertises the registered
// tools and `tools/call` runs the wrapped executor end-to-end — asserting the
// injected trail sink records request + answer across the wire.
// ---------------------------------------------------------------------------

/** Connect a real Client to the server over a linked in-memory transport pair. */
async function connectInMemory(server: BuiltMcpServer['server']): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'mcp-roundtrip-test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
}

describe('MCP wire round-trip — tools/list + tools/call through a fake transport', () => {
    test('tools/list advertises the tool; tools/call runs it and writes trail', async () => {
        const sink = spySink();
        const echo = fakeTool('tomAi_echo', async (input) => `echoed:${input.x}`);
        const { server } = buildToolMcpServer([echo], sink);
        const client = await connectInMemory(server);

        try {
            const listed = await client.listTools();
            assert.deepEqual(listed.tools.map((t) => t.name), ['tomAi_echo']);
            assert.equal(listed.tools[0].description, 'desc-tomAi_echo');

            const result = await client.callTool({ name: 'tomAi_echo', arguments: { x: 'hi' } });
            assert.notEqual(result.isError, true);
            assert.deepEqual(result.content, [{ type: 'text', text: 'echoed:hi' }]);

            // The trail wrapper fired across the wire, not just on a direct callback.
            assert.equal(sink.requests.length, 1);
            assert.equal(sink.requests[0].name, 'tomAi_echo');
            assert.deepEqual(sink.requests[0].input, { x: 'hi' });
            assert.equal(sink.answers.length, 1);
            assert.equal(sink.answers[0].result, 'echoed:hi');
            assert.equal(sink.answers[0].error, undefined);
        } finally {
            await client.close();
            await server.close();
        }
    });

    test('a throwing tool surfaces isError over the wire and records an error answer', async () => {
        const sink = spySink();
        const boom = fakeTool('tomAi_boom', async () => { throw new Error('kaboom'); });
        const { server } = buildToolMcpServer([boom], sink);
        const client = await connectInMemory(server);

        try {
            const result = await client.callTool({ name: 'tomAi_boom', arguments: {} });
            assert.equal(result.isError, true);
            assert.deepEqual(result.content, [{ type: 'text', text: 'Error: kaboom' }]);
            assert.equal(sink.answers.length, 1);
            assert.equal(sink.answers[0].error, 'kaboom');
        } finally {
            await client.close();
            await server.close();
        }
    });
});
