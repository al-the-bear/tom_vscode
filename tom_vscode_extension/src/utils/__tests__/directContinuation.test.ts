/**
 * The direct transport continues a turn after a dropped connection (CC-8,
 * src/utils/directContinuation.ts), over the real Anthropic SDK and the
 * extension's createMessageStreamed, with a fetch whose stream is cut
 * mid-answer the way a dropped connection cuts it.
 *
 *   DC-1 what is a dropped connection: the SDK's "terminated" after a cut stream, its connection errors,
 *        Node's codes (also in the cause); not a busy 429 / 529, not a cancellation, not a 400
 *   DC-2 a stream cut mid-answer: the round is sent again over the same history — the earlier messages as
 *        they were, the continuation prompt (with the error) added to the last user message — and the answer
 *        is the second response's, the cut one's partial text not kept; the continuation is reported
 *   DC-3 at most maxAttempts in all; a second continuation of the round replaces the first's prompt
 *   DC-4 not continued: a busy error (the retry budget's), a cancellation, maxAttempts 1, any other error
 *   DC-5 a prompt given as a string becomes text blocks, the continuation after it
 *   DC-6 the direct loop sends through sendWithContinuation, its messages rebuilt for each attempt, with the
 *        continuation prompt the Agent SDK uses
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { addContinuationPrompt, sendWithContinuation, type ContinuationMessage } from '../directContinuation';
import { isDroppedConnectionError } from '../retryableError';
import { createMessageStreamed } from '../../services/anthropicMessageCall';

const enc = new TextEncoder();
// eslint-disable-next-line @typescript-eslint/naming-convention -- SSE wire fields
const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields */
function streamResponse(text: string, cut: boolean): Response {
    const body = new ReadableStream({
        start(c) {
            c.enqueue(enc.encode(sse('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })));
            c.enqueue(enc.encode(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })));
            c.enqueue(enc.encode(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })));
            if (cut) {
                // The connection drops mid-answer: what undici reports when the peer closes the socket.
                setTimeout(() => c.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })), 2);
                return;
            }
            c.enqueue(enc.encode(sse('content_block_stop', { index: 0 })));
            c.enqueue(enc.encode(sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })));
            c.enqueue(enc.encode(sse('message_stop', {})));
            c.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A real SDK client whose fetch answers the script in turn (`cut` streams break off), recording each request body. */
function client(script: Array<{ text: string; cut?: boolean }>) {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetch = async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)));
        const next = script[Math.min(bodies.length - 1, script.length - 1)];
        return streamResponse(next.text, !!next.cut);
    };
    return { anthropic: new Anthropic({ apiKey: 'test', fetch: fetch as never, maxRetries: 0 }), bodies };
}

/** The turn so far: the prompt, a finished tool round. */
function history(): ContinuationMessage[] {
    return [
        { role: 'user', content: 'Refactor the parser' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'tomAi_readFile', input: { filePath: 'p.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export class Parser {}' }] },
    ];
}
/* eslint-enable @typescript-eslint/naming-convention */

const PROMPT = (e: string) => `The connection dropped (${e}). Continue the task where you stopped.`;

async function run(script: Array<{ text: string; cut?: boolean }>, maxAttempts = 3) {
    const { anthropic, bodies } = client(script);
    const messages = history();
    const continued: Array<[number, number, string]> = [];
    const promise = sendWithContinuation({
        messages,
        send: () => createMessageStreamed(anthropic as never, { model: 'claude-test', max_tokens: 100, messages: messages as never }),
        maxAttempts,
        continuationPrompt: PROMPT,
        onContinue: (a, m, e) => continued.push([a, m, e]),
    });
    return { promise, bodies, messages, continued };
}

const textOf = (m: { content: unknown }) => JSON.stringify(m.content);

