/**
 * The queue's session wiring (src/managers/promptQueueManager.ts imports vscode, so its source is
 * read, as in queueSendNow.test.ts and directSessionHistory.test.ts).
 *
 *   QW-1 every stage dispatch carries its iteration key: a pre-prompt the iteration it precedes, the main
 *        prompt the next one (counted, and rolled back with the repetition), a follow-up the last; the key
 *        reaches sendMessage and is kept for a resend; the Quest Refresh prompt carries none
 *   QW-2 a missing named session is created in dispatchStage before the send, from the item's spec
 *   QW-3 the profile: stage, item, then the session's, then the queue default
 *   QW-4 a malformed spec or a session the item's profile cannot continue is refused when the item is
 *        queued or its session changes; the spec is written to and read from the entry YAML
 *   QW-5 the handler passes the iteration key to the session plan (Agent SDK) and the history scope
 *        (direct), and saves the SDK id as that iteration's
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** out/utils/__tests__ -> project root is three levels up. */
function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

function body(src: string, signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    return src.slice(start, src.indexOf('\n    }\n', start));
}

describe('queue session wiring', () => {
    const queue = source('src', 'managers', 'promptQueueManager.ts');

    test('QW-1: iteration keys', () => {
        const loop = body(queue, 'private async dispatchNextStageForSendingItem(');
        assert.ok(loop.indexOf('ensureRunId(item') < loop.indexOf('// Stage 1: Pre-prompts'), 'a run id before the first stage');
        const pre = loop.slice(loop.indexOf('// Stage 1: Pre-prompts'), loop.indexOf('// Stage 2: Main prompt'));
        const main = loop.slice(loop.indexOf('// Stage 2: Main prompt'), loop.indexOf('// Stage 3: Follow-ups'));
        const follow = loop.slice(loop.indexOf('// Stage 3: Follow-ups'));
        assert.match(pre, /iterationKey: iterationKeyFor\(item, 'prePrompt'\)/);
        assert.match(main, /iterationKey: iterationKeyFor\(item, 'main'\)/);
        assert.match(follow, /iterationKey: iterationKeyFor\(item, 'followUp'\)/);
        assert.match(main, /item\.iterationSeq = prevIterationSeq \+ 1;/, 'the main prompt counts its iteration');
        assert.match(main, /prevIterationSeq,\n\s*\};/, '… and records it for the rollback');
        for (const stage of [pre, main, follow]) {
            assert.match(stage, /iterationKey: resolved\.iterationKey,/, 'kept in lastDispatched for a resend');
        }
        const dispatch = body(queue, 'private async dispatchStage(');
        assert.match(dispatch, /\.\.\.\(resolved\.iterationKey \? \{ iterationKey: resolved\.iterationKey \} : \{\}\)/);
        assert.match(body(queue, 'async resendLastPrompt('), /iterationKey: last\.iterationKey,/);
        assert.match(queue, /this\.dispatchStage\(refreshText, \{ \.\.\.resolved, iterationKey: undefined \}/, 'no key for the refresh prompt');
    });

    test('QW-2: a missing session is created before the send', () => {
        const dispatch = body(queue, 'private async dispatchStage(');
        const ensure = dispatch.indexOf('this.ensureItemSession(resolved.item, resolved.session)');
        assert.ok(ensure > 0 && ensure < dispatch.indexOf('AnthropicHandler.instance.sendMessage('));
        assert.ok(dispatch.indexOf("resolved.transport === 'copilot'") < ensure, 'only on the Anthropic transport');
        const make = body(queue, 'private ensureItemSession(');
        assert.match(make, /ensureSession\(this\.sessionsFolder\(\), spec, \(id\) => lookupProfile\(section, id\), item\.anthropicProfileId\)/);
        assert.match(make, /sessionName === 'default' \|\| sessionName === 'chat'/, 'the shared sessions are never created here');
    });

    test('QW-3: profile precedence', () => {
        const resolve = body(queue, 'private resolveStageTransport(');
        assert.match(resolve, /stage\.anthropicProfileId \?\? item\.anthropicProfileId \?\? sessionProfile \?\? this\._defaultAnthropicProfileId/);
        assert.match(resolve, /item\.anthropicProfileId \?\? sessionProfile \?\? this\._defaultAnthropicProfileId/);
        assert.match(resolve, /anthropicProfileId: sessionProfile \?\? this\._defaultAnthropicProfileId/);
        assert.match(body(queue, 'private sessionProfileOf('), /readSession\(this\.sessionsFolder\(\), name\)\?\.profileId \?\? create\?\.profile/,
            'the session file\'s profile, else the spec it will be created with');
    });

    test('QW-4: refused when queued; the spec persists', () => {
        const enqueue = body(queue, '    async enqueue(');
        assert.ok(enqueue.indexOf('this.parseItemSession(opts.session)') > 0, 'a malformed spec throws');
        assert.ok(enqueue.indexOf('this.sessionRefusal(item)') < enqueue.indexOf('this._items.push(item)'), 'checked before it joins the queue');
        const update = body(queue, 'updateItemSession(');
        assert.ok(update.indexOf('this.sessionRefusal(next)') < update.indexOf('item.session = next.session'), 'checked before it changes');
        assert.match(body(queue, 'private sessionRefusal('), /sessionTransportMismatch\(this\.sessionsFolder\(\), resolved\.session/);
        assert.match(queue, /\.\.\.readItemSession\(main\.session \?\? main\['agent-sdk-session'\]\)/);
        assert.match(queue, /'run-id': item\.runId/);
        assert.match(queue, /'iteration-seq': item\.iterationSeq/);
    });

    test('QW-5: the handler', () => {
        const handler = source('src', 'handlers', 'anthropic-handler.ts');
        assert.match(handler, /planSessionStartIn\(TwoTierMemoryService\.instance\.agentSdkSessionsFolder\(quest\), sessionKey, options\.iterationKey\)/);
        assert.match(handler, /resolveHistoryScope\(quest, TwoTierMemoryService\.instance\.historyFolder\(quest\), name, iterationKey\)/);
        assert.equal((handler.match(/sessionKey,\n\s*sessionStart\.iterationKey,/g) ?? []).length, 2, 'both SDK id saves name the iteration');
        assert.match(body(handler, 'private seedHistoryFromSnapshot('), /if \(this\.historyScope\?\.fresh\)/, 'a fresh scope loads nothing');
    });
});
