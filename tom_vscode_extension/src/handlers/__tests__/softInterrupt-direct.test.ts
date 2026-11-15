/**
 * The hold points of a soft interrupt for continuation (vscimpb112) in the transports, through the real handler's
 * direct loop (only the Anthropic client is a stub that scripts the model's replies) and the Agent SDK's MCP tool
 * handler wrapper.
 *
 *   SD-1 direct API: with a soft interrupt of the turn's queue item requested, the round's tool results are held
 *        before the next request — no request goes out until the release; the held state names the tool and its
 *        result, and the conversation up to the held results is handed over for a restart; on release the turn
 *        goes on and ends normally
 *   SD-2 direct API: `resumeConversation` continues a saved conversation exactly — the first request is the saved
 *        messages (the held-for line on its tool result), not a new prompt
 *   SD-3 Agent SDK: an extension tool's MCP handler holds its result until release; the held-for line goes before
 *        its text when it was held longer than a minute; without a soft interrupt it passes
 */

/* eslint-disable @typescript-eslint/naming-convention -- the API's wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soft-interrupt-direct-')));
const ws = path.join(base, 'ws');
fs.mkdirSync(ws, { recursive: true });
installVscodeStub({ workspaceFolders: [ws] });

import { AnthropicHandler } from '../anthropic-handler.js';
import { heldAtResult } from '../agent-sdk-transport.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { SoftInterruptRegistry } from '../../services/softInterrupt.js';
import { runAsQueueItem } from '../../services/userWaits.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

const echoTool = {
    name: 'tomAi_echo', description: 'echo', readOnly: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (input: { text: string }) => `echo: ${input.text}`,
} as unknown as SharedToolDefinition;

type Reply = { kind: 'tool'; text: string } | { kind: 'text'; text: string };
let replies: Reply[] = [];
const requests: Array<Array<{ role: string; content: unknown }>> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
handler.getClient = () => ({
    messages: {
        stream: (params: { messages: Array<{ role: string; content: unknown }> }) => ({
            finalMessage: async () => {
                requests.push(JSON.parse(JSON.stringify(params.messages)));
                const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
                const content = reply.kind === 'tool'
                    ? [{ type: 'tool_use', id: `tu${requests.length}`, name: 'tomAi_echo', input: { text: reply.text } }]
                    : [{ type: 'text', text: reply.text }];
                return { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        }),
    },
});

function send(extra: Record<string, unknown> = {}) {
    return AnthropicHandler.instance.sendMessage({
        userText: 'do the work',
        profile: { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never' },
        configuration: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 6, transport: 'direct' },
        tools: [echoTool],
        isolated: true,
        source: 'queue',
        ...extra,
    } as never);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const registry = SoftInterruptRegistry.instance;

describe('soft interrupt: the transports\' hold points', () => {
    test('SD-1: the direct loop holds the round\'s results until release', async () => {
        requests.length = 0;
        replies = [{ kind: 'tool', text: 'one' }, { kind: 'text', text: 'All done.' }];
        registry.request('item-d1');
        let ended = false;
        const turn = runAsQueueItem('item-d1', () => send()).then((r) => { ended = true; return r; });
        await wait(200);
        assert.equal(requests.length, 1, 'no request after the held round');
        assert.equal(ended, false);
        const state = registry.stateOf('item-d1')!;
        assert.equal(state.kind, 'tool');
        assert.equal(state.tool, 'tomAi_echo');
        assert.match(state.heldResult ?? '', /echo: one/);
        const conversation = registry.extrasOf('item-d1')?.conversation as { transport: string; messages: Array<{ role: string; content: unknown }> };
        assert.equal(conversation.transport, 'direct');
        assert.equal(conversation.messages[0].content, 'do the work');
        assert.match(JSON.stringify(conversation.messages[conversation.messages.length - 1]), /"type":"tool_result".*echo: one/);
        assert.equal(registry.release('item-d1'), true);
        const result = await turn;
        assert.equal(result.text, 'All done.');
        assert.equal(requests.length, 2, 'the turn went on: one more request, nothing resent');
        assert.match(JSON.stringify(requests[1][requests[1].length - 1]), /echo: one/);
    });

    test('SD-2: a saved conversation continues exactly', async () => {
        requests.length = 0;
        replies = [{ kind: 'text', text: 'Continued.' }];
        const saved = [
            { role: 'user', content: 'do the work' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'tomAi_echo', input: { text: 'one' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '[held]\n\necho: one' }] },
        ];
        const result = await send({ resumeConversation: { transport: 'direct', messages: saved } });
        assert.equal(result.text, 'Continued.');
        assert.deepEqual(requests[0], saved, 'the first request is the saved conversation');
    });

    test('SD-3: an Agent SDK MCP tool handler holds its result', async () => {
        const inner = async () => ({ content: [{ type: 'text', text: 'file contents' }] });
        const wrapped = heldAtResult('tomAi_readFile', inner);
        assert.deepEqual(await runAsQueueItem('item-s3', () => wrapped()), { content: [{ type: 'text', text: 'file contents' }] }, 'nothing requested: passes');
        registry.request('item-s3');
        let out: unknown;
        void runAsQueueItem('item-s3', () => wrapped()).then((r) => { out = r; });
        await wait(20);
        assert.equal(out, undefined, 'held');
        assert.equal(registry.stateOf('item-s3')?.heldResult, 'file contents');
        // Held longer than a minute: the line goes before the result's text.
        const realNow = Date.now;
        Date.now = () => realNow() + 90_000;
        try { registry.release('item-s3'); } finally { Date.now = realNow; }
        await wait(20);
        assert.deepEqual(out, { content: [{ type: 'text', text: '[This result was held for 1 min 30 s by the user\'s interrupt for continuation.]' }, { type: 'text', text: 'file contents' }] });
    });
});
