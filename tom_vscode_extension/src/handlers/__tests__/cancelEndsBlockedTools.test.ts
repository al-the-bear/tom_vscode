/**
 * A cancelled send ends the tool call it is blocked in (vscimpb78), under the vscode stub.
 *
 *   CE-1 the owner with the send's token (services/askOwners.ts): the cancels run when the token fires, while the
 *        send still runs — not only when it settles; a wait registered after that ends right away; nothing runs
 *        twice; the listener is gone once the send settled
 *   CE-2 the race (utils/cancelRace.ts): a tool that never answers yields `cancelled` when the token fires, at once
 *        when it fired already; without a token the value; a rejection before the cancel rejects, one after it is
 *        swallowed
 *   CE-3 runTool on the direct, Local LLM and VS Code LM loops: a never-resolving tool answers
 *        'cancelled: the prompt was ended' within a second of the cancel; a call of a cancelled send does not run
 *   CE-4 the tool approval: the cancel closes it (no approval left pending or in the user-input panel) and the call
 *        answers that it was closed unanswered; a denial without a cancel still reads "denied by the user"
 *   CE-5 tomAi_exitPlanMode: a plan closed by the ended prompt answers promptEnded with the note, plan mode stays on;
 *        the chat panel's plan registers its cancel with the owner and unregisters when decided
 *   CE-6 tomAi_askCopilot stops polling and tomAi_askBigBrother stops its request on the owner's cancel (reason
 *        prompt-ended); a plain timeout still says timeout; the executors register with the owner
 *   CE-7 the direct transport through the real handler (a stub client): a turn blocked in tomAi_askUser ends within
 *        a second of the cancel, its question closes, no further model round is sent, and nothing more happens after
 *        it ended; the Agent SDK path is the same owner (sendMessage hands it the token)
 */

/* eslint-disable @typescript-eslint/naming-convention -- the API's wire fields */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261113_vscimpb78_cancel-')));
const stub = installVscodeStub({ workspaceFolders: [base] });

