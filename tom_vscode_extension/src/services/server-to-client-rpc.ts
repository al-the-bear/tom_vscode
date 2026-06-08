/**
 * Server→client RPC primitive (todo #4) — the one new transport capability of
 * the Agent SDK bridge: an awaited, id-correlated request the *extension*
 * issues to a connected Dart *client* over the bridge socket, with timeout and
 * cancel.
 *
 * Today the bridge is strictly client→server (the Dart client calls the
 * extension and awaits a reply); the streaming `agentSdk.chunk` path (todo #3)
 * is server→client but fire-and-forget. The callback-bearing SDK features
 * (#5 Dart-defined tools, #6 `canUseTool`) need the *reverse* of the normal
 * request: the extension must call into Dart mid-query and await the answer.
 * This class is that reverse half on the extension side; `BridgeRequestDispatcher`
 * (Dart) is the matching client half.
 *
 * It is deliberately generic — it knows nothing about the Agent SDK. It owns an
 * id→pending map, writes request frames through an injected sink, and resolves
 * or rejects each pending promise from `handleResponse`. The send sink and the
 * timer are injected so the module imports neither `vscode` nor `process` and
 * loads directly under `node --test` (mirroring `agent-sdk-bridge.ts`).
 *
 * Request ids carry an `s2c-` prefix so they never collide with the extension's
 * existing client→server `js-` request id space.
 */

/** A JSON-RPC request frame as written to the wire. */
export interface ServerToClientRequestFrame {
    jsonrpc: '2.0';
    id: string;
    method: string;
    params?: unknown;
}

/** A JSON-RPC response frame as received from the client. */
export interface ServerToClientResponseFrame {
    jsonrpc?: string;
    id?: string;
    result?: unknown;
    error?: { code?: number; message?: string } | string;
}

/** Collaborators injected so the primitive stays `vscode`/`process`-free. */
export interface ServerToClientRpcDeps {
    /** Writes a request frame to the connected client. */
    sendRequest: (frame: ServerToClientRequestFrame) => void;
    /** Default per-request timeout in ms. */
    defaultTimeoutMs?: number;
    /** Schedules a one-shot timer; defaults to `setTimeout`. */
    setTimer?: (cb: () => void, ms: number) => unknown;
    /** Cancels a timer created by `setTimer`; defaults to `clearTimeout`. */
    clearTimer?: (handle: unknown) => void;
}

/** Options for a single `request` call. */
export interface ServerToClientRequestOptions {
    /** Override the default timeout for this request. */
    timeoutMs?: number;
    /** Aborting this signal rejects (and forgets) the pending request. */
    signal?: AbortSignal;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: unknown;
    onAbort?: () => void;
    signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30000;

export class ServerToClientRpc {
    private readonly deps: ServerToClientRpcDeps;
    private readonly pending = new Map<string, PendingRequest>();
    private seq = 0;

    constructor(deps: ServerToClientRpcDeps) {
        this.deps = deps;
    }

    /**
     * Issue a request to the connected client and await its reply.
     *
     * Resolves with the response `result`; rejects on an `error` reply, on
     * timeout, or when [opts.signal] aborts.
     */
    request<T = unknown>(
        method: string,
        params?: unknown,
        opts?: ServerToClientRequestOptions,
    ): Promise<T> {
        const signal = opts?.signal;
        if (signal?.aborted) {
            return Promise.reject(this.abortError());
        }

        const id = `s2c-${++this.seq}`;
        const timeoutMs = opts?.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const setTimer = this.deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));

        return new Promise<T>((resolve, reject) => {
            const pending: PendingRequest = {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer: undefined,
                signal,
            };

            pending.timer = setTimer(() => {
                if (this.pending.delete(id)) {
                    this.detachAbort(pending);
                    reject(new Error(`Server→client request '${method}' (${id}) timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            if (signal) {
                pending.onAbort = () => {
                    if (this.pending.delete(id)) {
                        this.clearTimer(pending.timer);
                        this.detachAbort(pending);
                        reject(this.abortError());
                    }
                };
                signal.addEventListener('abort', pending.onAbort, { once: true });
            }

            this.pending.set(id, pending);
            this.deps.sendRequest({ jsonrpc: '2.0', id, method, params });
        });
    }

    /**
     * Resolve/reject the pending request matching [frame].id.
     *
     * Returns `true` if a pending request was matched and settled, `false`
     * otherwise — so the caller can fall through to its own response routing
     * for ids this RPC does not own.
     */
    handleResponse(frame: ServerToClientResponseFrame): boolean {
        const id = frame.id;
        if (id === undefined) {
            return false;
        }
        const pending = this.pending.get(id);
        if (!pending) {
            return false;
        }
        this.pending.delete(id);
        this.clearTimer(pending.timer);
        this.detachAbort(pending);

        if (frame.error !== undefined) {
            pending.reject(new Error(this.errorMessage(frame.error)));
        } else {
            pending.resolve(frame.result);
        }
        return true;
    }

    /** Reject and forget every in-flight request (e.g. on disconnect). */
    rejectAll(reason: string): void {
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            this.clearTimer(pending.timer);
            this.detachAbort(pending);
            pending.reject(new Error(reason));
        }
    }

    private clearTimer(timer: unknown): void {
        const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
        clear(timer);
    }

    private detachAbort(pending: PendingRequest): void {
        if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
    }

    private abortError(): Error {
        return new Error('Server→client request cancelled (aborted)');
    }

    private errorMessage(error: { code?: number; message?: string } | string): string {
        if (typeof error === 'string') {
            return error;
        }
        return error.message ?? `error code ${error.code ?? 'unknown'}`;
    }
}
