/**
 * Tool-impl tests for `ask-big-brother-tool.ts` — coverage entry #25.
 *
 * Strategy: an in-memory `LanguageModelBridge` fake that scripts:
 *   - the model catalogue + the selectModels filter behaviour
 *   - one or more sequential `sendRequest` responses (text-only or
 *     text + tool_call streams)
 *   - tool invocation results per tool name
 *   - a programmable summarise() output
 *
 * The fake records every call so each test can assert how many round-
 * trips happened, which model was picked, and whether the
 * summarisation gate fired.
 *
 * Coverage entry #25 four-row checklist (askBigBrother half):
 *
 *   a) Description clarity — verified in the impl file: model
 *      selection chain (id → family → substring), tool-loop bounds,
 *      timeout unwinding, summarisation gate.
 *   b) Ambiguities covered:
 *        - timeout vs response chunking now distinct envelopes
 *        - enableTools: false forces maxIterations = 1 (documented)
 *        - the substring fallback matches BOTH name OR id (case-insens.)
 *        - summarisation triggered only when length > threshold AND
 *          config.summarisation.enabled
 *   c) Tests use a fake `LanguageModelBridge` (the b-row asked for a
 *      stub of `vscode.lm`).
 *   d) Timing — sub-ms per call; no real model invoked.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    askBigBrotherImpl,
    selectModelByQuery,
    type LanguageModelBridge,
    type BigBrotherModel,
    type BigBrotherToolDef,
    type BigBrotherConfig,
    type ChatTurn,
    type ResponsePart,
    type CancelSignal,
} from '../ask-big-brother-tool.js';

// ===========================================================================
// Fake bridge
// ===========================================================================

interface SendRequestCall { modelId: string; messages: ChatTurn[]; tools: BigBrotherToolDef[] }
interface InvokeToolCall { name: string; input: object }

interface FakeBridge extends LanguageModelBridge {
    catalogue: BigBrotherModel[];
    /** Queue of canned responses for sequential sendRequest calls. */
    responseQueue: ResponsePart[][];
    sendRequestCalls: SendRequestCall[];
    invokeToolCalls: InvokeToolCall[];
    toolResponses: Record<string, string>;
    summariseCallCount: number;
    summaryOut: string;
    availableTools: BigBrotherToolDef[];
    config: BigBrotherConfig;
    /** When set, sendRequest flips the signal before returning. */
    cancelOnSend?: boolean;
}

function makeBridge(): FakeBridge {
    const cat: BigBrotherModel[] = [
        { id: 'gpt-4o',        name: 'GPT-4o',         family: 'gpt-4',  vendor: 'openai',    maxInputTokens: 128_000 },
        { id: 'claude-sonnet', name: 'Claude Sonnet',  family: 'claude', vendor: 'anthropic', maxInputTokens: 200_000 },
        { id: 'copilot-fast',  name: 'Copilot Fast',   family: 'copilot', vendor: 'github',   maxInputTokens: 32_000  },
    ];
    const fake: FakeBridge = {
        catalogue: cat,
        responseQueue: [],
        sendRequestCalls: [],
        invokeToolCalls: [],
        toolResponses: {},
        summariseCallCount: 0,
        summaryOut: '[SUMMARY]',
        availableTools: [],
        config: {
            enabled: true,
            defaultModel: 'gpt-4o',
            enableToolsByDefault: false,
            maxIterations: 3,
            responseTimeoutMs: 30_000,
            summarisation: { enabled: false, thresholdChars: 5_000 },
            modelRecommendations: '• gpt-4o for code\n• claude for prose',
        },
        async listAllModels() { return [...fake.catalogue]; },
        async selectModels(filter) {
            return fake.catalogue.filter((m) => {
                if (filter.id !== undefined && m.id !== filter.id) { return false; }
                if (filter.family !== undefined && m.family !== filter.family) { return false; }
                return true;
            });
        },
        listAvailableTools() { return [...fake.availableTools]; },
        async sendRequest(modelId, messages, tools, signal) {
            fake.sendRequestCalls.push({ modelId, messages: messages.map((m) => ({ ...m })), tools: [...tools] });
            const next = fake.responseQueue.shift() ?? [];
            if (fake.cancelOnSend) { signal.cancelled = true; }
            return next;
        },
        async invokeTool(name, input) {
            fake.invokeToolCalls.push({ name, input });
            return fake.toolResponses[name] ?? `[no canned result for ${name}]`;
        },
        async summarise(text) {
            fake.summariseCallCount++;
            return `${fake.summaryOut} (was ${text.length})`;
        },
        getConfig() { return fake.config; },
    };
    return fake;
}

// ===========================================================================
// `selectModelByQuery` — pure helper
// ===========================================================================

