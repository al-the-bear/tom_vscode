/**
 * The Local LLM transport honours `retry-after` (ccparity_c_transports-9):
 * the real `LocalLlmManager.callLocalLlmOnce` against a local HTTP server
 * answering as vLLM / an OpenAI-compatible gateway or Ollama would.
 *
 *   LA-1 OpenAI-compatible: a 429 with `retry-after: 1` waits that long (plus the loop's margin) before the
 *        retry, reported as a `rate_limit` wait through onRetryWait; the retry's answer is returned
 *   LA-2 Ollama: a 503 with `retry-after-ms` waits that long
 *   LA-3 without retry-after the backoff is unchanged: a `backoff` wait of the initial delay
 *   LA-4 the rejection carries `status`, `statusCode` and the response headers, so a 503 whose body replaces
 *        the message ("Model is loading") is still retried by its status; a 400 is not retried
 *   LA-5 the queue's sendWait covers Local LLM stages: sendViaLocalLlm passes the send's onRetryWait on
 */

/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-retry-after-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { LocalLlmManager } from '../localLlm-handler.js';
import { PROVIDER_WAIT_MARGIN_MS, type RetryWait } from '../../utils/retryBudgetLoop.js';

/** One scripted answer: a status, headers and a body. */
type Answer = { status: number; headers?: Record<string, string>; body: string };

let script: Answer[] = [];
let requests = 0;
let server: http.Server;
let baseUrl = '';

const OPENAI_OK: Answer = {
    status: 200, headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\ndata: [DONE]\n\n',
};
const OLLAMA_OK: Answer = { status: 200, body: '{"message":{"role":"assistant","content":"the answer"},"done":true}\n' };

before(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const a = script[Math.min(requests, script.length - 1)];
            requests++;
            res.writeHead(a.status, a.headers ?? { 'content-type': 'application/json' });
            res.end(a.body);
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const manager = new LocalLlmManager({ subscriptions: [] } as never);

async function call(apiStyle: 'openai' | 'ollama', answers: Answer[]) {
    script = answers;
    requests = 0;
    const waits: Array<RetryWait | null> = [];
    const started = Date.now();
    const result = await manager.callLocalLlmOnce({
        baseUrl, model: 'm', temperature: 0, messages: [{ role: 'user', content: 'hi' }], tools: [],
        apiStyle, retryTotalWaitMs: 60_000, onRetryWait: (w) => waits.push(w),
    });
    return { result, waits, requests, elapsed: Date.now() - started };
}

const errorBody = (message: string) => JSON.stringify({ error: { message } });

describe('Local LLM: retry-after', () => {
    test('LA-1: OpenAI-compatible 429 with retry-after', async () => {
        const r = await call('openai', [{ status: 429, headers: { 'retry-after': '1' }, body: errorBody('slow down') }, OPENAI_OK]);
        assert.equal(r.result.text, 'the answer');
        assert.equal(r.requests, 2);
        const wait = r.waits[0]!;
        assert.equal(wait.kind, 'rate_limit');
        assert.equal(wait.waitMs, 1000 + PROVIDER_WAIT_MARGIN_MS);
        assert.ok(r.elapsed >= 1000 + PROVIDER_WAIT_MARGIN_MS - 50, `waited ${r.elapsed} ms`);
        assert.equal(r.waits[1], null, 'the wait is announced over');
    });

    test('LA-2: Ollama 503 with retry-after-ms', async () => {
        const r = await call('ollama', [{ status: 503, headers: { 'retry-after-ms': '300' }, body: '{"error":"server busy"}' }, OLLAMA_OK]);
        assert.equal(r.result.text, 'the answer');
        assert.equal(r.waits[0]!.kind, 'rate_limit');
        assert.equal(r.waits[0]!.waitMs, 300 + PROVIDER_WAIT_MARGIN_MS);
    });

    test('LA-3: without retry-after the backoff is unchanged', async () => {
        const r = await call('openai', [{ status: 503, body: errorBody('Service Unavailable') }, OPENAI_OK]);
        assert.equal(r.result.text, 'the answer');
        assert.equal(r.waits[0]!.kind, 'backoff');
        assert.equal(r.waits[0]!.waitMs, 1000, 'the initial delay');
    });

    test('LA-4: the rejection carries status and headers', async () => {
        const loading = await call('openai', [{ status: 503, headers: { 'retry-after': '0' }, body: errorBody('Model is loading') }, OPENAI_OK]);
        assert.equal(loading.result.text, 'the answer', 'retried by its status, whatever the body says');
        script = [{ status: 400, headers: { 'retry-after': '1', 'content-type': 'application/json' }, body: errorBody('bad model') }];
        requests = 0;
        const err = await manager.callLocalLlmOnce({ baseUrl, model: 'm', temperature: 0, messages: [], tools: [], apiStyle: 'openai', retryTotalWaitMs: 60_000 })
            .then(() => undefined, (e: unknown) => e as Error & { status?: number; statusCode?: number; headers?: Record<string, unknown> });
        assert.ok(err, 'rejected');
        assert.equal(err!.message, 'bad model');
        assert.equal(err!.status, 400);
        assert.equal(err!.statusCode, 400);
        assert.equal(err!.headers?.['retry-after'], '1');
        assert.equal(requests, 1, 'a 400 is not retried');
    });

    test('LA-5: the queue sees Local LLM waits', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const local = src.slice(src.indexOf('private async sendViaLocalLlm('));
        assert.match(local.slice(0, local.indexOf('callLocalLlmOnce({') + 2000), /onRetryWait: options\.onRetryWait,/);
        const leaf = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'localLlm-handler.ts'), 'utf8');
        assert.match(leaf, /waitFromError: providerRetryDelayMs,/);
        assert.match(leaf, /onRetryWait: opts\.onRetryWait,/);
    });
});
