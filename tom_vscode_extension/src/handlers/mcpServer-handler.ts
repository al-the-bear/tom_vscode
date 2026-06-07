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

import * as http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { SharedToolDefinition } from '../tools/shared-tool-registry';
import { resolveProfileTools } from '../tools/tool-executors';
import type { ResolvedMcpServerSettings } from '../utils/sendToChatConfig';
import type { McpServerRuntimeStatus } from '../utils/mcpServerCard';
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

// ============================================================================
// Streamable HTTP transport + port probing + bearer auth (plan §7.3, todo #18)
//
// The server binds `0.0.0.0:<port>` (VPN-reachable) and probes upward from
// `basePort` (19920) to the first free port, so every VS Code window can run
// its own server. Each inbound request is authenticated by its bearer token and
// served a freshly-built MCP server scoped to that request's effective tool set
// (auth → read-only floor from #17), keeping the gate per-request rather than
// per-process. The vscode toast + Status-Page bound-port reporting live in the
// lifecycle wiring (#19); this module returns the bound port so #19 can surface
// it, staying `vscode`-free and unit-testable.
// ============================================================================

/**
 * Extract the token from an `Authorization: Bearer <token>` header. The scheme
 * match is case-insensitive and surrounding whitespace is tolerated. Any other
 * scheme — or a bare value with no scheme — yields `undefined` (unauthenticated).
 */
export function extractBearerToken(authHeader: string | undefined): string | undefined {
    if (!authHeader) { return undefined; }
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    return match ? match[1].trim() : undefined;
}

