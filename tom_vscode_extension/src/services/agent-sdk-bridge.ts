/**
 * Agent SDK Bridge — the thin pass-through half of the 1:1 Agent SDK mirror
 * (proposal §7.1, todo #3). Backs the `agentSdk.queryVce` / `agentSdk.cancelVce`
 * bridge methods.
 *
 * It builds `sdk.query({ prompt, options })` directly from the caller's
 * Options (relayed verbatim from the Dart `Options.toJson()`), and streams
 * every `SDKMessage` the SDK produces straight back as `streamId`-keyed
 * `agentSdk.chunk` notifications. A terminal `{ done: true }` chunk marks
 * completion; a `{ error }` chunk marks failure.
 *
 * This is deliberately NOT the convenience `sendToChat` path
 * (`handlers/agent-sdk-transport.ts`): there are no profiles, allow-lists,
 * MCP trail wrapping, or approval gates here. The caller owns the SDK Options
 * directly. Security is not weakened by that — this surface is only reachable
 * over the in-process bridge, and any allow-listing belongs in the extension
 * layer that decides whether to expose it, never in the Dart client.
 *
 * Cancellation is bridge-managed (proposal §7.0.5): the Dart `Options` omits
 * `abortController`; this bridge creates one per `streamId` and supplies it to
 * the SDK, so `cancelQuery` can abort the live query.
 *
 * Dart-defined tools (todo #5): a caller's `options.mcpServers` may carry
 * `{type:'sdk'}` *descriptors* (serialized `McpSdkServerConfig`s). Before
 * starting the query this bridge rebuilds each into a real
 * `sdk.createSdkMcpServer()` whose tool handlers call back into Dart over the
 * #4 reverse RPC (`agentSdk.toolCall`, via the injected `requestClient`) and
 * feed the returned `CallToolResult` into the running query. JSON-Schema tool
 * inputs are converted to Zod raw shapes with the shared `toRawShape`.
 *
 * The module imports neither `vscode` nor the Agent SDK directly — the loader,
 * the notification sink, and the reverse-RPC client are injected — so it is
 * unit-testable under `node --test` (mirroring `agent-sdk-retry.ts`).
 */

import { toRawShape } from '../utils/jsonSchemaToZod';

/** The subset of the Agent SDK this bridge calls. */
export interface AgentSdkLike {
    query(params: {
        prompt: string;
        options?: Record<string, unknown>;
    }): AsyncIterable<unknown>;
    /**
     * Builds an in-process tool definition (`sdk.tool`). Optional because the
     * thin pass-through path only needs it when a caller supplies `{type:'sdk'}`
     * mcp servers; test doubles that never use Dart tools omit it.
     */
    tool?(
        name: string,
        description: string,
        inputSchema: Record<string, unknown>,
        handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
    ): unknown;
    /** Builds an in-process MCP server (`sdk.createSdkMcpServer`). Optional (see `tool`). */
    createSdkMcpServer?(options: { name: string; version?: string; tools?: unknown[] }): unknown;
}

/** The reverse-RPC client used to invoke Dart tool handlers mid-query. */
export type RequestClient = (
    method: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
) => Promise<unknown>;

/** Collaborators injected so the bridge stays `vscode`/SDK-free. */
export interface AgentSdkBridgeDeps {
    /** Lazily loads (and caches) the ESM-only Agent SDK module. */
    loadSdk: () => Promise<AgentSdkLike>;
    /** Emits a JSON-RPC notification back to the Dart client. */
    sendNotification: (method: string, params: Record<string, unknown>) => void;
    /**
     * Issues a server→client request to the Dart client and awaits its reply
     * (the #4 reverse RPC). Required only when a query supplies `{type:'sdk'}`
     * mcp servers; absent it, building such a server fails the query.
     */
    requestClient?: RequestClient;
}

/** The wire method a Dart-defined tool handler is invoked over. */
const TOOL_CALL_METHOD = 'agentSdk.toolCall';

/** A serialized in-process ("sdk") MCP server descriptor (`McpSdkServerConfig`). */
interface SdkServerDescriptor {
    type: 'sdk';
    name?: string;
    version?: string;
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

/** Narrows a wire `mcpServers` entry to an `{type:'sdk'}` descriptor. */
function isSdkServerDescriptor(value: unknown): value is SdkServerDescriptor {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'sdk'
    );
}

/** Parameters of an `agentSdk.queryVce` request. */
export interface AgentSdkStartParams {
    /** Correlates this query's chunks; chosen by the Dart client. */
    streamId: string;
    /** The user prompt (thin pass-through path → always a string). */
    prompt: string;
    /** The serialized SDK `Options` wire JSON, relayed verbatim. */
    options?: Record<string, unknown>;
}

/** The notification method every chunk is sent under. */
const CHUNK_METHOD = 'agentSdk.chunk';

/**
 * Drives streaming Agent SDK queries on behalf of the Dart client.
 *
 * One instance is enough per bridge connection; it tracks the live
 * `AbortController`s keyed by `streamId` so `cancelQuery` can abort them.
 */
