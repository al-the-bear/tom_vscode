/**
 * Tom Tool Log — shared "Tom Tool Log" output channel.
 *
 * Historically the "Tom Tool Log" channel was created privately inside
 * `tomAiChat-handler.ts`. Several other subsystems also need to write to
 * it (notably config-path resolution diagnostics), and calling
 * `vscode.window.createOutputChannel('Tom Tool Log')` a second time would
 * produce a confusing *duplicate* channel in the Output dropdown.
 *
 * This module owns the single channel instance behind a lazy accessor so
 * every caller shares one channel.
 *
 * Usage:
 *   import { toolLog, logConfigAccess } from '../utils/toolLog';
 *   toolLog('Something happened');
 *   logConfigAccess('TomAiConfiguration.configPath', resolved, { branch: 'setting' });
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Channel name — centralised so it can be referenced from tests / UI.
// ---------------------------------------------------------------------------

export const TOOL_LOG_CHANNEL_NAME = 'Tom Tool Log';

// ---------------------------------------------------------------------------
// Lazy channel singleton
// ---------------------------------------------------------------------------

let _toolLogChannel: vscode.OutputChannel | undefined;

/**
 * Returns (and lazily creates) the shared "Tom Tool Log" output channel.
 * All modules that log tool activity MUST go through this accessor so the
 * Output dropdown shows a single channel rather than duplicates.
 */
export function getToolLogChannel(): vscode.OutputChannel {
    if (!_toolLogChannel) {
        _toolLogChannel = vscode.window.createOutputChannel(TOOL_LOG_CHANNEL_NAME);
    }
    return _toolLogChannel;
}

/** Dispose the channel. Safe to call multiple times. */
export function disposeToolLogChannel(): void {
    _toolLogChannel?.dispose();
    _toolLogChannel = undefined;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** ISO timestamp prefix for log lines. */
function timestamp(): string {
    return new Date().toISOString();
}

/**
 * Append a raw message to the "Tom Tool Log" channel with an ISO timestamp.
 * Never throws — swallows errors that occur while the channel is being
 * disposed during shutdown.
 */
export function toolLog(message: string): void {
    try {
        getToolLogChannel().appendLine(`${timestamp()} ${message}`);
    } catch {
        // Swallow — channel may have been disposed during shutdown.
    }
}

// ---------------------------------------------------------------------------
// Config-access diagnostics
// ---------------------------------------------------------------------------

/** Optional structured details for a config-access log line. */
export interface ConfigAccessDetails {
    /** Which resolution branch produced the path (e.g. 'workspace .tom', 'setting', 'default'). */
    branch?: string;
    /** Raw `tomAi.configPath` setting value before placeholder expansion, if relevant. */
    setting?: string;
    /** What is being done with the path (e.g. 'resolve', 'read', 'parsed', 'missing'). */
    action?: string;
    /** Extra free-form note. */
    note?: string;
}

/**
 * Log a config-file access to the "Tom Tool Log" channel.
 *
 * Emits the call site (`source`), the post-placeholder-replacement resolved
 * path, whether that path currently exists on disk, and any structured
 * details supplied by the caller. This is the single helper every config
 * resolution/load site routes through so the user can see exactly which file
 * the extension is trying to access and from where the access was issued.
 *
 * @param source    Human-readable call site (e.g. 'TomAiConfiguration.reload').
 * @param resolved  The fully-resolved path (after `${...}`/`~` expansion), or undefined.
 * @param details   Optional structured details (branch, setting, action, note).
 */
export function logConfigAccess(
    source: string,
    resolved: string | undefined,
    details: ConfigAccessDetails = {},
): void {
    const parts: string[] = [`[config] from=${source}`];

    if (details.action) { parts.push(`action=${details.action}`); }
    if (details.branch) { parts.push(`branch=${details.branch}`); }

    if (resolved) {
        let exists = false;
        try {
            exists = fs.existsSync(resolved);
        } catch {
            // Treat unreadable paths as non-existent for the diagnostic.
        }
        parts.push(`exists=${exists}`);
        parts.push(`path=${resolved}`);
    } else {
        parts.push('path=<none>');
    }

    if (details.setting !== undefined) {
        parts.push(`setting=${details.setting === '' ? '<empty>' : details.setting}`);
    }
    if (details.note) { parts.push(`note=${details.note}`); }

    toolLog(parts.join(' '));
}