/** True for the `EADDRINUSE` errno that signals "this port is taken, try the next". */
function isAddrInUse(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/**
 * Probe upward from `basePort` to the first port `attempt` can bind. `attempt`
 * resolves with the bound resource, or rejects with an `EADDRINUSE` error to
 * signal "try the next port"; any other rejection aborts the search immediately
 * (e.g. `EACCES`). After `maxAttempts` busy ports it rejects with a clear error.
 *
 * Injecting `attempt` keeps the probe logic socket-free and unit-testable; the
 * real binder ({@link startMcpHttpServer}) passes an `http.Server.listen` wrapper.
 */
export async function bindFirstFreePort<T>(
    basePort: number,
    maxAttempts: number,
    attempt: (port: number) => Promise<T>,
): Promise<{ port: number; resource: T }> {
    for (let i = 0; i < maxAttempts; i++) {
        const port = basePort + i;
        try {
            return { port, resource: await attempt(port) };
        } catch (error) {
            if (!isAddrInUse(error)) { throw error; }
        }
    }
    throw new Error(
        `MCP server: no free port in ${basePort}..${basePort + maxAttempts - 1} (${maxAttempts} attempts)`,
    );
}

/** Default cap on the upward port search (basePort..basePort+99). */
export const MCP_PORT_PROBE_ATTEMPTS = 100;

/**
 * Per-request dependencies for the HTTP server. `resolveTools` maps an inbound
 * bearer to the effective tool set (the caller wires this to
 * {@link resolveEffectiveMcpTools} with the live settings + `process.env`);
 * `sink` receives the trail entries every tool call writes.
 */
export interface McpHttpServerDeps {
    resolveTools: (bearer: string | undefined) => SharedToolDefinition[];
    sink: McpToolTrailSink;
}

/** A bound, running MCP HTTP server plus the handle to shut it down. */
export interface RunningMcpServer {
    host: string;
    port: number;
    /** `http://<host>:<port>` — the advertised base URL. */
    url: string;
    /** Stop accepting connections and release the port. */
    close(): Promise<void>;
}

/** Wrap `server.listen(port, host)` in a promise that rejects on bind error. */
function listenOnce(server: http.Server, host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
        const onListening = (): void => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

/**
 * Start a Streamable HTTP MCP server on `host`, probing upward from `basePort`
 * to the first free port. Each request is served in stateless mode: the bearer
 * is extracted, the effective tool set resolved for it, and a fresh MCP server
 * built and connected to a per-request transport — so auth gates every call.
 *
 * Returns the bound `host`/`port`/`url` and a `close()` handle. The success
 * toast and Status-Page reporting are the lifecycle layer's job (#19).
 */
export async function startMcpHttpServer(
    opts: { host: string; basePort: number; maxAttempts?: number },
    deps: McpHttpServerDeps,
): Promise<RunningMcpServer> {
    const maxAttempts = opts.maxAttempts ?? MCP_PORT_PROBE_ATTEMPTS;

    const { port, resource: server } = await bindFirstFreePort(
        opts.basePort,
        maxAttempts,
        async (candidate) => {
            const httpServer = http.createServer((req, res) => { void handleMcpRequest(req, res, deps); });
            try {
                await listenOnce(httpServer, opts.host, candidate);
            } catch (error) {
                httpServer.close();
                throw error;
            }
            return httpServer;
        },
    );

    return {
        host: opts.host,
        port,
        url: `http://${opts.host}:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/**
 * Serve a single inbound HTTP request: authenticate by bearer, resolve the
 * effective tool set, build a fresh stateless MCP server for it, and delegate to
 * the SDK transport. Closing both on response end keeps the stateless model
 * leak-free.
 */
async function handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: McpHttpServerDeps,
): Promise<void> {
    const bearer = extractBearerToken(req.headers.authorization);
    const tools = deps.resolveTools(bearer);
    const { server } = buildToolMcpServer(tools, deps.sink);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => { void transport.close(); void server.close(); });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
    } catch (error) {
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(500);
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
                id: null,
            }));
        }
    }
}

// ============================================================================
// Lifecycle state machine (plan §7.5, todo #19)
//
// `McpServerController` owns the single running server for a window. It is
// deliberately `vscode`-free: it takes an injected *starter* (which binds the
// real transport via `startMcpHttpServer`) and an `onChange` callback the
// extension uses to push the live bound port to the Status-Page card. The
// vscode wiring proper — activation/autoStart, the Start/Stop/Restart commands,
// the success toast, config-change handling, and disposal on deactivate — lives
// in `extension.ts`; only this state machine is unit-tested.
//
// "Never leak a listener" is enforced by the `pending`/`running` guard: a start
// while already running (or while a start is in flight) reuses the existing
// server instead of binding a second one.
// ============================================================================

/** Binds and returns a running server for the given settings (injectable). */
export type McpServerStarter = (settings: ResolvedMcpServerSettings) => Promise<RunningMcpServer>;

/**
 * Production starter: binds the Streamable HTTP transport for `settings`,
 * resolving the effective tool set per request (auth + read-only floor, #17)
 * and writing tool trail through `sink`.
 */
export function defaultMcpServerStarter(sink: McpToolTrailSink): McpServerStarter {
    return (settings) => startMcpHttpServer(
        { host: settings.host, basePort: settings.basePort },
        { resolveTools: (bearer) => resolveEffectiveMcpTools(settings, bearer), sink },
    );
}

/** Collaborators for {@link McpServerController}. */
export interface McpServerControllerDeps {
    /** Binds the transport and returns the running server. */
    start: McpServerStarter;
    /** Notified with the live status on every start/stop (for the Status Page). */
    onChange?: (status: McpServerRuntimeStatus) => void;
}

/**
 * Owns the lifecycle of a single MCP server: at most one listener is bound at a
 * time, every transition notifies `onChange`, and `dispose` guarantees clean
 * shutdown. Concurrent/duplicate starts collapse onto the in-flight bind.
 */
export class McpServerController {
    private running: RunningMcpServer | undefined;
    private pending: Promise<RunningMcpServer> | undefined;

    constructor(private readonly deps: McpServerControllerDeps) {}

    /** Live status: bound `host`/`port` while running, else `{ running: false }`. */
    get status(): McpServerRuntimeStatus {
        return this.running
            ? { running: true, host: this.running.host, port: this.running.port }
            : { running: false };
    }

    get isRunning(): boolean {
        return this.running !== undefined;
    }

    /**
     * Start the server. Idempotent: if already running (or a start is in flight)
     * the existing server is returned without binding a second listener.
     */
    async start(settings: ResolvedMcpServerSettings): Promise<RunningMcpServer> {
        if (this.running) {
            return this.running;
        }
        if (this.pending) {
            return this.pending;
        }
        this.pending = (async (): Promise<RunningMcpServer> => {
            const server = await this.deps.start(settings);
            this.running = server;
            this.notify();
            return server;
        })();
        try {
            return await this.pending;
        } finally {
            this.pending = undefined;
        }
    }

    /** Stop the running server and release the port. No-op when stopped. */
    async stop(): Promise<void> {
        const server = this.running;
        if (!server) {
            return;
        }
        this.running = undefined;
        await server.close();
        this.notify();
    }

    /** Stop the current server (if any) and bind a fresh one. */
    async restart(settings: ResolvedMcpServerSettings): Promise<RunningMcpServer> {
        await this.stop();
        return this.start(settings);
    }

    /** Clean shutdown for `deactivate` / config disposal. */
    async dispose(): Promise<void> {
        await this.stop();
    }

    private notify(): void {
        this.deps.onChange?.(this.status);
    }
}

// ----------------------------------------------------------------------------
// Module-level active-controller registry. `extension.ts` registers the live
// controller so the Status-Page handler can read the runtime status without a
// cross-handler import cycle (it only needs the read accessor).
// ----------------------------------------------------------------------------

let activeController: McpServerController | undefined;

/** Register (or clear) the controller whose status the Status Page reports. */
export function setActiveMcpServerController(controller: McpServerController | undefined): void {
    activeController = controller;
}

/** Live MCP server status for the Status-Page snapshot; stopped when none. */
export function getMcpServerStatus(): McpServerRuntimeStatus {
    return activeController?.status ?? { running: false };
}

/**
 * Reconcile the active controller against changed settings — the "clean disposal
 * on config change" half of #19. Called after the MCP card is saved:
 *   - disabled ⇒ stop (release the listener);
 *   - enabled & already running ⇒ restart to apply new host/port/tools/auth;
 *   - otherwise ⇒ no-op (the user starts it via command/autoStart).
 * Returns the running server when one is (re)bound, else `undefined`.
 */
export async function reconcileMcpServerConfig(
    settings: ResolvedMcpServerSettings,
): Promise<RunningMcpServer | undefined> {
    const controller = activeController;
    if (!controller) {
        return undefined;
    }
    if (!settings.enabled) {
        await controller.stop();
        return undefined;
    }
    if (controller.isRunning) {
        return controller.restart(settings);
    }
    return undefined;
}
