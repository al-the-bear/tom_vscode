/**
 * Server tool uses on the direct transport (srvtool1_akuj,
 * src/utils/serverToolUses.ts): a server tool use without its result block is
 * repaired, a paused turn goes on, a refused round is repaired and sent once
 * more — over the real Anthropic SDK and createMessageStreamed where a request
 * is involved.
 *
 *   ST-1 repair, tool search: an error result right after the unmatched use, a matched one untouched,
 *        the signed thinking block kept as it is (same object), the input not changed
 *   ST-2 repair, web search / web fetch / code execution: each gets its own result and error type
 *   ST-3 repairConversation: a result in a later message (the API's continuation) counts; repairs in place
 *   ST-4 pause_turn: the request is sent again with the assistant content last and no user message; the
 *        continued response goes on in the same assistant message
 *   ST-5 the 400 for a server tool use without its result is recognised; nothing else is
 *   ST-6 a refused round is repaired and sent once more (real SDK): the second request carries the error result
 *   ST-7 not retried: another error, nothing to repair; a second refusal is thrown
 *   ST-8 the live-trail lines of a result: the tools found, the pages, the error (the call's query is its input)
 *   ST-9 the direct loop wires it: repair around the continuation, pause_turn goes on, the Stop-hook and
 *        background continuations close the message first, no reminder after a pending server tool use
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import {
    appendAssistantContent, describeServerToolResult, hasPendingServerToolUse, isUnmatchedServerToolUseError,
    repairConversation, repairServerToolUses, sendWithServerToolRepair, unmatchedServerToolUses, type MessageLike,
} from '../serverToolUses';
import { createMessageStreamed } from '../../services/anthropicMessageCall';

/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields */
const THINKING = { type: 'thinking', thinking: 'I need a tool to write the plan.', signature: 'EqQBCkgIBxABGAIiQL…sig' };
const SEARCH = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'create file' } };
const CREATE = { type: 'tool_use', id: 'toolu_1', name: 'tomAi_createFile', input: { filePath: 'plan.md', content: 'x' } };
const REFUSAL = 'messages.1: `tool_search_tool_bm25` tool use with id `srvtoolu_1` was found without a corresponding `tool_search_tool_result` block';

const enc = new TextEncoder();
const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

type Block = Record<string, unknown>;

