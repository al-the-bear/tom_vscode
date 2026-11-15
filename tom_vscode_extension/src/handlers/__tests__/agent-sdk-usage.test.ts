/**
 * Agent SDK: a resumed session's prompt reports its own rounds, tokens and cost (qrfix3).
 *
 * Measured in the live trails: the result's `usage` and `num_turns` are the prompt's own, its `total_cost_usd`,
 * `duration_api_ms` and `modelUsage` grow over the resumed session. The fake SDK here answers like that.
 *
 *   AU-1 the rule (utils/agentSdkUsage.ts): with the session's previous snapshot the cost, API time and per-model
 *        rows are the difference (an unused model drops out, the tokens stay as reported); a new session's first
 *        result is its own; a resumed session without a snapshot keeps the tokens and reports the rest as
 *        `sessionSoFar`; a value below the snapshot's (counting started again) is taken as it is
 *   AU-2 the transport over a fake SDK with cumulative results: two prompts of one session — the second's usage
 *        block (live trail, so the Status Page's ledger) is its own share; the baseline survives a reload (the
 *        snapshot file in the store folder)
 *   AU-3 a resumed session with no baseline: the trail says "session so far", and the usage ledger counts its
 *        tokens but not the session's cost
 *   AU-4 a send that ends without a result message reports the turns it saw, not the configured maximum (the
 *        `rounds=800` of a cancelled prompt)
 */

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire messages are snake_case */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-usage-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { formatLiveTrailUsage, type LiveTrailUsage } from '../../services/live-trail.js';
import { perPromptUsage, snapshotOf } from '../../utils/agentSdkUsage.js';
import { AGENT_SDK_USAGE_FILE, setAgentSdkUsageStoreDir } from '../../services/agentSdkUsageSnapshots.js';
import { emptyUsageLedger, recordUsage, summarizeUsage } from '../../utils/usageLedger.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

/** A cumulative result as the SDK sends it for a session: per-query usage, the rest summed over the session. */
function result(sessionId: string, perQueryOut: number, cumulative: { cost: number; api: number; out: number }, turns = 3): Record<string, unknown> {
    return {
        type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, num_turns: turns,
        usage: { input_tokens: 10, output_tokens: perQueryOut, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 },
        modelUsage: {
            'claude-opus-5-5': { inputTokens: 100, outputTokens: cumulative.out, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 500, costUSD: cumulative.cost, contextWindow: 1_000_000 },
            'claude-haiku-4-5': { inputTokens: 983, outputTokens: 14, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0011, contextWindow: 200_000 },
        },
        total_cost_usd: cumulative.cost + 0.0011,
        duration_api_ms: cumulative.api,
    };
}

/** A fake SDK answering each query with the next scripted message list. */
function fakeSdk(scripts: unknown[][]): unknown {
    let call = 0;
    return {
        tool: (name: string) => ({ name }),
        createSdkMcpServer: () => ({}),
        query: () => {
            const messages = scripts[call++] ?? [];
            const stream = (async function* () { for (const m of messages) { yield m; } })();
            return Object.assign(stream, { setPermissionMode: async () => undefined });
        },
    };
}

/** A live trail recording the usage blocks (every other operation a no-op). */
function trailRecorder(): { trail: AgentSdkSendParams['liveTrail']; usage: LiveTrailUsage[] } {
    const usage: LiveTrailUsage[] = [];
    const trail = new Proxy({}, { get: (_t, prop) => (prop === 'appendUsage' ? (u: LiveTrailUsage) => { usage.push(u); } : () => undefined) });
    return { trail: trail as AgentSdkSendParams['liveTrail'], usage };
}

async function send(scripts: unknown[][], extra: Partial<AgentSdkSendParams>): Promise<{ usage: LiveTrailUsage[]; turnsUsed: number }> {
    __setAgentSdkForTests(fakeSdk(scripts));
    const rec = trailRecorder();
    try {
        const r = await runAgentSdkQuery({
            configuration: { id: 'cfg', name: 'cfg', model: 'claude-opus-5-5', maxTokens: 1000, maxRounds: 800 } as AgentSdkSendParams['configuration'],
            tools: [],
            systemPrompt: 'p',
            userText: 'hi',
            context: {
                requestApproval: async () => true, sessionApprovals: new Set(), toolTrail: new ToolTrail(),
                round: 1, questId: 'q', windowId: 'w', requestId: 'r',
            } as unknown as AgentSdkSendParams['context'],
            toolApprovalMode: 'never',
            liveTrail: rec.trail,
            ...extra,
        });
        return { usage: rec.usage, turnsUsed: r.turnsUsed };
    } finally {
        __setAgentSdkForTests(undefined);
    }
}

const assistant = (sessionId: string, id: string): Record<string, unknown> => ({
    type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: `turn ${id}` }] },
});

