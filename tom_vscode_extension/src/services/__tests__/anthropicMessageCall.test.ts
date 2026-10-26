/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (max_tokens, stop_reason) */
/**
 * The direct transport's Messages API calls are streamed.
 *
 *   MC-1 createMessageStreamed sends the params through `messages.stream` and
 *        resolves with the final message; the abort signal is passed on
 *   MC-2 an API error from the stream reaches the caller unchanged (the retry
 *        budget classifies it)
 *   MC-3 the handler makes no non-streaming `messages.create` call: with the
 *        current models' max_tokens the SDK refuses those ("Streaming is
 *        required for operations that may take longer than 10 minutes")
 *   MC-4 a cancelled VS Code token aborts the request's signal
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { abortSignalFor, createMessageStreamed, type MessageStreamingClient } from '../anthropicMessageCall.js';

const PARAMS = {
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('anthropicMessageCall', () => {
    test('MC-1: streamed, final message returned, signal passed', async () => {
        const seen: { params?: unknown; options?: unknown } = {};
        const message = { id: 'msg_1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        const client: MessageStreamingClient = {
            messages: {
                stream: (params, options) => {
                    seen.params = params;
                    seen.options = options;
                    return { finalMessage: async () => message as never };
                },
            },
        };
        const controller = new AbortController();
        const result = await createMessageStreamed(client, PARAMS, controller.signal);
        assert.equal(result, message);
        assert.deepEqual(seen.params, PARAMS);
        assert.deepEqual(seen.options, { signal: controller.signal });
        await createMessageStreamed(client, PARAMS);
        assert.equal(seen.options, undefined, 'no options without a signal');
    });

    test('MC-2: errors reach the caller', async () => {
        const failure = Object.assign(new Error('overloaded'), { status: 529 });
        const client: MessageStreamingClient = {
            messages: { stream: () => ({ finalMessage: async () => { throw failure; } }) },
        };
        await assert.rejects(createMessageStreamed(client, PARAMS), (e) => e === failure);
    });

    test('MC-3: the handler makes no non-streaming messages.create call', () => {
        // out/services/__tests__ -> project root is three levels up.
        const source = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.equal(/client\.messages\.create\(/.test(source), false);
        assert.ok(source.includes('createMessageStreamed('), 'the handler goes through the streamed call');
    });
});

describe('abortSignalFor', () => {
    test('MC-4: a cancelled token aborts the signal; none without a token', () => {
        assert.equal(abortSignalFor(undefined), undefined);
        let fire: (() => void) | undefined;
        const signal = abortSignalFor({ isCancellationRequested: false, onCancellationRequested: (l) => { fire = l; } });
        assert.equal(signal!.aborted, false);
        fire!();
        assert.equal(signal!.aborted, true);
        const already = abortSignalFor({ isCancellationRequested: true, onCancellationRequested: () => undefined });
        assert.equal(already!.aborted, true);
    });
});
