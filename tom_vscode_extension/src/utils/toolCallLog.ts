/**
 * One line per agent tool call, in the Tom Tool Log channel.
 *
 * How long a tool call took, and which one failed, could not be read for the
 * Agent SDK and MCP paths at all (only the direct transport kept a trail). Every
 * path the Anthropic panel and the queue run tools on now writes a line here:
 * the direct, VS Code LM and Local LLM transports through the handler's
 * `runTool`, the Agent SDK's in-process MCP server and the standalone MCP
 * server through the shared wrapper (src/utils/toolTrailWrapper.ts). Read it
 * with `tomAi_readOutputChannel {channel: 'Tom Tool Log', grep: '<tool>'}`.
 *
 * The line: `<ISO time> [tool-call] <transport> <tool> <ms> ms <chars> chars ok`
 * or `... error: <first line of the error>`.
 *
 * vscode-free: the channel is injected at activation ({@link setToolCallLogSink}).
 */

export interface ToolCallLogEntry {
    at: Date;
    /** direct / vscodeLm / localLlm / agentSdk / mcp. */
    transport: string;
    tool: string;
    durationMs: number;
    /** Length of the result text. */
    resultChars: number;
    error?: string;
}

let sink: ((line: string) => void) | undefined;

/** Where the lines go (the Tom Tool Log channel); undefined: nowhere. */
export function setToolCallLogSink(next: ((line: string) => void) | undefined): void {
    sink = next;
}

/** The line for one call; an error is cut to its first line, so every call is exactly one line. */
export function formatToolCallLine(e: ToolCallLogEntry): string {
    const outcome = e.error !== undefined ? `error: ${e.error.split('\n')[0].trim()}` : 'ok';
    return `${e.at.toISOString()} [tool-call] ${e.transport} ${e.tool} ${Math.round(e.durationMs)} ms ${e.resultChars} chars ${outcome}`;
}

/** Write the line for one call. Never throws: logging must not break a tool call. */
export function logToolCall(e: ToolCallLogEntry): void {
    try {
        sink?.(formatToolCallLine(e));
    } catch { /* a disposed channel: nothing to log to */ }
}
