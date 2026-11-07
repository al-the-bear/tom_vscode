/**
 * A fake Agent SDK for transport tests: it records the options of every
 * `query`, the MCP tool handlers it is given (`tool(name, …, handler)`) and
 * the permission modes the transport sets on a running query, and answers
 * each query with one successful result, so `runAgentSdkQuery` resolves.
 * `during` runs while the query is open, before the result. Install it with
 * `__setAgentSdkForTests(sdk)`. No vscode import: safe to import before the
 * test installs its vscode stub.
 */

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire messages are snake_case */

export interface FakeSdk {
    sdk: unknown;
    options: Record<string, unknown>[];
    /** The MCP tool handlers, by tool name. */
    handlers: Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>;
    /** Every `setPermissionMode` call on a running query, in order. */
    modeChanges: string[];
}

export function fakeSuccessSdk(opts: {
    during?: (options: Record<string, unknown>) => Promise<void>;
    /** Stream messages yielded before the result, in order. */
    messages?: unknown[];
} = {}): FakeSdk {
    const options: Record<string, unknown>[] = [];
    const handlers: FakeSdk['handlers'] = new Map();
    const modeChanges: string[] = [];
    const sdk = {
        tool: (name: string, _description: string, _shape: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => {
            handlers.set(name, handler);
            return { name };
        },
        createSdkMcpServer: () => ({}),
        query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
            options.push(args.options);
            const stream = (async function* () {
                if (opts.during) { await opts.during(args.options); }
                for (const m of opts.messages ?? []) { yield m; }
                yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-1', num_turns: 1, usage: {} };
            })();
            return Object.assign(stream, {
                setPermissionMode: async (mode: string) => { modeChanges.push(mode); },
            });
        },
    };
    return { sdk, options, handlers, modeChanges };
}
