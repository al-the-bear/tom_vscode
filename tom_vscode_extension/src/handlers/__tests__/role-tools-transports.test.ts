/**
 * A send's tools by its role's type (vscimpb87, services/roleTools.ts), through the real AnthropicHandler on every
 * transport, each against a fake model that records the tools it was offered.
 *
 *   RTT-1 direct: a role whose type selects tools gets exactly those and the always-on ones, whatever the profile
 *         passed; the profile's list is kept for a role without role-config.yaml, a type in profileDefault and a
 *         run without a role
 *   RTT-2 VS Code LM: the same
 *   RTT-3 Local LLM: the same
 *   RTT-4 Agent SDK: the MCP tools the SDK is given are the role type's
 *   RTT-5 an isolated send (a sub-agent) keeps the list it was given; the scoping comes before the external MCP
 *         tools and the tool plan (source order)
 */

/* eslint-disable @typescript-eslint/naming-convention -- Ollama wire fields */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-tools-transports-')));
const ws = path.join(base, 'ws');
const ai = path.join(ws, '_ai');
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
function put(rel: string, text: string): void {
    const abs = path.join(ai, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put('roles/writer/role.md', '# Writer\n');
put('roles/writer/role-config.yaml', 'roleType: narrow\n');
put('roles/free/role.md', '# Free\n');
put('roles/profiled/role.md', '# Profiled\n');
put('roles/profiled/role-config.yaml', 'roleType: wide\n');
put('role-types/narrow/role-type.yaml', 'tools:\n  mode: selected\n  enabled: [tomAi_readFile, tomAi_listDirectory]\n');
put('role-types/wide/role-type.yaml', 'tools:\n  mode: profileDefault\n');

const { stub } = installVscodeStub({ workspaceFolders: [ws] });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler } from '../anthropic-handler.js';
import { LocalLlmManager, setLocalLlmManager } from '../localLlm-handler.js';
import { __setAgentSdkForTests } from '../agent-sdk-transport.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { __setClaudeHomeForTests } from '../../services/claudeDirs.js';
import { __setRoleToolsDepsForTests } from '../../services/roleTools.js';
import { ALL_SHARED_TOOLS } from '../../tools/tool-executors.js';
import { ALWAYS_ON_TOOLS } from '../../utils/roleTypes.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
__setClaudeHomeForTests(home);
setLocalLlmManager(new LocalLlmManager({ subscriptions: [] } as never));

let role = 'writer';
__setRoleToolsDepsForTests({ role: () => role, aiRoot: () => ai });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
handler.awaitApproval = async () => true;

/** What the profile (the caller) passes: two tools the role type does not name. */
const PASSED = ALL_SHARED_TOOLS.filter((t) => ['tomAi_gitWrite', 'tomAi_runCommand'].includes(t.name));
const NARROW = [...new Set([...ALWAYS_ON_TOOLS, 'tomAi_readFile', 'tomAi_listDirectory'])].filter((n) => ALL_SHARED_TOOLS.some((t) => t.name === n)).sort();
const sorted = (names: string[]): string[] => [...names].sort();

// ── direct: a fake client that records each request's tools ───────────────────
let directTools: string[] = [];
handler.getClient = () => ({
    messages: {
        stream: (params: { tools?: Array<{ name: string }> }) => ({
            finalMessage: async () => {
                directTools = (params.tools ?? []).map((t) => t.name);
                return { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        }),
    },
});

// ── VS Code LM: a fake model that records the tools of each request ────────────
let lmTools: string[] = [];
// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's own field
(stub.lm as { __models: unknown[] }).__models = [{
    id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
    sendRequest: async (_messages: unknown, options: { tools?: Array<{ name: string }> }) => {
        lmTools = (options?.tools ?? []).map((t) => t.name);
        return { stream: (async function* () { yield new vscode.LanguageModelTextPart('ok'); })() };
    },
}];

// ── Local LLM: a fake Ollama that records each request's tools ─────────────────
let ollamaTools: string[] = [];
let server: http.Server;
let baseUrl = '';
before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            const body = JSON.parse(raw) as { tools?: Array<{ function: { name: string } }> };
            ollamaTools = (body.tools ?? []).map((t) => t.function.name);
            res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
    server.close();
    __setRoleToolsDepsForTests(undefined);
    fs.rmSync(base, { recursive: true, force: true });
});

const PROFILE = { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never', toolSearch: false };
const CONFIGS: Record<string, Record<string, unknown>> = {
    direct: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 2, transport: 'direct' },
    vscodeLm: { id: 'lm', name: 'lm', model: 'fake-lm', maxTokens: 100, maxRounds: 2, transport: 'vscodeLm', vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' } },
    localLlm: { id: 'local', name: 'local', model: 'qwen', maxTokens: 100, maxRounds: 2, transport: 'localLlm', localLlm: { baseUrl: '', model: 'qwen', temperature: 0 } },
};

async function send(transport: 'direct' | 'vscodeLm' | 'localLlm', isolated = false): Promise<string[]> {
    const configuration = { ...CONFIGS[transport] };
    if (transport === 'localLlm') { configuration.localLlm = { baseUrl, model: 'qwen', temperature: 0 }; }
    directTools = []; lmTools = []; ollamaTools = [];
    await AnthropicHandler.instance.sendMessage({ userText: 'hello', profile: PROFILE, configuration, tools: PASSED, isolated } as never);
    return sorted(transport === 'direct' ? directTools : transport === 'vscodeLm' ? lmTools : ollamaTools);
}

/** For each transport: the role type's tools, else the passed list. */
async function checkTransport(transport: 'direct' | 'vscodeLm' | 'localLlm'): Promise<void> {
    role = 'writer';
    assert.deepEqual(await send(transport), NARROW, `${transport}: the role type's tools and the always-on ones`);
    for (const other of ['free', 'profiled', '', 'default']) {
        role = other;
        assert.deepEqual(await send(transport), sorted(PASSED.map((t) => t.name)), `${transport}: role "${other}" keeps the profile's tools`);
    }
    role = 'writer';
}

describe('a send\'s tools by its role type, per transport', () => {
    test('RTT-1: direct', async () => { await checkTransport('direct'); });
    test('RTT-2: VS Code LM', async () => { await checkTransport('vscodeLm'); });
    test('RTT-3: Local LLM', async () => { await checkTransport('localLlm'); });

    test('RTT-4: Agent SDK', async () => {
        for (const [r, expected] of [['writer', NARROW], ['free', sorted(PASSED.map((t) => t.name))]] as const) {
            role = r;
            const fake = fakeSuccessSdk();
            __setAgentSdkForTests(fake.sdk);
            try {
                await AnthropicHandler.instance.sendMessage({
                    userText: 'hello', profile: PROFILE,
                    configuration: { id: 'sdk', name: 'sdk', model: 'claude-test', maxTokens: 100, maxRounds: 2, transport: 'agentSdk' },
                    tools: PASSED, sessionKey: `role-tools-${r}`,
                } as never);
            } finally {
                __setAgentSdkForTests(undefined);
            }
            assert.deepEqual(sorted([...fake.handlers.keys()]), expected, `agentSdk, role ${r}`);
        }
        role = 'writer';
    });

    test('RTT-5: an isolated send keeps its list; the order in the send', async () => {
        role = 'writer';
        assert.deepEqual(await send('direct', true), sorted(PASSED.map((t) => t.name)), 'a sub-agent keeps its own tools');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const send2 = src.slice(src.indexOf('    private async sendMessageOwned(options: AnthropicSendOptions)'));
        assert.ok(send2.indexOf('options = withRoleTools(options);') < send2.indexOf('options = await this.withExternalMcpTools(options);'));
        assert.ok(send2.indexOf('options = await this.withExternalMcpTools(options);') < send2.indexOf('options = withToolPlan(options);'));
    });
});
