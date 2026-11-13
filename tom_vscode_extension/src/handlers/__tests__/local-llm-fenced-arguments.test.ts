/**
 * Fenced tool-call arguments reach the tool as an object (vscimpb69): the real
 * `LocalLlmManager.callLocalLlmOnce` against a stub model, its tool calls then
 * run through the registry's `executeToolCall`.
 *
 *   LF-1 OpenAI-compatible: the arguments streamed as a ```json fence, split across chunks → the tool gets the object;
 *        the read is logged with the tool name
 *   LF-2 Ollama: `arguments` sent as a fenced string instead of an object → the object
 *   LF-3 unreadable arguments: the tool gets { _raw } and the Local LLM channel names the tool
 */

/* eslint-disable @typescript-eslint/naming-convention -- wire field names */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const logLines: string[] = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-fenced-'));
installVscodeStub({
    workspaceFolders: [tmpRoot],
    methodOverrides: {
        createOutputChannel: () => ({ appendLine: (l: string) => { logLines.push(l); }, append() {}, show() {}, clear() {}, dispose() {} }),
    },
});

import { LocalLlmManager } from '../localLlm-handler.js';
import { executeToolCall, type SharedToolDefinition } from '../../tools/shared-tool-registry.js';

let body = '';
let contentType = 'application/json';
let server: http.Server;
let root = '';

before(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': contentType }); res.end(body); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const manager = new LocalLlmManager({ subscriptions: [] } as never);
const received: unknown[] = [];
const TOOL: SharedToolDefinition<Record<string, unknown>> = {
    name: 'tomAi_readFile', displayName: 'Read', description: 'reads', tags: [], readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (input) => { received.push(input); return 'ok'; },
};

async function roundTrip(apiStyle: 'openai' | 'ollama'): Promise<unknown> {
    received.length = 0;
    const result = await manager.callLocalLlmOnce({
        baseUrl: root, model: 'm', temperature: 0, messages: [{ role: 'user', content: 'read it' }], tools: [TOOL], apiStyle,
    });
    assert.equal(result.toolCalls?.length, 1, JSON.stringify(result));
    assert.equal(await executeToolCall([TOOL], result.toolCalls![0]), 'ok');
    return received[0];
}

const sse = (frames: unknown[]): string => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
const toolFrame = (args: string, first: boolean) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: 'c1', function: { name: 'tomAi_readFile', arguments: args } } : { function: { arguments: args } }) }] } }] });

describe('Local LLM: fenced tool-call arguments', () => {
    test('LF-1: OpenAI-compatible, fenced and streamed in pieces', async () => {
        contentType = 'text/event-stream';
        const fenced = '```json\n{"path": "notes/a.md", "limit": 3}\n```';
        body = sse([toolFrame(fenced.slice(0, 12), true), toolFrame(fenced.slice(12, 30), false), toolFrame(fenced.slice(30), false)]);
        logLines.length = 0;
        assert.deepEqual(await roundTrip('openai'), { path: 'notes/a.md', limit: 3 });
        assert.ok(logLines.some((l) => l === '[toolArguments] tomAi_readFile: arguments read as fenced JSON'), logLines.join('\n'));
    });

    test('LF-2: Ollama, arguments as a fenced string', async () => {
        contentType = 'application/json';
        body = JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'tomAi_readFile', arguments: '```\n{"path": "b.md"}\n```' } }] }, done: true }) + '\n';
        assert.deepEqual(await roundTrip('ollama'), { path: 'b.md' });
        body = JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'tomAi_readFile', arguments: { path: 'c.md' } } }] }, done: true }) + '\n';
        assert.deepEqual(await roundTrip('ollama'), { path: 'c.md' }, 'an object as before');
    });

    test('LF-3: unreadable arguments', async () => {
        contentType = 'text/event-stream';
        body = sse([toolFrame('{"path": "a.md", ', true)]);
        logLines.length = 0;
        assert.deepEqual(await roundTrip('openai'), { _raw: '{"path": "a.md", ' });
        assert.ok(logLines.some((l) => l.startsWith('[toolArguments] tomAi_readFile: arguments are not a JSON object')), logLines.join('\n'));
    });
});
