/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (tool_use_id) */
/**
 * Tool-trail retention together with the conversation cache of the direct
 * API (src/services/toolTrailRetention.ts, finishvsf6).
 *
 * The direct transport caches the conversation up to the newest turn; a cache
 * read costs 0.1× the input price, a write 1.25×. Retention used to stub the
 * round `keepRounds` back after EVERY round, which rewrote a message inside the
 * cached prefix every round: each round then read the cache only up to that
 * message and wrote everything after it again. Decided (finishvsf6, option a):
 * with caching on, earlier rounds stay as sent until a collapse threshold —
 * `collapseRounds` rounds kept whole, or `collapseChars` characters of results
 * — and then every round but the newest `keepRounds` is stubbed at once. The
 * prefix changes once per batch.
 *
 *   TC-1 caching on: a 100-round loop rewrites an already-sent message exactly at the collapses
 *        (keep 2, collapse 30 → rounds 31, 60, 89), and after a collapse the newest keepRounds rounds
 *        are inline, every older one a stub
 *   TC-2 caching on, the character threshold: results of 10 000 chars, collapseChars 50 000 → a
 *        collapse once the inline results pass 50 000 characters, long before collapseRounds
 *   TC-3 caching off: as before — every round past keepRounds is stubbed at once (a rewrite each round)
 *   TC-4 a round just added is cut to the inline length once; a second pass leaves it alone
 *        (the cut is not nested, so a message the cache holds does not change)
 *   TC-5 collapseRounds below keepRounds is read as keepRounds (no collapse can keep fewer)
 *   TC-6 the caps: compaction defaults, a configuration's override, the handler passing caching
 *   TC-7 the Status Page: a configuration's own values are listed (⚙) and the wizard keeps the ones it
 *        does not ask for; the defaults have their fields
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ToolTrail, type ToolTrailEntry } from '../tool-trail.js';
import { configurationOverrides } from '../../utils/configurationOverrides.js';
import { applyToolTrailRetention, resolveRetentionCaps, type RetentionMessage, type RetentionOptions } from '../toolTrailRetention.js';

interface LoopResult { messages: RetentionMessage[]; rewrites: number[] }

/** A tool loop of `rounds` rounds; `rewrites` lists the rounds after which an already-sent message changed. */
function runLoop(rounds: number, options: RetentionOptions, resultChars = 400): LoopResult {
    const trail = new ToolTrail({ keepRounds: options.keepRounds, inlineMaxChars: options.inlineMaxChars });
    const byId = new Map<string, ToolTrailEntry>();
    const messages: RetentionMessage[] = [{ role: 'user', content: 'do the work' }];
    const rewrites: number[] = [];
    let sent: string[] = [];
    for (let round = 1; round <= rounds; round++) {
        const id = `toolu_${round}`;
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'tomAi_readFile', input: { path: `f${round}` } }] });
        const result = `r${round} `.padEnd(resultChars, 'x');
        byId.set(id, trail.add({ timestamp: '00:00:00', round, toolName: 'tomAi_readFile', inputSummary: `f${round}`, result, durationMs: 1 }));
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] });
        applyToolTrailRetention(messages, trail, (toolUseId) => byId.get(toolUseId), options);
        const now = messages.map((m) => JSON.stringify(m));
        // The messages the previous request sent, minus its newest round (cut on arrival, before it was sent).
        if (sent.some((s, i) => now[i] !== s)) { rewrites.push(round); }
        sent = now;
    }
    return { messages, rewrites };
}

const results = (messages: RetentionMessage[]): string[] => messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .map((m) => String((m.content as Array<{ content: string }>)[0].content));

const isStub = (s: string): boolean => s.startsWith('[Past tool call ');

