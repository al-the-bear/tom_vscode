/**
 * Shared trail path resolution.
 *
 * Wave 1.3 of the refactoring plan: the trail service and the trail
 * viewer previously each had their own mini-resolver that supported a
 * hand-maintained subset of tokens (`${workspaceFolder}`, `${ai}`,
 * `${username}`, `${home}`, `${quest}`, `${subsystem}`). Those two
 * resolvers drifted in small ways — the viewer also stripped
 * `${quest}` / `${subsystem}` to walk up to the trail root — and every
 * token the rest of the extension gained through the canonical
 * `resolveVariables()` (e.g. `${env.*}`, `${date.*}`, `${git.*}`) was
 * silently unavailable inside trail patterns.
 *
 * This module replaces both mini-resolvers with a single entry point
 * that delegates to `resolveVariables()` and layers trail-specific
 * behavior (quest/subsystem overrides, root-discovery strip mode, and
 * workspace-root fallback for relative results) on top.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { resolveVariables } from '../utils/variableResolver';

export interface TrailPathVars {
    /** Active quest id. Defaults to `'default'` when omitted. */
    quest?: string;
    /** Subsystem folder name (e.g. `'copilot'`, `'localLlm-<config>'`). */
    subsystem?: string;
}

export interface TrailPathOptions {
    /**
     * `'fill'` (default) replaces `${quest}` and `${subsystem}` with the
     * values passed in `vars` (or `'default'` / `'copilot'` if absent).
     *
     * `'strip'` removes them so the caller can walk up to the trail
     * root. A leading slash before the stripped token is also removed
     * so the result doesn't end with a dangling `/`.
     */
    mode?: 'fill' | 'strip';
}

/**
 * Resolve a configured trail path pattern (raw-path pattern or summary-file
 * pattern) to an absolute path. Supports the full canonical token surface
 * plus the trail-specific `${quest}` / `${subsystem}` tokens, with the
 * optional strip mode used by the trail viewer for root discovery.
 *
 * Relative results are resolved against the current workspace root so
 * callers can write patterns like `trail/${subsystem}/${quest}` and get
 * back an absolute path.
 */
export function resolveTrailPath(
    input: string,
    vars: TrailPathVars = {},
    options: TrailPathOptions = {},
): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const mode = options.mode ?? 'fill';

    let prepared = input;
    if (mode === 'strip') {
        // Drop optional leading slash before the token, then the token
        // itself. Must happen before resolveVariables — otherwise the
        // resolver would replace the token with an empty string and
        // leave the orphan slash behind.
        prepared = prepared
            .replace(/\/?\$\{quest\}/g, '')
            .replace(/\/?\$\{subsystem\}/g, '');
    }

    const resolverValues: Record<string, string> = {};
    if (mode === 'fill') {
        resolverValues.quest = vars.quest ?? 'default';
        resolverValues.subsystem = vars.subsystem ?? 'copilot';
    }

    const resolved = resolveVariables(prepared, {
        values: resolverValues,
        includeEditor: false,
        enableJsExpressions: false,
        unresolvedBehavior: 'empty',
    });

    if (path.isAbsolute(resolved)) {
        return resolved;
    }
    return path.join(workspaceRoot, resolved);
}
