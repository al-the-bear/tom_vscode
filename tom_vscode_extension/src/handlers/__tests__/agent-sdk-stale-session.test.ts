/**
 * A resumed session Claude Code has no conversation for ("No conversation found
 * with session ID: <id>"): recovered automatically (agent-sdk-transport.ts
 * runAgentSdkQuery, services/agentSdkSessionStore.ts forgetSessionId).
 *
 *   SS-1 a resume that fails so: the caller is told the id (onStaleSession), the query is sent again on a fresh
 *        session (no `resume`) with the original prompt, and its answer comes back — also with no retry configured;
 *        the live trail says what happened
 *   SS-2 once only: a fresh attempt failing the same way is not recovered again (no loop)
 *   SS-3 nothing to recover without a resume: the error is thrown as it is
 *   SS-4 the store forgets the id wherever a session holds it (its own conversation, an iteration's); the other
 *        sessions keep theirs
 *   SS-5 the wording is a session-unusable error (isUnknownSessionError)
 *   SS-6 the handler passes onStaleSession on the SDK-managed path, forgetting the id in the quest's sessions folder
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-stale-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { runAgentSdkQuery, __setAgentSdkForTests, type AgentSdkSendParams } from '../agent-sdk-transport.js';
import { ToolTrail } from '../../services/tool-trail.js';
import { TrailService } from '../../services/trailService.js';
import { forgetSessionId, readSession, saveSessionId } from '../../services/agentSdkSessionStore.js';
import { isUnknownSessionError } from '../../services/agent-sdk-retry.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

/* eslint-disable @typescript-eslint/naming-convention -- SDK wire messages are snake_case */

const STALE = 'c7337ba5-de98-4ebd-a62c-c546413b3e42';
const NOT_FOUND = `No conversation found with session ID: ${STALE}`;

/** One scripted attempt: its messages, then (optionally) the error it ends with. */
interface Attempt { messages: unknown[]; error?: Error }

function fakeSdk(attempts: Attempt[]) {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const sdk = {
        tool: () => ({}),
        createSdkMcpServer: () => ({}),
        query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
            calls.push({ options: args.options });
            const script = attempts[Math.min(calls.length - 1, attempts.length - 1)];
            return (async function* () {
                for (const m of script.messages) { yield m; }
                if (script.error) { throw script.error; }
            })();
        },
    };
    return { sdk, calls };
}

const answered: Attempt = {
    messages: [
        { type: 'system', subtype: 'init', session_id: 'fresh-1' },
        { type: 'assistant', session_id: 'fresh-1', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success', session_id: 'fresh-1', result: 'done', num_turns: 1 },
    ],
};
const notFound: Attempt = { messages: [], error: new Error(NOT_FOUND) };

function params(opts: { resume?: string; retry?: boolean; stale: string[]; retries: string[] }): AgentSdkSendParams {
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
        ...(opts.resume ? { resumeSessionId: opts.resume } : {}),
        onStaleSession: (sid) => { opts.stale.push(sid); },
        liveTrail: {
            appendThinking: () => undefined,
            appendAssistantText: () => undefined,
            beginToolCall: () => undefined,
            appendToolResult: () => undefined,
            appendRetry: (message) => { opts.retries.push(message); },
            appendNotice: () => undefined,
            appendUsage: () => undefined,
        },
        ...(opts.retry ? { retry: { maxAttempts: 3, buildContinuationPrompt: (e: string) => `continue after: ${e}` } } : {}),
    };
}

describe('a resumed session that no longer exists', () => {
    for (const retry of [false, true]) {
        test(`SS-1: recovered on a fresh session (${retry ? 'with' : 'without'} retries configured)`, async () => {
            const { sdk, calls } = fakeSdk([notFound, answered]);
            __setAgentSdkForTests(sdk as never);
            const stale: string[] = [];
            const retries: string[] = [];
            const result = await runAgentSdkQuery(params({ resume: STALE, retry, stale, retries }));
            assert.equal(result.text, 'done');
            assert.deepEqual(stale, [STALE], 'the caller forgets the id');
            assert.equal(calls.length, 2);
            assert.equal(calls[0].options.resume, STALE);
            assert.equal(calls[1].options.resume, undefined, 'a fresh session');
            assert.equal(retries.length, 1);
            assert.match(retries[0], /no longer exists in Claude Code — starting a new session/);
        });
    }

    test('SS-2: once only', async () => {
        const { sdk, calls } = fakeSdk([notFound, notFound]);
        __setAgentSdkForTests(sdk as never);
        const stale: string[] = [];
        await assert.rejects(runAgentSdkQuery(params({ resume: STALE, stale, retries: [] })), /No conversation found/);
        assert.equal(calls.length, 2, 'the fresh attempt is not recovered again');
        assert.deepEqual(stale, [STALE]);
    });

    test('SS-3: nothing to recover without a resume', async () => {
        const { sdk, calls } = fakeSdk([notFound, answered]);
        __setAgentSdkForTests(sdk as never);
        const stale: string[] = [];
        await assert.rejects(runAgentSdkQuery(params({ stale, retries: [] })), /No conversation found/);
        assert.equal(calls.length, 1);
        assert.deepEqual(stale, []);
    });

    test('SS-4: the store forgets the id', () => {
        const folder = fs.mkdtempSync(path.join(tmpRoot, 'sessions-'));
        saveSessionId(folder, 'default', STALE, 'claude-test');
        saveSessionId(folder, 'walk', STALE, undefined, 'iteration-1');
        saveSessionId(folder, 'chat', 'alive-1');
        assert.deepEqual(forgetSessionId(folder, STALE).sort(), ['default', 'walk']);
        assert.equal(readSession(folder, 'default')?.sessionId, undefined);
        assert.equal(readSession(folder, 'walk')?.iteration, undefined);
        assert.equal(readSession(folder, 'chat')?.sessionId, 'alive-1', 'another conversation is kept');
        assert.deepEqual(forgetSessionId(folder, 'unknown'), []);
    });

    test('SS-5: the wording', () => {
        assert.equal(isUnknownSessionError(`Agent SDK failed: error_during_execution — ${NOT_FOUND} (Claude Code returned an error result: ${NOT_FOUND})`), true);
        assert.equal(isUnknownSessionError('overloaded'), false);
    });

    test('SS-6: the handler forgets the id where it is stored', () => {
        const handler = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        assert.match(handler, /useSdkManagedContinuity \? \{\s*onStaleSession: \(sid: string\) => \{\s*const reset = forgetSessionId\(TwoTierMemoryService\.instance\.agentSdkSessionsFolder\(quest\), sid\);/);
    });
});