/** A streamed response holding `blocks`, stopped with `stop`. */
function streamOf(blocks: Block[], stop: string): Response {
    const body = new ReadableStream({
        start(c) {
            const put = (t: string, d: Record<string, unknown>) => c.enqueue(enc.encode(sse(t, d)));
            put('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
            blocks.forEach((b, index) => {
                if (b.type === 'text') {
                    put('content_block_start', { index, content_block: { type: 'text', text: '' } });
                    put('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
                } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
                    put('content_block_start', { index, content_block: { ...b, input: {} } });
                    put('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
                } else {
                    put('content_block_start', { index, content_block: b });
                }
                put('content_block_stop', { index });
            });
            put('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } });
            put('message_stop', {});
            c.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function refused(message: string): Response {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400, headers: { 'content-type': 'application/json' } });
}

/** A real SDK client whose fetch answers the script in turn, recording each request body. */
function client(script: Array<() => Response>) {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetch = async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return script[Math.min(bodies.length - 1, script.length - 1)]();
    };
    return { anthropic: new Anthropic({ apiKey: 'test', fetch: fetch as never, maxRetries: 0 }), bodies };
}

/** The conversation of the failed run: the prompt, a round whose server tool use has no result, its tool result and the reminder. */
function failedRound(): MessageLike[] {
    return [
        { role: 'user', content: 'Write the plan' },
        { role: 'assistant', content: [THINKING, SEARCH, CREATE] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Created plan.md' }, { type: 'text', text: 'Reminder: …' }] },
    ];
}

describe('direct transport: server tool uses without their result', () => {
    test('ST-1: tool search — an error result after the unmatched use, thinking kept', () => {
        const matched = { type: 'server_tool_use', id: 'srvtoolu_0', name: 'tool_search_tool_bm25', input: { query: 'read' } };
        const matchedResult = { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_0', content: { type: 'tool_search_tool_search_result', tool_references: [] } };
        const content = [THINKING, matched, matchedResult, SEARCH, CREATE];
        const before = JSON.stringify(content);
        assert.deepEqual(unmatchedServerToolUses(content).map((b) => b.id), ['srvtoolu_1']);
        assert.equal(hasPendingServerToolUse(content), true);
        const { content: fixed, repaired } = repairServerToolUses(content);
        assert.deepEqual(repaired, ['srvtoolu_1']);
        assert.deepEqual(fixed.map((b) => b.type), ['thinking', 'server_tool_use', 'tool_search_tool_result', 'server_tool_use', 'tool_search_tool_result', 'tool_use']);
        assert.deepEqual(fixed[4], { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } });
        assert.equal(fixed[0], THINKING, 'the thinking block is the same object, signature and all');
        assert.equal(JSON.stringify(content), before, 'the input is not changed');
        assert.equal(hasPendingServerToolUse(fixed), false);
        assert.deepEqual(repairServerToolUses(fixed).repaired, [], 'nothing left to repair');
    });

    test('ST-2: web search, web fetch, code execution — their own result types', () => {
        const uses = [
            { type: 'server_tool_use', id: 'a', name: 'web_search', input: { query: 'q' } },
            { type: 'server_tool_use', id: 'b', name: 'web_fetch', input: { url: 'https://x' } },
            { type: 'server_tool_use', id: 'c', name: 'code_execution', input: { code: 'print(1)' } },
            { type: 'server_tool_use', id: 'd', name: 'tool_search_tool_regex', input: { pattern: 'x' } },
        ];
        const { content } = repairServerToolUses([THINKING, ...uses]);
        const results = content.filter((b) => b.type !== 'server_tool_use' && b.type !== 'thinking') as unknown as Array<{ type: string; tool_use_id: string; content: { type: string; error_code: string } }>;
        assert.deepEqual(results.map((r) => [r.type, r.tool_use_id, r.content.type, r.content.error_code]), [
            ['web_search_tool_result', 'a', 'web_search_tool_result_error', 'unavailable'],
            ['web_fetch_tool_result', 'b', 'web_fetch_tool_result_error', 'unavailable'],
            ['code_execution_tool_result', 'c', 'code_execution_tool_result_error', 'unavailable'],
            ['tool_search_tool_result', 'd', 'tool_search_tool_result_error', 'unavailable'],
        ]);
    });

    test('ST-3: repairConversation — a later result counts, repaired in place', () => {
        const answeredLater: MessageLike[] = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: [THINKING, SEARCH, CREATE] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
            { role: 'assistant', content: [{ type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } }, { type: 'text', text: 'done' }] },
        ];
        assert.deepEqual(repairConversation(answeredLater), [], 'the API answered it in the next response');
        const messages = failedRound();
        assert.deepEqual(repairConversation(messages), ['srvtoolu_1']);
        assert.deepEqual((messages[1].content as Block[]).map((b) => b.type), ['thinking', 'server_tool_use', 'tool_search_tool_result', 'tool_use']);
        assert.equal((messages[1].content as Block[])[0], THINKING);
    });

    test('ST-4: pause_turn — sent again with the assistant content last, the answer goes on in it', async () => {
        const webSearch = { type: 'server_tool_use', id: 'srvtoolu_w', name: 'web_search', input: { query: 'tom framework' } };
        const webResult = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_w', content: [{ type: 'web_search_result', title: 'Tom', url: 'https://tom', encrypted_content: 'e', page_age: null }] };
        const { anthropic, bodies } = client([() => streamOf([{ type: 'text', text: 'Searching.' }, webSearch], 'pause_turn'), () => streamOf([webResult, { type: 'text', text: 'Found it.' }], 'end_turn')]);
        const messages: MessageLike[] = [{ role: 'user', content: 'Find the Tom framework' }];
        const send = () => createMessageStreamed(anthropic as never, { model: 'claude-test', max_tokens: 100, messages: messages as never });
        const first = await send();
        assert.equal(first.stop_reason, 'pause_turn');
        appendAssistantContent(messages, first.content);
        const second = await send();
        assert.equal(bodies.length, 2);
        const sent = bodies[1].messages;
        assert.equal(sent.length, 2, 'no user message added');
        assert.equal(sent[1].role, 'assistant', 'the paused content is the last message');
        assert.deepEqual((sent[1].content as Block[]).map((b) => b.type), ['text', 'server_tool_use'], 'sent as it came, the pending use not repaired');
        appendAssistantContent(messages, second.content);
        assert.equal(messages.length, 2, 'the continued response goes on in the same assistant message');
        assert.deepEqual((messages[1].content as Block[]).map((b) => b.type), ['text', 'server_tool_use', 'web_search_tool_result', 'text']);
        appendAssistantContent(messages, [{ type: 'text', text: 'next' }]);
        assert.equal(messages.length, 2);
        messages.push({ role: 'user', content: 'go on' });
        appendAssistantContent(messages, [{ type: 'text', text: 'a new turn' }]);
        assert.equal(messages.length, 4, 'after a user message it is a new assistant message');
    });

    test('ST-5: the refusal is recognised', () => {
        assert.equal(isUnmatchedServerToolUseError(Object.assign(new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"${REFUSAL}"}}`), { status: 400 })), true);
        assert.equal(isUnmatchedServerToolUseError(new Error('messages.3: `web_search` tool use with id `srvtoolu_x` was found without a corresponding `web_search_tool_result` block')), true);
        assert.equal(isUnmatchedServerToolUseError(Object.assign(new Error('messages.1: tool_use ids were found without tool_result blocks'), { status: 400 })), false);
        assert.equal(isUnmatchedServerToolUseError(Object.assign(new Error(REFUSAL), { status: 429 })), false);
        assert.equal(isUnmatchedServerToolUseError(new Error('overloaded')), false);
    });

    test('ST-6: a refused round is repaired and sent once more (real SDK)', async () => {
        const { anthropic, bodies } = client([() => refused(REFUSAL), () => streamOf([{ type: 'text', text: 'The plan is written.' }], 'end_turn')]);
        const messages = failedRound();
        const repairs: Array<[string[], string]> = [];
        const response = await sendWithServerToolRepair({
            messages,
            send: () => createMessageStreamed(anthropic as never, { model: 'claude-test', max_tokens: 100, messages: messages as never }),
            onRepair: (ids, text) => repairs.push([ids, text]),
        });
        assert.equal(bodies.length, 2, 'sent once more');
        assert.equal(response.stop_reason, 'end_turn');
        assert.deepEqual(repairs.map((r) => r[0]), [['srvtoolu_1']]);
        assert.match(repairs[0][1], /without a corresponding `tool_search_tool_result` block/);
        const assistant = bodies[1].messages[1].content as Block[];
        assert.deepEqual(assistant.map((b) => b.type), ['thinking', 'server_tool_use', 'tool_search_tool_result', 'tool_use']);
        assert.equal((assistant[0] as { signature?: string }).signature, THINKING.signature, 'the thinking block is sent as it was');
        assert.deepEqual(bodies[0].messages[1].content, [THINKING, SEARCH, CREATE], 'the first request had no repair');
    });

    test('ST-7: not retried — another error, nothing to repair; a second refusal is thrown', async () => {
        let sends = 0;
        await assert.rejects(sendWithServerToolRepair({ messages: failedRound(), send: async () => { sends++; throw Object.assign(new Error('overloaded'), { status: 529 }); } }), /overloaded/);
        assert.equal(sends, 1);
        sends = 0;
        const clean: MessageLike[] = [{ role: 'user', content: 'q' }];
        await assert.rejects(sendWithServerToolRepair({ messages: clean, send: async () => { sends++; throw Object.assign(new Error(REFUSAL), { status: 400 }); } }), /srvtoolu_1/);
        assert.equal(sends, 1, 'nothing to repair: thrown at once');
        const { anthropic, bodies } = client([() => refused(REFUSAL)]);
        const messages = failedRound();
        await assert.rejects(sendWithServerToolRepair({ messages, send: () => createMessageStreamed(anthropic as never, { model: 'claude-test', max_tokens: 100, messages: messages as never }) }), /srvtoolu_1/);
        assert.equal(bodies.length, 2, 'once more, then it fails as before');
    });

    test('ST-8: the live-trail lines', () => {
        assert.equal(describeServerToolResult({ type: 'tool_search_tool_result', tool_use_id: 'x', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'tomAi_specOutline' }, { type: 'tool_reference', tool_name: 'tomAi_specSetContent' }] } }), 'tools found: tomAi_specOutline, tomAi_specSetContent');
        assert.equal(describeServerToolResult({ type: 'tool_search_tool_result', tool_use_id: 'x', content: { type: 'tool_search_tool_search_result', tool_references: [] } }), 'no tools found');
        assert.equal(describeServerToolResult({ type: 'tool_search_tool_result', tool_use_id: 'x', content: { type: 'tool_search_tool_result_error', error_code: 'too_many_requests', error_message: 'slow down' } }), 'error: too_many_requests — slow down');
        assert.equal(describeServerToolResult({ type: 'web_search_tool_result', tool_use_id: 'x', content: [{ title: 'A' }, { url: 'https://b' }] }), '2 result(s): A; https://b');
    });

    test('ST-9: the direct loop wires it', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        assert.match(src, /const response = await sendWithServerToolRepair\(\{[\s\S]{0,700}send: \(\) => sendWithContinuation\(\{/, 'the repair wraps the continuation');
        assert.match(src, /if \(response\.stop_reason === 'pause_turn'\) \{\s*appendAssistantContent\(messages as unknown as MessageLike\[\], response\.content\);[\s\S]{0,200}continue;/, 'a paused turn goes on without a user message');
        const stopHook = src.indexOf('stopHookActive = true;\n');
        assert.ok(stopHook > 0);
        assert.match(src.slice(stopHook, stopHook + 200), /closeAssistantMessage\(\);\s*messages\.push\(\{ role: 'user', content: goOn \}\)/, 'Stop hook: the message closed first');
        assert.match(src, /if \(background\.continueWith !== undefined\) \{\s*closeAssistantMessage\(\);\s*messages\.push\(\{ role: 'user', content: background\.continueWith \}\)/, 'background: the message closed first');
        assert.match(src, /const roundReminder = hasPendingServerToolUse\(messages\[messages\.length - 1\]\.content\) \? '' : parallelReminder;/);
        assert.doesNotMatch(src, /roundResultContent\(toolResults, parallelReminder\)/, 'every round uses roundReminder');
        assert.doesNotMatch(src, /messages\.push\(\{ role: 'assistant', content: response\.content \}\)/, 'no response pushed unrepaired');
    });
});
/* eslint-enable @typescript-eslint/naming-convention */
