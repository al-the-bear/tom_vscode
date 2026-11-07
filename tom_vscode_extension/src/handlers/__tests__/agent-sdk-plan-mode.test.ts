/**
 * Plan mode on the Agent SDK transport (CC-3, CC-27): the real
 * `runAgentSdkQuery` over a fake SDK.
 *
 *   SP-1 canUseTool: a writing built-in (Bash, Write, Edit) and a tomAi_* writer are refused with the plan-mode
 *        message, also under Tool Approval "Never"'s gates; readers and tomAi_askUser run
 *   SP-2 the MCP tool handlers refuse a writer while plan mode is on — they run without canUseTool under
 *        bypassPermissions — and run it again once plan mode is off
 *   SP-3 the SDK's own permission mode: `plan` when plan mode is on at the start (even on a "Never" profile);
 *        plan mode entered or left during the query is passed on with setPermissionMode
 *   SP-4 the SDK's ExitPlanMode is a proposal: the user's Accept leaves plan mode and allows it; Keep planning
 *        denies it with the reason, plan mode stays on
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-plan-mode-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import {
    enterPlanModeImpl, isPlanModeActive, leavePlanModeByUser, PLAN_MODE_REFUSAL, registerPlanDecider, resetPlanModeForTests,
} from '../../tools/planning-tools.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;

const ran: string[] = [];
const TOM_WRITER = { name: 'tomAi_editFile', description: 'w', readOnly: false, inputSchema: { type: 'object', properties: {} }, execute: async () => { ran.push('tomAi_editFile'); return 'edited'; } } as unknown as SharedToolDefinition;
const TOM_READER = { name: 'tomAi_readFile', description: 'r', readOnly: true, inputSchema: { type: 'object', properties: {} }, execute: async () => { ran.push('tomAi_readFile'); return 'read'; } } as unknown as SharedToolDefinition;

async function send(approval: 'always' | 'never', during?: (options: Record<string, unknown>) => Promise<void>) {
    const fake = fakeSuccessSdk(during ? { during } : {});
    __setAgentSdkForTests(fake.sdk);
    const params: AgentSdkSendParams = {
        configuration: { id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
        tools: [TOM_WRITER, TOM_READER],
        systemPrompt: '',
        userText: 'plan',
        context: {
            requestApproval: async () => true,
            sessionApprovals: new Set(),
            toolTrail: new ToolTrail(),
            round: 1,
            questId: 'test_quest',
            windowId: 'win',
            requestId: 'req-1',
        } as AgentSdkSendParams['context'],
        toolApprovalMode: approval,
        useBuiltInTools: true,
    };
    try {
        await runAgentSdkQuery(params);
    } finally {
        __setAgentSdkForTests(undefined);
    }
    return { ...fake, canUseTool: fake.options[0].canUseTool as CanUseTool };
}

const text = (r: unknown): string => JSON.stringify(r);

beforeEach(() => { resetPlanModeForTests(); ran.length = 0; });

describe('Agent SDK: plan mode', () => {
    test('SP-1: canUseTool refuses the writers', async () => {
        await enterPlanModeImpl({});
        const { canUseTool } = await send('always');
        for (const writer of ['Bash', 'Write', 'Edit', 'mcp__tom-ai__tomAi_editFile']) {
            const r = await canUseTool(writer, { command: 'x', file_path: '/a' });
            assert.equal(r.behavior, 'deny', writer);
            assert.equal(r.message, PLAN_MODE_REFUSAL, writer);
        }
        for (const reader of ['Read', 'Grep', 'mcp__tom-ai__tomAi_readFile', 'mcp__tom-ai__tomAi_askUser']) {
            assert.equal((await canUseTool(reader, {})).behavior, 'allow', reader);
        }
    });

    test('SP-2: the MCP handlers refuse a writer while plan mode is on', async () => {
        await enterPlanModeImpl({});
        const { handlers } = await send('never');
        const refused = await handlers.get('tomAi_editFile')!({});
        assert.match(text(refused), /plan mode: read and plan only/);
        assert.match(text(refused), /"isError":true/);
        assert.deepEqual(ran, [], 'the writer did not run');
        await handlers.get('tomAi_readFile')!({});
        assert.deepEqual(ran, ['tomAi_readFile'], 'a reader runs');
        leavePlanModeByUser();
        await handlers.get('tomAi_editFile')!({});
        assert.deepEqual(ran, ['tomAi_readFile', 'tomAi_editFile'], 'plan mode off: the writer runs again');
    });

    test('SP-3: the SDK runs in its plan mode, and follows changes', async () => {
        await enterPlanModeImpl({});
        const onNever = await send('never');
        assert.equal(onNever.options[0].permissionMode, 'plan', 'plan mode wins over a bypassing profile');
        leavePlanModeByUser();
        const following = await send('always', async () => {
            await enterPlanModeImpl({});
            leavePlanModeByUser();
        });
        assert.equal(following.options[0].permissionMode, 'default');
        assert.deepEqual(following.modeChanges, ['plan', 'default'], 'entered and left during the query');
        const after = await send('always');
        assert.deepEqual(after.modeChanges, [], 'a finished query no longer follows');
        await enterPlanModeImpl({});
        assert.deepEqual(following.modeChanges, ['plan', 'default']);
    });

    test('SP-4: the SDK\'s ExitPlanMode asks the user', async () => {
        await enterPlanModeImpl({});
        const { canUseTool } = await send('always');
        registerPlanDecider(async () => ({ accepted: false, feedback: 'more detail on step 2' }));
        const kept = await canUseTool('ExitPlanMode', { plan: 'the plan' });
        assert.equal(kept.behavior, 'deny');
        assert.match(String(kept.message), /keep planning.*more detail on step 2/s);
        assert.equal(isPlanModeActive(), true);
        registerPlanDecider(async () => ({ accepted: true }));
        assert.equal((await canUseTool('ExitPlanMode', { plan: 'the plan' })).behavior, 'allow');
        assert.equal(isPlanModeActive(), false, 'accepted: plan mode left');
    });
});
