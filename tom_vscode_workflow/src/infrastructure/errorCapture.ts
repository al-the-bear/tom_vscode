/**
 * TOM Tracker — Error Capture Infrastructure
 *
 * Provides reliable error capture and reporting patterns for:
 * - VS Code command handlers
 * - Webview providers and message handlers
 * - Event listeners and disposables
 * - Unhandled promise rejections and uncaught exceptions
 *
 * All captured errors are routed through the centralized logger
 * and optionally surfaced to the user via VS Code notifications.
 *
 * Usage:
 *   import { wrapCommand, wrapWebviewProvider, installGlobalErrorHandlers } from './infrastructure/errorCapture';
 *
 *   // In activation:
 *   installGlobalErrorHandlers();
 *   context.subscriptions.push(
 *       vscode.commands.registerCommand('myCmd', wrapCommand('myCmd', () => { ... }))
 *   );
 */

import * as vscode from 'vscode';
import { debug, error as logError } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface ErrorReport {
    /** Short context identifier (e.g., 'command:myCmd', 'webview:myPanel') */
    context: string;
    /** The error message */
    message: string;
    /** Stack trace, if available */
    stack?: string;
    /** Additional structured details */
    details?: Record<string, unknown>;
    /** ISO timestamp */
    timestamp: string;
}

/**
 * Callback invoked for every captured error. Useful for telemetry, external logging, etc.
 */
export type ErrorCallback = (report: ErrorReport) => void;

// ============================================================================
// State
// ============================================================================

let globalHandlersInstalled = false;
const errorCallbacks: ErrorCallback[] = [];

// ============================================================================
// Error Callback Registration
// ============================================================================

/**
 * Register a callback that will be invoked for every captured error.
 * Returns a disposable to unregister.
 */
export function onError(callback: ErrorCallback): vscode.Disposable {
    errorCallbacks.push(callback);
    return { dispose: () => {
        const idx = errorCallbacks.indexOf(callback);
        if (idx >= 0) { errorCallbacks.splice(idx, 1); }
    }};
}

// ============================================================================
// Core Error Reporting
// ============================================================================

/**
 * Report an error with structured context. This is the central error sink.
 * All error capture wrappers funnel through this function.
 *
 * @param context  Short identifier for where the error occurred
 * @param err      The caught error
 * @param details  Optional structured context (message type, arg count, etc.)
 * @param showUser Whether to show a VS Code error notification. Default: false.
 */
export function reportError(
    context: string,
    err: unknown,
    details?: Record<string, unknown>,
    showUser = false,
): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const detailsSuffix = details ? ` ${safeStringify(details)}` : '';

    logError(`[EXCEPTION] ${context}: ${message}${detailsSuffix}`);
    if (stack) {
        debug(`[EXCEPTION] ${context} stack:\n${stack}`);
    }

    const report: ErrorReport = {
        context,
        message,
        stack,
        details,
        timestamp: new Date().toISOString(),
    };

    for (const cb of errorCallbacks) {
        try { cb(report); } catch { /* ignore callback errors */ }
    }

    if (showUser) {
        // Extract error ID from message (e.g., [E01], [B01])
        const idMatch = message.match(/\[([A-Z]\d+)\]/);
        const prefix = idMatch ? `${idMatch[0]} ` : '';
        vscode.window.showErrorMessage(`${prefix}${context}: ${message}`);
    }
}

// ============================================================================
// Command Wrapper
// ============================================================================

/**
 * Wrap a command handler with automatic error capture.
 * Caught errors are reported and re-thrown to preserve VS Code's error UX.
 *
 * @param commandId  The command identifier for error context
 * @param handler    The actual command implementation
 * @returns          A wrapped handler safe to pass to registerCommand
 */
export function wrapCommand<T extends (...args: any[]) => any>(
    commandId: string,
    handler: T,
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
        try {
            return await Promise.resolve(handler(...args));
        } catch (err) {
            reportError(`command:${commandId}`, err, { argsCount: args.length }, true);
            throw err;
        }
    };
}

// ============================================================================
// Event Listener Wrapper
// ============================================================================

