/**
 * Rich tool results on the direct transport (ccparity_c_transports-10): a
 * tool with `executeRich` (tomAi_readFile on an image or a PDF) answers the
 * direct API with content blocks; every other transport keeps the text.
 *
 *   RT-1 direct: runTool answers executeRich's blocks as the tool_result content; execute does not run;
 *        the tool trail and the live trail get the stand-in text
 *   RT-2 Local LLM and VS Code LM: execute's text, executeRich not called
 *   RT-3 executeRich answering nothing (not an image): execute's text on direct too
 *   RT-4 retention: the round just added keeps its media blocks (the inline cut is for text); a media round
 *        past keepRounds becomes a stub like any other
 */

/* eslint-disable @typescript-eslint/naming-convention -- tool_result / media wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-tool-results-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { applyToolTrailRetention, type RetentionMessage, type RetentionTrail } from '../../services/toolTrailRetention.js';
import type { RichToolResult, SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const RICH: RichToolResult = { text: 'Image shot.png (image/png, 8 bytes).', blocks: [{ type: 'text', text: 'Image shot.png (image/png, 8 bytes).' }, IMAGE as never] };

const calls: string[] = [];
let richAnswer: RichToolResult | undefined = RICH;
const READ = {
    name: 'tomAi_readFile', description: 'r', readOnly: true, inputSchema: { type: 'object', properties: {} },
    execute: async () => { calls.push('execute'); return 'the bytes as text'; },
    executeRich: async () => { calls.push('executeRich'); return richAnswer; },
} as unknown as SharedToolDefinition;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;

async function runTool(transport: string) {
    const liveResults: string[] = [];
    const liveTrail = new Proxy({}, { get: (_t, name) => (name === 'appendToolResult' ? (r: string) => { liveResults.push(r); } : () => undefined) });
    const result = await handler.runTool(
        { type: 'tool_use', id: `tu-${transport}-${calls.length}`, name: 'tomAi_readFile', input: { filePath: 'shot.png' } },
        [READ],
        { id: 'cfg', name: 'cfg', model: 'm', maxTokens: 100, maxRounds: 3, transport },
        { profile: { id: 'p', toolApprovalMode: 'never' } },
        1, 'test_quest', 'win', 'req-1', liveTrail,
    );
    return { result: result as { content: unknown; is_error?: boolean }, liveResults };
}

beforeEach(() => { calls.length = 0; richAnswer = RICH; });

describe('rich tool results', () => {
    test('RT-1: direct gets the blocks', async () => {
        for (const transport of ['direct', undefined]) {
            calls.length = 0;
            const { result, liveResults } = await runTool(transport as string);
            assert.deepEqual(result.content, RICH.blocks, String(transport));
            assert.notEqual(result.is_error, true);
            assert.deepEqual(calls, ['executeRich'], 'execute does not run');
            assert.deepEqual(liveResults, [RICH.text]);
            const entries = handler.toolTrail.listEntries() as Array<{ toolName: string; result: string }>;
            assert.equal(entries[entries.length - 1].result, RICH.text, 'the tool trail holds the stand-in');
        }
    });

    test('RT-2: the other transports keep the text', async () => {
        for (const transport of ['localLlm', 'vscodeLm']) {
            calls.length = 0;
            const { result } = await runTool(transport);
            assert.equal(result.content, 'the bytes as text', transport);
            assert.deepEqual(calls, ['execute'], transport);
        }
    });

    test('RT-3: no rich answer — the text', async () => {
        richAnswer = undefined;
        const { result } = await runTool('direct');
        assert.equal(result.content, 'the bytes as text');
        assert.deepEqual(calls, ['executeRich', 'execute']);
    });

    test('RT-4: retention keeps the new media round, stubs it later', () => {
        const trail: RetentionTrail = {
            inlineMaxChars: 100, keepRounds: 1,
            truncateInline: (_k, _n, _i, body) => `[cut] ${body.slice(0, 10)}`,
            renderStub: (e) => `[Past tool call ${e.key}]`,
        };
        const round = (id: string, content: unknown): RetentionMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
        const entry = (key: string) => ({ key, toolName: 'tomAi_readFile', inputSummary: '{}', round: 1, timestamp: '', result: '', durationMs: 0 });
        const entries: Record<string, ReturnType<typeof entry>> = { a: entry('t1'), b: entry('t2') };
        const messages: RetentionMessage[] = [round('a', structuredClone(RICH.blocks))];
        applyToolTrailRetention(messages, trail, (id) => entries[id] as never, { inlineMaxChars: 100, keepRounds: 1 });
        const first = (messages[0].content as Array<{ content: unknown }>)[0].content;
        assert.deepEqual(first, RICH.blocks, 'the new image round is not flattened');
        messages.push({ role: 'assistant', content: [{ type: 'text', text: 'next' }] }, round('b', 'text answer'));
        applyToolTrailRetention(messages, trail, (id) => entries[id] as never, { inlineMaxChars: 100, keepRounds: 1 });
        assert.equal((messages[0].content as Array<{ content: unknown }>)[0].content, '[Past tool call t1]', 'past keepRounds: a stub');
    });
});