describe('Agent SDK: per-prompt usage of a resumed session', () => {
    test('AU-1: the rule', () => {
        const first: LiveTrailUsage = {
            totals: { inputTokens: 10, outputTokens: 100 },
            models: [{ model: 'opus', outputTokens: 100, costUSD: 1 }, { model: 'haiku', outputTokens: 14, costUSD: 0.001 }],
            totalCostUsd: 1.001, durationApiMs: 10_000,
        };
        const second: LiveTrailUsage = {
            totals: { inputTokens: 12, outputTokens: 60 },
            models: [{ model: 'opus', outputTokens: 160, costUSD: 1.5, contextWindow: 1_000_000 }, { model: 'haiku', outputTokens: 14, costUSD: 0.001 }],
            totalCostUsd: 1.501, durationApiMs: 14_000,
        };
        assert.deepEqual(perPromptUsage(first, undefined, false), first, 'a new session\'s first result is its own');
        const own = perPromptUsage(second, snapshotOf(first), true);
        assert.deepEqual(own.totals, second.totals, 'the per-query tokens stay');
        assert.ok(Math.abs((own.totalCostUsd ?? 0) - 0.5) < 1e-9);
        assert.equal(own.durationApiMs, 4_000);
        assert.deepEqual(own.models?.map((m) => [m.model, m.outputTokens, m.contextWindow]), [['opus', 60, 1_000_000]], 'the unused haiku row drops out');
        assert.ok(Math.abs((own.models![0].costUSD ?? 0) - 0.5) < 1e-9);
        const unknown = perPromptUsage(second, undefined, true);
        assert.deepEqual(unknown, { totals: second.totals, sessionSoFar: { totalCostUsd: 1.501, durationApiMs: 14_000, models: second.models } });
        const restarted = perPromptUsage(first, snapshotOf(second), true);
        assert.equal(restarted.totalCostUsd, 1.001, 'below the snapshot: the counting started again');
    });

    test('AU-2: two prompts of one session — the second reports its own share; the baseline survives a reload', async () => {
        const store = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-usage-store-'));
        setAgentSdkUsageStoreDir(store);
        try {
            const one = await send([[assistant('sess-a', 'm1'), result('sess-a', 100, { cost: 1, api: 10_000, out: 100 })]], {});
            assert.equal(one.usage[0].totalCostUsd, 1.0011, 'a new session: its first result as it came');
            const two = await send([[assistant('sess-a', 'm2'), result('sess-a', 60, { cost: 1.5, api: 14_000, out: 160 })]], { resumeSessionId: 'sess-a' });
            const u = two.usage[0];
            assert.ok(Math.abs((u.totalCostUsd ?? 0) - 0.5) < 1e-9, JSON.stringify(u));
            assert.equal(u.durationApiMs, 4_000);
            assert.deepEqual(u.models?.map((m) => [m.model, m.outputTokens]), [['claude-opus-5-5', 60]], 'its own opus share; haiku unused');
            assert.equal(u.totals?.outputTokens, 60, 'the per-query tokens');
            assert.match(formatLiveTrailUsage(u, new Date()), /- cost: \$0\.5000 · api 4\.0s/);
            assert.ok(fs.existsSync(path.join(store, AGENT_SDK_USAGE_FILE)));
            // A reload: the snapshots are read back from the store folder.
            setAgentSdkUsageStoreDir(store);
            const three = await send([[result('sess-a', 40, { cost: 1.75, api: 15_000, out: 200 })]], { resumeSessionId: 'sess-a' });
            assert.ok(Math.abs((three.usage[0].totalCostUsd ?? 0) - 0.25) < 1e-9, JSON.stringify(three.usage[0]));
        } finally {
            setAgentSdkUsageStoreDir(undefined);
            fs.rmSync(store, { recursive: true, force: true });
        }
    });

    test('AU-3: a resumed session without a baseline', async () => {
        setAgentSdkUsageStoreDir(undefined);
        const r = await send([[result('sess-b', 70, { cost: 85.25, api: 3_144_100, out: 310_138 })]], { resumeSessionId: 'sess-b' });
        const u = r.usage[0];
        assert.equal(u.totalCostUsd, undefined, 'the session\'s cost is not the prompt\'s');
        assert.equal(u.totals?.outputTokens, 70);
        const md = formatLiveTrailUsage(u, new Date());
        assert.match(md, /- session so far \(the resumed session's totals; this prompt's share is not known\): \$85\.2511 · api 3144\.1s · claude-opus-5-5 out 310,138, claude-haiku-4-5 out 14/);
        assert.doesNotMatch(md, /- cost:/);
        const ledger = summarizeUsage(recordUsage(emptyUsageLedger(new Date()), u, new Date()), new Date());
        assert.equal(ledger.todayCostUsd, 0, 'the ledger does not count the session\'s cost');
        assert.equal(ledger.today[0].outputTokens, 70, 'but the prompt\'s tokens');
    });

    test('AU-4: no result message — the turns seen, not the configured maximum', async () => {
        const r = await send([[assistant('sess-c', 'm1'), assistant('sess-c', 'm1'), assistant('sess-c', 'm2')]], {});
        assert.equal(r.turnsUsed, 2, 'two model turns (one message id repeats for a second content block)');
    });
});
