/**
 * The Status Page's usage section: today's and the since-reset totals of this
 * window's sends, per model (src/utils/usageLedger.ts). A model without a
 * configured price (`anthropic.modelPrices`) or a Local LLM shows "no price"
 * rather than a cost of $0.
 *
 * vscode-free.
 */

import type { UsageRow, UsageSummary } from './usageLedger';

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const tokens = (n: number): string => n.toLocaleString('en-US');

function costCell(r: UsageRow): string {
    if (r.unpricedSends === r.sends) { return 'no price'; }
    const cost = `$${r.costUsd.toFixed(4)}`;
    return r.unpricedSends > 0 ? `${cost} (${r.unpricedSends} without a price)` : cost;
}

function table(title: string, rows: UsageRow[], totalUsd: number): string {
    if (rows.length === 0) {
        return `<div class="sp-settings-row"><label>${esc(title)}:</label><span>no sends</span></div>`;
    }
    const cell = 'style="text-align:right;padding:0 6px;"';
    const body = rows.map((r) =>
        `<tr><td>${esc(r.model)}</td><td ${cell}>${r.sends}</td><td ${cell}>${tokens(r.inputTokens)}</td><td ${cell}>${tokens(r.outputTokens)}</td>` +
        `<td ${cell}>${tokens(r.cacheReadInputTokens)}</td><td ${cell}>${tokens(r.cacheCreationInputTokens)}</td><td ${cell}>${costCell(r)}</td></tr>`,
    ).join('');
    return `<div class="sp-settings-row"><label>${esc(title)}: $${totalUsd.toFixed(4)}</label></div>
        <table class="sp-usage-table" style="font-size:0.9em;border-collapse:collapse;margin:2px 0 8px 0;">
        <tr><th style="text-align:left;">model</th><th ${cell}>sends</th><th ${cell}>in</th><th ${cell}>out</th><th ${cell}>cache read</th><th ${cell}>cache write</th><th ${cell}>cost</th></tr>
        ${body}</table>`;
}

/** The section's HTML; `summary` undefined renders nothing (the ledger is not registered). */
export function usageSectionHtml(summary: UsageSummary | undefined): string {
    if (!summary) { return ''; }
    const since = summary.resetAt.slice(0, 16).replace('T', ' ');
    const content = summary.sinceReset.length === 0
        ? '<div class="sp-settings-row"><span>No usage recorded since ' + esc(since) + '.</span></div>'
        : table('Today', summary.today, summary.todayCostUsd) + table(`Since ${since}`, summary.sinceReset, summary.sinceResetCostUsd);
    return `<div class="sp-section" data-section="usage">
        <div class="sp-section-header"><span class="sp-section-title">📊 Usage and cost</span></div>
        ${content}
        <div class="sp-settings-row"><label>Costs from <code>anthropic.modelPrices</code>; the Agent SDK reports its own.</label>
            <div class="sp-controls"><button class="sp-btn" data-status-action="resetUsage" title="Start the since-reset totals again (this window's workspace)">Reset</button></div></div>
    </div>`;
}
