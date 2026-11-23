/**
 * Aspect guidelines reach the sent prompt (gsel2): through the real AnthropicHandler on every transport, each against
 * a fake model that records what it was sent, and on Copilot through the send it opens. The workspace's
 * `_ai/aspect_guidelines/` has a system section (`answer_mode`, default `brief`) and a user section (`night`, default
 * `quiet`).
 *
 *   AGT-1 direct: the system section's text is in the system prompt, the user section's before the user text; the
 *         raw prompt trail shows both as sent
 *   AGT-2 VS Code LM: the same
 *   AGT-3 Local LLM: the same
 *   AGT-4 Agent SDK: the system section in the SDK's system prompt, the user section in its prompt; the trail
 *   AGT-5 the levels a send carries: an item's option replaces the default, a todo's `remove` sends nothing for its
 *         section
 *   AGT-6 an isolated send (a sub-agent) gets no aspect text
 *   AGT-7 Copilot: both sections before the prompt text, in what the Send to Copilot command opens
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

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aspect-transports-')));
const ws = path.join(base, 'ws');
function put(rel: string, text: string): void {
    const abs = path.join(ws, '_ai', 'aspect_guidelines', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put('answer_mode/aspect.yaml', 'name: Answer mode\nlabel: Answer\ndefault: brief\nchoices: [brief, detailed]\n');
put('answer_mode/brief.md', 'ASPECT-SYSTEM-BRIEF: answer briefly.\n');
put('answer_mode/detailed.md', 'ASPECT-SYSTEM-DETAILED: answer in detail.\n');
put('night/aspect.yaml', 'name: Night\nplacement: user\ndefault: quiet\n');
put('night/quiet.md', 'ASPECT-USER-QUIET: nobody is there to answer questions.\n');

const { stub, spies } = installVscodeStub({ workspaceFolders: [ws] });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

// Safe to import after the stub is wired into the resolver.
import { AnthropicHandler } from '../anthropic-handler.js';
import { LocalLlmManager, setLocalLlmManager } from '../localLlm-handler.js';
import { __setAgentSdkForTests } from '../agent-sdk-transport.js';
import { fakeSuccessSdk } from './_agentSdkFake.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { withAspectsForCopilot } from '../../services/aspectGuidelinesStore.js';
import { openCopilotChat } from '../sendToChatRouter.js';
import type { AspectLevelChoices } from '../../utils/aspectGuidelines.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
setLocalLlmManager(new LocalLlmManager({ subscriptions: [] } as never));

/** The raw prompt trail: what each send wrote. */
const trail: string[] = [];
const trailService = TrailService.instance as unknown as { writeRawPrompt: (...a: unknown[]) => void };
trailService.writeRawPrompt = (_subsystem: unknown, text: unknown) => { trail.push(String(text)); };

/** What the fake model of each transport received: the system text and the user text. */
let sentSystem = '';
let sentUser = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;
handler.awaitApproval = async () => true;
handler.getClient = () => ({
    messages: {
        stream: (params: { system?: unknown; messages: unknown[] }) => ({
            finalMessage: async () => {
                sentSystem = JSON.stringify(params.system ?? '');
                sentUser = JSON.stringify(params.messages);
                return { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        }),
    },
});

// eslint-disable-next-line @typescript-eslint/naming-convention -- the stub's own field
(stub.lm as { __models: unknown[] }).__models = [{
    id: 'fake-lm', vendor: 'test', family: 'fake', name: 'Fake',
    sendRequest: async (messages: Array<{ content: unknown }>) => {
        // VS Code LM has no system/user split: the system text and the user text arrive as one message.
        const all = messages.map((m) => (Array.isArray(m.content) ? m.content : [m.content])
            .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : String(p))).join('')).join('\n');
        sentSystem = all; sentUser = all;
        return { stream: (async function* () { yield new vscode.LanguageModelTextPart('ok'); })() };
    },
}];

let server: http.Server;
let baseUrl = '';
before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
            sentSystem = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
            sentUser = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
            res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
});

const PROFILE = { id: 'p', name: 'p', systemPrompt: 'BASE-SYSTEM.', toolApprovalMode: 'never', toolSearch: false };
const CONFIGS: Record<string, Record<string, unknown>> = {
    direct: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 2, transport: 'direct' },
    vscodeLm: { id: 'lm', name: 'lm', model: 'fake-lm', maxTokens: 100, maxRounds: 2, transport: 'vscodeLm', vscodeLm: { vendor: 'test', family: 'fake', modelId: 'fake-lm' } },
    localLlm: { id: 'local', name: 'local', model: 'qwen', maxTokens: 100, maxRounds: 2, transport: 'localLlm', localLlm: { baseUrl: '', model: 'qwen', temperature: 0 } },
};

async function send(transport: 'direct' | 'vscodeLm' | 'localLlm', extra: { choices?: AspectLevelChoices; isolated?: boolean } = {}): Promise<void> {
    const configuration = { ...CONFIGS[transport] };
    if (transport === 'localLlm') { configuration.localLlm = { baseUrl, model: 'qwen', temperature: 0 }; }
    sentSystem = ''; sentUser = ''; trail.length = 0;
    await AnthropicHandler.instance.sendMessage({
        userText: 'USER-TEXT', profile: PROFILE, configuration, tools: [],
        isolated: extra.isolated ?? false,
        ...(extra.choices ? { aspectGuidelineChoices: extra.choices } : {}),
    } as never);
}

