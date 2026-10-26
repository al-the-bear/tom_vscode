/**
 * The history a request carries is bounded.
 *
 * Measured 2026-10-26 (quest al_the_bear): with compaction switched off the
 * round accumulator (`compaction_rounds.json`) is never cleared, and every
 * request sent accumulator ∪ rolling tail — 237 rounds — so `rawTurnsKept`
 * and `maxHistoryTokens` bounded nothing; a direct request failed with
 * "prompt is too long: 1055184 tokens > 1000000 maximum".
 *
 *   HB-1 compaction on: the union of accumulator and rolling tail, oldest first
 *   HB-2 compaction off: only the rolling tail (the accumulator is never compacted)
 *   HB-3 the newest rounds that fit maxHistoryTokens are kept, contiguous; a round that does
 *        not fit ends the history there; no cap (0, NaN) keeps everything
 *   HB-4 the handler builds every payload's history through the bound, and stores a round's
 *        user text as the user's prompt, not the wrapped message carrying the injected history
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { boundPayloadHistory, estimateTokens } from '../historyPayloadBound.js';

type Msg = { role: 'user' | 'assistant'; content: string };
const round = (n: number, size = 8): Msg[] => [
    { role: 'user', content: `u${n}`.padEnd(size, '.') },
    { role: 'assistant', content: `a${n}`.padEnd(size, '.') },
];

describe('boundPayloadHistory', () => {
    test('HB-1: compaction on: the union', () => {
        const out = boundPayloadHistory({ union: [round(1), round(2), round(3)], rollingTail: [round(3)], compactionDisabled: false, maxHistoryTokens: 0 });
        assert.deepEqual(out.map((m) => m.content.slice(0, 2)), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    });

    test('HB-2: compaction off: the rolling tail only', () => {
        const out = boundPayloadHistory({ union: [round(1), round(2), round(3)], rollingTail: [round(2), round(3)], compactionDisabled: true, maxHistoryTokens: 0 });
        assert.deepEqual(out.map((m) => m.content.slice(0, 2)), ['u2', 'a2', 'u3', 'a3']);
    });

    test('HB-3: the newest rounds that fit the token cap', () => {
        // each round: 2 messages x 400 chars = 800 chars ≈ 200 tokens
        const rounds = [round(1, 400), round(2, 400), round(3, 400)];
        const keep = (cap: number): string[] => boundPayloadHistory({ union: rounds, rollingTail: [], compactionDisabled: false, maxHistoryTokens: cap })
            .filter((m) => m.role === 'user').map((m) => m.content.slice(0, 2));
        assert.deepEqual(keep(450), ['u2', 'u3']);
        assert.deepEqual(keep(600), ['u1', 'u2', 'u3']);
        assert.deepEqual(keep(100), [], 'the newest round alone is too big: no history');
        const giantNewest = [round(1, 40), round(2, 40000)];
        assert.deepEqual(boundPayloadHistory({ union: giantNewest, rollingTail: [], compactionDisabled: false, maxHistoryTokens: 5000 }), [],
            'an oversized round ends the history; older rounds are not stitched past it');
        assert.equal(boundPayloadHistory({ union: rounds, rollingTail: [], compactionDisabled: false, maxHistoryTokens: Number.NaN }).length, 6);
        assert.equal(estimateTokens('x'.repeat(400)), 100);
    });

    test('HB-4: the handler wiring', () => {
        // out/services/__tests__ -> project root is three levels up.
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.ok(src.includes('boundPayloadHistory('), 'the handler bounds its payload history');
        for (const unbounded of [
            'rawTurns: this.rawTurns }\n                    : {}),\n                toolHistory',
            'const payloadHistory = options.isolated ? [] : this.rawTurns;',
            ': this.rawTurns.map((m) => ({',
            'for (const turn of this.rawTurns) {',
        ]) {
            assert.equal(src.includes(unbounded), false, `unbounded use left: ${unbounded.slice(0, 50)}`);
        }
        assert.equal(/const userMsg: ConversationMessage = \{ role: 'user', content: userContent \}/.test(src), false,
            'a stored round must not keep the wrapped message (it carries the injected raw turns)');
    });
});
