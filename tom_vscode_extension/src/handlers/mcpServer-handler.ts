/**
 * Standalone MCP server handler (plan §7, todo #16).
 *
 * Builds a real Model Context Protocol server (`@modelcontextprotocol/sdk`)
 * exposing the extension's shared tool registry to **external** MCP clients
 * (Claude Desktop, other agents/editors), as opposed to the in-SDK MCP server
 * the Agent SDK path builds (`agent-sdk-transport.ts:buildMcpServer`, which uses
 * `createSdkMcpServer` and runs in-process for Anthropic chat).
 *
 * This module owns ONLY the registry → MCP wiring + the per-call trail wrapper.
 * The pieces it deliberately does NOT own (later todos):
 *   - effective-tool-set resolution (auth / read-only floor) → #17
 *   - the Streamable HTTP transport + port probing + bearer auth → #18
 *   - lifecycle (activation / Start-Stop-Restart / disposal) in `extension.ts` → #19
 *
 * Reuse, not duplication:
 *   - the JSON-Schema → Zod converter (`toRawShape`) is the shared util from #15;
 *   - the executor invariant (`runWithToolContext` + `def.execute`) mirrors
 *     `buildMcpServer`. We cannot call `buildMcpServer` itself: it targets the
 *     Agent SDK's `createSdkMcpServer`/`sdk.tool` shape and carries chat-only
 *     state (`toolTrail` round), neither of which apply to an external client.
 *
 * Trail decoupling: the trail target is **injected** (`McpToolTrailSink`) rather
 * than calling `TrailService` directly. `TrailService` is `vscode`-bound and its
 * `TrailSubsystem` union has no `mcp` member yet; introducing one touches
 * `trailService.ts` / `trailSubsystems.ts` (out of #16's file scope). #19 wires
 * the production sink. Injection also keeps this module `vscode`-free and unit-
 * testable under plain `node:test`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { SharedToolDefinition } from '../tools/shared-tool-registry';
import { resolveProfileTools } from '../tools/tool-executors';
import type { ResolvedMcpServerSettings } from '../utils/sendToChatConfig';
import { toRawShape } from '../utils/jsonSchemaToZod';
import { runWithToolContext } from '../services/tool-execution-context';

/** MCP server identity advertised to clients. Matches the Agent SDK path. */
export const MCP_SERVER_NAME = 'tom-ai';
export const MCP_SERVER_VERSION = '1.0.0';

/** One trail "request" entry written before a tool runs. */
export interface McpTrailRequest {
    /** Correlates the request with its answer; includes the tool name. */
    id: string;
    name: string;
    input: Record<string, unknown>;
}

/** One trail "answer" entry written after a tool runs (or fails). */
export interface McpTrailAnswer {
    name: string;
    result: string;
    durationMs: number;
    error?: string;
}

/**
 * Where MCP tool-call trail entries go. Injected so this module stays free of
 * `TrailService` (and the not-yet-existing `{type:'mcp'}` subsystem). #19 backs
 * this with the real `TrailService`.
 */
export interface McpToolTrailSink {
    writeRequest(entry: McpTrailRequest): void;
    writeAnswer(entry: McpTrailAnswer): void;
}

/** A sink that discards everything — handy for tests or trail-less runs. */
export const NULL_MCP_TRAIL_SINK: McpToolTrailSink = {
    writeRequest() { /* no-op */ },
    writeAnswer() { /* no-op */ },
};

/** The callback shape `McpServer.registerTool` invokes for each tool call. */
export type McpToolCallback = (args: Record<string, unknown> | undefined) => Promise<CallToolResult>;

/**
 * Wrap a single tool definition in the trail-writing executor used for every
 * registered MCP tool. Writes a request entry, runs `def.execute` inside the
 * ambient tool context, then writes an answer entry (capturing errors), and
 * returns the result as MCP text content.
 */
