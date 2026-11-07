/**
 * Prompt caching on the direct Anthropic transport (ccparity_a_directapi-1,
 * decided in CC-5 (a) and CC-56 (a)): besides the system prompt, the tool
 * definitions and the conversation are marked cacheable, and the cache reads
 * and writes show in the usage a send reports.
 *
 *   PC-1 the last tool definition carries the breakpoint; the input array and its tools are not touched
 *   PC-2 the last cacheable block of the last message carries it: a string becomes a text block, thinking and
 *        empty text blocks are passed over, an earlier message is used only when the last holds nothing markable
 *   PC-3 over a growing tool loop the request carries system, tools and last message — three breakpoints every
 *        round, never more than Anthropic's four, because the stored conversation is never marked
 *   PC-4 caching off: no breakpoint anywhere
 *   PC-5 usage is summed over the rounds, cache reads and writes included; a null field counts as zero
 *   PC-6 the direct send uses all of it: the marked tools and messages go into the request and the dump, every
 *        response's usage is added round by round, and the totals go to the live trail and the send result
 *   PC-7 live (needs ANTHROPIC_API_KEY): a second identical request reads the prefix from the cache
 */

/* eslint-disable @typescript-eslint/naming-convention -- the Messages API's snake_case wire fields */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import {
    MAX_CACHE_BREAKPOINTS,
    addResponseUsage,
    applyPromptCaching,
    countCacheBreakpoints,
    withLastMessageCacheBreakpoint,
    withToolsCacheBreakpoint,
} from '../anthropicPromptCache.js';
import { createMessageStreamed } from '../../services/anthropicMessageCall.js';

type Msg = Anthropic.MessageParam;

const tool = (name: string): Anthropic.Tool => ({
    name,
    description: `the ${name} tool`,
    input_schema: { type: 'object', properties: {} },
});

const systemWithBreakpoint: Anthropic.TextBlockParam[] = [
    { type: 'text', text: 'role' },
    { type: 'text', text: 'quest', cache_control: { type: 'ephemeral' } },
];

