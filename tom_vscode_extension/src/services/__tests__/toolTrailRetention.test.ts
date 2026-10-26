/**
 * The tool loop's retention step (src/services/toolTrailRetention.ts) and extended thinking.
 *
 *   TR-1 thinking on: a tool loop of more rounds than keepRounds (a fake model whose every assistant
 *        turn carries a signed thinking block) — after each round, every message before the last
 *        assistant turn is byte-identical to what was sent before; only the round just added is cut,
 *        once, to the inline length. The API would otherwise refuse the request: "Invalid `signature`
 *        in `thinking` block. The block is bound to a different conversation."
 *   TR-2 thinking off: as before — the newest keepRounds rounds inline (cut), older ones stubbed, the
 *        tool_use / tool_result pairing kept
 *   TR-3 the handler: the step runs with freezeEarlierRounds = thinking on
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ToolTrail, type ToolTrailEntry } from '../tool-trail.js';
import { applyToolTrailRetention, type RetentionMessage } from '../toolTrailRetention.js';

const ROUNDS = 6;
const KEEP = 2;
const INLINE = 120;

/** A fake tool loop: `rounds` rounds of thinking + tool_use, each answered with a long tool result. */
function runLoop(thinking: boolean, onRound: (messages: RetentionMessage[], round: number) => void): RetentionMessage[] {
    const trail = new ToolTrail({ keepRounds: KEEP, inlineMaxChars: INLINE });
    const byId = new Map<string, ToolTrailEntry>();
    const messages: RetentionMessage[] = [{ role: 'user', content: 'do the work' }];
    for (let round = 1; round <= ROUNDS; round++) {
        const id = `toolu_${round}`;
        messages.push({
            role: 'assistant',
            content: [
                ...(thinking ? [{ type: 'thinking', thinking: `plan ${round}`, signature: `sig-over-${messages.length}-messages` }] : []),
                { type: 'tool_use', id, name: 'tomAi_readFile', input: { path: `f${round}` } },
            ],
        });
        const result = `result ${round} `.repeat(40);
        byId.set(id, trail.add({ timestamp: '00:00:00', round, toolName: 'tomAi_readFile', inputSummary: `f${round}`, result, durationMs: 1 }));
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] });
        applyToolTrailRetention(messages, trail, (toolUseId) => byId.get(toolUseId),
            { keepRounds: KEEP, inlineMaxChars: INLINE, freezeEarlierRounds: thinking });
        onRound(messages, round);
    }
    return messages;
}

const resultOf = (m: RetentionMessage): string => String((m.content as Array<{ content: string }>)[0].content);

describe('tool-trail retention and extended thinking', () => {
    test('TR-1: thinking on — nothing before the last assistant turn changes', () => {
        let sent: string[] = [];
        runLoop(true, (messages, round) => {
            const now = messages.map((m) => JSON.stringify(m));
            const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
            for (let i = 0; i < Math.min(lastAssistant, sent.length); i++) {
                assert.equal(now[i], sent[i], `round ${round}: message ${i} was rewritten after it was sent`);
            }
            // Everything already sent stays as sent, including the previous round's results.
            assert.deepEqual(now.slice(0, sent.length), sent, `round ${round}`);
            const newest = resultOf(messages[messages.length - 1]);
            assert.match(newest, /^\[Truncated inline view: 120\//, 'the round just added is cut once, before the model sees it');
            sent = now;
        });
        assert.ok(ROUNDS > KEEP + 1, 'more rounds than keepRounds');
    });

    test('TR-2: thinking off — older rounds are stubbed', () => {
        const messages = runLoop(false, () => undefined);
        const results = messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).map(resultOf);
        assert.equal(results.length, ROUNDS);
        for (const old of results.slice(0, ROUNDS - KEEP)) {
            assert.match(old, /^\[Past tool call t\d+ — tomAi_readFile\(f\d\) — \d+ chars\. Use tomAi_readPastToolResult/);
        }
        for (const kept of results.slice(ROUNDS - KEEP)) { assert.match(kept, /^\[Truncated inline view/); }
        const pairs = messages.flatMap((m) => (Array.isArray(m.content) ? m.content as Array<{ type: string; id?: string; tool_use_id?: string }> : []));
        assert.deepEqual(pairs.filter((b) => b.type === 'tool_use').map((b) => b.id), pairs.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id),
            'every tool_use keeps its tool_result');
    });

    test('TR-3: the handler freezes earlier rounds while thinking is on', () => {
        const handler = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.match(handler, /this\.applyToolTrailRetentionPolicy\(messages, caps, thinkingBlock !== undefined\);/);
        assert.match(handler, /freezeEarlierRounds: thinkingEnabled/);
        assert.doesNotMatch(handler, /tt\.renderStub\(/, 'the stubbing lives in the shared step only');
    });
});