export function makeMcpToolCallback(def: SharedToolDefinition, sink: McpToolTrailSink): McpToolCallback {
    return async (args) => {
        const input = (args ?? {}) as Record<string, unknown>;

        sink.writeRequest({ id: `${def.name}-${Date.now()}`, name: def.name, input });

        const start = Date.now();
        let result = '';
        let error: string | undefined;
        try {
            result = await runWithToolContext(
                { source: 'anthropic', requestId: `mcp-${Date.now()}` },
                () => def.execute(input),
            );
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            result = `Error: ${error}`;
        }
        const durationMs = Date.now() - start;

        sink.writeAnswer({ name: def.name, result, durationMs, error });

        return {
            content: [{ type: 'text' as const, text: result }],
            isError: error !== undefined,
        };
    };
}

// ============================================================================
// Effective tool-set resolution (plan §7.4, todo #17)
//
// The MCP server exposes a gated subset of the configured allow-list:
//   - the configured allow-list comes from the MCP picker, resolved with the
//     SAME primitive the chat profiles use (`resolveProfileTools`);
//   - inbound auth + the read-only floor then decide how much of it is exposed.
// Mirrors the Phase-1 seam (`invokeAllowedTool` pure / `invokeToolByName`
// context-bound): the pure pieces take injected doubles; the composition wires
// them to the registry + `process.env`.
// ============================================================================

/**
 * Is the client authenticated? True only when the operator configured an
 * expected token (a non-empty `process.env[apiKeyEnv]`) AND the client
 * presented a bearer that matches it. A missing/empty/wrong bearer — or no
 * configured token at all — is unauthenticated.
 */
export function isMcpAuthenticated(expectedToken: string, bearer: string | undefined): boolean {
    return Boolean(expectedToken) && Boolean(bearer) && bearer === expectedToken;
}

/**
 * Apply the auth + read-only floor to an already-configured allow-list.
 * Authenticated clients (or the explicit `allowWriteWithoutAuth` opt-in) get the
 * full configured set; otherwise the unauthenticated floor keeps only the
 * read-only tools.
 */
export function resolveEffectiveTools(
    configured: SharedToolDefinition[],
    opts: { authenticated: boolean; allowWriteWithoutAuth: boolean },
): SharedToolDefinition[] {
    if (opts.authenticated || opts.allowWriteWithoutAuth) {
        return [...configured];
    }
    return configured.filter((t) => t.readOnly);
}

/**
 * Resolve the effective tool set for an MCP request: the configured allow-list
 * (`resolveProfileTools` over the MCP picker settings) narrowed by the auth +
 * read-only floor. `env` is injectable for tests; it defaults to `process.env`.
 */
export function resolveEffectiveMcpTools(
    settings: ResolvedMcpServerSettings,
    bearer: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): SharedToolDefinition[] {
    const configured = resolveProfileTools({
        toolsEnabled: settings.toolsEnabled,
        enabledTools: settings.enabledTools,
    });
    const expectedToken = settings.apiKeyEnv ? (env[settings.apiKeyEnv] ?? '') : '';
    const authenticated = isMcpAuthenticated(expectedToken, bearer);
    return resolveEffectiveTools(configured, {
        authenticated,
        allowWriteWithoutAuth: settings.allowWriteWithoutAuth,
    });
}

/** A built MCP server plus the names of the tools registered on it. */
export interface BuiltMcpServer {
    server: McpServer;
    toolNames: string[];
}

/**
 * Build an `McpServer` and register every supplied tool with a trail-wrapping
 * executor (see {@link makeMcpToolCallback}). The caller decides the effective
 * tool set (#17) and binds a transport (#18); this only does the registration.
 */
export function buildToolMcpServer(tools: SharedToolDefinition[], sink: McpToolTrailSink): BuiltMcpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    const toolNames: string[] = [];

    for (const def of tools) {
        server.registerTool(
            def.name,
            {
                description: def.description,
                inputSchema: toRawShape(def.inputSchema),
            },
            makeMcpToolCallback(def, sink),
        );
        toolNames.push(def.name);
    }

    return { server, toolNames };
}
