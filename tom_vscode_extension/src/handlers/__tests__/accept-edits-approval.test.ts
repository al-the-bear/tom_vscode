/**
 * Tool Approval "Accept edits" (CC-9) on every transport, per tool class:
 * file edits go through without asking, commands and every other writer ask,
 * readers never ask.
 *
 *   AE-1 per transport whose tool loop the extension runs (direct, localLlm, vscodeLm), through
 *        AnthropicHandler.runTool with the approval stubbed: a file edit runs unasked; a command, git and a
 *        delete ask (and a denied one does not run); a reader runs unasked
 *   AE-2 "Always" on the same loop still asks for the file edit (the mode, not the tool, decides)
 *   AE-3 the Agent SDK: the query runs in its acceptEdits permission mode; canUseTool lets the file edits
 *        (ours and the built-ins) through unasked and asks for Bash and the other writers
 */

/* eslint-disable @typescript-eslint/naming-convention -- tool_result / SDK input wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-edits-approval-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler } from '../anthropic-handler.js';
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { resetPlanModeForTests } from '../../tools/planning-tools.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

const ran: string[] = [];
const asked: string[] = [];
const tool = (name: string, readOnly: boolean): SharedToolDefinition => ({
    name, description: name, readOnly, inputSchema: { type: 'object', properties: {} },
    execute: async () => { ran.push(name); return `${name} done`; },
}) as unknown as SharedToolDefinition;

const FILE_EDITS = ['tomAi_editFile', 'tomAi_multiEditFile', 'tomAi_createFile', 'tomAi_applyEdit'];
const OTHER_WRITERS = ['tomAi_runCommand', 'tomAi_gitWrite', 'tomAi_deleteFile'];
const READERS = ['tomAi_readFile'];
const TOOLS = [...FILE_EDITS.map((n) => tool(n, false)), ...OTHER_WRITERS.map((n) => tool(n, false)), ...READERS.map((n) => tool(n, true))];

type ToolResult = { content: string; is_error?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
let approve = true;
handler.awaitApproval = async (req: { toolName: string }) => { asked.push(req.toolName); return approve; };

async function runTool(transport: string, name: string, mode: string): Promise<ToolResult> {
    return handler.runTool(
        { type: 'tool_use', id: `tu-${name}`, name, input: {} },
        TOOLS,
        { id: 'cfg', name: 'cfg', model: 'm', maxTokens: 100, maxRounds: 3, transport },
        { profile: { id: 'p', toolApprovalMode: mode } },
        1, 'test_quest', 'win', 'req-1', null,
    );
}

beforeEach(() => {
    resetPlanModeForTests();
    ran.length = 0;
    asked.length = 0;
    approve = true;
    handler.sessionApprovals?.clear?.();
});

describe('Tool Approval "Accept edits"', () => {
    for (const transport of ['direct', 'localLlm', 'vscodeLm']) {
        test(`AE-1: ${transport} — edits go through, the rest asks`, async () => {
            for (const name of [...FILE_EDITS, ...READERS]) {
                const r = await runTool(transport, name, 'acceptEdits');
                assert.notEqual(r.is_error, true, name);
            }
            assert.deepEqual(asked, [], 'no file edit and no reader asked');
            assert.deepEqual(ran, [...FILE_EDITS, ...READERS]);
            ran.length = 0;
            for (const name of OTHER_WRITERS) { await runTool(transport, name, 'acceptEdits'); }
            assert.deepEqual(asked, OTHER_WRITERS, 'a command, git and a delete ask');
            assert.deepEqual(ran, OTHER_WRITERS, 'approved: they run');
            approve = false;
            ran.length = 0;
            const denied = await runTool(transport, 'tomAi_runCommand', 'acceptEdits');
            assert.equal(denied.is_error, true);
            assert.match(denied.content, /denied by the user/);
            assert.deepEqual(ran, [], 'denied: it does not run');
        });
    }

    test('AE-2: "Always" still asks for a file edit', async () => {
        await runTool('direct', 'tomAi_editFile', 'always');
        assert.deepEqual(asked, ['tomAi_editFile']);
        await runTool('direct', 'tomAi_readFile', 'always');
        assert.deepEqual(asked, ['tomAi_editFile'], 'a reader never asks');
    });

    test('AE-3: the Agent SDK in acceptEdits', async () => {
        const fake = fakeSuccessSdk();
        __setAgentSdkForTests(fake.sdk);
        const sdkAsked: string[] = [];
        const params: AgentSdkSendParams = {
            configuration: { id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
            tools: TOOLS,
            systemPrompt: '',
            userText: 'edit',
            context: {
                requestApproval: async (req: { toolName: string }) => { sdkAsked.push(req.toolName); return true; },
                sessionApprovals: new Set(),
                toolTrail: new ToolTrail(),
                round: 1,
                questId: 'test_quest',
                windowId: 'win',
                requestId: 'req-1',
            } as unknown as AgentSdkSendParams['context'],
            toolApprovalMode: 'acceptEdits',
            useBuiltInTools: true,
        };
        try {
            await runAgentSdkQuery(params);
        } finally {
            __setAgentSdkForTests(undefined);
        }
        assert.equal(fake.options[0].permissionMode, 'acceptEdits');
        const canUseTool = fake.options[0].canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>;
        for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...FILE_EDITS.map((n) => `mcp__tom-ai__${n}`), 'Read', 'Grep', 'mcp__tom-ai__tomAi_readFile']) {
            assert.equal((await canUseTool(name, { file_path: '/a' })).behavior, 'allow', name);
        }
        assert.deepEqual(sdkAsked, [], 'no edit and no reader asked');
        for (const name of ['Bash', 'KillShell', ...OTHER_WRITERS.map((n) => `mcp__tom-ai__${n}`)]) {
            await canUseTool(name, { command: 'ls' });
        }
        assert.deepEqual(sdkAsked, ['Bash', 'KillShell', ...OTHER_WRITERS]);
    });
});
