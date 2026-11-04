/**
 * Usage and cost of a send on every transport (src/utils/usageCost.ts,
 * src/utils/usageLedger.ts).
 *
 * Only the Agent SDK reported usage and cost in the live trail; direct sends
 * summed their tokens but priced nothing, Local LLM sends reported nothing, and
 * the Status Page showed no totals (ccparity_a_directapi-3).
 *
 *   UC-1 a model's price: its exact entry, else the longest entry it starts with; none → no price
 *   UC-2 cost per million tokens: input, output, cache read and cache write; cache prices default to
 *        0.1× and 1.25× the input price
 *   UC-3 a direct send's usage: totals, one model line with its cost and the total; an unpriced
 *        model keeps its tokens and has no cost
 *   UC-4 a Local LLM send's usage: tokens only, never a cost
 *   UC-5 token counts add up over rounds; Local LLM stats (prompt / completion tokens) map onto them
 *   UC-6 the ledger: today's and since-reset totals per model, cost summed, sends without a price
 *        counted; a reset starts the since-reset totals again
 *   UC-7 the ledger keeps a bounded number of days
 *   UC-8 the live-trail block of a priced direct send names the model and its cost
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    addTokenCounts, costOf, directSendUsage, localLlmSendUsage, priceFor, tokensFromLocalStats, type ModelPrice,
} from '../usageCost';
import { emptyUsageLedger, MAX_LEDGER_DAYS, recordUsage, resetUsageLedger, summarizeUsage } from '../usageLedger';
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

// live-trail.ts imports vscode; the shared stub stands in for it.
installVscodeStub({ workspaceFolders: [] });
import { formatLiveTrailUsage } from '../../services/live-trail';

const PRICES: ModelPrice[] = [
    { model: 'claude-opus-5', inputPerMTok: 10, outputPerMTok: 50 },
    { model: 'claude-opus-5-5', inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1, cacheWritePerMTok: 20 },
    { model: 'claude-haiku', inputPerMTok: 1, outputPerMTok: 5 },
];

describe('usage and cost', () => {
    test('UC-1: exact entry, else the longest prefix', () => {
        assert.equal(priceFor('claude-opus-5-5', PRICES)?.inputPerMTok, 15, 'exact');
        assert.equal(priceFor('claude-opus-5-1', PRICES)?.inputPerMTok, 10, 'prefix claude-opus-5');
        assert.equal(priceFor('claude-haiku-5-5', PRICES)?.inputPerMTok, 1);
        assert.equal(priceFor('claude-sonnet-5-5', PRICES), undefined);
        assert.equal(priceFor('claude-opus-5-5', undefined), undefined);
    });

    test('UC-2: cost per million tokens, cache prices defaulted', () => {
        const counts = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 400_000 };
        // 10 + 0.1*50 + 2*(0.1*10) + 0.4*(1.25*10) = 10 + 5 + 2 + 5
        assert.equal(costOf(counts, PRICES[0]), 22);
        // explicit cache prices: 15 + 7.5 + 2*1 + 0.4*20
        assert.equal(costOf(counts, PRICES[1]), 32.5);
        assert.equal(costOf({}, PRICES[0]), 0);
    });

    test('UC-3: a direct send, priced and unpriced', () => {
        const totals = { inputTokens: 2000, outputTokens: 500, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 0 };
        const priced = directSendUsage('claude-haiku-5-5', totals, PRICES);
        assert.deepEqual(priced.totals, totals);
        assert.equal(priced.models?.length, 1);
        assert.equal(priced.models?.[0].model, 'claude-haiku-5-5');
        // 2000*1 + 500*5 + 10000*0.1 = 2000 + 2500 + 1000 = 5500 per million
        assert.equal(priced.models?.[0].costUSD, 0.0055);
        assert.equal(priced.totalCostUsd, 0.0055);
        const unpriced = directSendUsage('claude-sonnet-5-5', totals, PRICES);
        assert.equal(unpriced.models?.[0].costUSD, undefined);
        assert.equal(unpriced.totalCostUsd, undefined);
        assert.deepEqual(unpriced.totals, totals);
    });

    test('UC-4: a Local LLM send has tokens, never a cost', () => {
        const u = localLlmSendUsage('qwen3:32b', { inputTokens: 300, outputTokens: 40 });
        assert.deepEqual(u.totals, { inputTokens: 300, outputTokens: 40 });
        assert.deepEqual(u.models, [{ model: 'qwen3:32b', inputTokens: 300, outputTokens: 40 }]);
        assert.equal(u.totalCostUsd, undefined);
    });

    test('UC-5: counts add up; Local LLM stats map onto them', () => {
        assert.deepEqual(addTokenCounts({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 10, cacheReadInputTokens: 5 }),
            { inputTokens: 11, outputTokens: 2, cacheReadInputTokens: 5 });
        assert.deepEqual(tokensFromLocalStats({ promptTokens: 120, completionTokens: 30 }), { inputTokens: 120, outputTokens: 30 });
        assert.deepEqual(tokensFromLocalStats(undefined), {});
    });

    test('UC-6: the ledger: today, since reset, unpriced sends, reset', () => {
        const day1 = new Date(2026, 10, 3, 10, 0);
        const day2 = new Date(2026, 10, 4, 9, 0);
        let ledger = emptyUsageLedger(new Date(2026, 10, 1));
        ledger = recordUsage(ledger, directSendUsage('claude-haiku-5-5', { inputTokens: 2000, outputTokens: 500 }, PRICES), day1);
        ledger = recordUsage(ledger, directSendUsage('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 0 }, PRICES), day2);
        ledger = recordUsage(ledger, localLlmSendUsage('qwen3:32b', { inputTokens: 300, outputTokens: 40 }), day2);
        ledger = recordUsage(ledger, { totals: { inputTokens: 5, outputTokens: 1 } }, day2);   // no model line
        const s = summarizeUsage(ledger, day2);
        const haikuAll = s.sinceReset.find((r) => r.model === 'claude-haiku-5-5')!;
        assert.equal(haikuAll.sends, 2);
        assert.equal(haikuAll.inputTokens, 3000);
        assert.equal(Number(haikuAll.costUsd.toFixed(6)), 0.0055);
        const haikuToday = s.today.find((r) => r.model === 'claude-haiku-5-5')!;
        assert.equal(haikuToday.sends, 1);
        const local = s.sinceReset.find((r) => r.model === 'qwen3:32b')!;
        assert.equal(local.unpricedSends, 1, 'a send without a cost is counted, not priced at 0');
        assert.ok(s.sinceReset.find((r) => r.model === '(unknown model)'));
        assert.equal(Number(s.sinceResetCostUsd.toFixed(6)), 0.0055);
        assert.equal(Number(s.todayCostUsd.toFixed(6)), 0.001);
        const after = summarizeUsage(resetUsageLedger(ledger, day2), day2);
        assert.deepEqual([after.today.length, after.sinceReset.length], [0, 0]);
    });

    test('UC-7: a bounded number of days is kept', () => {
        let ledger = emptyUsageLedger(new Date(2026, 0, 1));
        for (let d = 0; d < MAX_LEDGER_DAYS + 10; d++) {
            ledger = recordUsage(ledger, localLlmSendUsage('m', { inputTokens: 1 }), new Date(2026, 0, 1 + d));
        }
        assert.equal(Object.keys(ledger.days).length, MAX_LEDGER_DAYS);
    });

    test('UC-8: the live-trail block of a priced direct send', () => {
        const md = formatLiveTrailUsage(directSendUsage('claude-haiku-5-5', { inputTokens: 2000, outputTokens: 500 }, PRICES), new Date(2026, 10, 4, 9, 0));
        assert.match(md, /### 📊 usage/);
        assert.match(md, /- tokens: in 2,000 · out 500/);
        assert.match(md, /- cost: \$0\.0045/);
        assert.match(md, /\| claude-haiku-5-5 \| 2,000 \| 500 \|/);
    });
});