describe('selectModelByQuery', () => {

    test('exact id match wins first', async () => {
        const b = makeBridge();
        const m = await selectModelByQuery(b, 'claude-sonnet');
        assert.equal(m?.id, 'claude-sonnet');
    });

    test('family match when id misses', async () => {
        const b = makeBridge();
        const m = await selectModelByQuery(b, 'gpt-4');  // family, not id
        assert.equal(m?.id, 'gpt-4o');
    });

    test('substring on name (case-insensitive) when id + family miss', async () => {
        const b = makeBridge();
        const m = await selectModelByQuery(b, 'COPILOT');
        assert.equal(m?.id, 'copilot-fast');
    });

    test('substring on id (case-insensitive) when name does not match', async () => {
        const b = makeBridge();
        b.catalogue.push({ id: 'mistral-7b', name: 'Mistral', family: 'mistral', vendor: 'mistral', maxInputTokens: 8000 });
        const m = await selectModelByQuery(b, '7b');
        assert.equal(m?.id, 'mistral-7b');
    });

    test('no match → undefined', async () => {
        const b = makeBridge();
        assert.equal(await selectModelByQuery(b, 'llama-9000'), undefined);
    });

    test('empty query → undefined', async () => {
        const b = makeBridge();
        assert.equal(await selectModelByQuery(b, ''), undefined);
    });
});

// ===========================================================================
// `askBigBrotherImpl` — list + query
// ===========================================================================