/**
 * Wrap an event listener with automatic error capture.
 * Errors are reported but NOT re-thrown (event handlers should not throw).
 *
 * @param context   Description for error context (e.g., 'onDidChangeConfig')
 * @param listener  The actual listener function
 * @returns         A wrapped listener
 */
export function wrapListener<T>(
    context: string,
    listener: (event: T) => unknown,
): (event: T) => Promise<void> {
    return async (event: T): Promise<void> => {
        try {
            await Promise.resolve(listener(event));
        } catch (err) {
            reportError(`listener:${context}`, err);
        }
    };
}

// ============================================================================
// Webview Provider Wrapper
// ============================================================================

/**
 * Wrap a WebviewViewProvider with automatic error capture on:
 * - resolveWebviewView (catches rendering failures)
 * - onDidReceiveMessage (catches message handler failures)
 *
 * @param viewId   The webview view ID for error context
 * @param provider The original provider
 * @returns        A wrapped provider with error capture
 */
export function wrapWebviewProvider(
    viewId: string,
    provider: vscode.WebviewViewProvider,
): vscode.WebviewViewProvider {
    return {
        resolveWebviewView(
            webviewView: vscode.WebviewView,
            context: vscode.WebviewViewResolveContext,
            token: vscode.CancellationToken,
        ): void | Thenable<void> {
            try {
                // Wrap onDidReceiveMessage before the provider sets it up
                const originalOnMessage = webviewView.webview.onDidReceiveMessage.bind(webviewView.webview);
                (webviewView.webview as any).onDidReceiveMessage = (
                    listener: (message: any) => any,
                    thisArgs?: any,
                    disposables?: vscode.Disposable[],
                ) => {
                    const wrappedListener = async (message: unknown) => {
                        try {
                            return await Promise.resolve(listener.call(thisArgs, message));
                        } catch (err) {
                            const messageType =
                                typeof message === 'object' && message !== null && 'type' in (message as Record<string, unknown>)
                                    ? (message as Record<string, unknown>).type
                                    : undefined;
                            reportError(`webview:${viewId}.onDidReceiveMessage`, err, { messageType });
                            throw err;
                        }
                    };
                    return originalOnMessage(wrappedListener, thisArgs, disposables);
                };

                return provider.resolveWebviewView(webviewView, context, token);
            } catch (err) {
                reportError(`webviewProvider:${viewId}.resolveWebviewView`, err, undefined, true);

                // Render fallback error HTML
                webviewView.webview.html = `<html><body>
                    <pre style="color:red;white-space:pre-wrap;padding:20px;">
TOM Tracker panel error: ${escapeHtml(String(err))}
                    </pre>
                </body></html>`;
            }
        },
    };
}

// ============================================================================
// Disposable Wrapper
// ============================================================================

/**
 * Wrap a dispose function with error capture.
 * Ensures disposal errors don't crash the extension.
 */
export function safeDispose(context: string, disposeFn: () => void): vscode.Disposable {
    return {
        dispose: () => {
            try {
                disposeFn();
            } catch (err) {
                reportError(`dispose:${context}`, err);
            }
        },
    };
}

// ============================================================================
// Global Error Handlers
// ============================================================================

/**
 * Install global error handling setup.
 * Call once during extension activation.
 *
 * NOTE: We intentionally do NOT install process-level `unhandledRejection`
 * or `uncaughtException` handlers. In VS Code, all extensions share the
 * same Node.js process, so process-level handlers catch errors from OTHER
 * extensions (e.g., GitHub PR extension's HTTP errors containing circular
 * TLSSocket references). VS Code and tom_vscode_extension already handle
 * these globally. Our extension should only capture errors from its own code
 * via the wrapCommand/wrapListener/wrapWebviewProvider utilities.
 */
export function installGlobalErrorHandlers(): void {
    if (globalHandlersInstalled) {
        return;
    }
    globalHandlersInstalled = true;

    debug('TOM Tracker error capture initialized (command/listener/webview wrappers active)');
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Safely stringify a value, handling circular references gracefully.
 */
function safeStringify(value: unknown): string {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) {
                    return '[Circular]';
                }
                seen.add(val);
            }
            return val;
        });
    } catch {
        return String(value);
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
