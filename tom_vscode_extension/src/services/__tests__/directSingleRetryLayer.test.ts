/**
 * The direct transport has one retry layer: ours (ccparity_c_transports-8).
 * The direct client is built with `maxRetries: 0`, so the SDK no longer
 * retries 408 / 409 / 429 / 5xx and connection errors on its own before the
 * time-budget loop sees them; the classifier takes over what the SDK covered.
 *
 *   RL-1 the direct client: maxRetries 0 (the SDK's default is 2)
 *   RL-2 each class the SDK retried and the classifier now covers: 408, the SDK's APIConnectionError
 *        ("Connection error.") and APIConnectionTimeoutError ("Request timed out."), the Agent SDK's
 *        "API Error: Connection error.", ECONNRESET / ETIMEDOUT on the error or its cause
 *   RL-3 not retried by the budget: a stream cut mid-answer ("terminated" — the continuation's, CC-8), a
 *        cancellation, a refused connection (a Local LLM server that is not running fails at once), 400 / 401
 *   RL-4 over a real SDK client with that factory: a 429 costs one request per attempt (the loop reads the
 *        reset headers after the first), a network error is retried within the budget, and a network error that
 *        does not go away stops when the budget is spent — every attempt one request
 *   RL-5 the handler builds its client with the factory; its one-shot calls (compaction, memory extraction,
 *        the model list) go through the budget loop, since the client no longer retries them; the Local LLM
 *        path builds no Anthropic client (its fetch calls never had the SDK's retries) and keeps its loop
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';

import { createDirectAnthropicClient, DIRECT_CLIENT_MAX_RETRIES } from '../directAnthropicClient';
import { isRetryableBusyError, isDroppedConnectionError } from '../../utils/retryableError';
import { runRetryBudgetLoop, type RetryBudgetLoopDeps } from '../../utils/retryBudgetLoop';
import { providerRetryDelayMs } from '../../utils/rateLimitHeaders';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields and HTTP headers */
const OK_BODY = {
    id: 'm', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 },
};

const ok = () => new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
const rateLimited = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' },
});
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

/** A direct client whose fetch answers the script in turn (an Error is thrown), counting the requests. */
function scripted(script: Array<() => Response | Error>) {
    let requests = 0;
    const fetch = async () => {
        const next = script[Math.min(requests, script.length - 1)]();
        requests++;
        if (next instanceof Error) { throw next; }
        return next;
    };
    return { client: createDirectAnthropicClient('test-key', fetch as never), requests: () => requests };
}

/** A fake clock: sleeping moves it on. */
function fakeDeps(): RetryBudgetLoopDeps & { slept: number[] } {
    let now = 1_000_000;
    const slept: number[] = [];
    return { slept, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; }, isCancelled: () => false, log: () => undefined };
}

const send = (client: Anthropic) => () => client.messages.create({ model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

describe('direct transport: one retry layer', () => {
    test('RL-1: the direct client does not retry', () => {
        assert.equal(DIRECT_CLIENT_MAX_RETRIES, 0);
        assert.equal(createDirectAnthropicClient('k').maxRetries, 0);
        assert.equal(new Anthropic({ apiKey: 'k' }).maxRetries, 2, 'the SDK default it replaces');
    });

    test('RL-2: what the SDK retried is retried by the budget loop', () => {
        const yes: unknown[] = [
            { status: 408 },
            new APIConnectionError({ message: undefined, cause: new Error('x') }),
            new APIConnectionTimeoutError(),
            new Error('API Error: Connection error.'),
            new Error('Request timed out.'),
            Object.assign(new Error('read'), { code: 'ECONNRESET' }),
            Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
            reset(),
        ];
        for (const e of yes) { assert.equal(isRetryableBusyError(e), true, String((e as Error).message ?? JSON.stringify(e))); }
        assert.equal(new APIConnectionError({ message: undefined }).message, 'Connection error.');
        assert.equal(new APIConnectionTimeoutError().message, 'Request timed out.');
    });

    test('RL-3: what the budget loop leaves alone', () => {
        const terminated = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
        assert.equal(isRetryableBusyError(terminated), false, 'a cut stream is continued (CC-8), not resent');
        assert.equal(isDroppedConnectionError(terminated), true);
        const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });
        assert.equal(isRetryableBusyError(refused), false, 'a server that is not running fails at once');
        for (const e of [
            Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }),
            Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ETIMEDOUT' }),
            { status: 400 }, { status: 401 }, new Error('invalid x-api-key'),
        ]) {
            assert.equal(isRetryableBusyError(e), false, JSON.stringify(e));
        }
    });

    test('RL-4a: a 429 costs one request per attempt', async () => {
        const s = scripted([rateLimited, ok]);
        const deps = fakeDeps();
        const r = await runRetryBudgetLoop({ call: send(s.client), totalWaitMs: 60_000, waitFromError: providerRetryDelayMs }, deps);
        assert.equal(r.id, 'm');
        assert.equal(s.requests(), 2, 'no hidden SDK retries');
        assert.equal(deps.slept.length, 1);
        assert.ok(deps.slept[0] >= 3000, 'the retry-after the loop read');
    });

    test('RL-4b: a network error is retried within the budget', async () => {
        const s = scripted([reset, reset, ok]);
        const deps = fakeDeps();
        const r = await runRetryBudgetLoop({ call: send(s.client), totalWaitMs: 60_000 }, deps);
        assert.equal(r.id, 'm');
        assert.equal(s.requests(), 3);
        assert.equal(deps.slept.length, 2);
    });

    test('RL-4c: a network error that stays stops when the budget is spent', async () => {
        const s = scripted([reset]);
        const deps = fakeDeps();
        await assert.rejects(runRetryBudgetLoop({ call: send(s.client), totalWaitMs: 10_000, initialDelayMs: 1000 }, deps), /Connection error/);
        assert.equal(s.requests(), deps.slept.length + 1, 'one request per attempt');
        assert.ok(deps.slept.reduce((a, b) => a + b, 0) <= 10_000, 'within the budget');
    });

    test('RL-5: the handler and the Local LLM path', () => {
        const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf-8');
        const handler = src('handlers/anthropic-handler.ts');
        assert.match(handler, /new KeyedClientCache<Anthropic>\(\(apiKey\) => createDirectAnthropicClient\(apiKey\)\)/);
        assert.doesNotMatch(handler, /new Anthropic\(/);
        const internal = handler.slice(handler.indexOf('async runInternalCall('), handler.indexOf('async runInternalAgentSdkCall('));
        assert.match(internal, /withRetryBudget\(\{\s*call: \(\) => createMessageStreamed\(client,/);
        assert.match(internal, /totalWaitMs: INTERNAL_CALL_RETRY_WAIT_MS/);
        const models = handler.slice(handler.indexOf('async fetchModels('), handler.indexOf('async sendMessage('));
        assert.match(models, /withRetryBudget\(\{\s*call: \(\) => client\.models\.list\(/);
        assert.match(handler, /send: \(\) => withRetryBudget\(\{/, 'the tool loop as before');
        const local = src('handlers/localLlm-handler.ts');
        assert.doesNotMatch(local, /@anthropic-ai\/sdk|new Anthropic/);
        assert.match(local, /return withRetryBudget\(\{/);
    });
});