export class AgentSdkBridge {
    private readonly deps: AgentSdkBridgeDeps;
    private readonly controllers = new Map<string, AbortController>();

    constructor(deps: AgentSdkBridgeDeps) {
        this.deps = deps;
    }

    /**
     * Start a query. Returns once the query has been *started* — the
     * resulting `SDKMessage`s arrive asynchronously as `agentSdk.chunk`
     * notifications, not as the result of this call.
     */
    async startQuery(params: AgentSdkStartParams): Promise<{ success: true; streamId: string }> {
        const { streamId, prompt } = params;
        const callerOptions = params.options ?? {};

        const abortController = new AbortController();
        this.controllers.set(streamId, abortController);

        const sdk = await this.deps.loadSdk();

        let stream: AsyncIterable<unknown>;
        try {
            // Spread (not mutate) the caller's options so the only addition is
            // the bridge-managed abortController; everything else is passed
            // unchanged — except `{type:'sdk'}` mcp servers, which are rebuilt
            // into real instances whose tools call back into Dart.
            const options: Record<string, unknown> = { ...callerOptions, abortController };
            const mcpServers = options.mcpServers;
            if (mcpServers && typeof mcpServers === 'object') {
                options.mcpServers = this.buildMcpServers(
                    sdk,
                    mcpServers as Record<string, unknown>,
                    { streamId, signal: abortController.signal },
                );
            }
            stream = sdk.query({ prompt, options });
        } catch (err) {
            // A pre-flight build failure surfaces like any stream error: a
            // terminal error chunk, not a rejected start (the start request has
            // already been accepted by the time chunks flow).
            const message = err instanceof Error ? err.message : String(err);
            this.deps.sendNotification(CHUNK_METHOD, { streamId, error: message });
            this.controllers.delete(streamId);
            return { success: true, streamId };
        }

        // Detached pump: forward chunks without blocking the start response.
        void this.pump(streamId, stream);

        return { success: true, streamId };
    }

    /**
     * Rebuild the caller's `mcpServers` map: `{type:'sdk'}` descriptors become
     * real `sdk.createSdkMcpServer()` instances; every other server (stdio /
     * sse / http) is passed through unchanged.
     */
    private buildMcpServers(
        sdk: AgentSdkLike,
        mcpServers: Record<string, unknown>,
        ctx: { streamId: string; signal: AbortSignal },
    ): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(mcpServers)) {
            out[name] = isSdkServerDescriptor(value)
                ? this.buildSdkMcpServer(sdk, name, value, ctx)
                : value;
        }
        return out;
    }

    /**
     * Build one in-process MCP server from its wire [descriptor]. Each tool's
     * handler invokes the Dart handler over the reverse RPC and returns its
     * `CallToolResult` straight into the running query.
     */
    private buildSdkMcpServer(
        sdk: AgentSdkLike,
        serverName: string,
        descriptor: SdkServerDescriptor,
        ctx: { streamId: string; signal: AbortSignal },
    ): unknown {
        if (!sdk.tool || !sdk.createSdkMcpServer) {
            throw new Error(
                `Agent SDK lacks tool()/createSdkMcpServer(); cannot build in-process mcp server '${serverName}'`,
            );
        }
        const requestClient = this.deps.requestClient;
        if (!requestClient) {
            throw new Error(
                `Cannot invoke Dart-defined tools for mcp server '${serverName}': no requestClient (reverse RPC) is configured on this bridge`,
            );
        }
        const tools = (descriptor.tools ?? []).map((t) =>
            sdk.tool!(
                t.name,
                t.description ?? '',
                toRawShape(t.inputSchema ?? {}),
                async (args: Record<string, unknown>) =>
                    requestClient(
                        TOOL_CALL_METHOD,
                        { streamId: ctx.streamId, server: serverName, tool: t.name, args },
                        { signal: ctx.signal },
                    ),
            ),
        );
        return sdk.createSdkMcpServer!({
            name: descriptor.name ?? serverName,
            version: descriptor.version ?? '1.0.0',
            tools,
        });
    }

    /** Abort the query identified by [streamId]. Idempotent. */
    cancelQuery(params: { streamId: string }): { success: true } {
        const controller = this.controllers.get(params.streamId);
        if (controller) {
            controller.abort();
            this.controllers.delete(params.streamId);
        }
        return { success: true };
    }

    /**
     * Relays every `SDKMessage` from [stream] as an `agentSdk.chunk`
     * notification, then a terminal `{ done: true }` — or a `{ error }`
     * chunk if the stream throws.
     */
    private async pump(streamId: string, stream: AsyncIterable<unknown>): Promise<void> {
        try {
            for await (const message of stream) {
                this.deps.sendNotification(CHUNK_METHOD, { streamId, message });
            }
            this.deps.sendNotification(CHUNK_METHOD, { streamId, done: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.sendNotification(CHUNK_METHOD, { streamId, error: message });
        } finally {
            this.controllers.delete(streamId);
        }
    }
}
