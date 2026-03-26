/**
 * Queue & Timed Request Output Channels (§3.2 / §3.3 Observability)
 *
 * Provides two dedicated VS Code output channels for the prompt queue
 * and timed request subsystems.  Channels are created lazily on first
 * log call to avoid startup overhead.
 *
 * Usage:
 *   import { logQueue, logTimed } from '../utils/queueLogger';
 *   logQueue('Item enqueued ...');
 *   logTimed('Tick #42 ...');
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Channel names — centralised so they can be referenced from tests / UI
// ---------------------------------------------------------------------------

export const QUEUE_CHANNEL_NAME = 'Tom Prompt Queue';
export const TIMED_CHANNEL_NAME = 'Tom Timed Requests';

// ---------------------------------------------------------------------------
// Runtime enable/disable flag — can be toggled from extension settings or
// programmatically (e.g. during tests) without disposing the channels.
// ---------------------------------------------------------------------------

let _loggingEnabled = true;

/** Turn queue/timed logging on or off at runtime. */
export function setQueueLoggingEnabled(enabled: boolean): void {
    _loggingEnabled = enabled;
}

/** Returns the current logging enabled state. */
export function isQueueLoggingEnabled(): boolean {
    return _loggingEnabled;
}

// ---------------------------------------------------------------------------
// Lazy channel singletons
// ---------------------------------------------------------------------------

let _queueChannel: vscode.OutputChannel | undefined;
let _timedChannel: vscode.OutputChannel | undefined;

/**
 * Returns (and lazily creates) the "Tom Prompt Queue" output channel.
 * The channel is appended to `context.subscriptions` the first time it is
 * created so it is disposed together with the extension.
 */
export function getQueueOutputChannel(): vscode.OutputChannel {
    if (!_queueChannel) {
        _queueChannel = vscode.window.createOutputChannel(QUEUE_CHANNEL_NAME);
    }
    return _queueChannel;
}

/**
 * Returns (and lazily creates) the "Tom Timed Requests" output channel.
 */
export function getTimedOutputChannel(): vscode.OutputChannel {
    if (!_timedChannel) {
        _timedChannel = vscode.window.createOutputChannel(TIMED_CHANNEL_NAME);
    }
    return _timedChannel;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** ISO timestamp prefix for log lines (e.g. "2026-03-26T14:02:33.123Z"). */
function timestamp(): string {
    return new Date().toISOString();
}

/** Truncate a string to `maxLen` characters, appending "…" if truncated. */
export function truncate(text: string, maxLen: number = 120): string {
    if (text.length <= maxLen) { return text; }
    return text.substring(0, maxLen - 1) + '…';
}

/**
 * Produce a short preview of prompt text for log readability.
 * Strips newlines and limits to 80 chars.
 */
export function promptPreview(text: string | undefined, maxLen: number = 80): string {
    if (!text) { return '(empty)'; }
    const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
    return truncate(oneLine, maxLen);
}

// ---------------------------------------------------------------------------
// Core log functions
// ---------------------------------------------------------------------------

/**
 * Log a message to the "Tom Prompt Queue" output channel with ISO timestamp.
 *
 * Does nothing when logging is disabled via `setQueueLoggingEnabled(false)`.
 */
export function logQueue(message: string): void {
    if (!_loggingEnabled) { return; }
    try {
        getQueueOutputChannel().appendLine(`${timestamp()} ${message}`);
    } catch {
        // Swallow — channel may have been disposed during shutdown.
    }
}

/**
 * Log a message to the "Tom Timed Requests" output channel with ISO timestamp.
 *
 * Does nothing when logging is disabled via `setQueueLoggingEnabled(false)`.
 */
export function logTimed(message: string): void {
    if (!_loggingEnabled) { return; }
    try {
        getTimedOutputChannel().appendLine(`${timestamp()} ${message}`);
    } catch {
        // Swallow — channel may have been disposed during shutdown.
    }
}

/**
 * Log an error (with optional stack trace) to the queue channel.
 * Intended for try-catch blocks in promptQueueManager / reminderSystem.
 */
export function logQueueError(context: string, error: unknown): void {
    if (!_loggingEnabled) { return; }
    try {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
        getQueueOutputChannel().appendLine(`${timestamp()} ERROR [${context}] ${msg}${stack}`);
    } catch {
        // Swallow
    }
}

/**
 * Log an error (with optional stack trace) to the timed channel.
 * Intended for try-catch blocks in timerEngine.
 */
export function logTimedError(context: string, error: unknown): void {
    if (!_loggingEnabled) { return; }
    try {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
        getTimedOutputChannel().appendLine(`${timestamp()} ERROR [${context}] ${msg}${stack}`);
    } catch {
        // Swallow
    }
}

// ---------------------------------------------------------------------------
// Disposal — called from extension.deactivate()
// ---------------------------------------------------------------------------

/**
 * Dispose both output channels.  Safe to call multiple times.
 */
export function disposeQueueLogChannels(): void {
    _queueChannel?.dispose();
    _queueChannel = undefined;
    _timedChannel?.dispose();
    _timedChannel = undefined;
}
