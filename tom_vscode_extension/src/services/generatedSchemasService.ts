/**
 * The window's side of the generated schemas (utils/generatedSchemas.ts):
 * write the extension's schemas into the top `.tom` at activation and when the
 * layout changes, keep what is wrong for the status page's Configuration
 * Errors (an unstamped folder that differs, stale copies below the root), and
 * remove stale copies after the user confirms.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readBuildStamp } from '../utils/buildStamp';
import {
    describeDifferingSet, describeStaleCopies, findStaleGeneratedCopies, removeStaleGeneratedCopies, syncGeneratedSchemas,
    type SchemaSetResult,
} from '../utils/generatedSchemas';
import { getLayout, onDidChangeLayout } from '../utils/workspaceLayout';
import { WsPaths } from '../utils/workspacePaths';
import { debugLog } from '../utils/debugLogger';

let extensionPath = '';
let stamp: { generatedBy: string; version: string; build?: { commit?: string; dirty?: boolean; builtAt?: string } } | undefined;
let lastResults: SchemaSetResult[] = [];
let lastStale: string[] = [];

/** Write the generated schemas into the top `.tom` of the window's layout (when it exists); answers what happened. */
export function syncWindowGeneratedSchemas(): SchemaSetResult[] {
    const topTom = WsPaths.topTom;
    const layout = getLayout();
    if (!stamp || !topTom || !layout || !fs.existsSync(topTom)) { lastResults = []; lastStale = []; return []; }
    lastResults = syncGeneratedSchemas(topTom, extensionPath, stamp);
    lastStale = findStaleGeneratedCopies(layout, WsPaths.wsConfigFolder);
    for (const r of lastResults) {
        if (r.outcome !== 'current') { debugLog(`[schemas] ${r.folder}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} — ${r.path}`, 'INFO', 'schemas'); }
    }
    return lastResults;
}

/** Start: write now, and again when the layout changes. */
export function initGeneratedSchemas(context: vscode.ExtensionContext): void {
    extensionPath = context.extensionPath;
    const build = readBuildStamp(extensionPath);
    stamp = {
        generatedBy: context.extension.id,
        version: String((context.extension.packageJSON as { version?: string } | undefined)?.version ?? ''),
        ...(build ? { build: { ...(build.commit ? { commit: build.commit } : {}), ...(build.dirty ? { dirty: true } : {}), ...(build.builtAt ? { builtAt: build.builtAt } : {}) } } : {}),
    };
    try { syncWindowGeneratedSchemas(); } catch (e) { debugLog(`[schemas] not written: ${(e as Error).message}`, 'ERROR', 'schemas'); }
    context.subscriptions.push(onDidChangeLayout(() => {
        try { syncWindowGeneratedSchemas(); } catch (e) { debugLog(`[schemas] not written: ${(e as Error).message}`, 'ERROR', 'schemas'); }
    }));
}

/** The Configuration Errors lines of the generated schemas. */
export function generatedSchemaErrors(): string[] {
    return [
        ...lastResults.filter((r) => r.outcome === 'differs').map(describeDifferingSet),
        ...(lastStale.length ? [describeStaleCopies(lastStale)] : []),
    ];
}

/** Whether there are stale copies to offer removing. */
export function hasStaleSchemaCopies(): boolean { return lastStale.length > 0; }

/** Ask (a modal with the list), then remove the stale copies. Answers the folders removed. */
export async function removeStaleSchemaCopiesConfirmed(): Promise<string[]> {
    const layout = getLayout();
    const stale = layout ? findStaleGeneratedCopies(layout, WsPaths.wsConfigFolder) : [];
    if (!stale.length) {
        void vscode.window.showInformationMessage('No stale generated schema copies.');
        return [];
    }
    const choice = await vscode.window.showWarningMessage(
        'Remove these generated schema copies? The root\'s .tom holds the current ones.',
        { modal: true, detail: stale.join('\n') },
        'Remove',
    );
    if (choice !== 'Remove') { return []; }
    const removed = removeStaleGeneratedCopies(stale);
    lastStale = layout ? findStaleGeneratedCopies(layout, WsPaths.wsConfigFolder) : [];
    void vscode.window.showInformationMessage(`Removed ${removed.length} stale schema cop${removed.length === 1 ? 'y' : 'ies'}.`);
    return removed;
}
