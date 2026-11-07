/**
 * Subagent definitions on every transport (ccparity_d_claudecode-2, CC-11 (a)):
 * the real spawner (`spawnAnthropicSubagent`) over a fake VS Code LM model in a
 * workspace holding a fixture `.claude/agents/reviewer.md`, and the Agent SDK
 * transport over a fake SDK.
 *
 *   SA-1 `agent: "reviewer"`: the definition's body is the system prompt, its tools (Read, Grep, our own) the
 *        tools sent, the one without an equivalent named in `notes`; its model (`sonnet`, which no
 *        configuration has) leaves the default configuration with a note
 *   SA-2 the caller's systemPrompt / enabledTools win over the definition's
 *   SA-3 progress in the status line: started, each tool call, done with rounds and calls
 *   SA-4 an unknown agent fails naming the agents there are; tomAi_spawnSubagent passes `agent` and returns
 *        `agent`, `model`, `notes`
 *   SA-5 the Agent SDK: the definitions go into its `agents` option (our tools under their MCP names); its own
 *        sub-agent (a Task call with subagent_type) reports started / its tool calls / done in the status line;
 *        top-level tool calls reach onToolUse, the sub-agent's do not
 */

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-definitions-'));
fs.mkdirSync(path.join(tmpRoot, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, '.claude', 'agents', 'reviewer.md'), [
    '---', 'name: reviewer', 'description: Reviews a change.', 'tools: Read, Grep, tomAi_gitRead, Frobnicate', 'model: sonnet', '---',
    'You are the fixture reviewer. Report findings only.',
].join('\n'));
fs.mkdirSync(path.join(tmpRoot, '.tom'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        configurations: [{
            id: 'lm', name: 'lm', model: 'fake-lm', maxTokens: 100, maxRounds: 4, transport: 'vscodeLm', isDefault: true,
            vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' },
        }],
    },
}));
const { stub } = installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import * as vscode from 'vscode';
import { AnthropicHandler, spawnAnthropicSubagent } from '../anthropic-handler.js';
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { spawnSubagentImpl } from '../../tools/planning-tools.js';
import { toSdkAgents, listAgentDefinitions } from '../../services/agentDefinitions.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

/** What each request of the fake model carried: its text and the names of the tools offered. */
const requests: Array<{ text: string; tools: string[] }> = [];
let script: Array<'tool' | 'text'> = ['text'];
// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's own field
(stub.lm as { __models: unknown[] }).__models = [{
    id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
    sendRequest: async (messages: Array<{ content: unknown }>, options?: { tools?: Array<{ name: string }> }) => {
        requests.push({
            text: messages.map((m) => (Array.isArray(m.content) ? m.content : [m.content])
                .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : typeof p === 'string' ? p : '')).join('')).join('\n'),
            tools: (options?.tools ?? []).map((t) => t.name),
        });
        const step = script[Math.min(requests.length - 1, script.length - 1)];
        return {
            stream: (async function* () {
                if (step === 'tool') {
                    yield new vscode.LanguageModelToolCallPart(`call-${requests.length}`, 'tomAi_readFile', { filePath: 'missing.txt' });
                } else {
                    yield new vscode.LanguageModelTextPart('review done');
                }
            })(),
        };
    },
}];

