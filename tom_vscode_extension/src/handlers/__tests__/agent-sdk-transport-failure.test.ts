/**
 * The Agent SDK transport's retry loop names the real failure cause.
 *
 * On 2026-10-12 a queued prompt failed three times with nothing but
 * "Claude Code process exited with code 1". The cause, an expired OAuth
 * login, had arrived in the stream as an assistant message with
 * `error: 'authentication_failed'` and was dropped. These tests run the real
 * `runAgentSdkQuery` loop over a fake SDK whose stream yields what the CLI
 * yields and then throws the exit error (TF-*):
 *
 *   TF-1  authentication_failed: the thrown error leads with the cause and
 *         says what to do; one delayed retry, not N immediate ones; the user
 *         is notified once; the retry note names the cause
 *   TF-2  an is_error result: the cause is surfaced; ordinary retries apply
 *   TF-3  an overloaded assistant error keeps the busy retry behaviour and
 *         notifies nobody
 *   TF-4  billing_error gives up at once
 *   TF-5  the CLI's stderr reaches the error, scrubbed of credentials
 *   TF-6  a failure the stream says nothing about is thrown unchanged
 *   TF-7  the live trail's ERROR block names the cause: the handler's
 *         classifier leaves the auth error alone (so it renders as ERROR,
 *         not as an interruption), and the block written from the error's
 *         stack leads with the cause and the advice
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-failure-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { LiveTrailWriter } from '../../services/live-trail.js';
import { classifyAnthropicError } from '../../utils/anthropicErrorClassifier.js';

TrailService.init({} as never);

// The fixtures below are SDK wire messages, whose fields are snake_case.
/* eslint-disable @typescript-eslint/naming-convention */

const EXIT = 'Claude Code process exited with code 1';
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';

/** One scripted attempt: messages to yield, stderr to emit, then the exit error. */
interface ScriptedAttempt {
    messages: unknown[];
    stderr?: string[];
    exitError?: Error;
}

/** A fake SDK whose `query` plays one scripted attempt per call. */
function fakeSdk(attempts: ScriptedAttempt[]) {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const sdk = {
        tool: () => ({}),
        createSdkMcpServer: () => ({}),
        query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
            calls.push(args);
            const script = attempts[Math.min(calls.length - 1, attempts.length - 1)];
            const stderr = args.options.stderr as ((d: string) => void) | undefined;
            return (async function* () {
                for (const line of script.stderr ?? []) { stderr?.(line); }
                for (const m of script.messages) { yield m; }
                throw script.exitError ?? new Error(EXIT);
            })();
        },
    };
    return { sdk, calls };
}

function recorder() {
    const retries: { message: string; cause?: string }[] = [];
    const notices: string[] = [];
    const liveTrail: NonNullable<AgentSdkSendParams['liveTrail']> = {
        appendThinking: () => undefined,
        appendAssistantText: () => undefined,
        beginToolCall: () => undefined,
        appendToolResult: () => undefined,
        appendRetry: (message, cause) => { retries.push({ message, cause }); },
        appendNotice: () => undefined,
        appendUsage: () => undefined,
    };
    return { retries, notices, liveTrail };
}

function params(rec: ReturnType<typeof recorder>, retry: Partial<NonNullable<AgentSdkSendParams['retry']>> = {}): AgentSdkSendParams {
    return {
        configuration: { id: 'cfg', name: 'cfg', model: 'claude-test', maxTokens: 1000, maxRounds: 5 } as AgentSdkSendParams['configuration'],
        tools: [],
        systemPrompt: '',
        userText: 'do the thing',
        context: {
            requestApproval: async () => true,
            sessionApprovals: new Set(),
            toolTrail: new ToolTrail(),
            round: 1,
            questId: 'test_quest',
            windowId: 'win',
            requestId: 'req-1',
        },
        liveTrail: rec.liveTrail,
        onFailureNotice: (message) => { rec.notices.push(message); },
        retry: {
            maxAttempts: 3,
            buildContinuationPrompt: (e) => `continue after: ${e}`,
            authRetryDelayMs: 0,
            ...retry,
        },
    };
}

async function failure(p: AgentSdkSendParams): Promise<Error> {
    try {
        await runAgentSdkQuery(p);
    } catch (e) {
        return e as Error;
    }
    assert.fail('runAgentSdkQuery resolved; expected it to throw');
}

const authAttempt: ScriptedAttempt = {
    messages: [{
        type: 'assistant',
        session_id: 'sess-1',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: OAUTH }] },
    }],
};

