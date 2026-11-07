/**
 * Agent SDK: append to or replace Claude Code's system prompt, and the
 * profile's setting sources (ccparity_d_claudecode-5, CC-15 (a)).
 *
 *   PS-1 the mapping (utils/agentSdkSystemPrompt.ts): a stored mode other than `append` reads as `replace`;
 *        replace sends the text (none for an empty one), append Claude Code's preset with the text appended
 *        (no `append` for an empty one); setting sources keep the valid ones in canonical order, the profile's
 *        winning over the configuration's
 *   PS-2 the transport over a fake SDK: a profile without a mode replaces (existing profiles unchanged), with
 *        `append` it sends `{type: 'preset', preset: 'claude_code', append}`; the profile's setting sources reach
 *        the SDK, else the configuration's; the CLAUDE.md auto-load still adds `project`
 *   PS-3 the setting in the schema, sendToChatConfig.ts and the profile editor (field, options, save that keeps
 *        the defaults out of the file), and the handler passing it on
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-system-prompt-'));
fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), '# Project rules\n');
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import {
    effectiveSettingSources, parseSettingSources, parseSystemPromptMode, sdkSystemPromptOption,
} from '../../utils/agentSdkSystemPrompt.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

async function options(extra: Partial<AgentSdkSendParams>, configSources?: string[]): Promise<Record<string, unknown>> {
    const fake = fakeSuccessSdk();
    __setAgentSdkForTests(fake.sdk);
    try {
        await runAgentSdkQuery({
            configuration: {
                id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5,
                ...(configSources ? { agentSdk: { settingSources: configSources } } : {}),
            } as AgentSdkSendParams['configuration'],
            tools: [],
            systemPrompt: 'You are the profile prompt.',
            userText: 'hi',
            context: {
                requestApproval: async () => true, sessionApprovals: new Set(), toolTrail: new ToolTrail(),
                round: 1, questId: 'test_quest', windowId: 'win', requestId: 'req-1',
            } as unknown as AgentSdkSendParams['context'],
            toolApprovalMode: 'never',
            ...extra,
        });
    } finally {
        __setAgentSdkForTests(undefined);
    }
    return fake.options[0];
}

describe('Agent SDK: system prompt mode and setting sources', () => {
    test('PS-1: the mapping', () => {
        assert.deepEqual([undefined, 'replace', 'append', 'APPEND', 3].map(parseSystemPromptMode), ['replace', 'replace', 'append', 'replace', 'replace']);
        assert.equal(sdkSystemPromptOption('replace', 'P'), 'P');
        assert.equal(sdkSystemPromptOption('replace', ''), undefined);
        assert.deepEqual(sdkSystemPromptOption('append', 'P'), { type: 'preset', preset: 'claude_code', append: 'P' });
        assert.deepEqual(sdkSystemPromptOption('append', ''), { type: 'preset', preset: 'claude_code' });
        assert.deepEqual(parseSettingSources(['local', 'bogus', 'user', 'local']), ['user', 'local']);
        assert.equal(parseSettingSources('project'), undefined);
        assert.deepEqual(effectiveSettingSources(['user'], ['project']), ['user'], 'the profile wins');
        assert.deepEqual(effectiveSettingSources(undefined, ['project']), ['project'], 'else the configuration');
        assert.deepEqual(effectiveSettingSources(undefined, undefined), []);
    });

    test('PS-2: the SDK options', async () => {
        const unchanged = await options({});
        assert.equal(unchanged.systemPrompt, 'You are the profile prompt.', 'no mode: replace, as before');
        const appended = await options({ systemPromptMode: 'append' });
        assert.deepEqual(appended.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'You are the profile prompt.' });
        assert.deepEqual((await options({ settingSources: ['user', 'local'] }, ['project'])).settingSources, ['user', 'local']);
        assert.deepEqual((await options({}, ['project'])).settingSources, ['project']);
        const autoLoaded = await options({ settingSources: ['user'], autoLoadProjectSettings: true });
        assert.deepEqual(autoLoaded.settingSources, ['user', 'project'], 'CLAUDE.md still brings project');
    });

    test('PS-3: schema, config type, profile editor, handler', () => {
        const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', rel), 'utf8');
        const schema = src('config/tom_vscode_extension.schema.json');
        const parsed = JSON.parse(schema) as Record<string, unknown>;
        const found: Array<Record<string, unknown>> = [];
        const walk = (n: unknown): void => {
            if (!n || typeof n !== 'object') { return; }
            const o = n as Record<string, unknown>;
            if (o.systemPromptMode && o.settingSources && o.toolApprovalMode) { found.push(o); }
            Object.values(o).forEach(walk);
        };
        walk(parsed);
        assert.equal(found.length, 1, 'the profile schema has both');
        assert.deepEqual((found[0].systemPromptMode as { enum: string[] }).enum, ['replace', 'append']);
        assert.deepEqual(((found[0].settingSources as { items: { enum: string[] } }).items).enum, ['user', 'project', 'local']);
        const config = src('utils/sendToChatConfig.ts');
        assert.match(config, /systemPromptMode\?: 'replace' \| 'append';/);
        assert.match(config, /settingSources\?: Array<'user' \| 'project' \| 'local'>;/);
        const editor = src('handlers/globalTemplateEditor-handler.ts');
        assert.match(editor, /name: 'systemPromptMode', label: 'System Prompt \(Agent SDK\)', type: 'select'/);
        assert.match(editor, /value: 'append', label: "Append — Claude Code's default prompt, then the system prompt above"/);
        assert.match(editor, /name: 'settingSources', label: 'Setting Sources \(Agent SDK\)', type: 'multi-checkbox'/);
        assert.match(editor, /\.\.\.\(systemPromptMode === 'append' \? \{ systemPromptMode \} : \{\}\),/, 'replace stays out of the file');
        assert.match(editor, /if \(systemPromptMode === 'replace' && 'systemPromptMode' in existing\)/, 'set back to replace: removed');
        const handler = src('handlers/anthropic-handler.ts');
        assert.match(handler, /systemPromptMode: parseSystemPromptMode\(profile\.systemPromptMode\),/);
        assert.match(handler, /settingSources: parseSettingSources\(profile\.settingSources\)/);
    });
});
