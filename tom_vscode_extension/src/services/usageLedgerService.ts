/**
 * Records every send's usage into this window's usage ledger
 * (src/utils/usageLedger.ts), kept in the workspace state, for the Status
 * Page's totals: the live trail's `usage` events, from any transport, except
 * the direct transport's, which records each round as it arrives
 * ({@link recordRoundUsage}) so a failed send is counted too; its usage block
 * says so (`recordedInLedger`) and is not counted again.
 */

import * as vscode from 'vscode';

import { LiveTrailWriter, type LiveTrailUsage } from './live-trail';
import { asUsageLedger, recordUsage, resetUsageLedger, summarizeUsage, type UsageSummary } from '../utils/usageLedger';

/** The workspace-state key of the ledger. */
export const USAGE_LEDGER_KEY = 'tomAi.usageLedger';

let ledgerContext: vscode.ExtensionContext | undefined;

/** Start recording; the observer is disposed with the extension. */
export function registerUsageLedger(context: vscode.ExtensionContext): void {
    ledgerContext = context;
    context.subscriptions.push(LiveTrailWriter.addObserver((event) => {
        if (event.kind === 'usage' && event.usage.recordedInLedger !== true) {
            record(context, event.usage, true);
        }
    }));
}

function record(context: vscode.ExtensionContext, usage: LiveTrailUsage, countSend: boolean): void {
    const now = new Date();
    const ledger = recordUsage(asUsageLedger(context.workspaceState.get(USAGE_LEDGER_KEY), now), usage, now, { countSend });
    void context.workspaceState.update(USAGE_LEDGER_KEY, ledger);
}

/**
 * One round of a direct send, as its response arrives: the send's first round
 * counts as a send, later rounds add their tokens and cost to it. A no-op
 * before registration.
 */
export function recordRoundUsage(usage: LiveTrailUsage, firstOfSend: boolean): void {
    if (!ledgerContext) { return; }
    record(ledgerContext, usage, firstOfSend);
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