describe('tool-trail retention with the conversation cache', () => {
    test('TC-1: caching on — the prefix changes only at the collapses', () => {
        const { messages, rewrites } = runLoop(100, { keepRounds: 2, inlineMaxChars: 1000, cachingEnabled: true, collapseRounds: 30, collapseChars: 10_000_000 });
        assert.deepEqual(rewrites, [31, 60, 89]);
        const r = results(messages);
        // After the collapse at round 89, rounds 88 and 89 stayed inline, then 90 … 100 were added.
        assert.ok(r.slice(0, 87).every(isStub), 'every round before the last collapse is a stub');
        assert.ok(r.slice(87).every((s) => !isStub(s)), 'the newest keepRounds rounds of the collapse and every later one are inline');
    });

    test('TC-2: caching on — the character threshold collapses first', () => {
        const { rewrites } = runLoop(20, { keepRounds: 2, inlineMaxChars: 20_000, cachingEnabled: true, collapseRounds: 30, collapseChars: 50_000 }, 10_000);
        // 10 000 chars a round: past 50 000 at round 6 → stub down to 2 rounds; past again at round 10, 14, 18.
        assert.deepEqual(rewrites, [6, 10, 14, 18]);
    });

    test('TC-3: caching off — every round past keepRounds is stubbed', () => {
        const { rewrites } = runLoop(10, { keepRounds: 2, inlineMaxChars: 1000, cachingEnabled: false, collapseRounds: 30, collapseChars: 10_000_000 });
        assert.deepEqual(rewrites, [3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('TC-4: a cut result is cut once', () => {
        const { messages } = runLoop(3, { keepRounds: 2, inlineMaxChars: 100, cachingEnabled: true, collapseRounds: 30, collapseChars: 10_000_000 }, 400);
        const before = JSON.stringify(messages);
        const trail = new ToolTrail({ keepRounds: 2, inlineMaxChars: 100 });
        applyToolTrailRetention(messages, trail, () => ({ key: 'tX', toolName: 'tomAi_readFile', inputSummary: 'f', result: 'y'.repeat(400) } as ToolTrailEntry),
            { keepRounds: 2, inlineMaxChars: 100, cachingEnabled: true, collapseRounds: 30, collapseChars: 10_000_000 });
        assert.equal(JSON.stringify(messages), before);
        assert.equal(results(messages).filter((s) => s.startsWith('[Truncated inline view: ')).length, 3);
    });

    test('TC-5: collapseRounds below keepRounds', () => {
        const { rewrites } = runLoop(8, { keepRounds: 4, inlineMaxChars: 1000, cachingEnabled: true, collapseRounds: 1, collapseChars: 10_000_000 });
        assert.deepEqual(rewrites, [5, 6, 7, 8]);
    });

    test('TC-6: defaults, overrides and the handler', () => {
        const defaults = resolveRetentionCaps({}, undefined);
        assert.deepEqual(defaults, { toolTrailMaxResultChars: 30_000, toolTrailKeepRounds: 2, toolTrailCollapseRounds: 30, toolTrailCollapseChars: 300_000 });
        const section = { toolTrailMaxResultChars: 1000, toolTrailKeepRounds: 3, toolTrailCollapseRounds: 40, toolTrailCollapseChars: 200_000 };
        assert.deepEqual(resolveRetentionCaps(section, undefined), section);
        assert.deepEqual(resolveRetentionCaps(section, { toolTrailCollapseRounds: 10 }), { ...section, toolTrailCollapseRounds: 10 });
        const handler = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.match(handler, /cachingEnabled: caps\.cachingEnabled/);
        assert.match(handler, /resolveRetentionCaps\(/);
    });

    test('TC-7: the Status Page marks and keeps a configuration\'s own values', () => {
        assert.deepEqual(configurationOverrides({ id: 'x', model: 'm', toolTrailCollapseRounds: 40, rawTurnsKept: 6, maxTokens: 9 }),
            [{ key: 'rawTurnsKept', value: 6 }, { key: 'toolTrailCollapseRounds', value: 40 }]);
        assert.deepEqual(configurationOverrides({ id: 'y', model: 'm' }), []);
        const page = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'statusPage-handler.ts'), 'utf-8');
        assert.match(page, /\.\.\.retentionOverrides,/);
        assert.match(page, /'historyMaxChars', 'memoryMaxChars', 'rawTurnsKept'\] as const\)\.reduce/);
        assert.match(page, /const customMark = c\.overrides\.length > 0/);
        assert.match(page, /id="sp-comp-toolTrailCollapseRounds"/);
        assert.match(page, /id="sp-comp-toolTrailCollapseChars"/);
        const listeners = readFileSync(join(__dirname, '..', '..', '..', 'media', 'statusPage', 'listeners.js'), 'utf-8');
        assert.match(listeners, /toolTrailCollapseRounds: parseInt/);
    });
});