describe('direct transport: continue after a dropped connection', () => {
    test('DC-1: what is a dropped connection', () => {
        const yes = [
            new Error('terminated'), Object.assign(new Error('x'), { name: 'APIConnectionError' }), Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }),
            Object.assign(new Error('read'), { code: 'ECONNRESET' }), new Error('socket hang up'), new Error('fetch failed'),
            Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) }),
        ];
        for (const e of yes) { assert.equal(isDroppedConnectionError(e), true, e.message); }
        const no = [
            Object.assign(new Error('rate limited'), { status: 429 }), new Error('overloaded_error'), Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }),
            Object.assign(new Error('aborted'), { name: 'AbortError' }), Object.assign(new Error('invalid_request_error: messages: bad'), { status: 400 }), undefined,
        ];
        for (const e of no) { assert.equal(isDroppedConnectionError(e), false, String(e && (e as Error).message)); }
    });

    test('DC-2: a stream cut mid-answer continues over the same history', async () => {
        const { promise, bodies, messages, continued } = await run([{ text: 'Half of the ans', cut: true }, { text: 'The parser is refactored.' }]);
        const response = await promise;
        assert.equal(bodies.length, 2, 'sent again after the cut');
        assert.deepEqual(bodies[1].messages.slice(0, 2), bodies[0].messages.slice(0, 2), 'the earlier messages as they were');
        const last = bodies[1].messages[2];
        assert.match(textOf(last), /tool_result.*tu1/, 'the round\'s tool results stay');
        assert.match(textOf(last), /The connection dropped \(terminated\)\. Continue the task where you stopped\./, 'the continuation prompt, with the error');
        assert.doesNotMatch(textOf(bodies[0].messages[2]), /connection dropped/, 'the first request had none');
        const answer = (response.content as Array<{ text?: string }>).map((b) => b.text).join('');
        assert.equal(answer, 'The parser is refactored.');
        assert.doesNotMatch(answer, /Half of the ans/, 'the cut response is not kept');
        assert.deepEqual(continued, [[2, 3, 'terminated']]);
        assert.equal(messages.length, 3, 'no new message: the prompt goes into the last user message');
    });

    test('DC-3: at most maxAttempts; one continuation prompt per round', async () => {
        const { promise, bodies, continued } = await run([{ text: 'a', cut: true }], 3);
        await assert.rejects(promise, /terminated/);
        assert.equal(bodies.length, 3);
        assert.equal(continued.length, 2);
        const prompts = (textOf(bodies[2].messages[2]).match(/connection dropped/g) ?? []).length;
        assert.equal(prompts, 1, 'the second continuation replaced the first prompt');
    });

    test('DC-4: what is not continued', async () => {
        const cases: Array<{ err: unknown; max?: number; cancelled?: boolean }> = [
            { err: Object.assign(new Error('429 rate_limit_error'), { status: 429 }) },
            { err: Object.assign(new Error('400 bad request'), { status: 400 }) },
            { err: new Error('terminated'), cancelled: true },
            { err: new Error('terminated'), max: 1 },
        ];
        for (const c of cases) {
            let sends = 0;
            await assert.rejects(sendWithContinuation({
                messages: history(),
                send: async () => { sends++; throw c.err; },
                maxAttempts: c.max ?? 3,
                continuationPrompt: PROMPT,
                isCancelled: () => !!c.cancelled,
            }));
            assert.equal(sends, 1, String((c.err as Error).message));
        }
    });

    test('DC-5: a string prompt becomes text blocks', () => {
        const messages: ContinuationMessage[] = [{ role: 'user', content: 'Do it' }];
        addContinuationPrompt(messages, 'continue');
        assert.deepEqual(messages[0].content, [{ type: 'text', text: 'Do it' }, { type: 'text', text: 'continue' }]);
        assert.throws(() => addContinuationPrompt([{ role: 'assistant', content: 'x' }], 'c'), /follows a user message/);
    });

    test('DC-6: the direct loop uses it', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        assert.match(src, /const response = await sendWithContinuation\(\{/);
        assert.match(src, /createMessageStreamed\(client, \{ \.\.\.createParams, messages: requestMessages\(\) \}, abortSignal\)/, 'messages rebuilt per attempt');
        assert.match(src, /continuationPrompt: \(errorText\) => this\.transportContinuationPrompt\(errorText, userContent\)/);
        assert.match(src, /buildContinuationPrompt: \(errorText: string\): string => this\.transportContinuationPrompt\(errorText, userContent\)/, 'the same prompt as the Agent SDK');
    });
});
