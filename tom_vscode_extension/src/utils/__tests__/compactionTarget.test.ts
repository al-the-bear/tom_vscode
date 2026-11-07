/**
 * Which model compaction and memory extraction run on
 * (src/utils/compactionTarget.ts), and that each kind is called through its
 * own transport (ccparity_a_directapi-4).
 *
 * Both ran on one provider + configuration pair, and an Anthropic choice always
 * went to the direct API (`runInternalCall`), so an Agent SDK–only setup with no
 * API key could not compact. Now each has its own dropdown listing every
 * Anthropic configuration (direct, Agent SDK, VS Code LM) and every Local LLM
 * configuration; no fallback list, no per-quest override.
 *
 *   CT-1 a target is written `anthropic:<id>` or `localLlm:<id>`; anything else is not a target
 *   CT-2 each purpose reads its own key; without one, the legacy llmProvider / llmConfigId pair (both);
 *        without that, no target (configId '': not configured — compaction does not run, as before)
 *   CT-3 the choices: every Anthropic configuration with its transport, then every Local LLM configuration
 *   CT-4 the route of a target: an Anthropic configuration goes to its transport (direct, agentSdk,
 *        vscodeLm), a Local LLM configuration to localLlm; an unknown id is an error naming it, an
 *        empty one ("not configured") an error too
 *   CT-5 runTargetCall calls exactly the runner of the route, with the configuration
 *   CT-6 the quest override no longer switches the model
 *   CT-7 wired: the Status Page has the two dropdowns (every configuration), sends and saves both
 *        keys (dropping llmProvider / llmConfigId), the dry run uses the purpose's model; the handlers
 *        call compaction with the compaction target and memory extraction with the memory target, and
 *        the compaction module routes every call (no HTTP of its own)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    compactionTargetChoices, encodeCompactionTarget, parseCompactionTarget, resolveCompactionTarget, routeCompactionTarget,
    runTargetCall, type InternalCallRunners,
} from '../compactionTarget';
import { applyQuestCompactionOverride } from '../compactionQuestOverride';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ANTHROPIC = [
    { id: 'haiku-direct', name: 'Haiku direct', model: 'claude-haiku-5-5', transport: 'direct' as const },
    { id: 'opus-sdk', name: 'Opus SDK', model: 'claude-opus-5-5', transport: 'agentSdk' as const },
    { id: 'copilot', name: 'Copilot GPT', model: 'gpt', transport: 'vscodeLm' as const },
    { id: 'plain', name: 'Plain', model: 'claude-sonnet-5-5' },   // no transport: direct
];
const LOCAL = [
    { id: 'gemma', name: 'Gemma on bomber', model: 'gemma4:26b', ollamaUrl: 'http://bomber:8001' },
    { id: 'qwen', name: 'Qwen', model: 'qwen3', ollamaUrl: 'http://localhost:11434' },
];

describe('compaction and memory-extraction targets', () => {
    test('CT-1: encoding', () => {
        assert.equal(encodeCompactionTarget({ kind: 'anthropic', configId: 'opus-sdk' }), 'anthropic:opus-sdk');
        assert.deepEqual(parseCompactionTarget('localLlm:gemma'), { kind: 'localLlm', configId: 'gemma' });
        assert.deepEqual(parseCompactionTarget('anthropic:a:b'), { kind: 'anthropic', configId: 'a:b' });
        for (const bad of ['', 'gemma', 'openai:x', 'anthropic:', undefined, 42]) {
            assert.equal(parseCompactionTarget(bad as unknown), undefined, String(bad));
        }
    });

    test('CT-2: each purpose its own key, then the legacy pair, then the first Local LLM', () => {
        const both = { compactionModel: 'anthropic:opus-sdk', memoryExtractionModel: 'localLlm:qwen', llmProvider: 'localLlm', llmConfigId: 'gemma' };
        assert.deepEqual(resolveCompactionTarget(both, 'compaction'), { kind: 'anthropic', configId: 'opus-sdk' });
        assert.deepEqual(resolveCompactionTarget(both, 'memory'), { kind: 'localLlm', configId: 'qwen' });
        const legacy = { llmProvider: 'anthropic', llmConfigId: 'haiku-direct' };
        assert.deepEqual(resolveCompactionTarget(legacy, 'compaction'), { kind: 'anthropic', configId: 'haiku-direct' });
        assert.deepEqual(resolveCompactionTarget(legacy, 'memory'), { kind: 'anthropic', configId: 'haiku-direct' });
        assert.deepEqual(resolveCompactionTarget({ llmProvider: 'localLlm', llmConfigId: 'gemma' }, 'memory'), { kind: 'localLlm', configId: 'gemma' });
        assert.deepEqual(resolveCompactionTarget({}, 'memory'), { kind: 'localLlm', configId: '' });
        assert.deepEqual(resolveCompactionTarget({ compactionModel: 'nonsense' }, 'compaction'), { kind: 'localLlm', configId: '' });
        assert.deepEqual(resolveCompactionTarget(undefined, 'compaction'), { kind: 'localLlm', configId: '' });
    });

    test('CT-3: the choices', () => {
        assert.deepEqual(compactionTargetChoices(ANTHROPIC, LOCAL).map((c) => [c.value, c.label]), [
            ['anthropic:haiku-direct', 'Haiku direct (direct API)'],
            ['anthropic:opus-sdk', 'Opus SDK (Agent SDK)'],
            ['anthropic:copilot', 'Copilot GPT (VS Code LM)'],
            ['anthropic:plain', 'Plain (direct API)'],
            ['localLlm:gemma', 'Gemma on bomber (Local LLM)'],
            ['localLlm:qwen', 'Qwen (Local LLM)'],
        ]);
    });

    test('CT-4: routes', () => {
        const route = (v: string) => routeCompactionTarget(parseCompactionTarget(v)!, ANTHROPIC, LOCAL);
        assert.equal((route('anthropic:haiku-direct') as { kind: string }).kind, 'direct');
        assert.equal((route('anthropic:plain') as { kind: string }).kind, 'direct');
        assert.equal((route('anthropic:opus-sdk') as { kind: string }).kind, 'agentSdk');
        assert.equal((route('anthropic:copilot') as { kind: string }).kind, 'vscodeLm');
        const local = route('localLlm:qwen') as { kind: string; localConfig: { id: string } };
        assert.deepEqual([local.kind, local.localConfig.id], ['localLlm', 'qwen']);
        assert.match((route('anthropic:gone') as { error: string }).error, /gone/);
        assert.match((route('localLlm:gone') as { error: string }).error, /gone/);
        // An empty id is "not configured": refused, never a guessed configuration.
        assert.match((routeCompactionTarget({ kind: 'localLlm', configId: '' }, ANTHROPIC, LOCAL) as { error: string }).error, /no model is chosen/);
    });

    test('CT-5: exactly the route\'s runner is called', async () => {
        const calls: string[] = [];
        const runners: InternalCallRunners = {
            direct: async (c) => { calls.push(`direct ${c.id}`); return 'd'; },
            agentSdk: async (c) => { calls.push(`agentSdk ${c.id}`); return 's'; },
            vscodeLm: async (c) => { calls.push(`vscodeLm ${c.id}`); return 'v'; },
            localLlm: async (c) => { calls.push(`localLlm ${c.id}`); return 'l'; },
        };
        const prompts = { systemPrompt: 'S', userPrompt: 'U' };
        for (const v of ['anthropic:haiku-direct', 'anthropic:opus-sdk', 'anthropic:copilot', 'localLlm:gemma']) {
            const route = routeCompactionTarget(parseCompactionTarget(v)!, ANTHROPIC, LOCAL);
            await runTargetCall(route, runners, prompts);
        }
        assert.deepEqual(calls, ['direct haiku-direct', 'agentSdk opus-sdk', 'vscodeLm copilot', 'localLlm gemma']);
        await assert.rejects(runTargetCall({ error: 'no such configuration: x' }, runners, prompts), /no such configuration: x/);
    });

    test('CT-6: no per-quest model', () => {
        const ws = { llmConfigId: 'a', compactionModel: 'anthropic:a', disabled: false };
        const out = applyQuestCompactionOverride(ws, { llmProvider: 'anthropic', llmConfigId: 'b', compactionModel: 'localLlm:x', memoryExtractionModel: 'localLlm:y', disabled: true });
        assert.deepEqual(out, { llmConfigId: 'a', compactionModel: 'anthropic:a', disabled: true });
    });

    test('CT-7: wired', () => {
        const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf-8');
        const page = src('src', 'handlers', 'statusPage-handler.ts');
        assert.match(page, /id="sp-comp-compactionModel"/);
        assert.match(page, /id="sp-comp-memoryExtractionModel"/);
        assert.match(page, /compactionPickerState\(/, 'the choices through compactionPickerState (compactionTargetChoices), shared with the queue editor');
        assert.match(page, /stcConfig\.compaction\.compactionModel = /);
        assert.match(page, /stcConfig\.compaction\.memoryExtractionModel = /);
        assert.match(page, /delete stcConfig\.compaction\.llmProvider/);
        assert.doesNotMatch(page, /id="sp-comp-llmProvider"/);
        const listeners = src('media', 'statusPage', 'listeners.js');
        assert.match(listeners, /compactionModel: \(document\.getElementById\('sp-comp-compactionModel'\)/);
        assert.match(listeners, /memoryExtractionModel: \(document\.getElementById\('sp-comp-memoryExtractionModel'\)/);
        const handler = src('src', 'handlers', 'anthropic-handler.ts');
        assert.match(handler, /llmProvider: cfg\.compactionTarget\.kind/);
        assert.match(handler, /llmProvider: cfg\.memoryTarget\.kind/);
        assert.doesNotMatch(handler, /cfg\.llmProvider/);
        const compaction = src('src', 'services', 'history-compaction.ts');
        assert.match(compaction, /routeCompactionTarget</);
        assert.doesNotMatch(compaction, /from 'https?'/, 'no HTTP of its own: the Local LLM call goes through callLocalLlmOnce');
        assert.match(compaction, /callLocalLlmOnce\(/);
    });
});
