/**
 * The Local LLM loop trims old tool results like the direct and VS Code LM loops (CC-6), through the handler's
 * real loop (sendViaLocalLlm) over a fake Local LLM call.
 *
 *   LT-1 a result longer than toolTrailMaxResultChars is cut when it arrives; rounds past toolTrailKeepRounds
 *        become a stub naming their replay key (no prompt cache: every round past keepRounds); the newest rounds
 *        stay whole; every assistant tool_calls message keeps its `tool` messages, in order
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-trimming-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { AnthropicHandler } from '../anthropic-handler.js';
import { setLocalLlmManager } from '../localLlm-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

type Msg = { role: string; content?: string; tool_calls?: unknown[] };
/** Each request's messages, copied as they were sent. */
const seen: Msg[][] = [];
let script: Array<{ text?: string; toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }> = [];
setLocalLlmManager({
    callLocalLlmOnce: async (opts: { messages: Msg[] }) => {
        seen.push(opts.messages.map((m) => ({ ...m })));
        const next = script[Math.min(seen.length - 1, script.length - 1)];
        return { text: next.text ?? '', toolCalls: next.toolCalls, stats: {} };
    },
} as never);

const ran: string[] = [];
const BIG = 'x'.repeat(500);
const READ_TOOL = {
    name: 'tomAi_readFile', description: 'r', readOnly: true, inputSchema: { type: 'object', properties: {} },
    execute: async (input: { n?: number }) => { ran.push(`read${input.n}`); return `content ${input.n} ${input.n === 1 ? BIG : ''}`.trim(); },
} as unknown as SharedToolDefinition;
const call = (n: number) => ({ toolCalls: [{ function: { name: 'tomAi_readFile', arguments: { n } } }] });

async function send(caps: Record<string, number> = {}) {
    const liveTrail = new Proxy({}, { get: () => () => undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = AnthropicHandler.instance as any;
    return handler.sendViaLocalLlm(
        {
            configuration: {
                id: 'local-cfg', name: 'local', model: 'gemma', maxTokens: 1000, maxRounds: 8, transport: 'localLlm',
                localLlm: { baseUrl: 'http://localhost:1', model: 'gemma' }, ...caps,
            },
            profile: { id: 'p', toolApprovalMode: 'never', retryMaxTotalWaitMinutes: 1 },
            tools: [READ_TOOL],
            isolated: true,
        },
        ['system'], 'user prompt', 'win', 'req-1', 1, 'test_quest', 'user prompt', liveTrail,
    );
}

const toolContents = (msgs: Msg[]): string[] => msgs.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('Local LLM: trimming old tool results', () => {
    test('LT-1: cut on arrival, stubbed past keepRounds', async () => {
        seen.length = 0;
        ran.length = 0;
        script = [call(1), call(2), call(3), call(4), { text: 'done' }];
        const result = await send({ toolTrailKeepRounds: 2, toolTrailMaxResultChars: 100 });
        assert.match(String(result.text), /done/);
        assert.deepEqual(ran, ['read1', 'read2', 'read3', 'read4']);
        const second = toolContents(seen[1]);
        assert.equal(second.length, 1);
        assert.match(second[0], /^\[Truncated inline view: 100\/510 chars\. Full result available via tomAi_readPastToolResult\(\{"key":"t\d+"\}\)/,
            'round 1\'s 510-character result is cut to the inline length when it arrives, naming its replay key');
        const last = seen[4];
        const tools = toolContents(last);
        assert.equal(tools.length, 4, 'every call keeps its tool message');
        assert.match(tools[0], /^\[Past tool call t\d+/, 'round 1: a stub with its replay key');
        assert.match(tools[1], /^\[Past tool call t\d+/, 'round 2: a stub');
        assert.equal(tools[2], 'content 3', 'the newest two rounds stay whole');
        assert.equal(tools[3], 'content 4');
        const shape = last.map((m) => (m.tool_calls ? 'assistant+calls' : m.role));
        assert.deepEqual(shape, ['system', 'user', 'assistant+calls', 'tool', 'assistant+calls', 'tool', 'assistant+calls', 'tool', 'assistant+calls', 'tool'],
            'each tool message follows its assistant tool_calls message');
    });

});
