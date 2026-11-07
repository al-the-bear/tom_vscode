/**
 * Claude Code's built-ins under the profile's Tool Approval (CC-2): the real
 * `runAgentSdkQuery` over a fake SDK; the test calls the `canUseTool` the
 * transport hands the SDK, as the SDK does before a tool runs.
 *
 *   BA-1 Tool Approval "Always": a writing built-in (Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell)
 *        asks, with a summary naming what it does (the command, the file); a reader (Read, Grep, Glob,
 *        WebFetch, WebSearch) runs without asking — as a tomAi_* writer and reader do
 *   BA-2 a denied writer is denied with a message naming it; a writer approved for the session runs unasked
 *   BA-3 "Never": nothing asks; the send runs in bypassPermissions
 *   BA-4 with the built-ins on and "Always", a configured acceptEdits runs as `default` (it would accept
 *        edits without calling canUseTool); without the built-ins it is kept
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-builtin-approval-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

type CanUseTool = (name: string, input: Record<string, unknown>, opts?: unknown) => Promise<{ behavior: string; message?: string; updatedInput?: unknown }>;

const TOM_WRITER = { name: 'tomAi_editFile', readOnly: false } as unknown as SharedToolDefinition;
const TOM_READER = { name: 'tomAi_readFile', readOnly: true } as unknown as SharedToolDefinition;

/** One send; answers the SDK options, the canUseTool it got, and the approval requests made. */
async function send(opts: { approval: 'always' | 'never'; builtIns?: boolean; mode?: string; approve?: boolean; sessionApproved?: string[] }) {
    const { sdk, options } = fakeSuccessSdk();
    __setAgentSdkForTests(sdk);
    const asked: Array<{ toolName: string; inputSummary: string }> = [];
    const params: AgentSdkSendParams = {
        configuration: {
            id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5,
            ...(opts.mode ? { agentSdk: { permissionMode: opts.mode } } : {}),
        } as AgentSdkSendParams['configuration'],
        tools: [TOM_WRITER, TOM_READER],
        systemPrompt: '',
        userText: 'work',
        context: {
            requestApproval: async (r: { toolName: string; inputSummary: string }) => { asked.push(r); return opts.approve ?? true; },
            sessionApprovals: new Set(opts.sessionApproved ?? []),
            toolTrail: new ToolTrail(),
            round: 1,
            questId: 'test_quest',
            windowId: 'win',
            requestId: 'req-1',
        } as AgentSdkSendParams['context'],
        toolApprovalMode: opts.approval,
        useBuiltInTools: opts.builtIns ?? true,
    };
    try {
        await runAgentSdkQuery(params);
    } finally {
        __setAgentSdkForTests(undefined);
    }
    const o = options[0];
    return { options: o, canUseTool: o.canUseTool as CanUseTool, asked };
}

const WRITERS: Array<[string, Record<string, unknown>, RegExp]> = [
    ['Bash', { command: 'rm -rf build' }, /rm -rf build/],
    ['Write', { file_path: '/ws/a.ts', content: 'x' }, /\/ws\/a\.ts/],
    ['Edit', { file_path: '/ws/b.ts', old_string: 'a', new_string: 'b' }, /\/ws\/b\.ts/],
    ['MultiEdit', { file_path: '/ws/c.ts', edits: [] }, /\/ws\/c\.ts/],
    ['NotebookEdit', { notebook_path: '/ws/n.ipynb', new_source: '' }, /\/ws\/n\.ipynb/],
    ['KillShell', { shell_id: 'bash_3' }, /bash_3/],
];
const READERS: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: '/ws/a.ts' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'p' }],
    ['WebSearch', { query: 'q' }],
];

describe('Agent SDK: built-ins under Tool Approval', () => {
    test('BA-1: Always — writers ask, readers do not, like the tomAi_* tools', async () => {
        const { canUseTool, asked } = await send({ approval: 'always' });
        for (const [name, input, summary] of WRITERS) {
            const before = asked.length;
            const r = await canUseTool(name, input);
            assert.equal(r.behavior, 'allow', name);
            assert.equal(asked.length, before + 1, `${name} asks`);
            assert.equal(asked[asked.length - 1].toolName, name);
            assert.match(asked[asked.length - 1].inputSummary, summary, `${name}: the summary says what it does`);
        }
        const afterWriters = asked.length;
        for (const [name, input] of READERS) {
            assert.equal((await canUseTool(name, input)).behavior, 'allow', name);
        }
        assert.equal(asked.length, afterWriters, 'no reader asks');
        await canUseTool('mcp__tom-ai__tomAi_editFile', { filePath: 'a' });
        assert.equal(asked.length, afterWriters + 1, 'a tomAi_* writer asks too');
        await canUseTool('mcp__tom-ai__tomAi_readFile', { filePath: 'a' });
        assert.equal(asked.length, afterWriters + 1, 'a tomAi_* reader does not');
    });

    test('BA-2: denied, and approved for the session', async () => {
        const denied = await send({ approval: 'always', approve: false });
        const r = await denied.canUseTool('Bash', { command: 'ls' });
        assert.equal(r.behavior, 'deny');
        assert.match(String(r.message), /Bash.*denied/);
        const session = await send({ approval: 'always', sessionApproved: ['Bash'] });
        assert.equal((await session.canUseTool('Bash', { command: 'ls' })).behavior, 'allow');
        assert.equal(session.asked.length, 0, 'approved for the session: not asked again');
        await session.canUseTool('Write', { file_path: '/ws/a' });
        assert.equal(session.asked.length, 1, 'other writers still ask');
    });

    test('BA-3: Never asks nothing', async () => {
        const { canUseTool, asked, options } = await send({ approval: 'never' });
        for (const [name, input] of WRITERS) { assert.equal((await canUseTool(name, input)).behavior, 'allow'); }
        assert.equal(asked.length, 0);
        assert.equal(options.permissionMode, 'bypassPermissions');
    });

    test('BA-4: acceptEdits does not slip edits past the approval', async () => {
        assert.equal((await send({ approval: 'always', mode: 'acceptEdits' })).options.permissionMode, 'default');
        assert.equal((await send({ approval: 'always', mode: 'acceptEdits', builtIns: false })).options.permissionMode, 'acceptEdits');
        assert.equal((await send({ approval: 'always', mode: 'plan' })).options.permissionMode, 'plan');
    });
});