/** The defaults reached the model and the trail: system section in the system text, user section before the user text. */
function checkDefaults(transport: string): void {
    assert.match(sentSystem, /BASE-SYSTEM\./, `${transport}: the profile's system prompt`);
    assert.match(sentSystem, /## Aspect guidelines/, `${transport}: the heading`);
    assert.match(sentSystem, /ASPECT-SYSTEM-BRIEF/, `${transport}: the system section's default in the system text`);
    assert.match(sentUser, /ASPECT-USER-QUIET[\s\S]*USER-TEXT/, `${transport}: the user section before the user text`);
    const raw = trail.at(-1) ?? '';
    const [system, user] = raw.split('\n\nUSER:\n');
    assert.match(system, /ASPECT-SYSTEM-BRIEF/, `${transport}: the trail's SYSTEM`);
    assert.doesNotMatch(system, /ASPECT-USER-QUIET/, `${transport}: the user section is not in the trail's SYSTEM`);
    assert.match(user, /ASPECT-USER-QUIET[\s\S]*---[\s\S]*USER-TEXT/, `${transport}: the trail's USER`);
}

describe('aspect guidelines in the sent prompt', () => {
    test('AGT-1: direct', async () => { await send('direct'); checkDefaults('direct'); });
    test('AGT-2: VS Code LM', async () => { await send('vscodeLm'); checkDefaults('vscodeLm'); });
    test('AGT-3: Local LLM', async () => { await send('localLlm'); checkDefaults('localLlm'); });

    test('AGT-4: Agent SDK', async () => {
        const fake = fakeSuccessSdk();
        __setAgentSdkForTests(fake.sdk);
        trail.length = 0;
        try {
            await AnthropicHandler.instance.sendMessage({
                userText: 'USER-TEXT', profile: PROFILE,
                configuration: { id: 'sdk', name: 'sdk', model: 'claude-test', maxTokens: 100, maxRounds: 2, transport: 'agentSdk' },
                tools: [], sessionKey: 'aspect-transports',
            } as never);
        } finally {
            __setAgentSdkForTests(undefined);
        }
        const system = JSON.stringify(fake.options[0]?.systemPrompt ?? '');
        assert.match(system, /BASE-SYSTEM\./);
        assert.match(system, /ASPECT-SYSTEM-BRIEF/, 'the system section in the SDK\'s system prompt');
        assert.doesNotMatch(system, /ASPECT-USER-QUIET/);
        // The prompt is the transport's message stream: its first message is the user content.
        const stream = fake.prompts[0] as AsyncIterable<unknown>;
        const first = await Promise.race([
            stream[Symbol.asyncIterator]().next(),
            new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 2000)),
        ]);
        assert.match(JSON.stringify(first.value ?? ''), /ASPECT-USER-QUIET[\s\S]*USER-TEXT/, 'the user section in the prompt');
        const raw = trail.at(-1) ?? '';
        assert.match(raw, /SYSTEM:\n[\s\S]*ASPECT-SYSTEM-BRIEF[\s\S]*\n\nUSER:\n[\s\S]*ASPECT-USER-QUIET[\s\S]*USER-TEXT/, 'the trail');
    });

    test('AGT-5: the levels a send carries', async () => {
        await send('direct', { choices: { item: { answer_mode: 'detailed' }, todo: { night: 'remove' } } });
        assert.match(sentSystem, /ASPECT-SYSTEM-DETAILED/, 'the item\'s option');
        assert.doesNotMatch(sentSystem, /ASPECT-SYSTEM-BRIEF/, 'not the default');
        assert.doesNotMatch(sentUser, /ASPECT-USER-QUIET/, 'the todo removed the user section');
        assert.match(sentUser, /USER-TEXT/);
        await send('direct', { choices: { window: { answer_mode: 'remove', night: 'remove' } } });
        assert.doesNotMatch(sentSystem, /## Aspect guidelines/, 'everything removed: no heading');
    });

    test('AGT-6: an isolated send gets none', async () => {
        await send('direct', { isolated: true });
        assert.match(sentSystem, /BASE-SYSTEM\./);
        assert.doesNotMatch(sentSystem, /ASPECT-/);
        assert.doesNotMatch(sentUser, /ASPECT-/);
    });

    test('AGT-7: Copilot', async () => {
        const text = withAspectsForCopilot('COPILOT-PROMPT');
        assert.match(text, /^## Aspect guidelines[\s\S]*ASPECT-SYSTEM-BRIEF[\s\S]*ASPECT-USER-QUIET[\s\S]*\n---\n\nCOPILOT-PROMPT$/);
        assert.equal(withAspectsForCopilot('X', { window: { answer_mode: 'remove', night: 'remove' } }), 'X', 'nothing chosen: the prompt as it is');
        spies.clear();
        await openCopilotChat('COPILOT-PROMPT');
        const opened = spies.byMethod('commands.executeCommand').find((c) => c.args[0] === 'workbench.action.chat.open');
        assert.ok(opened, 'Copilot Chat opened');
        assert.match(String((opened.args[1] as { query: string }).query), /ASPECT-SYSTEM-BRIEF[\s\S]*ASPECT-USER-QUIET[\s\S]*COPILOT-PROMPT/);
    });
});