describe('runAgentSdkQuery names the failure cause', () => {
    test('TF-1: an expired login gives one delayed retry and an actionable error', async () => {
        const { sdk, calls } = fakeSdk([authAttempt]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec));

        assert.equal(calls.length, 2, 'one first attempt and one auth retry, not three immediate attempts');
        assert.ok(err.message.startsWith(`Agent SDK failed: authentication_failed — ${OAUTH}`), err.message);
        assert.ok(err.message.includes(EXIT), err.message);
        assert.match(err.message, /sign in again/i);
        assert.ok(err.stack?.startsWith(`AgentSdkFailureError: ${err.message}`), 'the ERROR block shows the stack; it must lead with the cause');

        assert.equal(rec.retries.length, 1);
        assert.match(rec.retries[0].cause ?? '', /authentication_failed/);
        assert.equal(rec.notices.length, 1);
        assert.match(rec.notices[0], /authentication_failed/);
        assert.match(rec.notices[0], /sign in again/i);
    });

    test('TF-2: an is_error result is surfaced and retried normally', async () => {
        const { sdk, calls } = fakeSdk([{
            messages: [{ type: 'result', session_id: 'sess-2', subtype: 'error_during_execution', is_error: true, errors: ['Tool runner crashed'], num_turns: 1 }],
        }]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec, { maxAttempts: 2 }));

        assert.equal(calls.length, 2);
        assert.ok(err.message.startsWith('Agent SDK failed: error_during_execution — Tool runner crashed'), err.message);
        assert.equal(rec.notices.length, 0, 'a retryable failure notifies nobody');
    });

    test('TF-3: an overloaded assistant error keeps the busy behaviour', async () => {
        const { sdk, calls } = fakeSdk([{
            messages: [{ type: 'assistant', session_id: 'sess-3', error: 'overloaded', message: { content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } }],
        }]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec, { maxAttempts: 3 }));

        assert.equal(calls.length, 3, 'busy errors use the normal attempt budget');
        assert.match(err.message, /overloaded/);
        assert.equal(rec.notices.length, 0);
    });

    test('TF-4: a billing error gives up at once', async () => {
        const { sdk, calls } = fakeSdk([{
            messages: [{ type: 'assistant', session_id: 'sess-4', error: 'billing_error', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] } }],
        }]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec));

        assert.equal(calls.length, 1);
        assert.equal(rec.retries.length, 0);
        assert.match(err.message, /^Agent SDK failed: billing_error — Credit balance is too low/);
        assert.equal(rec.notices.length, 1);
    });

    test('TF-5: stderr reaches the error, scrubbed of credentials', async () => {
        const secret = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
        const { sdk, calls } = fakeSdk([{
            messages: [],
            stderr: ['starting up\n', `Error: token ${secret} was rejected\n`],
        }]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec, { maxAttempts: 1 }));

        assert.equal(calls.length, 1);
        assert.ok(typeof calls[0].options.stderr === 'function', 'the transport passes a stderr callback');
        assert.ok(err.message.startsWith('Agent SDK failed: Error: token [redacted] was rejected'), err.message);
        assert.ok(!err.message.includes(secret));
        assert.ok(!(err.stack ?? '').includes(secret));
    });

    test('TF-6: a failure the stream says nothing about is thrown unchanged', async () => {
        const original = new Error(EXIT);
        const { sdk } = fakeSdk([{ messages: [], exitError: original }]);
        __setAgentSdkForTests(sdk);
        const rec = recorder();
        const err = await failure(params(rec, { maxAttempts: 1 }));
        assert.equal(err, original);
    });

    test('TF-7: the live trail ERROR block names the cause and what to do', async () => {
        const { sdk } = fakeSdk([authAttempt]);
        __setAgentSdkForTests(sdk);
        const err = await failure(params(recorder(), { maxAttempts: 1 }));

        assert.equal(classifyAnthropicError(err), null, 'an auth failure is an ERROR, not an interruption');
        const writer = new LiveTrailWriter(`q_${Math.random().toString(36).slice(2)}`);
        writer.beginPrompt({ transport: 'agentSdk', config: 'default', userText: 'do the thing' });
        // What closeLiveTrailForThrown passes for an unclassified error.
        writer.endPromptWithError(err.stack || err.message);
        const body = fs.readFileSync(writer.getFilePath(), 'utf-8');
        const block = body.slice(body.lastIndexOf('### ⚠️ ERROR'));
        assert.match(block, /AgentSdkFailureError: Agent SDK failed: authentication_failed — Failed to authenticate: OAuth session expired/);
        assert.match(block, /sign in again/i);
    });
});
