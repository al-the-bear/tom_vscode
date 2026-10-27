/**
 * One line per agent tool call in the Tom Tool Log channel (src/utils/toolCallLog.ts).
 *
 *   TL-1 the line: time, transport, tool, duration, result size, `ok` or the error's first line — one line
 *        whatever the error holds, so `tomAi_readOutputChannel {channel: 'Tom Tool Log', grep}` finds it
 *   TL-2 no sink (tests, before activation): nothing happens; a sink that throws never breaks a tool call
 *   TL-3 the shared MCP wrapper (Agent SDK in-process server, standalone MCP server) logs every call under its
 *        transport, with the duration of the call itself (a slow fake tool), and failures as errors
 *   TL-4 the Anthropic handler's runTool (direct, VS Code LM, Local LLM through a profile) logs under the
 *        configuration's transport; the Agent SDK and MCP wrappers name theirs; the sink is the Tom Tool Log
 *        channel, set at activation
 */

import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatToolCallLine, logToolCall, setToolCallLogSink } from '../toolCallLog.js';
import { wrapToolWithTrail } from '../toolTrailWrapper.js';

const src = (...p: string[]): string => readFileSync(join(__dirname, '..', '..', '..', 'src', ...p), 'utf-8');

afterEach(() => setToolCallLogSink(undefined));

describe('tool call log', () => {
    test('TL-1: the line', () => {
        const at = new Date('2026-10-27T17:20:01.123Z');
        assert.equal(formatToolCallLine({ at, transport: 'agentSdk', tool: 'tomAi_readFile', durationMs: 1234, resultChars: 532 }),
            '2026-10-27T17:20:01.123Z [tool-call] agentSdk tomAi_readFile 1234 ms 532 chars ok');
        assert.equal(formatToolCallLine({ at, transport: 'mcp', tool: 'tomAi_x', durationMs: 5, resultChars: 9, error: 'boom\n  at stack line' }),
            '2026-10-27T17:20:01.123Z [tool-call] mcp tomAi_x 5 ms 9 chars error: boom');
    });

    test('TL-2: no sink, or a failing sink', () => {
        logToolCall({ at: new Date(), transport: 'direct', tool: 't', durationMs: 1, resultChars: 1 });
        setToolCallLogSink(() => { throw new Error('channel disposed'); });
        assert.doesNotThrow(() => logToolCall({ at: new Date(), transport: 'direct', tool: 't', durationMs: 1, resultChars: 1 }));
    });

    test('TL-3: the MCP wrapper logs every call', async () => {
        const lines: string[] = [];
        setToolCallLogSink((l) => lines.push(l));
        const sink = { writeRequest: () => undefined, writeAnswer: () => undefined };
        const slow = { name: 'tomAi_slow', description: '', inputSchema: {}, execute: () => new Promise<string>((r) => setTimeout(() => r('done'), 60)) };
        const failing = { name: 'tomAi_fail', description: '', inputSchema: {}, execute: async () => { throw new Error('no such file'); } };
        await wrapToolWithTrail(slow as never, sink, () => ({ source: 'anthropic' }), 'agentSdk')({});
        const failed = await wrapToolWithTrail(failing as never, sink, () => ({ source: 'mcp' }), 'mcp')({});
        assert.equal(failed.isError, true);
        assert.equal(lines.length, 2);
        const m = /\[tool-call\] agentSdk tomAi_slow (\d+) ms 4 chars ok$/.exec(lines[0]);
        assert.ok(m, lines[0]);
        assert.ok(Number(m![1]) >= 50, 'the duration wraps the call');
        assert.match(lines[1], /\[tool-call\] mcp tomAi_fail \d+ ms \d+ chars error: no such file$/);
    });

    test('TL-4: every transport is wired', () => {
        const handler = src('handlers', 'anthropic-handler.ts');
        const at = handler.indexOf('private async runTool(');
        const runTool = handler.slice(at, handler.indexOf('\n    }\n', at));
        assert.match(runTool, /logToolCall\(\{ at: new Date\(\), transport: configuration\.transport \?\? 'direct', tool: block\.name, durationMs, resultChars: result\.length, error \}\)/);
        assert.match(src('handlers', 'agent-sdk-transport.ts'), /\(\) => \(\{ source: 'anthropic', requestId: ctx\.requestId \}\),\s*'agentSdk',/);
        assert.match(src('handlers', 'mcpServer-handler.ts'), /'mcp',\s*\);/);
        assert.match(src('extension.ts'), /setToolCallLogSink\(\(line\) => getToolLogChannel\(\)\.appendLine\(line\)\)/);
    });
});
