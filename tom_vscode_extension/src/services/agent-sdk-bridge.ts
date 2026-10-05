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
import {
    QueryInputChannel,
    describeInputChannelEvent,
    outputFileSize,
    SESSION_STATE_EVENTS_ENV,
} from './agent-sdk-input-channel';

/** The subset of the Agent SDK this bridge calls. */
export interface AgentSdkLike {
    query(params: {
        prompt: string | AsyncIterable<unknown>;
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
    createSdkMcpServer?(options: { name: string; version?: string; tools?: unknown[]; alwaysLoad?: boolean }): unknown;
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
    /**
     * The environment `envOverlay` is laid over when the caller gives no `env`.
     * Defaults to this extension host's `process.env`; injectable for tests.
     */
    baseEnv?: () => Record<string, string | undefined>;
    /** Diagnostics sink (the Tom Tool Log in production). Optional. */
    log?: (line: string) => void;
}

/**
 * The Dart-only option asking for "the inherited environment plus these".
 * Not an SDK option: the bridge resolves it into `env` and removes it.
 */
const ENV_OVERLAY_KEY = 'envOverlay';

/** The wire method a Dart-defined tool handler is invoked over. */
const TOOL_CALL_METHOD = 'agentSdk.toolCall';

/** The wire method the Dart `canUseTool` approval callback is invoked over. */
const CAN_USE_TOOL_METHOD = 'agentSdk.canUseTool';

/**
 * The SDK-shaped `canUseTool` callback the bridge installs in place of the
 * caller's capability flag. Returns the awaited `PermissionResult` JSON.
 */
type CanUseToolCallback = (
    toolName: string,
    input: Record<string, unknown>,
    opts?: { signal?: AbortSignal; suggestions?: unknown },
) => Promise<unknown>;

/** A serialized in-process ("sdk") MCP server descriptor (`McpSdkServerConfig`). */
interface SdkServerDescriptor {
    type: 'sdk';
    name?: string;
    version?: string;
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    /** SDK 0.3.142+: keep the tools in the prompt and connect before turn 1. */
    alwaysLoad?: boolean;
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
    /** The user prompt. Absent when {@link promptStream} is set. */
    prompt?: string;
    /**
     * The caller owns the input: user messages arrive as `agentSdk.inputVce`
     * and the input ends with `agentSdk.endInputVce` (the SDK's streaming-input
     * mode, `prompt: AsyncIterable<SDKUserMessage>`).
     */
    promptStream?: boolean;
    /** The serialized SDK `Options` wire JSON, relayed verbatim. */
    options?: Record<string, unknown>;
}

/**
 * The input a Dart caller feeds through `agentSdk.inputVce`: an async
 * iterable the SDK reads its user messages from, open until {@link end}.
 */
class CallerInput {
    private readonly pending: unknown[] = [];
    private wake: (() => void) | undefined;
    private ended = false;

    push(message: unknown): void {
        this.pending.push(message);
        this.wake?.();
    }

    end(): void {
        this.ended = true;
        this.wake?.();
    }

    async *messages(): AsyncGenerator<unknown, void, unknown> {
        for (;;) {
            if (this.pending.length > 0) {
                yield this.pending.shift();
                continue;
            }
            if (this.ended) { return; }
            await new Promise<void>((resolve) => { this.wake = resolve; });
            this.wake = undefined;
        }
    }
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
    /** Bridge-managed input for a string prompt with bidirectional needs. */
    private readonly channels = new Map<string, QueryInputChannel>();
    /** Caller-owned input (`promptStream`), fed by `agentSdk.inputVce`. */
    private readonly callerInputs = new Map<string, CallerInput>();

    constructor(deps: AgentSdkBridgeDeps) {
        this.deps = deps;
    }

    /**
     * Start a query. Returns once the query has been *started* — the
     * resulting `SDKMessage`s arrive asynchronously as `agentSdk.chunk`
     * notifications, not as the result of this call.
     */
    async startQuery(params: AgentSdkStartParams): Promise<{ success: true; streamId: string }> {
        const { streamId } = params;
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
            this.resolveEnvOverlay(options);
            const mcpServers = options.mcpServers;
            if (mcpServers && typeof mcpServers === 'object') {
                options.mcpServers = this.buildMcpServers(
                    sdk,
                    mcpServers as Record<string, unknown>,
                    { streamId, signal: abortController.signal },
                );
            }
            // A `canUseTool` capability flag (proposal §7.7) means the caller
            // wants the SDK's approval callback routed back into Dart. Replace
            // the flag with a real callback that issues an `agentSdk.canUseTool`
            // reverse-RPC request and returns the awaited PermissionResult.
            const bidirectional = Boolean(options.canUseTool) || this.hasSdkServer(callerOptions.mcpServers);
            if (options.canUseTool) {
                options.canUseTool = this.buildCanUseTool(streamId, abortController.signal);
            }
            stream = sdk.query({ prompt: this.buildPrompt(streamId, params, bidirectional, options), options });
        } catch (err) {
            // A pre-flight build failure surfaces like any stream error: a
            // terminal error chunk, not a rejected start (the start request has
            // already been accepted by the time chunks flow).
            const message = err instanceof Error ? err.message : String(err);
            this.deps.sendNotification(CHUNK_METHOD, { streamId, error: message });
            this.controllers.delete(streamId);
            this.closeInput(streamId, 'start-failed');
            return { success: true, streamId };
        }

        // Detached pump: forward chunks without blocking the start response.
        void this.pump(streamId, stream);

        return { success: true, streamId };
    }

    /**
     * The prompt `sdk.query` receives.
     *
     * The CLI reaches in-process MCP tools and the `canUseTool` callback over
     * control requests whose replies travel on its stdin, and with a string
     * prompt the SDK closes stdin at the first `result`. Work the CLI does
     * after that (a background-agent continuation, a background Bash's
     * follow-up turn, or on resume an orphan-summary turn run before the
     * prompt) then fails every Dart tool call and approval request at once.
     *
     * - `promptStream`: the caller owns the input ({@link sendInput} /
     *   {@link endInput}).
     * - a string prompt with such bidirectional needs: wrapped in the
     *   transport's {@link QueryInputChannel}, which keeps stdin open until
     *   the CLI is idle after answering it. The one place the bridge departs
     *   from passing the caller's request through 1:1.
     * - otherwise: the string, unchanged.
     *
     * The first two ask the CLI for `session_state_changed` events, which the
     * channel needs and a stream-mode caller can use the same way.
     */
    private buildPrompt(
        streamId: string,
        params: AgentSdkStartParams,
        bidirectional: boolean,
        options: Record<string, unknown>,
    ): string | AsyncIterable<unknown> {
        if (params.promptStream === true) {
            const input = new CallerInput();
            this.callerInputs.set(streamId, input);
            this.requestSessionStateEvents(options);
            return input.messages();
        }
        const prompt = params.prompt ?? '';
        if (!bidirectional) { return prompt; }
        const log = this.deps.log;
        const channel = new QueryInputChannel(prompt, {
            progressOf: outputFileSize,
            onEvent: (event) => log?.(`[agent-sdk-bridge] ${describeInputChannelEvent(event)} (stream ${streamId})`),
            onClose: (reason) => log?.(`[agent-sdk-bridge] input closed (${reason}) for stream ${streamId}`),
        });
        this.channels.set(streamId, channel);
        this.requestSessionStateEvents(options);
        return channel.messages();
    }

    /** Adds the session-state flag on top of the environment the CLI would get. */
    private requestSessionStateEvents(options: Record<string, unknown>): void {
        const callerEnv = options.env;
        const base = callerEnv && typeof callerEnv === 'object'
            ? (callerEnv as Record<string, string | undefined>)
            : (this.deps.baseEnv ?? (() => process.env))();
        options.env = { ...base, [SESSION_STATE_EVENTS_ENV]: '1' };
    }

    private hasSdkServer(mcpServers: unknown): boolean {
        if (!mcpServers || typeof mcpServers !== 'object') { return false; }
        return Object.values(mcpServers as Record<string, unknown>).some((s) => isSdkServerDescriptor(s));
    }

    /**
     * Sends one user message into a `promptStream` query
     * (`agentSdk.inputVce`). Refused for any other stream, so a message is
     * never silently dropped.
     */
    sendInput(params: { streamId: string; message: unknown }): { success: true } {
        const input = this.callerInputs.get(params.streamId);
        if (!input) {
            throw new Error(`No streaming input for stream "${params.streamId}": start it with promptStream: true`);
        }
        input.push(params.message);
        return { success: true };
    }

    /** Ends a `promptStream` query's input (`agentSdk.endInputVce`). */
    endInput(params: { streamId: string }): { success: true } {
        const input = this.callerInputs.get(params.streamId);
        if (!input) {
            throw new Error(`No streaming input for stream "${params.streamId}": start it with promptStream: true`);
        }
        input.end();
        this.callerInputs.delete(params.streamId);
        return { success: true };
    }

    private closeInput(streamId: string, reason: string): void {
        this.channels.get(streamId)?.close(reason);
        this.channels.delete(streamId);
        this.callerInputs.get(streamId)?.end();
        this.callerInputs.delete(streamId);
    }

    /**
     * Resolve the Dart-only `envOverlay` into the SDK's `env`.
     *
     * The SDK's `env` REPLACES the Claude Code subprocess's environment, and a
     * TypeScript caller adds a variable by spreading `process.env` itself. A
     * Dart caller cannot: the subprocess is spawned here, in the extension
     * host, whose environment the Dart process cannot read. So the overlay is
     * laid over the caller's `env` when one is given (keeping its replace
     * semantics), else over the extension host's environment. `env` alone is
     * passed through unchanged.
     */
    private resolveEnvOverlay(options: Record<string, unknown>): void {
        if (!(ENV_OVERLAY_KEY in options)) { return; }
        const overlay = options[ENV_OVERLAY_KEY];
        delete options[ENV_OVERLAY_KEY];
        if (!overlay || typeof overlay !== 'object') { return; }
        const callerEnv = options.env;
        const base = callerEnv && typeof callerEnv === 'object'
            ? (callerEnv as Record<string, string | undefined>)
            : (this.deps.baseEnv ?? (() => process.env))();
        options.env = { ...base, ...(overlay as Record<string, string>) };
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
        // `alwaysLoad` is passed only when the descriptor sets it, so a
        // descriptor without it builds exactly the server it always did.
        return sdk.createSdkMcpServer!({
            name: descriptor.name ?? serverName,
            version: descriptor.version ?? '1.0.0',
            tools,
            ...(typeof descriptor.alwaysLoad === 'boolean' ? { alwaysLoad: descriptor.alwaysLoad } : {}),
        });
    }

    /**
     * Build the SDK `canUseTool` callback for a query. Each invocation issues an
     * `agentSdk.canUseTool` request over the reverse RPC and returns the awaited
     * `PermissionResult` straight to the SDK, so the Dart client owns the
     * allow/deny decision (incl. `updatedInput`).
     */
    private buildCanUseTool(streamId: string, signal: AbortSignal): CanUseToolCallback {
        const requestClient = this.deps.requestClient;
        if (!requestClient) {
            throw new Error(
                `Cannot honour canUseTool: no requestClient (reverse RPC) is configured on this bridge`,
            );
        }
        return async (toolName, input, opts) => {
            const params: Record<string, unknown> = { streamId, toolName, input };
            // Forward the SDK's permission suggestions so the Dart callback's
            // `context.suggestions` resolves; omit when absent.
            if (opts && opts.suggestions !== undefined) {
                params.suggestions = opts.suggestions;
            }
            return requestClient(CAN_USE_TOOL_METHOD, params, { signal });
        };
    }

    /** Abort the query identified by [streamId]. Idempotent. */
    cancelQuery(params: { streamId: string }): { success: true } {
        const controller = this.controllers.get(params.streamId);
        if (controller) {
            controller.abort();
            this.controllers.delete(params.streamId);
        }
        this.closeInput(params.streamId, 'cancelled');
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
                this.channels.get(streamId)?.observe(message);
                this.deps.sendNotification(CHUNK_METHOD, { streamId, message });
            }
            this.deps.sendNotification(CHUNK_METHOD, { streamId, done: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.sendNotification(CHUNK_METHOD, { streamId, error: message });
        } finally {
            this.controllers.delete(streamId);
            this.closeInput(streamId, 'stream-ended');
        }
    }
}