describe('subagent definitions', () => {
    test('SA-1: the definition shapes the sub-agent', async () => {
        requests.length = 0;
        script = ['text'];
        const result = await spawnAnthropicSubagent({ agent: 'reviewer', prompt: 'Review the change.' });
        assert.match(requests[0].text, /You are the fixture reviewer\. Report findings only\./);
        assert.match(requests[0].text, /Review the change\./);
        assert.deepEqual([...requests[0].tools].sort(), ['tomAi_findTextInFiles', 'tomAi_gitRead', 'tomAi_readFile']);
        assert.equal(result.agent, 'reviewer');
        assert.equal(result.model, 'fake-lm');
        assert.equal(result.summary, 'review done');
        assert.ok(result.notes?.some((n) => /Frobnicate/.test(n)), 'the unmapped tool is named');
        assert.ok(result.notes?.some((n) => /"sonnet"/.test(n)), 'the model not found is named');
    });

    test('SA-2: the caller\'s values win', async () => {
        requests.length = 0;
        script = ['text'];
        await spawnAnthropicSubagent({ agent: 'reviewer', prompt: 'p', systemPrompt: 'Caller prompt.', enabledTools: ['tomAi_listDirectory'] });
        assert.match(requests[0].text, /Caller prompt\./);
        assert.doesNotMatch(requests[0].text, /fixture reviewer/);
        assert.deepEqual(requests[0].tools, ['tomAi_listDirectory']);
    });

    test('SA-3: progress in the status line', async () => {
        requests.length = 0;
        script = ['tool', 'text'];
        const lines: string[] = [];
        const sub = AnthropicHandler.instance.onStatusUpdate((t) => lines.push(t));
        try {
            const result = await spawnAnthropicSubagent({ agent: 'reviewer', prompt: 'p' });
            assert.equal(result.toolCalls, 1);
        } finally {
            sub.dispose();
        }
        const mine = lines.filter((l) => l.startsWith('Sub-agent reviewer'));
        assert.deepEqual(mine, [
            'Sub-agent reviewer started (fake-lm)',
            'Sub-agent reviewer: tomAi_readFile (call 1)',
            'Sub-agent reviewer done: 2 rounds, 1 tool calls',
        ]);
    });

    test('SA-4: an unknown agent; the tool passes agent through', async () => {
        await assert.rejects(spawnAnthropicSubagent({ agent: 'nobody', prompt: 'p' }), /No agent "nobody".*Agents: reviewer\./);
        let seenAgent: string | undefined;
        const raw = await spawnSubagentImpl({ prompt: 'p', agent: 'reviewer' }, {
            get: () => async (o) => { seenAgent = o.agent; return { summary: 's', rounds: 1, toolCalls: 0, agent: 'reviewer', model: 'm', notes: ['n'] }; },
        });
        assert.equal(seenAgent, 'reviewer');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        assert.equal(parsed.agent, 'reviewer');
        assert.equal(parsed.model, 'm');
        assert.deepEqual(parsed.notes, ['n']);
    });

    test('SA-5: the Agent SDK', async () => {
        const fake = fakeSuccessSdk({
            messages: [
                { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'reviewer', description: 'Review the diff', prompt: 'x' } }] } },
                { type: 'assistant', parent_tool_use_id: 'task-1', message: { content: [{ type: 'tool_use', id: 'r-1', name: 'Read', input: { file_path: '/a' } }] } },
                { type: 'user', parent_tool_use_id: 'task-1', message: { content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'a' }] } },
                { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'review done' }] } },
            ],
        });
        __setAgentSdkForTests(fake.sdk);
        const status: string[] = [];
        const toolUses: string[] = [];
        try {
            await runAgentSdkQuery({
                configuration: { id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
                tools: [],
                systemPrompt: '',
                userText: 'review',
                context: {
                    requestApproval: async () => true, sessionApprovals: new Set(), toolTrail: new ToolTrail(),
                    round: 1, questId: 'test_quest', windowId: 'win', requestId: 'req-1',
                } as unknown as AgentSdkSendParams['context'],
                toolApprovalMode: 'never',
                useBuiltInTools: true,
                agents: toSdkAgents(listAgentDefinitions(tmpRoot)),
                onStatus: (t) => status.push(t),
                onToolUse: (n) => toolUses.push(n),
            });
        } finally {
            __setAgentSdkForTests(undefined);
        }
        const agents = fake.options[0].agents as Record<string, { prompt: string; tools?: string[]; model?: string }>;
        assert.deepEqual(Object.keys(agents), ['reviewer']);
        assert.deepEqual(agents.reviewer.tools, ['Read', 'Grep', 'mcp__tom-ai__tomAi_gitRead', 'Frobnicate']);
        assert.equal(agents.reviewer.model, 'sonnet');
        assert.match(agents.reviewer.prompt, /fixture reviewer/);
        assert.deepEqual(status, [
            'Sub-agent reviewer started: Review the diff',
            'Sub-agent reviewer: Read (call 1)',
            'Sub-agent reviewer done: 1 tool calls',
        ]);
        assert.deepEqual(toolUses, ['Task'], 'only the top-level call');
    });
});
