/**
 * An Agent SDK profile's thinking reaches the SDK (CC-1): the real
 * `runAgentSdkQuery` over a fake SDK that records the options it is given.
 * The options are built the way the handler builds them
 * (anthropic-handler.ts: agentSdkThinkingOptions(model, profileThinkingSettings(profile))).
 *
 *   ST-1 thinking on, on a model that thinks with a budget: the SDK gets `{type: 'enabled', budgetTokens}`,
 *        the profile's budget, else 8192 (as on the direct transport)
 *   ST-2 thinking on, on an adaptive model: `{type: 'adaptive'}`; the profile's effort goes along
 *   ST-3 thinking off: `{type: 'disabled'}` where the model allows it; no thinking key: the model's default
 *        (no option sent)
 *   ST-4 the handler builds the transport's thinkingOptions from the profile and the configuration's model
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-thinking-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { agentSdkThinkingOptions, profileThinkingSettings } from '../../utils/thinkingAndEffort.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';

TrailService.init({} as never);
// A successful send writes the raw trail, which reads the configuration (the workspace is the temp folder).
TomAiConfiguration.init({} as never);

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire messages are snake_case */

/** A fake SDK that records the options of every query and answers with one successful result. */
function fakeSdk() {
    const options: Record<string, unknown>[] = [];
    const sdk = {
        tool: () => ({}),
        createSdkMcpServer: () => ({}),
        query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
            options.push(args.options);
            return (async function* () {
                yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-1', num_turns: 1, usage: {} };
            })();
        },
    };
    return { sdk, options };
}

/* eslint-enable @typescript-eslint/naming-convention */

/** The SDK options of one send with `profile` on `model`, its thinking options built as the handler builds them. */
async function sdkOptionsFor(model: string, profile: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { sdk, options } = fakeSdk();
    __setAgentSdkForTests(sdk);
    try {
        const params: AgentSdkSendParams = {
            configuration: { id: 'cfg', name: 'cfg', model, maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
            tools: [],
            systemPrompt: '',
            userText: 'think about it',
            context: {
                requestApproval: async () => true,
                sessionApprovals: new Set(),
                toolTrail: new ToolTrail(),
                round: 1,
                questId: 'test_quest',
                windowId: 'win',
                requestId: 'req-1',
            },
            thinkingOptions: agentSdkThinkingOptions(model, profileThinkingSettings(profile)),
        };
        await runAgentSdkQuery(params);
    } finally {
        __setAgentSdkForTests(undefined);
    }
    assert.equal(options.length, 1, 'one query');
    return options[0];
}

describe('Agent SDK: the profile thinking reaches the SDK', () => {
    test('ST-1: a budget model gets the budget', async () => {
        assert.deepEqual((await sdkOptionsFor('claude-haiku-4-5', { thinking: 'adaptive' })).thinking,
            { type: 'enabled', budgetTokens: 8192 }, 'the default budget, as on direct');
        assert.deepEqual((await sdkOptionsFor('claude-haiku-4-5', { thinking: 'adaptive', legacyThinkingBudgetTokens: 16000 })).thinking,
            { type: 'enabled', budgetTokens: 16000 }, 'the profile\'s budget');
        assert.deepEqual((await sdkOptionsFor('claude-haiku-4-5', { thinking: 'adaptive', thinkingBudgetTokens: 4096 })).thinking,
            { type: 'enabled', budgetTokens: 4096 }, 'the older key is read too');
    });

    test('ST-2: an adaptive model thinks adaptively, with the effort', async () => {
        const opts = await sdkOptionsFor('claude-opus-4-8', { thinking: 'adaptive', effort: 'high' });
        assert.deepEqual(opts.thinking, { type: 'adaptive' });
        assert.equal(opts.effort, 'high');
    });

    test('ST-3: off, and the default', async () => {
        assert.deepEqual((await sdkOptionsFor('claude-opus-4-8', { thinking: 'off' })).thinking, { type: 'disabled' });
        const none = await sdkOptionsFor('claude-opus-4-8', {});
        assert.equal('thinking' in none, false, 'no thinking key on the profile: no option, the model decides');
        assert.equal('effort' in none, false);
    });

    test('ST-4: the handler wires the profile and the model in', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        assert.match(src, /thinkingOptions: agentSdkThinkingOptions\(configuration\.model, profileThinkingSettings\(profile/);
    });
});
