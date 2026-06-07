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

import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';
import { getCurrentToolContext } from '../../services/tool-execution-context.js';
import {
    McpToolTrailSink,
    makeMcpToolCallback,
    buildToolMcpServer,
} from '../../handlers/mcpServer-handler.js';

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

    test('runs the executor inside runWithToolContext (tools can read the source)', async () => {
        const sink = spySink();
        let seenSource: string | undefined;
        const def = fakeTool('tomAi_ctx', async () => {
            seenSource = getCurrentToolContext()?.source;
            return 'ok';
        });

        await makeMcpToolCallback(def, sink)({});

        assert.equal(seenSource, 'anthropic');
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