describe('anthropicPromptCache', () => {
    test('PC-1: the last tool carries the breakpoint, the input is untouched', () => {
        const tools = [tool('a'), tool('b'), tool('c')];
        const marked = withToolsCacheBreakpoint(tools);
        assert.deepEqual(marked[2].cache_control, { type: 'ephemeral' });
        assert.equal(marked[0].cache_control, undefined);
        assert.equal(marked[1].cache_control, undefined);
        assert.equal(tools[2].cache_control, undefined, 'the input tool is not mutated');
        assert.notEqual(marked, tools);
        assert.deepEqual(withToolsCacheBreakpoint([]), []);
    });

    test('PC-2: the last markable block of the conversation carries the breakpoint', () => {
        // String content becomes one text block.
        const s = withLastMessageCacheBreakpoint<Msg>([{ role: 'user', content: 'hello' }]);
        assert.deepEqual(s[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);

        // Tool results: the last one is marked.
        const toolResults: Msg[] = [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
            {
                role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 't1', content: 'one' },
                    { type: 'tool_result', tool_use_id: 't2', content: 'two' },
                ],
            },
        ];
        const r = withLastMessageCacheBreakpoint(toolResults);
        const last = r[2].content as Anthropic.ToolResultBlockParam[];
        assert.deepEqual(last[1].cache_control, { type: 'ephemeral' });
        assert.equal(last[0].cache_control, undefined);
        assert.equal((toolResults[2].content as Anthropic.ToolResultBlockParam[])[1].cache_control, undefined,
            'the stored block is not mutated');
        assert.equal(r[0], toolResults[0], 'unmarked messages are shared, not copied');

        // Thinking and empty text blocks are passed over.
        const thinking: Msg[] = [{
            role: 'assistant', content: [
                { type: 'text', text: 'answer' },
                { type: 'thinking', thinking: 'hm', signature: 'sig' },
                { type: 'text', text: '' },
            ],
        }];
        const t = withLastMessageCacheBreakpoint(thinking)[0].content as Anthropic.ContentBlockParam[];
        assert.deepEqual((t[0] as Anthropic.TextBlockParam).cache_control, { type: 'ephemeral' });
        assert.equal(countCacheBreakpoints({ messages: withLastMessageCacheBreakpoint(thinking) }), 1);

        // Nothing markable in the last message: the one before it.
        const fallback: Msg[] = [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
        ];
        const f = withLastMessageCacheBreakpoint(fallback);
        assert.deepEqual(f[0].content, [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }]);
        assert.equal(f[1], fallback[1]);

        assert.deepEqual(withLastMessageCacheBreakpoint<Msg>([]), []);
    });

    test('PC-3: a growing tool loop carries three breakpoints every round, never more than four', () => {
        const tools = [tool('a'), tool('b')];
        const messages: Msg[] = [{ role: 'user', content: 'start' }];
        for (let round = 0; round < 12; round++) {
            const req = applyPromptCaching({ tools, messages }, true);
            const n = countCacheBreakpoints({ system: systemWithBreakpoint, tools: req.tools, messages: req.messages });
            assert.equal(n, 3, `round ${round}: system, tools and the last message`);
            assert.ok(n <= MAX_CACHE_BREAKPOINTS);
            const last = req.messages[req.messages.length - 1];
            assert.ok(Array.isArray(last.content));
            // The handler then appends the round to its stored conversation.
            messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${round}`, name: 'a', input: {} }] });
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${round}`, content: 'ok' }] });
        }
        assert.equal(countCacheBreakpoints({ tools, messages }), 0, 'the stored tools and conversation stay unmarked');
    });

    test('PC-4: caching off marks nothing', () => {
        const req = applyPromptCaching({ tools: [tool('a')], messages: [{ role: 'user', content: 'x' } as Msg] }, false);
        assert.equal(countCacheBreakpoints(req), 0);
        assert.equal(req.messages[0].content, 'x');
    });

    test('PC-5: usage is summed over the rounds, cache fields included', () => {
        let totals = addResponseUsage({}, {
            input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3000, cache_read_input_tokens: null,
        });
        totals = addResponseUsage(totals, {
            input_tokens: 4, output_tokens: 7, cache_creation_input_tokens: 120, cache_read_input_tokens: 3000,
        });
        totals = addResponseUsage(totals, undefined);
        assert.deepEqual(totals, {
            inputTokens: 14, outputTokens: 12, cacheCreationInputTokens: 3120, cacheReadInputTokens: 3000,
        });
        assert.deepEqual(addResponseUsage({}, null), {});
    });

    test('PC-6: the direct send marks tools and conversation and reports the usage', () => {
        const root = join(__dirname, '..', '..', '..');
        const src = readFileSync(join(root, 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        const start = src.indexOf("endpoint: 'client.messages.stream (direct SDK)'");
        assert.ok(start > 0, 'the direct send dumps its request');
        const loop = src.slice(src.lastIndexOf('const requestTools', start), src.indexOf('private ', start));
        assert.match(loop, /const requestTools = effectiveCaching \? withToolsCacheBreakpoint\(anthropicTools\)/);
        assert.match(loop, /effectiveCaching \? withLastMessageCacheBreakpoint\(messages\) : messages/);
        // The dump, the request body and each attempt after a dropped connection
        // (rebuilt with the continuation prompt, CC-8) use the marked tools and messages.
        assert.equal((loop.match(/tools: requestTools/g) ?? []).length, 2);
        assert.equal((loop.match(/messages: requestMessages\(\)/g) ?? []).length, 3);
        assert.doesNotMatch(loop, /\? \{ tools: anthropicTools \}/, 'no request goes out with the unmarked tools');
        // Every response's usage is added as it arrives, round by round (DirectSendUsage, UC-9..12).
        assert.match(loop, /sendUsage\.addRound\(addResponseUsage\(\{\}, response\.usage\)\)/);
        // The block carries the model line and its cost (usageCost.ts, UC-3), summed over the rounds.
        assert.match(loop, /const block = sendUsage\.sendUsage\(\);/);
        assert.match(loop, /liveTrail\?\.appendUsage\(block\)/);
        // Every way the loop ends with an answer reports the usage.
        const finals = loop.match(/return (withUsage\()?this\.finalize\(/g) ?? [];
        assert.ok(finals.length >= 2);
        assert.ok(finals.every((f) => f.includes('withUsage')), 'every finalize returns the usage');
    });

    // PC-7 costs a few cents and needs a key, so it runs only where one is set.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    test('PC-7: live — a second identical request reads the prefix from the cache', {
        skip: apiKey ? false : 'NOT MEASURED: ANTHROPIC_API_KEY is not set',
        timeout: 120_000,
    }, async () => {
        const client = new Anthropic({ apiKey });
        const model = process.env.ANTHROPIC_CACHE_TEST_MODEL ?? 'claude-haiku-4-5';
        // Above every model's minimum cacheable prefix (up to 4096 tokens).
        const filler = Array.from({ length: 900 }, (_, i) => `Fact ${i}: the value of item ${i} is ${i * 7}.`).join(' ');
        const system: Anthropic.TextBlockParam[] = [
            { type: 'text', text: `PC-7 ${Date.now()} ${filler}`, cache_control: { type: 'ephemeral' } },
        ];
        const req = applyPromptCaching({
            tools: [tool('lookup')],
            messages: [{ role: 'user', content: 'Reply with the single word OK.' } as Msg],
        }, true);
        const params = { model, max_tokens: 16, system, tools: req.tools, messages: req.messages };
        assert.equal(countCacheBreakpoints(params), 3);
        const first = await createMessageStreamed(client, params);
        const second = await createMessageStreamed(client, params);
        assert.ok((first.usage.cache_creation_input_tokens ?? 0) > 0, 'the first request writes the cache');
        assert.ok((second.usage.cache_read_input_tokens ?? 0) > 0, 'the second request reads it');
        const totals = addResponseUsage(addResponseUsage({}, first.usage), second.usage);
        assert.ok((totals.cacheReadInputTokens ?? 0) > 0);
    });
});
