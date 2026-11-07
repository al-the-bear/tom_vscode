/**
 * The VS Code LM loop's retry and tool-result trimming (CC-6), through the
 * handler's real loop (sendViaVsCodeLm) over a fake `vscode.lm` model.
 *
 *   VL-1 which errors are retried: 429 / 5xx in VS Code LM's shapes ("Request Failed: 429", "Server error: 503"),
 *        rate limits; not `Blocked` / `NoPermissions` / `NotFound`, not a plain failure
 *   VL-2 a busy backend: the request is sent again and the answer comes from the retry; the retry is reported
 *        (live trail); a failure mid-stream retries the whole request, its partial text not kept
 *   VL-3 a non-transient error is thrown at once, not retried
 *   VL-4 trimming: a result longer than toolTrailMaxResultChars is cut when it arrives; rounds past
 *        toolTrailKeepRounds become a stub naming their replay key; the newest rounds stay whole; every
 *        tool_call keeps its result part (same call ids)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-lm-robustness-'));
const { stub } = installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import * as vscode from 'vscode';
import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { isRetryableVsCodeLmError } from '../../utils/retryableError.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

/** What one request carried: per message, its role and text / tool parts flattened. */
type Seen = Array<{ role: unknown; parts: string[] }>;

function flatten(messages: unknown[]): Seen {
    return messages.map((m) => {
        const msg = m as { role: unknown; content: unknown };
        const content = Array.isArray(msg.content) ? msg.content : [msg.content];
        return {
            role: msg.role,
            parts: content.map((p) => {
                if (p instanceof vscode.LanguageModelTextPart) { return `text:${p.value}`; }
                if (p instanceof vscode.LanguageModelToolCallPart) { return `call:${p.callId}`; }
                if (p instanceof vscode.LanguageModelToolResultPart) {
                    return `result:${p.callId}:${(p.content as vscode.LanguageModelTextPart[]).map((t) => t.value).join('')}`;
                }
                return String(p);
            }),
        };
    });
}

/** A fake model: each request answers the next script entry — an error to throw, or parts to stream. */
function fakeModel(script: Array<Error | { parts: unknown[]; failAfter?: Error }>) {
    const seen: Seen[] = [];
    const model = {
        id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
        sendRequest: async (messages: unknown[]) => {
            seen.push(flatten(messages));
            const next = script[Math.min(seen.length - 1, script.length - 1)];
            if (next instanceof Error) { throw next; }
            return {
                stream: (async function* () {
                    for (const p of next.parts) { yield p; }
                    if (next.failAfter) { throw next.failAfter; }
                })(),
            };
        },
    };
    (stub.lm as { __models: unknown[] }).__models = [model];
    return { seen };
}

const ran: string[] = [];
const BIG = 'x'.repeat(500);
const READ_TOOL = {
    name: 'tomAi_readFile', description: 'r', readOnly: true, inputSchema: { type: 'object', properties: {} },
    execute: async (input: { n?: number }) => { ran.push(`read${input.n}`); return `content ${input.n} ${input.n === 1 ? BIG : ''}`.trim(); },
} as unknown as SharedToolDefinition;

