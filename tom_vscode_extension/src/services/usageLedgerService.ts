/**
 * Records every send's usage block (the live trail's `usage` events, from any
 * transport) into this window's usage ledger (src/utils/usageLedger.ts), kept
 * in the workspace state, for the Status Page's totals.
 */

import * as vscode from 'vscode';

import { LiveTrailWriter } from './live-trail';
import { asUsageLedger, recordUsage, resetUsageLedger, summarizeUsage, type UsageSummary } from '../utils/usageLedger';

/** The workspace-state key of the ledger. */
export const USAGE_LEDGER_KEY = 'tomAi.usageLedger';

let ledgerContext: vscode.ExtensionContext | undefined;

/** Start recording; the observer is disposed with the extension. */
export function registerUsageLedger(context: vscode.ExtensionContext): void {
    ledgerContext = context;
    context.subscriptions.push(LiveTrailWriter.addObserver((event) => {
        if (event.kind === 'usage') {
            const now = new Date();
            const ledger = recordUsage(asUsageLedger(context.workspaceState.get(USAGE_LEDGER_KEY), now), event.usage, now);
            void context.workspaceState.update(USAGE_LEDGER_KEY, ledger);
        }
    }));
}

/** Today's and the since-reset totals; undefined before registration. */
export function usageSummary(now = new Date()): UsageSummary | undefined {
    if (!ledgerContext) { return undefined; }
    return summarizeUsage(asUsageLedger(ledgerContext.workspaceState.get(USAGE_LEDGER_KEY), now), now);
}

/** Start the since-reset totals again. */
export async function resetUsage(now = new Date()): Promise<void> {
    if (!ledgerContext) { return; }
    const current = asUsageLedger(ledgerContext.workspaceState.get(USAGE_LEDGER_KEY), now);
    await ledgerContext.workspaceState.update(USAGE_LEDGER_KEY, resetUsageLedger(current, now));
}
