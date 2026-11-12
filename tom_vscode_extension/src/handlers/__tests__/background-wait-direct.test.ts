/**
 * A direct-API queue turn waits for the command streams it started (vscimpb56), through the real handler and its
 * direct loop; only the Anthropic client is a stub that scripts the model's replies.
 *
 *   BD-1 the model starts `tomAi_runCommandStream` and ends its turn ("waiting to get notified"): the turn holds
 *        while the command runs, then goes on with a message naming the command and its exit code; the model's
 *        answer to it is the turn's answer; the waiting state was reported, then cleared
 *   BD-2 the limit (the queue item's, here a few hundred ms) ends the wait: the answer ends with the hint naming
 *        the command still running, and no extra round is sent
 *   BD-3 a chat send (not the queue) does not wait
 *   BD-4 the Local LLM loop waits the same way (wired through the same helper)
 */

/* eslint-disable @typescript-eslint/naming-convention -- the API's wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'background-wait-direct-')));
const ws = path.join(base, 'ws');
fs.mkdirSync(ws, { recursive: true });
installVscodeStub({ workspaceFolders: [ws] });

import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { _resetRegistryForTesting, runCommandStreamImpl } from '../../tools/process-tools.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';
import type { BackgroundWaitState } from '../../utils/backgroundWait.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
after(() => {
    _resetRegistryForTesting();
    fs.rmSync(base, { recursive: true, force: true });
});

const streamTool = {
    name: 'tomAi_runCommandStream', description: 'stream', readOnly: false,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async (input: { command: string }) => runCommandStreamImpl({ wsRoot: ws }, input),
} as unknown as SharedToolDefinition;

/** What the stub model answers, per request; each request's messages are kept. */
type Reply = { kind: 'tool'; command: string } | { kind: 'text'; text: string };
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
                    ? [{ type: 'tool_use', id: `tu${requests.length}`, name: 'tomAi_runCommandStream', input: { command: reply.command } }]
                    : [{ type: 'text', text: reply.text }];
                return { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        }),
    },
});

function send(opts: { source?: 'queue' | 'chat'; limit?: number; states?: Array<BackgroundWaitState | undefined> }) {
    return AnthropicHandler.instance.sendMessage({
        userText: 'run the suites and report',
        profile: { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never' },
        configuration: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 6, transport: 'direct' },
        tools: [streamTool],
        isolated: true,
        source: opts.source ?? 'queue',
        ...(opts.limit !== undefined ? { backgroundWaitLimitMinutes: opts.limit } : {}),
        ...(opts.states ? { onBackgroundWait: (s: BackgroundWaitState | undefined) => { opts.states!.push(s); } } : {}),
    } as never);
}

const lastUserText = (msgs: Array<{ role: string; content: unknown }>): string => {
    const last = msgs[msgs.length - 1];
    return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
};

describe('a direct-API queue turn waits for its command streams', () => {
    test('BD-1: held while the command runs, then goes on with its end', async () => {
        requests.length = 0;
        replies = [
            { kind: 'tool', command: 'sleep 1; echo built; exit 0' },
            { kind: 'text', text: 'Started the build; I am waiting to get notified.' },
            { kind: 'text', text: 'The build finished with exit code 0. Done.' },
        ];
        const states: Array<BackgroundWaitState | undefined> = [];
        const started = Date.now();
        const result = await send({ states });
        assert.ok(Date.now() - started >= 900, 'the turn waited for the command');
        assert.equal(requests.length, 3, 'one more round after the command ended');
        assert.match(lastUserText(requests[2]), /The background command you started has finished:.*`sleep 1; echo built; exit 0` \[proc_\d+_\w+\]: exit code 0/s);
        assert.equal(result.text, 'The build finished with exit code 0. Done.');
        assert.equal(states[0]?.items[0]?.command, 'sleep 1; echo built; exit 0');
        assert.equal(states[0]?.limitMinutes, 360, 'the default limit');
        assert.equal(states[states.length - 1], undefined, 'cleared');
    });

    test('BD-2: the limit ends the wait with the hint', async () => {
        requests.length = 0;
        replies = [
            { kind: 'tool', command: 'sleep 30' },
            { kind: 'text', text: 'Waiting for the long run.' },
        ];
        const result = await send({ limit: 0.01 });
        assert.equal(requests.length, 2, 'no round after the limit');
        assert.match(result.text, /^Waiting for the long run\.\n\n_\(1 background task was still running when this turn ended — the queue stopped waiting after 1 s \(the background-wait limit\)/);
        assert.match(result.text, /sleep 30 \[proc_/);
        _resetRegistryForTesting();
    });

    test('BD-3: a chat send does not wait', async () => {
        requests.length = 0;
        replies = [
            { kind: 'tool', command: 'sleep 30' },
            { kind: 'text', text: 'Started.' },
        ];
        const started = Date.now();
        const result = await send({ source: 'chat' });
        assert.ok(Date.now() - started < 1_500);
        assert.equal(result.text, 'Started.');
        assert.equal(requests.length, 2);
        _resetRegistryForTesting();
    });

    test('BD-4: the Local LLM loop waits the same way', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const local = src.slice(src.indexOf('private async sendViaLocalLlm('));
        assert.match(local, /const background = await this\.awaitBackgroundCommands\(options, liveTrail, turn \+ 1 < configuration\.maxRounds\);/);
        assert.match(local, /messages\.push\(\{ role: 'user', content: background\.continueWith \}\);/);
    });
});
