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
 * The module imports neither `vscode` nor the Agent SDK directly — the loader
 * and the notification sink are injected — so it is unit-testable under
 * `node --test` (mirroring `agent-sdk-retry.ts`).
 */

/** The subset of the Agent SDK this bridge calls. */
export interface AgentSdkLike {
    query(params: {
        prompt: string;
        options?: Record<string, unknown>;
    }): AsyncIterable<unknown>;
}

/** Collaborators injected so the bridge stays `vscode`/SDK-free. */
export interface AgentSdkBridgeDeps {
    /** Lazily loads (and caches) the ESM-only Agent SDK module. */
    loadSdk: () => Promise<AgentSdkLike>;
    /** Emits a JSON-RPC notification back to the Dart client. */
    sendNotification: (method: string, params: Record<string, unknown>) => void;
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
        // Spread (not mutate) the caller's options so the only addition is the
        // bridge-managed abortController; everything else is passed unchanged.
        const options: Record<string, unknown> = { ...callerOptions, abortController };

        const stream = sdk.query({ prompt, options });
        // Detached pump: forward chunks without blocking the start response.
        void this.pump(streamId, stream);

        return { success: true, streamId };
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
