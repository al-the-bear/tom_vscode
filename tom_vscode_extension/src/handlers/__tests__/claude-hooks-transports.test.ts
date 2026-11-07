/**
 * Claude Code hooks on every transport (ccparity_d_claudecode-6, CC-12 (a)),
 * through the real handler: a workspace whose `.claude/settings.json` names a
 * fixture hook (a Node script deciding by the event and its input), the
 * user's home a scratch folder.
 *
 *   HT-1 runTool (the direct, Local LLM and VS Code LM loops): PreToolUse deny refuses the call (no approval
 *        asked, the tool does not run), allow runs a writer without asking, ask asks for a reader, updatedInput
 *        modifies the input the tool gets; PostToolUse context reaches the model with the result
 *   HT-2 a send over a fake VS Code LM model: SessionStart (startup, then clear after clearing the session)
 *        and UserPromptSubmit context go after the prompt; a blocking UserPromptSubmit stops the send before
 *        any request; a blocking Stop hook makes the model go on with its reason, stop_hook_active then true
 *   HT-3 `continue: false` from a PostToolUse hook ends the send after the round
 *   HT-4 the Agent SDK: the hooks of setting sources it does not load go to its `hooks` option as callbacks,
 *        those it loads do not (each hook runs once)
 */

/* eslint-disable @typescript-eslint/naming-convention -- hook and SDK wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-transports-')));
const ws = path.join(base, 'ws');
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
const log = path.join(base, 'hook-inputs.log');
const script = path.join(base, 'hook.js');
fs.writeFileSync(script, `
const fs = require('fs');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
    const input = JSON.parse(raw);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
    const out = (o) => process.stdout.write(JSON.stringify(o));
    const file = input.tool_input && input.tool_input.filePath;
    switch (input.hook_event_name) {
        case 'PreToolUse':
            if (file === 'deny.txt') { process.stderr.write('no deny.txt'); process.exit(2); }
            if (file === 'modify.txt') { out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { filePath: 'safe.txt' } } }); break; }
            if (file === 'ask.txt') { out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }); break; }
            out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }); break;
        case 'PostToolUse':
            if (file === 'halt.txt') { out({ continue: false, stopReason: 'enough' }); break; }
            out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'checked by the post hook' } }); break;
        case 'UserPromptSubmit':
            if (/forbidden/.test(input.prompt)) { process.stderr.write('no forbidden words'); process.exit(2); }
            process.stdout.write('Context: release freeze.'); break;
        case 'SessionStart':
            out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Session started (' + input.source + ').' } }); break;
        case 'Stop':
            if (!input.stop_hook_active) { out({ decision: 'block', reason: 'Write DONE at the end.' }); }
            break;
    }
});
`);
const hookCommand = `node "${script}"`;
const writeSettings = (events: string[]): void => {
    const hooks: Record<string, unknown> = {};
    for (const e of events) { hooks[e] = [{ ...(e.endsWith('ToolUse') ? { matcher: 'tomAi_editFile|tomAi_readFile' } : {}), hooks: [{ type: 'command', command: hookCommand, timeout: 20 }] }]; }
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks }));
};
const inputs = (): Array<Record<string, unknown>> =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const { stub } = installVscodeStub({ workspaceFolders: [ws] });

// Safe to import after the stub is wired into the resolver.
import * as vscode from 'vscode';
import { AnthropicHandler } from '../anthropic-handler.js';
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import type { CommandHook } from '../../services/claudeHooks.js';
import { __setClaudeHomeForTests } from '../../services/claudeDirs.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
__setClaudeHomeForTests(home);

const ran: Array<{ name: string; input: Record<string, unknown> }> = [];
const asked: string[] = [];
const tool = (name: string, readOnly: boolean): SharedToolDefinition => ({
    name, description: name, readOnly, inputSchema: { type: 'object', properties: {} },
    execute: async (input: Record<string, unknown>) => { ran.push({ name, input }); return `${name} done`; },
}) as unknown as SharedToolDefinition;
const TOOLS = [tool('tomAi_editFile', false), tool('tomAi_readFile', true)];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
handler.awaitApproval = async (req: { toolName: string }) => { asked.push(req.toolName); return true; };

async function runTool(name: string, filePath: string) {
    return handler.runTool(
        { type: 'tool_use', id: `tu-${name}-${filePath}`, name, input: { filePath } },
        TOOLS,
        { id: 'cfg', name: 'cfg', model: 'm', maxTokens: 100, maxRounds: 3, transport: 'direct' },
        { profile: { id: 'p', toolApprovalMode: 'always' } },
        1, 'test_quest', 'win', 'req-1', null,
    ) as Promise<{ content: string; is_error?: boolean }>;
}

/** The fake VS Code LM model: each request records its text; the script says what each answer is. */
const requests: string[] = [];
let script2: Array<'text' | 'tool-halt'> = ['text'];
// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's own field
(stub.lm as { __models: unknown[] }).__models = [{
    id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
    sendRequest: async (messages: Array<{ content: unknown }>) => {
        requests.push(messages.map((m) => (Array.isArray(m.content) ? m.content : [m.content])
            .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : typeof p === 'string' ? p : '')).join('')).join('\n'));
        const step = script2[Math.min(requests.length - 1, script2.length - 1)];
        return {
            stream: (async function* () {
                if (step === 'tool-halt') {
                    yield new vscode.LanguageModelToolCallPart(`c${requests.length}`, 'tomAi_readFile', { filePath: 'halt.txt' });
                } else {
                    yield new vscode.LanguageModelTextPart(`answer ${requests.length}`);
                }
            })(),
        };
    },
}];

