/**
 * A fake Agent SDK for transport tests: it records the options of every
 * `query` and answers each with one successful result, so `runAgentSdkQuery`
 * resolves. Install it with `__setAgentSdkForTests(sdk)`. No vscode import:
 * safe to import before the test installs its vscode stub.
 */

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire messages are snake_case */

export function fakeSuccessSdk(): { sdk: unknown; options: Record<string, unknown>[] } {
    const options: Record<string, unknown>[] = [];
    const sdk = {
        tool: () => ({}),
        createSdkMcpServer: () => ({}),
        query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
            options.push(args.options);
            return (async function* () {
                yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-1', num_turns: 1, usage: {} };
            })();
        },
    };
    return { sdk, options };
}
