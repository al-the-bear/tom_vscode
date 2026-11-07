/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (tool_use_id) */
/**
 * Parallel tool calls on the direct transport (DA-11, dapieff4):
 * src/utils/parallelToolCalls.ts, DirectSendUsage, the usage block.
 *
 *   PT-1 the reminder: the setting's text (trimmed), the built-in one when unset, none when ''
 *   PT-2 the appended block: the round's tool results, then the reminder as a text block; over a tool loop
 *        with signed thinking every earlier message stays byte for byte as sent, each keeping its reminder
 *   PT-3 the share: assistant turns, turns that called tools, turns with more than one call; also measured
 *        from a request's messages
 *   PT-4 the usage block of a direct send carries the counts and renders the share
 *   PT-5 the direct loop counts every response's tool calls, appends the reminder from the setting, and the
 *        setting is in the schema and the config type
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    DEFAULT_PARALLEL_CALLS_REMINDER, addAssistantTurn, emptyToolTurns, multiCallShare, parallelCallsReminder,
    roundResultContent, toolTurnsOfMessages,
} from '../parallelToolCalls.js';
import { DirectSendUsage } from '../usageCost.js';
import { formatLiveTrailUsage, type LiveTrailToolTurns } from '../../services/live-trail.js';
import { ToolTrail, type ToolTrailEntry } from '../../services/tool-trail.js';
import { applyToolTrailRetention, type RetentionMessage } from '../../services/toolTrailRetention.js';

const ROOT = join(__dirname, '..', '..', '..');
const src = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

describe('parallel tool calls', () => {
    test('PT-1: the reminder', () => {
        assert.equal(parallelCallsReminder(undefined), DEFAULT_PARALLEL_CALLS_REMINDER);
        assert.equal(parallelCallsReminder(null), DEFAULT_PARALLEL_CALLS_REMINDER);
        assert.equal(parallelCallsReminder(''), '');
        assert.equal(parallelCallsReminder('   '), '');
        assert.equal(parallelCallsReminder('  Batch calls.  '), 'Batch calls.');
        assert.match(DEFAULT_PARALLEL_CALLS_REMINDER, /same turn/);
    });

    test('PT-2: the appended block, earlier copies left as sent', () => {
        const results = [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }];
        const content = roundResultContent(results, 'R');
        assert.deepEqual(content, [results[0], { type: 'text', text: 'R' }]);
        assert.equal(results.length, 1, 'the results are not changed');
        assert.deepEqual(roundResultContent(results, ''), results, 'no reminder: the results alone');

        // A tool loop whose model thinks: each round's results + reminder; nothing sent before changes.
        const trail = new ToolTrail({ keepRounds: 1, inlineMaxChars: 100 });
        const byId = new Map<string, ToolTrailEntry>();
        const messages: RetentionMessage[] = [{ role: 'user', content: 'go' }];
        let sent: string[] = [];
        for (let round = 1; round <= 5; round++) {
            const id = `toolu_${round}`;
            messages.push({ role: 'assistant', content: [
                { type: 'thinking', thinking: `t${round}`, signature: `s${round}` },
                { type: 'tool_use', id, name: 'tomAi_readFile', input: {} },
            ] });
            const result = `r${round} `.repeat(80);
            byId.set(id, trail.add({ timestamp: '0', round, toolName: 'tomAi_readFile', inputSummary: '', result, durationMs: 1 }));
            messages.push({ role: 'user', content: roundResultContent([{ type: 'tool_result', tool_use_id: id, content: result }], 'R') });
            applyToolTrailRetention(messages, trail, (u) => byId.get(u), { keepRounds: 1, inlineMaxChars: 100 });
            const now = messages.map((m) => JSON.stringify(m));
            assert.deepEqual(now.slice(0, sent.length), sent, `round ${round}: an earlier message changed`);
            const last = messages[messages.length - 1].content as Array<{ type: string; text?: string }>;
            assert.deepEqual(last[last.length - 1], { type: 'text', text: 'R' }, 'the reminder follows the results, also after the cut');
            sent = now;
        }
        const reminders = messages.filter((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'text'));
        assert.equal(reminders.length, 5, 'every round keeps its own copy');
    });

    test('PT-3: the share', () => {
        let t = emptyToolTurns();
        for (const calls of [1, 3, 0, 2, 1]) { t = addAssistantTurn(t, calls); }
        assert.deepEqual(t, { assistantTurns: 5, toolTurns: 4, multiCallTurns: 2 });
        assert.equal(multiCallShare(t), 0.4);
        assert.equal(multiCallShare(emptyToolTurns()), 0);
        assert.deepEqual(toolTurnsOfMessages([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [{ type: 'tool_use' }, { type: 'tool_use' }] },
            { role: 'user', content: [{ type: 'tool_result' }] },
            { role: 'assistant', content: [{ type: 'text' }, { type: 'tool_use' }] },
            { role: 'assistant', content: 'done' },
        ]), { assistantTurns: 3, toolTurns: 2, multiCallTurns: 1 });
    });

    test('PT-4: the usage block', () => {
        const send = new DirectSendUsage('claude-opus-5-5', undefined, () => undefined);
        send.addRound({ inputTokens: 10, outputTokens: 2 });
        for (const calls of [2, 1, 0]) { send.addTurn(calls); }
        const block = send.sendUsage();
        assert.deepEqual(block?.toolTurns, { assistantTurns: 3, toolTurns: 2, multiCallTurns: 1 } satisfies LiveTrailToolTurns);
        assert.match(formatLiveTrailUsage(block!, new Date()), /- parallel calls: 1 of 3 turns made more than one tool call \(33 %\); 2 called tools/);
        assert.doesNotMatch(formatLiveTrailUsage({ totals: { inputTokens: 1 } }, new Date()), /parallel calls/, 'other transports: no line');
    });

    test('PT-5: the direct loop and the setting', () => {
        const handler = src('src', 'handlers', 'anthropic-handler.ts');
        const loop = handler.slice(handler.indexOf('const sendUsage = new DirectSendUsage('), handler.indexOf('private async sendViaVsCodeLm'));
        assert.match(loop, /const parallelReminder = parallelCallsReminder\(loadSendToChatConfig\(\)\?\.anthropic\?\.parallelToolCallsReminder\)/);
        assert.match(loop, /sendUsage\.addTurn\(response\.content\.filter\(\(b\) => b\.type === 'tool_use'\)\.length\)/);
        assert.match(loop, /messages\.push\(\{ role: 'user', content: roundResultContent\(toolResults, parallelReminder\) \}\)/);
        assert.doesNotMatch(loop, /content: toolResults \}/, 'no round goes out without the reminder');
        const schema = JSON.parse(src('src', 'config', 'tom_vscode_extension.schema.json'));
        assert.equal(schema.properties.anthropic.properties.parallelToolCallsReminder.type, 'string');
        assert.match(src('src', 'utils', 'sendToChatConfig.ts'), /parallelToolCallsReminder\?: string;/);
    });
});