// The tool registry first: the handler is one of its members, and loading it alone hits the cycle.
import '../../tools/tool-executors.js';
import { AnthropicHandler } from '../anthropic-handler.js';
import { ASK_USER_LIVE_TOOL, openQuestionIds } from '../askUser-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { askOwnerEnded, registerAskCancel, runAsAskOwner } from '../../services/askOwners.js';
import { userInteractions } from '../../services/userInteractions.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { PROMPT_ENDED_TOOL_RESULT, raceCancellation } from '../../utils/cancelRace.js';
import { exitPlanModeImpl, enterPlanModeImpl, isPlanModeActive, PLAN_PROMPT_ENDED_NOTE, registerPlanDecider, resetPlanModeForTests } from '../../tools/planning-tools.js';
import { askCopilotImpl, type AskCopilotDeps } from '../../tools/ask-copilot-tool.js';
import { askBigBrotherImpl, type CancelSignal, type LanguageModelBridge } from '../../tools/ask-big-brother-tool.js';
import type { SharedToolDefinition } from '../../tools/shared-tool-registry.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);
setExtensionPath(EXT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CTS = (stub.stub as any).CancellationTokenSource as new () => { token: Json; cancel(): void };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const src = (...p: string[]) => fs.readFileSync(path.join(EXT, 'src', ...p), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = AnthropicHandler.instance as any;

const never = (name: string, readOnly = true): SharedToolDefinition => ({
    name, description: name, readOnly, inputSchema: { type: 'object', properties: {} },
    execute: () => new Promise<string>(() => undefined),
}) as unknown as SharedToolDefinition;
const runTool = (transport: string, tool: SharedToolDefinition, token: Json, mode = 'never', id = 'tu-1'): Promise<{ content: string; is_error?: boolean }> =>
    handler.runTool(
        { type: 'tool_use', id, name: tool.name, input: {} },
        [tool],
        { id: 'cfg', name: 'cfg', model: 'm', maxTokens: 100, maxRounds: 3, transport },
        { profile: { id: 'p', toolApprovalMode: mode }, cancellationToken: token },
        1, 'test_quest', 'win', 'req-1', null,
    );

describe('a cancelled send ends the tool call it is blocked in', () => {
    test('CE-1: the owner with the send\'s token', async () => {
        const cts = new CTS();
        const ran: string[] = [];
        let afterCancel: Promise<void> | undefined;
        let release: () => void = () => undefined;
        const send = runAsAskOwner(async () => {
            registerAskCancel(() => ran.push('question'));
            const unregister = registerAskCancel(() => ran.push('answered'));
            unregister();
            assert.equal(askOwnerEnded(), false);
            await new Promise<void>((r) => { release = r; });
            assert.equal(askOwnerEnded(), true, 'the send knows it was cancelled');
            afterCancel = new Promise<void>((r) => { registerAskCancel(() => { ran.push('late'); r(); }); });
            await afterCancel;
        }, cts.token);
        await tick();
        cts.cancel();
        assert.deepEqual(ran, ['question'], 'run when the token fires, while the send still runs');
        release();
        await send;
        assert.deepEqual(ran, ['question', 'late'], 'a wait registered after the cancel ends right away, once');
        cts.cancel();
        assert.deepEqual(ran, ['question', 'late'], 'nothing twice; the listener is gone');
        // Without a token: at the end only (as before).
        const plain: string[] = [];
        await runAsAskOwner(async () => { registerAskCancel(() => plain.push('end')); assert.deepEqual(plain, []); });
        assert.deepEqual(plain, ['end']);
    });

    test('CE-2: the race', async () => {
        const cts = new CTS();
        const pending = raceCancellation(new Promise<string>(() => undefined), cts.token);
        await tick();
        cts.cancel();
        assert.deepEqual(await pending, { cancelled: true });
        assert.deepEqual(await raceCancellation(Promise.resolve(7), cts.token), { cancelled: true }, 'already cancelled');
        assert.deepEqual(await raceCancellation(Promise.resolve(7)), { cancelled: false, value: 7 });
        const live = new CTS();
        await assert.rejects(raceCancellation(Promise.reject(new Error('boom')), live.token), /boom/);
        let rejectLater: (e: Error) => void = () => undefined;
        const late = raceCancellation(new Promise<string>((_, reject) => { rejectLater = reject; }), live.token);
        live.cancel();
        assert.deepEqual(await late, { cancelled: true });
        rejectLater(new Error('after the cancel'));
        await tick();
    });

    for (const transport of ['direct', 'localLlm', 'vscodeLm']) {
        test(`CE-3: runTool on ${transport}`, async () => {
            const cts = new CTS();
            const started = Date.now();
            const call = runTool(transport, never('tomAi_slowTool'), cts.token);
            await tick(50);
            cts.cancel();
            const result = await call;
            assert.ok(Date.now() - started < 1000, 'within a second');
            assert.equal(result.is_error, true);
            assert.equal(result.content, PROMPT_ENDED_TOOL_RESULT);
            let ran = false;
            const tool = { ...never('tomAi_next'), execute: async () => { ran = true; return 'ran'; } } as unknown as SharedToolDefinition;
            const next = await runTool(transport, tool, cts.token, 'never', 'tu-2');
            assert.equal(next.content, PROMPT_ENDED_TOOL_RESULT);
            assert.equal(ran, false, 'a call of a cancelled send does not run');
        });
    }

    test('CE-4: the tool approval', async () => {
        const cts = new CTS();
        const writer = { ...never('tomAi_writeSomething', false), execute: async () => 'written' } as unknown as SharedToolDefinition;
        const result = await runAsAskOwner(async () => {
            const call = runTool('direct', writer, cts.token, 'always', 'tu-ap');
            await tick(20);
            assert.equal(handler.pendingApprovals.has('tu-ap'), true, 'the approval waits');
            assert.ok(userInteractions.list().some((i: Json) => i.id === 'tu-ap'), 'in the user-input panel');
            cts.cancel();
            return call;
        }, cts.token);
        assert.equal(result.is_error, true);
        assert.match(result.content, /^cancelled: the prompt was ended: the approval of "tomAi_writeSomething" was closed unanswered\.$/);
        assert.equal(handler.pendingApprovals.has('tu-ap'), false, 'closed');
        assert.ok(!userInteractions.list().some((i: Json) => i.id === 'tu-ap'), 'gone from the panel');
        // A denial without a cancel still reads as the user's.
        const live = new CTS();
        const denied = runTool('direct', writer, live.token, 'always', 'tu-deny');
        await tick(20);
        handler.handleApprovalResponse('tu-deny', false);
        assert.match((await denied).content, /was denied by the user/);
        assert.match(src('handlers', 'anthropic-handler.ts'), /const unregisterOwner = registerAskCancel\(\(\) => \{\s*if \(!this\.pendingApprovals\.has\(req\.toolUseId\)\) \{ return; \}/);
    });

    test('CE-5: tomAi_exitPlanMode', async () => {
        resetPlanModeForTests();
        await enterPlanModeImpl({ reason: 'test' });
        registerPlanDecider(async () => ({ accepted: false, promptEnded: true }));
        const answer = JSON.parse(await exitPlanModeImpl({ plan: '1. do it' }));
        assert.equal(answer.accepted, false);
        assert.equal(answer.promptEnded, true);
        assert.equal(answer.note, PLAN_PROMPT_ENDED_NOTE);
        assert.equal(isPlanModeActive(), true, 'plan mode stays on');
        resetPlanModeForTests();
        const chat = src('handlers', 'chatPanel-handler.ts');
        assert.match(chat, /unregisterOwner = registerAskCancel\(\(\) => settle\(\{ accepted: false, promptEnded: true \}\)\);/);
        assert.match(chat, /settled = true;\s*this\._planProposals\.delete\(id\);\s*unregisterOwner\(\);\s*remove\(\);/);
    });

    test('CE-6: askCopilot and askBigBrother', async () => {
        let ended = false;
        let reads = 0;
        let t = 0;
        const deps: AskCopilotDeps = {
            config: () => ({ enabled: true, answerFileTimeoutMs: 60_000, pollIntervalMs: 100, selectedTemplateId: '__none__', selectedTemplateBody: undefined, answerFileTemplate: '${originalPrompt}' }) as never,
            opener: { open: async () => undefined },
            newRequestId: () => 'r1',
            sinkFor: () => ({ absolutePath: () => '/ws/answer.json', clear: () => undefined, read: () => { reads++; if (reads === 3) { ended = true; } return null; } }),
            expander: { expand: async (tpl: string) => tpl } as never,
            clock: { now: () => t, sleep: async (ms: number) => { t += ms; } },
            promptEnded: () => ended,
        };
        const copilot = JSON.parse(await askCopilotImpl(deps, { prompt: 'hi' }));
        assert.equal(copilot.ok, false);
        assert.equal(copilot.reason, 'prompt-ended');
        assert.equal(copilot.cancelled, true);
        assert.equal(reads, 3, 'no poll after the cancel');
        assert.ok(t < 1000, 'long before the 60-s timeout');

        const signal: CancelSignal = { cancelled: false };
        const bridge: LanguageModelBridge = {
            listAllModels: async () => [],
            selectModels: async () => [{ id: 'm1', name: 'M1', family: 'f', vendor: 'v' }] as never,
            listAvailableTools: () => [],
            sendRequest: async () => { signal.reason = 'prompt-ended'; signal.cancelled = true; return [{ kind: 'text', text: 'partial' }]; },
            invokeTool: async () => '',
            summarise: async (s: string) => s,
            getConfig: () => ({ enabled: true, defaultModel: 'm1', enableToolsByDefault: false, maxIterations: 3, responseTimeoutMs: 1000, summarisation: { enabled: false, thresholdChars: 1 }, modelRecommendations: '' }),
        };
        const bb = JSON.parse(await askBigBrotherImpl(bridge, { operation: 'query', prompt: 'hi', modelId: 'm1' }, signal));
        assert.equal(bb.reason, 'prompt-ended');
        assert.match(bb.error, /^cancelled: the prompt was ended/);
        const timeoutSignal: CancelSignal = { cancelled: false };
        const timedOut = JSON.parse(await askBigBrotherImpl({ ...bridge, sendRequest: async () => { timeoutSignal.cancelled = true; return []; } }, { operation: 'query', prompt: 'hi', modelId: 'm1' }, timeoutSignal));
        assert.equal(timedOut.reason, 'timeout');
        const executors = src('tools', 'tool-executors.ts');
        assert.match(executors, /const unregisterOwner = registerAskCancel\(\(\) => \{ signal\.reason = 'prompt-ended'; signal\.cancelled = true; \}\);/);
        assert.match(executors, /const unregisterOwner = registerAskCancel\(\(\) => \{ promptEnded = true; \}\);/);
    });

    test('CE-7: the direct transport through the real handler', async () => {
        const requests: Json[] = [];
        const savedClient = handler.getClient;
        handler.getClient = () => ({
            messages: {
                stream: (params: Json) => ({
                    finalMessage: async () => {
                        requests.push(params.messages.length);
                        return requests.length === 1
                            ? { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'tu-ask', name: 'tomAi_askUser', input: { questions: ['Which one?'] } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
                            : { id: 'm2', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'went on' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
                    },
                }),
            },
        });
        try {
            const cts = new CTS();
            const send = AnthropicHandler.instance.sendMessage({
                userText: 'ask me',
                profile: { id: 'p', name: 'p', systemPrompt: 'Base.', toolApprovalMode: 'never' },
                configuration: { id: 'd', name: 'd', model: 'claude-test', maxTokens: 100, maxRounds: 6, transport: 'direct' },
                tools: [ASK_USER_LIVE_TOOL],
                isolated: true,
                source: 'queue',
                cancellationToken: cts.token,
            } as never);
            for (let i = 0; i < 100 && !AskUserRegistry.instance.hasPending(); i++) { await tick(10); }
            assert.equal(AskUserRegistry.instance.hasPending(), true, 'the turn is blocked in tomAi_askUser');
            assert.equal(openQuestionIds().length, 1);
            const cancelledAt = Date.now();
            cts.cancel();
            const result = await send;
            assert.ok(Date.now() - cancelledAt < 1000, 'the turn ends within a second');
            assert.equal(AskUserRegistry.instance.hasPending(), false, 'its question is closed');
            assert.deepEqual(openQuestionIds(), []);
            assert.equal(requests.length, 1, 'no further model round');
            assert.notEqual(result.text, 'went on');
            await tick(200);
            assert.equal(requests.length, 1, 'nothing more after it ended');
        } finally {
            handler.getClient = savedClient;
        }
        assert.match(src('handlers', 'anthropic-handler.ts'), /return await runAsAskOwner\(\(\) => runAsCommandOwner\(randomUUID\(\), \(\) => this\.sendMessageOwned\(options\)\), options\.cancellationToken\);/);
        fs.rmSync(base, { recursive: true, force: true });
    });
});
