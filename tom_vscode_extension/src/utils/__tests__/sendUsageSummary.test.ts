/**
 * A send's token usage where the send is watched (src/utils/usageCost.ts, media/chatPanel/main.js,
 * media/shared/queueEntryRenderFunctions.js).
 *
 *   SU-1 the summary line from a usage object: input / output / cache read / cache write, a missing field as 0;
 *        none without counts
 *   SU-2 a queue item's usage summed over its stages; a stage without usage leaves it; the line names the stages
 *   SU-3 a fresh start of the item resets the sum
 *   SU-4 the @CHAT ANTHROPIC/LLM status shows the line after an answer, and no usage part without one
 *   SU-5 the queue editor shows an item's line; an item without usage shows none
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { addStageUsage, itemUsageSummaryLine, usageSummaryLine } from '../usageCost';
import { resetItemRunState, type RunStateItem } from '../queueSendNow';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

describe('send usage summary', () => {
    test('SU-1: the line from a usage object', () => {
        assert.equal(
            usageSummaryLine({ inputTokens: 1234, outputTokens: 56, cacheReadInputTokens: 789012, cacheCreationInputTokens: 3456 }),
            'in 1,234 · out 56 · cache read 789,012 · cache write 3,456',
        );
        assert.equal(usageSummaryLine({ inputTokens: 10, outputTokens: 2 }), 'in 10 · out 2 · cache read 0 · cache write 0',
            'a cache miss reads as cache read 0');
        assert.equal(usageSummaryLine({}), undefined);
        assert.equal(usageSummaryLine(undefined), undefined);
    });

    test('SU-2: a queue item sums its stages', () => {
        let sum = addStageUsage(undefined, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5000 });
        sum = addStageUsage(sum, undefined);
        sum = addStageUsage(sum, {});
        sum = addStageUsage(sum, { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 700 });
        assert.deepEqual(sum, {
            totals: { inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 5000, cacheCreationInputTokens: 700 },
            stages: 2,
        });
        assert.equal(itemUsageSummaryLine(sum), 'in 150 · out 30 · cache read 5,000 · cache write 700 (2 stages)');
        assert.equal(itemUsageSummaryLine(addStageUsage(undefined, { inputTokens: 1 })), 'in 1 · out 0 · cache read 0 · cache write 0 (1 stage)');
        assert.equal(itemUsageSummaryLine(undefined), undefined);
    });

    test('SU-3: a fresh start resets the sum', () => {
        const item: RunStateItem = { sendUsage: { totals: { inputTokens: 1 }, stages: 1 } };
        resetItemRunState(item);
        assert.equal(item.sendUsage, undefined);
    });

    test('SU-4: the ANTHROPIC/LLM status line', (t) => {
        const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        w.__INIT__ = {};
        w.eval(media('chatPanel', 'main.js'));
        const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data }));
        const status = () => w.document.getElementById('anthropic-status').textContent as string;
        send({ type: 'anthropicResult', text: 'a', turnsUsed: 1, toolCallCount: 2, historyMode: 'full',
            usageLine: usageSummaryLine({ inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 40000, cacheCreationInputTokens: 0 }) });
        assert.match(status(), /last 2 tool calls · 1 session turns · in 1,200 · out 80 · cache read 40,000 · cache write 0$/);
        send({ type: 'anthropicResult', text: 'b', turnsUsed: 1, toolCallCount: 0, historyMode: 'full' });
        assert.match(status(), /2 session turns$/, 'no usage part without usage');
    });

    test('SU-5: the queue editor shows an item\'s usage', (t) => {
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        const base = { type: 'normal', template: '(None)', createdAt: '2026-11-07T10:00:00.000Z', status: 'sending', originalText: 'p', expandedText: 'p' };
        w.__INIT__ = {
            state: { items: [
                { ...base, id: 'u', sendUsageLine: 'in 150 · out 30 · cache read 5,000 · cache write 700 (2 stages)' },
                { ...base, id: 'n', status: 'pending' },
            ], autoSend: false },
            queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
            addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
        };
        w.eval([
            media('shared', 'queueEntryUtils.js'),
            media('shared', 'queueEntryRenderFunctions.js'),
            media('shared', 'queueEntryMessageHandlers.js'),
            media('queueEditor', 'main.js'),
        ].join('\n;\n'));
        const headers = [...w.document.querySelectorAll('.queue-item .item-header')].map((h: Win) => h.textContent as string);
        assert.equal(headers.length, 2);
        assert.match(headers[0], /\[Σ in 150 · out 30 · cache read 5,000 · cache write 700 \(2 stages\)\]/);
        assert.doesNotMatch(headers[1], /Σ/);
    });
});