describe('askBigBrotherImpl', () => {

    test('typical: operation: "list" returns catalogue + recommendations', async () => {
        const b = makeBridge();
        const raw = await withTiming('tomAi_askBigBrother:typical', () =>
            askBigBrotherImpl(b, { operation: 'list' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.operation, 'list');
        assert.equal(r.count, 3);
        assert.equal(r.models.length, 3);
        assert.match(r.recommendations, /gpt-4o/);
    });

    test('query: text-only response is returned trimmed', async () => {
        const b = makeBridge();
        b.responseQueue = [[{ kind: 'text', text: '  hello\n' }]];
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'hi' }));
        assert.equal(r.ok, true);
        assert.equal(r.response, 'hello');
        assert.equal(r.iterationsUsed, 1);
        assert.equal(r.toolCallsMade, 0);
        assert.equal(r.enableTools, false);
        assert.equal(r.summarised, false);
        assert.equal(r.model.id, 'gpt-4o');  // default
    });

    test('query: explicit modelId overrides default', async () => {
        const b = makeBridge();
        b.responseQueue = [[{ kind: 'text', text: 'answer' }]];
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x', modelId: 'claude-sonnet' }));
        assert.equal(r.model.id, 'claude-sonnet');
    });

    test('tool loop: one tool_call → one invoke → second sendRequest returns final text', async () => {
        const b = makeBridge();
        b.config = { ...b.config, enableToolsByDefault: false, maxIterations: 5 };
        b.availableTools = [{ name: 'tomAi_readFile', description: 'read', inputSchema: {} }];
        b.toolResponses = { tomAi_readFile: 'FILE CONTENTS' };
        b.responseQueue = [
            [{ kind: 'tool_call', callId: 'c1', name: 'tomAi_readFile', input: { path: 'x' } }],
            [{ kind: 'text', text: 'I read it.' }],
        ];
        const r = JSON.parse(await askBigBrotherImpl(b, {
            operation: 'query', prompt: 'use tools', enableTools: true,
        }));
        assert.equal(r.ok, true);
        assert.equal(r.response, 'I read it.');
        assert.equal(r.iterationsUsed, 2);
        assert.equal(r.toolCallsMade, 1);
        assert.equal(b.invokeToolCalls.length, 1);
        assert.equal(b.invokeToolCalls[0].name, 'tomAi_readFile');
        // The 2nd sendRequest received the tool_result turn
        assert.equal(b.sendRequestCalls.length, 2);
        const secondMsgs = b.sendRequestCalls[1].messages;
        assert.equal(secondMsgs[secondMsgs.length - 1].role, 'tool_result');
    });

    test('enableTools: false forces maxIterations = 1 even when input says 5', async () => {
        const b = makeBridge();
        b.responseQueue = [[
            { kind: 'tool_call', callId: 'c1', name: 'tool_a', input: {} },
        ]];
        const r = JSON.parse(await askBigBrotherImpl(b, {
            operation: 'query', prompt: 'x', enableTools: false, maxIterations: 5,
        }));
        // With tools disabled, the loop hits maxIter=1 and exits without invoking the call.
        assert.equal(r.iterationsUsed, 1);
        assert.equal(b.sendRequestCalls.length, 1);
        // No tools forwarded
        assert.deepEqual(b.sendRequestCalls[0].tools, []);
    });

    test('maxIterations: respected when enableTools is true (loop stops at cap)', async () => {
        const b = makeBridge();
        b.availableTools = [{ name: 't', description: '' }];
        b.toolResponses = { t: 'r' };
        // Every round returns a tool_call → loop must bail at maxIterations
        b.responseQueue = [
            [{ kind: 'tool_call', callId: 'c1', name: 't', input: {} }],
            [{ kind: 'tool_call', callId: 'c2', name: 't', input: {} }],
        ];
        const r = JSON.parse(await askBigBrotherImpl(b, {
            operation: 'query', prompt: 'x', enableTools: true, maxIterations: 2,
        }));
        assert.equal(r.iterationsUsed, 2);
        assert.equal(r.toolCallsMade, 2);
        assert.equal(r.response, '');  // never got a text-final round
    });

    test('timeout: signal.cancelled before iteration → ok:false with reason: "timeout"', async () => {
        const b = makeBridge();
        const signal: CancelSignal = { cancelled: false };
        b.responseQueue = [[{ kind: 'text', text: 'I shall never speak' }]];
        // Cancel before the impl even checks
        signal.cancelled = true;
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x' }, signal));
        assert.equal(r.ok, false);
        assert.match(r.error, /Response timed out/);
        assert.equal(r.cancelled, true);
        assert.equal(r.reason, 'timeout');
        assert.equal(b.sendRequestCalls.length, 0, 'no request sent after cancellation');
    });

    test('timeout: signal flipped mid-stream → unwinds with iterationsUsed = 1', async () => {
        const b = makeBridge();
        b.cancelOnSend = true;
        b.responseQueue = [[{ kind: 'text', text: 'partial' }]];
        const signal: CancelSignal = { cancelled: false };
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x' }, signal));
        assert.equal(r.ok, false);
        assert.equal(r.cancelled, true);
        assert.equal(r.iterationsUsed, 1, 'one round attempted before cancel detected');
    });

    test('summarisation: triggered when response > threshold AND enabled', async () => {
        const b = makeBridge();
        b.config = { ...b.config, summarisation: { enabled: true, thresholdChars: 10 } };
        b.responseQueue = [[{ kind: 'text', text: 'this response is long enough to summarise' }]];
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x' }));
        assert.equal(r.summarised, true);
        assert.equal(b.summariseCallCount, 1);
        assert.match(r.response, /\[SUMMARY\]/);
    });

    test('summarisation: NOT triggered when below threshold', async () => {
        const b = makeBridge();
        b.config = { ...b.config, summarisation: { enabled: true, thresholdChars: 1000 } };
        b.responseQueue = [[{ kind: 'text', text: 'short' }]];
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x' }));
        assert.equal(r.summarised, false);
        assert.equal(b.summariseCallCount, 0);
    });

    test('summarisation: NOT triggered when disabled (even if over threshold)', async () => {
        const b = makeBridge();
        b.config = { ...b.config, summarisation: { enabled: false, thresholdChars: 1 } };
        b.responseQueue = [[{ kind: 'text', text: 'over the threshold' }]];
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query', prompt: 'x' }));
        assert.equal(r.summarised, false);
    });

    test('tool: invoke throws → impl reports inline error, continues with empty result text', async () => {
        const b = makeBridge();
        b.availableTools = [{ name: 'crashy' }];
        // Override invokeTool to throw
        const original = b.invokeTool;
        b.invokeTool = async (name, input) => {
            if (name === 'crashy') { throw new Error('disk full'); }
            return original.call(b, name, input);
        };
        b.responseQueue = [
            [{ kind: 'tool_call', callId: 'c1', name: 'crashy', input: {} }],
            [{ kind: 'text', text: 'recovered' }],
        ];
        const r = JSON.parse(await askBigBrotherImpl(b, {
            operation: 'query', prompt: 'x', enableTools: true, maxIterations: 5,
        }));
        assert.equal(r.ok, true);
        assert.equal(r.response, 'recovered');
        // The tool_result turn we pushed had an error message inline
        const secondMsgs = b.sendRequestCalls[1].messages;
        const last = secondMsgs[secondMsgs.length - 1];
        assert.equal(last.role, 'tool_result');
        if (last.role === 'tool_result') {
            assert.match(last.results[0].text, /Tool crashy error: disk full/);
        }
    });

    test('disabled tool → ok:false with hint', async () => {
        const b = makeBridge();
        b.config = { ...b.config, enabled: false };
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'list' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /disabled/);
        assert.match(r.hint, /status page/);
    });

    test('query with missing prompt → ok:false', async () => {
        const b = makeBridge();
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'query' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`prompt` is required/);
    });

    test('query with unknown model → ok:false with list hint', async () => {
        const b = makeBridge();
        const r = JSON.parse(await askBigBrotherImpl(b, {
            operation: 'query', prompt: 'x', modelId: 'unknown-model',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /No model found matching "unknown-model"/);
        assert.match(r.hint, /list/);
    });

    test('unknown operation → ok:false', async () => {
        const b = makeBridge();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await askBigBrotherImpl(b, { operation: 'foo' as any }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Unknown operation/);
    });
});
