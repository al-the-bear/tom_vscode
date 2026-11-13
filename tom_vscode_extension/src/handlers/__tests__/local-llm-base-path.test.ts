/**
 * The Local LLM requests keep the base URL's path (vscimpb68): the real
 * `LocalLlmManager.callLocalLlmOnce` against a local HTTP server that records
 * the path every request arrives on.
 *
 *   LP-1 OpenAI-compatible on a path base (`/v2`, Qianfan's form): the request goes to `/v2/chat/completions`;
 *        with a trailing slash the same; a query on the base arrives with it
 *   LP-2 Ollama behind a proxy path: `/proxy/ollama/api/chat`
 *   LP-3 a base without a path keeps today's endpoints: `/v1/chat/completions` and `/api/chat`
 *   LP-4 both request sites use the helper and pick `https` for an https base (source check: a TLS stub would
 *        need a certificate)
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-base-path-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { LocalLlmManager } from '../localLlm-handler.js';

const OPENAI_OK = 'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\ndata: [DONE]\n\n';
const OLLAMA_OK = '{"message":{"role":"assistant","content":"the answer"},"done":true}\n';

let server: http.Server;
let root = '';
const seen: string[] = [];

before(async () => {
    server = http.createServer((req, res) => {
        seen.push(req.url ?? '');
        req.resume();
        req.on('end', () => {
            const openai = (req.url ?? '').includes('chat/completions');
            // eslint-disable-next-line @typescript-eslint/naming-convention
            res.writeHead(200, { 'content-type': openai ? 'text/event-stream' : 'application/json' });
            res.end(openai ? OPENAI_OK : OLLAMA_OK);
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const manager = new LocalLlmManager({ subscriptions: [] } as never);

async function call(baseUrl: string, apiStyle: 'openai' | 'ollama'): Promise<string> {
    seen.length = 0;
    const result = await manager.callLocalLlmOnce({
        baseUrl, model: 'm', temperature: 0, messages: [{ role: 'user', content: 'hi' }], tools: [], apiStyle,
    });
    assert.equal(result.text, 'the answer');
    assert.equal(seen.length, 1);
    return seen[0];
}

describe('Local LLM: the base URL\'s path', () => {
    test('LP-1: OpenAI-compatible on a path base', async () => {
        assert.equal(await call(`${root}/v2`, 'openai'), '/v2/chat/completions');
        assert.equal(await call(`${root}/v2/`, 'openai'), '/v2/chat/completions');
        assert.equal(await call(`${root}/v1beta/openai?key=k`, 'openai'), '/v1beta/openai/chat/completions?key=k');
    });

    test('LP-2: Ollama behind a proxy path', async () => {
        assert.equal(await call(`${root}/proxy/ollama`, 'ollama'), '/proxy/ollama/api/chat');
    });

    test('LP-3: a base without a path is unchanged', async () => {
        assert.equal(await call(root, 'openai'), '/v1/chat/completions');
        assert.equal(await call(`${root}/`, 'ollama'), '/api/chat');
    });

    test('LP-4: both requests use the helper and https for an https base', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'localLlm-handler.ts'), 'utf8');
        assert.equal((src.match(/localLlmChatUrl\(baseUrl, '(ollama|openai)'\)/g) ?? []).length, 2);
        assert.equal((src.match(/\(url\.protocol === 'https:' \? https : http\)\.request\(/g) ?? []).length, 2);
        assert.equal((src.match(/path: localLlmRequestPath\(url\),/g) ?? []).length, 2);
        assert.doesNotMatch(src, /new URL\('\//, 'no absolute-path join is left');
    });
});