async function send(text: string) {
    return AnthropicHandler.instance.sendMessage({
        userText: text,
        profile: { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never' },
        configuration: {
            id: 'lm', name: 'lm', model: 'fake-lm', maxTokens: 100, maxRounds: 4, transport: 'vscodeLm',
            vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' },
        },
        tools: TOOLS,
        sessionKey: 'hooks-session',
    } as never);
}

beforeEach(() => { ran.length = 0; asked.length = 0; requests.length = 0; fs.rmSync(log, { force: true }); });

describe('Claude Code hooks on the transports', () => {
    test('HT-1: PreToolUse and PostToolUse in runTool', async () => {
        writeSettings(['PreToolUse', 'PostToolUse']);
        const denied = await runTool('tomAi_editFile', 'deny.txt');
        assert.equal(denied.is_error, true);
        assert.equal(denied.content, 'Blocked by a PreToolUse hook: no deny.txt');
        assert.deepEqual([ran, asked], [[], []], 'not run, not asked');
        const allowed = await runTool('tomAi_editFile', 'allow.txt');
        assert.deepEqual(asked, [], 'allow: no approval for a writer');
        assert.match(allowed.content, /tomAi_editFile done\n\nchecked by the post hook/);
        await runTool('tomAi_editFile', 'modify.txt');
        assert.deepEqual(ran.pop()!.input, { filePath: 'safe.txt' }, 'the hook modified the input');
        await runTool('tomAi_readFile', 'ask.txt');
        assert.deepEqual(asked, ['tomAi_readFile'], 'ask: even a reader asks');
        const pre = inputs().find((i) => i.hook_event_name === 'PreToolUse')!;
        assert.deepEqual([pre.tool_name, pre.tool_input, pre.cwd, pre.session_id], ['tomAi_editFile', { filePath: 'deny.txt' }, ws, 'test_quest:default']);
        const post = inputs().find((i) => i.hook_event_name === 'PostToolUse')!;
        assert.equal(post.tool_response, 'tomAi_editFile done');
    });

    test('HT-2: SessionStart, UserPromptSubmit and Stop on a send', async () => {
        writeSettings(['SessionStart', 'UserPromptSubmit', 'Stop']);
        script2 = ['text'];
        const result = await send('hello');
        assert.equal(requests.length, 2, 'the Stop hook made the model go on once');
        assert.match(requests[0], /hello\n\nSession started \(startup\)\.\n\nContext: release freeze\./);
        assert.match(requests[1], /Write DONE at the end\./);
        assert.equal(result.text, 'answer 2');
        const stops = inputs().filter((i) => i.hook_event_name === 'Stop').map((i) => i.stop_hook_active);
        assert.deepEqual(stops, [false, true]);
        assert.equal(inputs().find((i) => i.hook_event_name === 'UserPromptSubmit')!.prompt, 'hello');

        requests.length = 0;
        await send('again');
        assert.doesNotMatch(requests[0], /Session started/, 'once per session');
        AnthropicHandler.instance.clearSession('hooks-session');
        requests.length = 0;
        await send('after clear');
        assert.match(requests[0], /Session started \(clear\)\./);

        requests.length = 0;
        const blocked = await send('a forbidden prompt');
        assert.equal(requests.length, 0, 'not sent');
        assert.equal(blocked.stopReason, 'hook_blocked');
        assert.equal(blocked.text, 'Prompt blocked by a UserPromptSubmit hook: no forbidden words');
    });

    test('HT-3: continue: false ends the send', async () => {
        writeSettings(['PostToolUse']);
        script2 = ['tool-halt', 'text'];
        const result = await send('read it');
        assert.equal(result.stopReason, 'hook_stop');
        assert.equal(requests.length, 1, 'no further round');
    });

    test('HT-4: the Agent SDK gets the hooks it does not load', async () => {
        const hooks: CommandHook[] = [
            { event: 'PreToolUse', matcher: 'Bash', command: hookCommand, timeoutSec: 5, source: 'project', file: 'p' },
            { event: 'Stop', command: hookCommand, timeoutSec: 5, source: 'user', file: 'u' },
        ];
        const optionsWith = async (settingSources: Array<'user' | 'project' | 'local'>) => {
            const fake = fakeSuccessSdk();
            __setAgentSdkForTests(fake.sdk);
            try {
                await runAgentSdkQuery({
                    configuration: { id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
                    tools: [], systemPrompt: '', userText: 'hi',
                    context: {
                        requestApproval: async () => true, sessionApprovals: new Set(), toolTrail: new ToolTrail(),
                        round: 1, questId: 'test_quest', windowId: 'win', requestId: 'req-1',
                    } as unknown as AgentSdkSendParams['context'],
                    toolApprovalMode: 'never', settingSources, claudeHooks: hooks,
                });
            } finally {
                __setAgentSdkForTests(undefined);
            }
            return fake.options[0].hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>> | undefined;
        };
        assert.deepEqual(Object.keys((await optionsWith(['project']))!), ['Stop'], 'the project hook runs in the SDK');
        assert.deepEqual(Object.keys((await optionsWith([]))!), ['PreToolUse', 'Stop']);
        assert.equal((await optionsWith([]))!.PreToolUse[0].matcher, 'Bash');
        assert.equal(await optionsWith(['user', 'project']), undefined, 'all loaded by the SDK: none passed');
    });
});