async function send(caps: Record<string, number> = {}) {
    const retries: string[] = [];
    // Every live-trail method is a no-op; appendRetry is recorded.
    const liveTrail = new Proxy({}, {
        get: (_t, name) => (name === 'appendRetry' ? (msg: string) => { retries.push(msg); } : () => undefined),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = AnthropicHandler.instance as any;
    const result = await handler.sendViaVsCodeLm(
        {
            configuration: {
                id: 'lm-cfg', name: 'lm', model: 'fake-lm', maxTokens: 1000, maxRounds: 8, transport: 'vscodeLm',
                vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' }, ...caps,
            },
            profile: { id: 'p', toolApprovalMode: 'never', retryMaxTotalWaitMinutes: 1 },
            tools: [READ_TOOL],
            isolated: true,
        },
        ['system'], 'user prompt', 'win', 'req-1', 1, 'test_quest', 'user prompt', liveTrail,
    );
    return { result, retries };
}

const call = (n: number) => new vscode.LanguageModelToolCallPart(`call-${n}`, 'tomAi_readFile', { n });
const text = (t: string) => new vscode.LanguageModelTextPart(t);

describe('VS Code LM: retry and trimming', () => {
    test('VL-1: what is retried', () => {
        for (const e of [new Error('Request Failed: 429 Too Many Requests'), new Error('Server error: 503'), new Error('Sorry, you have been rate-limited'),
            new Error('status code: 502'), Object.assign(new Error('x'), { status: 529 })]) {
            assert.equal(isRetryableVsCodeLmError(e), true, e.message);
        }
        for (const e of [Object.assign(new Error('Request Failed: 429'), { code: 'Blocked' }), Object.assign(new Error('no'), { code: 'NoPermissions' }),
            Object.assign(new Error('gone'), { code: 'NotFound' }), new Error('Request Failed: 400 bad request'), new Error('Request Failed: 501')]) {
            assert.equal(isRetryableVsCodeLmError(e), false, e.message);
        }
    });

    test('VL-2: a busy backend is retried', async () => {
        const { seen } = fakeModel([
            new Error('Request Failed: 429 Too Many Requests'),
            { parts: [text('half an ans')], failAfter: new Error('Server error: 503') },
            { parts: [text('the answer')] },
        ]);
        const { result, retries } = await send();
        assert.equal(seen.length, 3, 'sent again after the 429 and after the failure mid-stream');
        assert.equal(retries.length, 2, 'each retry reported');
        assert.match(String(result.text), /the answer/);
        assert.doesNotMatch(String(result.text), /half an ans/, 'the broken response is not kept');
    });

    test('VL-3: a non-transient error is not retried', async () => {
        const { seen } = fakeModel([Object.assign(new Error('The model is blocked'), { code: 'Blocked' })]);
        await assert.rejects(() => send(), /blocked/);
        assert.equal(seen.length, 1);
    });

    test('VL-4: old tool results are trimmed', async () => {
        ran.length = 0;
        const { seen } = fakeModel([
            { parts: [call(1)] },
            { parts: [call(2)] },
            { parts: [call(3)] },
            { parts: [call(4)] },
            { parts: [text('done')] },
        ]);
        await send({ toolTrailKeepRounds: 2, toolTrailMaxResultChars: 100 });
        assert.deepEqual(ran, ['read1', 'read2', 'read3', 'read4']);
        const results = (s: Seen) => s.flatMap((m) => m.parts).filter((p) => p.startsWith('result:'));
        const second = results(seen[1]);
        assert.equal(second.length, 1);
        assert.match(second[0], /^result:call-1:\[Truncated inline view: 100\/510 chars\. Full result available via tomAi_readPastToolResult\(\{"key":"t\d+"\}\)/,
            'round 1\'s 510-character result is cut to the inline length when it arrives, naming its replay key');
        assert.ok(second[0].length < 510, 'shorter than the result');
        const last = results(seen[4]);
        assert.deepEqual(last.map((r) => r.split(':')[1]), ['call-1', 'call-2', 'call-3', 'call-4'], 'every call keeps its result part');
        assert.match(last[0], /^result:call-1:\[Past tool call t\d+/, 'round 1: a stub with its replay key');
        assert.match(last[1], /^result:call-2:\[Past tool call t\d+/, 'round 2: a stub');
        assert.equal(last[2], 'result:call-3:content 3', 'the newest two rounds stay whole');
        assert.equal(last[3], 'result:call-4:content 4');
        const calls = seen[4].flatMap((m) => m.parts).filter((p) => p.startsWith('call:'));
        assert.deepEqual(calls, ['call:call-1', 'call:call-2', 'call:call-3', 'call:call-4'], 'the tool_call parts stay');
    });
});
