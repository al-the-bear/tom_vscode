/**
 * The skills section reaches the model (ccparity_d_claudecode-1, CC-10 (a)):
 * `AnthropicHandler.sendMessage` on the VS Code LM transport, over a fake
 * `vscode.lm` model, in a workspace holding a fixture skill.
 *
 *   SS-1 a send carrying tomAi_loadSkill: the system text names the skill and its description and how to load it
 *   SS-2 a send without the tool: no skills section (nothing could load one)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-system-prompt-'));
fs.mkdirSync(path.join(tmpRoot, '.claude', 'skills', 'fixture-skill'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, '.claude', 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Does the fixture task the careful way.\n---\nBody.\n');
const { stub } = installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import * as vscode from 'vscode';
import { AnthropicHandler } from '../anthropic-handler.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { WsPaths } from '../../utils/workspacePaths.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

/** The text of every request the fake model received. */
const seen: string[] = [];
// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's own field
(stub.lm as { __models: unknown[] }).__models = [{
    id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
    sendRequest: async (messages: Array<{ content: unknown }>) => {
        seen.push(messages.map((m) => (Array.isArray(m.content) ? m.content : [m.content])
            .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : String(p))).join('')).join('\n'));
        return { stream: (async function* () { yield new vscode.LanguageModelTextPart('done'); })() };
    },
}];

const tool = (name: string): SharedToolDefinition => ({
    name, description: name, readOnly: true, inputSchema: { type: 'object', properties: {} }, execute: async () => 'x',
}) as unknown as SharedToolDefinition;

async function send(tools: SharedToolDefinition[]): Promise<string> {
    seen.length = 0;
    await AnthropicHandler.instance.sendMessage({
        userText: 'hello',
        profile: { id: 'p', name: 'p', systemPrompt: 'Base prompt.', toolApprovalMode: 'never' },
        configuration: {
            id: 'lm', name: 'lm', model: 'fake-lm', maxTokens: 100, maxRounds: 2, transport: 'vscodeLm',
            vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' },
        },
        tools,
        isolated: true,
    } as never);
    return seen[0] ?? '';
}

describe('skills in the system prompt', () => {
    test('SS-1: listed when the send carries tomAi_loadSkill', async () => {
        assert.equal(path.resolve(WsPaths.wsRoot ?? ''), path.resolve(tmpRoot));
        const text = await send([tool('tomAi_readFile'), tool('tomAi_loadSkill')]);
        assert.match(text, /Base prompt\./);
        assert.match(text, /## Skills/);
        assert.match(text, /- fixture-skill: Does the fixture task the careful way\./);
        assert.match(text, /call `tomAi_loadSkill` with its name/);
    });

    test('SS-2: not without the tool', async () => {
        const text = await send([tool('tomAi_readFile')]);
        assert.match(text, /Base prompt\./);
        assert.doesNotMatch(text, /## Skills/);
    });
});
