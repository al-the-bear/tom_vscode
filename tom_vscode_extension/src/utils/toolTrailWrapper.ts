/**
 * Shared executor + trail wrapper for both MCP surfaces (plan §8, todo #8).
 *
 * Two surfaces register the extension's shared tools against a Model Context
 * Protocol server:
 *   - the standalone MCP server (`mcpServer-handler.ts:makeMcpToolCallback`),
 *     exposed over Streamable HTTP to external clients;
 *   - the in-SDK MCP server (`agent-sdk-transport.ts:buildMcpServer`), used by
 *     the Anthropic Agent SDK path in-process.
 *
 * Both wrap every tool in the SAME invariant: write a request entry, run
 * `def.execute` inside the ambient tool context, time it, write an answer entry
 * (capturing errors), and shape the `CallToolResult`. Previously each surface
 * carried its own copy of that try/execute/trail block; this is the single
 * implementation both delegate to.
 *
 * The two things that legitimately differ between the surfaces are injected, so
 * the wrapper itself never branches:
 *   - the trail destination (`ToolTrailSink`) — the standalone server forwards
 *     to `TrailService` under the `mcp` subsystem; the Agent SDK path forwards
 *     to `TrailService` under the anthropic subsystem AND decorates the chat
 *     `toolTrail`;
 *   - the execution context (`resolveContext`) — `{source:'mcp'}` vs
 *     `{source:'anthropic', requestId}` — resolved per call so each invocation
 *     gets fresh values (e.g. a new request id).
 *
 * `vscode`-free by design, so it lives under `src/utils/` and is covered by the
 * `out/utils/__tests__/*.test.js` glob.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { SharedToolDefinition } from '../tools/shared-tool-registry';
import { runWithToolContext, type ToolExecutionContext } from '../services/tool-execution-context';

/** The callback shape an MCP server's `registerTool` / `tool` invokes per call. */
export type McpToolCallback = (args: Record<string, unknown> | undefined) => Promise<CallToolResult>;

/** One completed tool call, handed to a sink's `writeAnswer`. */
export interface ToolCallRecord {
    name: string;
    input: Record<string, unknown>;
    result: string;
    durationMs: number;
    error?: string;
}

/**
 * Where a wrapped tool's trail entries go. Injected so the wrapper stays free of
 * any concrete trail/transport. Each surface adapts its own destination(s) to
 * this shape (e.g. composing a `TrailService` write with a `toolTrail.add`).
 */
export interface ToolTrailSink {
    writeRequest(name: string, input: Record<string, unknown>): void;
    writeAnswer(record: ToolCallRecord): void;
}

/**
 * Wrap `def` in the shared executor + trail invariant.
 *
 * @param def            the tool to run
 * @param sink           trail destination (request before, answer after)
 * @param resolveContext per-call ambient context (source + optional requestId)
 */
export function wrapToolWithTrail(
    def: SharedToolDefinition,
    sink: ToolTrailSink,
    resolveContext: () => ToolExecutionContext,
): McpToolCallback {
    return async (args) => {
        const input = (args ?? {}) as Record<string, unknown>;

        sink.writeRequest(def.name, input);

        const start = Date.now();
        let result = '';
        let error: string | undefined;
        try {
            result = await runWithToolContext(resolveContext(), () => def.execute(input));
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            result = `Error: ${error}`;
        }
        const durationMs = Date.now() - start;

        sink.writeAnswer({ name: def.name, input, result, durationMs, error });

        return {
            content: [{ type: 'text' as const, text: result }],
            isError: error !== undefined,
        };
    };
}
