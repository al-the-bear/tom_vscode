/**
 * The Status Page's usage section (src/utils/usageSection.ts) and its wiring.
 *
 *   US-1 today and since-reset rows per model: sends, tokens, cost; an unpriced model says so
 *        instead of showing $0; a Reset button posts `resetUsage`
 *   US-2 no recorded send: one line saying so, no tables
 *   US-3 model names are escaped
 *   US-4 wired: the ledger service records live-trail `usage` events into the workspace state; the
 *        Status Page gathers the summary, renders the section and handles `resetUsage`; activation
 *        registers the service
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { usageSectionHtml } from '../usageSection';
import { emptyUsageLedger, recordUsage, summarizeUsage } from '../usageLedger';
import { directSendUsage, localLlmSendUsage } from '../usageCost';

const now = new Date(2026, 10, 4, 12, 0);
const prices = [{ model: 'claude-haiku', inputPerMTok: 1, outputPerMTok: 5 }];

describe('Status Page usage section', () => {
    test('US-1: rows, unpriced models, reset', () => {
        let ledger = emptyUsageLedger(new Date(2026, 10, 1));
        ledger = recordUsage(ledger, directSendUsage('claude-haiku-5-5', { inputTokens: 2000, outputTokens: 500 }, prices), now);
        ledger = recordUsage(ledger, localLlmSendUsage('qwen3:32b', { inputTokens: 300, outputTokens: 40 }), now);
        const html = usageSectionHtml(summarizeUsage(ledger, now));
        assert.match(html, /data-section="usage"/);
        assert.match(html, /Today/);
        assert.match(html, /Since /);
        assert.match(html, /claude-haiku-5-5<\/td><td[^>]*>1<\/td><td[^>]*>2,000<\/td><td[^>]*>500<\/td>/);
        assert.match(html, /\$0\.0045/);
        assert.match(html, /qwen3:32b<\/td>.*no price/);
        assert.match(html, /data-status-action="resetUsage"/);
    });

    test('US-2: nothing recorded yet', () => {
        const html = usageSectionHtml(summarizeUsage(emptyUsageLedger(now), now));
        assert.match(html, /No usage recorded/);
        assert.doesNotMatch(html, /<table/);
    });

    test('US-3: escaped', () => {
        const ledger = recordUsage(emptyUsageLedger(now), localLlmSendUsage('<b>x</b>', { inputTokens: 1 }), now);
        assert.doesNotMatch(usageSectionHtml(summarizeUsage(ledger, now)), /<b>x<\/b>/);
    });

    test('US-4: wired', () => {
        const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', 'src', ...p), 'utf-8');
        const service = src('services', 'usageLedgerService.ts');
        assert.match(service, /LiveTrailWriter\.addObserver\(/);
        assert.match(service, /kind === 'usage'/);
        assert.match(service, /workspaceState/);
        const page = src('handlers', 'statusPage-handler.ts');
        assert.match(page, /usageSectionHtml\(/);
        assert.match(page, /case 'resetUsage'/);
        assert.match(src('extension.ts'), /registerUsageLedger\(context\)/);
    });
});
