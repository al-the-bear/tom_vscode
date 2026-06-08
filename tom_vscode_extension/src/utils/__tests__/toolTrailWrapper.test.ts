/**
 * Unit tests for `wrapToolWithTrail` (plan §8, todo #8).
 *
 * This is the single executor+trail wrapper both MCP surfaces share — the
 * standalone MCP server (`makeMcpToolCallback`) and the Agent SDK adapter
 * (`buildMcpServer`'s inline tool callback). The wrapper owns the invariant:
 * write a request entry, run `def.execute` inside the ambient tool context,
 * time it, write an answer entry (capturing errors), and shape the
 * `CallToolResult`. The trail destination and execution context are injected,
 * so each surface composes its own behaviour without the wrapper branching.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { wrapToolWithTrail, type ToolTrailSink, type ToolCallRecord } from '../toolTrailWrapper.js';
import { getCurrentToolContext, type ToolExecutionContext } from '../../services/tool-execution-context.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

/** A sink that records every request/answer for assertions. */
function spySink(): ToolTrailSink & {
    requests: Array<{ name: string; input: Record<string, unknown> }>;
    answers: ToolCallRecord[];
} {
    const requests: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answers: ToolCallRecord[] = [];
    return {
        requests,
        answers,
        writeRequest: (name, input) => { requests.push({ name, input }); },
        writeAnswer: (record) => { answers.push(record); },
    };
}

/** Build a minimal tool definition with a custom executor. */
function fakeTool(
    name: string,
    execute: (input: Record<string, unknown>) => Promise<string>,
): SharedToolDefinition {
    return {
        name,
        displayName: name,
        description: `desc-${name}`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        tags: [],
        readOnly: true,
        execute,
    } as SharedToolDefinition;
}

const mcpContext = (): ToolExecutionContext => ({ source: 'mcp', requestId: 'req-1' });

describe('wrapToolWithTrail (todo #8)', () => {
    test('success writes a request then an answer and returns text content', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_echo', async (input) => `echoed:${input.x}`);

        const result = await wrapToolWithTrail(def, sink, mcpContext)({ x: 'hi' });

        assert.equal(sink.requests.length, 1);
        assert.equal(sink.requests[0].name, 'tomAi_echo');
        assert.deepEqual(sink.requests[0].input, { x: 'hi' });

        assert.equal(sink.answers.length, 1);
        assert.equal(sink.answers[0].name, 'tomAi_echo');
        assert.deepEqual(sink.answers[0].input, { x: 'hi' });
        assert.equal(sink.answers[0].result, 'echoed:hi');
        assert.equal(sink.answers[0].error, undefined);
        assert.ok(typeof sink.answers[0].durationMs === 'number' && sink.answers[0].durationMs >= 0);

        assert.equal(result.isError, false);
        assert.deepEqual(result.content, [{ type: 'text', text: 'echoed:hi' }]);
    });

    test('a throwing executor surfaces isError and records the error answer', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_boom', async () => { throw new Error('kaboom'); });

        const result = await wrapToolWithTrail(def, sink, mcpContext)({});

        // The request is still written before the failure.
        assert.equal(sink.requests.length, 1);
        assert.equal(sink.answers.length, 1);
        assert.equal(sink.answers[0].error, 'kaboom');
        assert.equal(sink.answers[0].result, 'Error: kaboom');
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: 'text', text: 'Error: kaboom' }]);
    });

    test('runs the executor inside the injected tool context, then pops it', async () => {
        const sink = spySink();
        let seen: ToolExecutionContext | undefined;
        const def = fakeTool('tomAi_ctx', async () => {
            seen = getCurrentToolContext();
            return 'ok';
        });

        await wrapToolWithTrail(def, sink, () => ({ source: 'anthropic', requestId: 'r-9' }))({});

        assert.equal(seen?.source, 'anthropic');
        assert.equal(seen?.requestId, 'r-9');
        // Context is popped after execution.
        assert.equal(getCurrentToolContext(), undefined);
    });

    test('the context is resolved per call (fresh requestId each invocation)', async () => {
        const sink = spySink();
        const seen: string[] = [];
        let counter = 0;
        const def = fakeTool('tomAi_seq', async () => {
            seen.push(getCurrentToolContext()?.requestId ?? '');
            return 'ok';
        });
        const cb = wrapToolWithTrail(def, sink, () => ({ source: 'mcp', requestId: `mcp-${++counter}` }));

        await cb({});
        await cb({});

        assert.deepEqual(seen, ['mcp-1', 'mcp-2']);
    });

    test('tolerates an undefined args object (defaults input to {})', async () => {
        const sink = spySink();
        const def = fakeTool('tomAi_noargs', async () => 'done');

        const result = await wrapToolWithTrail(def, sink, mcpContext)(undefined);

        assert.deepEqual(sink.requests[0].input, {});
        assert.deepEqual(sink.answers[0].input, {});
        assert.equal(result.isError, false);
    });
});
