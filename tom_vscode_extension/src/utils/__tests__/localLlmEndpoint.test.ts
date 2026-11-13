/**
 * The Local LLM chat endpoint keeps a base URL's path (vscimpb68).
 *
 *   LE-1 a base without a path keeps the well-known absolute endpoint, with and without a trailing slash
 *   LE-2 a base with a path is the API root: `chat/completions` / `api/chat` appended, with and without a
 *        trailing slash — `/v1`, `/v2` (Qianfan), `/v1beta/openai` (Google), `/api/paas/v4` (Zhipu), a proxy path
 *   LE-3 a query on the base is kept (and is part of the request path), a fragment is dropped; a base that is not
 *        a URL throws, and the endpoint text says so instead
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { localLlmChatUrl, localLlmEndpointText, localLlmRequestPath } from '../localLlmEndpoint.js';

const openai = (base: string): string => localLlmChatUrl(base, 'openai').toString();
const ollama = (base: string): string => localLlmChatUrl(base, 'ollama').toString();

describe('Local LLM endpoint', () => {
    test('LE-1: a base without a path', () => {
        for (const base of ['http://localhost:11434', 'http://localhost:11434/']) {
            assert.equal(ollama(base), 'http://localhost:11434/api/chat', base);
            assert.equal(openai(base), 'http://localhost:11434/v1/chat/completions', base);
        }
        assert.equal(openai('http://10.8.0.1:8000'), 'http://10.8.0.1:8000/v1/chat/completions');
    });

    test('LE-2: a base with a path is the API root', () => {
        const cases: Array<[string, string, string]> = [
            ['http://host:8000/v1', 'http://host:8000/v1/chat/completions', 'http://host:8000/v1/api/chat'],
            ['https://qianfan.baidubce.com/v2', 'https://qianfan.baidubce.com/v2/chat/completions', 'https://qianfan.baidubce.com/v2/api/chat'],
            ['https://generativelanguage.googleapis.com/v1beta/openai',
                'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
                'https://generativelanguage.googleapis.com/v1beta/openai/api/chat'],
            ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/api/paas/v4/api/chat'],
            ['https://gateway.example/llm/ollama', 'https://gateway.example/llm/ollama/chat/completions', 'https://gateway.example/llm/ollama/api/chat'],
        ];
        for (const [base, wantOpenai, wantOllama] of cases) {
            for (const b of [base, `${base}/`, `${base}//`]) {
                assert.equal(openai(b), wantOpenai, `openai ${b}`);
                assert.equal(ollama(b), wantOllama, `ollama ${b}`);
            }
        }
    });

    test('LE-3: query, fragment, not a URL', () => {
        const url = localLlmChatUrl('https://res.openai.azure.example/openai/deployments/d?api-version=2024-10-21#x', 'openai');
        assert.equal(url.toString(), 'https://res.openai.azure.example/openai/deployments/d/chat/completions?api-version=2024-10-21');
        assert.equal(localLlmRequestPath(url), '/openai/deployments/d/chat/completions?api-version=2024-10-21');
        assert.equal(localLlmRequestPath(localLlmChatUrl('http://localhost:11434', 'ollama')), '/api/chat');
        assert.throws(() => localLlmChatUrl('not a url', 'openai'));
        assert.equal(localLlmEndpointText('not a url', 'openai'), 'not a url (not a URL)');
        assert.equal(localLlmEndpointText(' http://localhost:11434 ', 'ollama'), 'http://localhost:11434/api/chat', 'trimmed');
    });
});
