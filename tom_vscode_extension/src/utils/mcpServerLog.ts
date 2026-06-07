/**
 * Tom AI: MCP Server log — shared "Tom AI: MCP Server" output channel.
 *
 * The standalone MCP server (`mcpServer-handler.ts`) is `vscode`-free and takes
 * an injected `log` callback. This module owns the single output channel that
 * production wires that callback to, behind a lazy accessor so the Output
 * dropdown shows one channel rather than a duplicate per `createOutputChannel`
 * call. Mirrors `toolLog.ts`.
 *
 * Usage (from `extension.ts`):
 *   import { mcpLog, disposeMcpLogChannel } from '../utils/mcpServerLog';
 *   defaultMcpServerStarter(sink, mcpLog);
 *   context.subscriptions.push({ dispose: disposeMcpLogChannel });
 */

import * as vscode from 'vscode';

/** Channel name — centralised so it can be referenced from tests / UI. */
export const MCP_LOG_CHANNEL_NAME = 'Tom AI: MCP Server';

let _mcpLogChannel: vscode.OutputChannel | undefined;

/**
 * Returns (and lazily creates) the shared "Tom AI: MCP Server" output channel.
 * All MCP logging goes through this accessor so the Output dropdown shows a
 * single channel rather than duplicates.
 */
export function getMcpLogChannel(): vscode.OutputChannel {
    if (!_mcpLogChannel) {
        _mcpLogChannel = vscode.window.createOutputChannel(MCP_LOG_CHANNEL_NAME);
    }
    return _mcpLogChannel;
}

/** Dispose the channel. Safe to call multiple times. */
export function disposeMcpLogChannel(): void {
    _mcpLogChannel?.dispose();
    _mcpLogChannel = undefined;
}

/** ISO timestamp prefix for log lines. */
function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Append a line to the "Tom AI: MCP Server" channel with an ISO timestamp.
 * Never throws — swallows errors that occur while the channel is being disposed
 * during shutdown.
 */
export function mcpLog(line: string): void {
    try {
        getMcpLogChannel().appendLine(`${timestamp()} ${line}`);
    } catch {
        // Swallow — channel may have been disposed during shutdown.
    }
}
