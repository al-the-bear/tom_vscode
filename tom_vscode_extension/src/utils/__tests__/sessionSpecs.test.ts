/**
 * Session specs, session profiles and queue iteration keys (src/utils/sessionSpecs.ts,
 * src/utils/queueIterations.ts).
 *
 *   SP-1 a session is a name or a spec {name, basedOn?, mode?, profile?}: lifetimes need no base,
 *        fork-from-base reads as per-prompt; a malformed spec is refused with the reason
 *   SP-2 a profile is looked up by its exact id; its model is its configuration's; its conversation is
 *        an Agent SDK session (history mode sdk-managed, stated or the Agent SDK default) or our own
 *        history (every other)
 *   SP-3 the profile a prompt runs with: item -> session -> queue default
 *   SP-4 a conversation can only be continued by a profile of its kind: an SDK session id is the SDK's,
 *        a session's own history files are ours; a session without one takes any profile
 *   QI-1 iteration keys: the main prompt starts iteration n+1, a pre-prompt runs in the iteration it
 *        precedes, a follow-up in the one it follows; another run, other keys
 *   QI-2 a failed main send is rolled back to the same iteration; a reset starts a new run
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    conversationKindOf,
    effectiveProfileId,
    lookupProfile,
    parseSessionSpec,
    specExtras,
    transportMismatch,
    type ProfileSection,
} from '../sessionSpecs.js';
import { ensureRunId, iterationKeyFor } from '../queueIterations.js';
import { rollbackInFlightRepetition } from '../queueRetryTransitions.js';
import { resetItemRunState } from '../queueSendNow.js';

const SECTION: ProfileSection = {
    profiles: [
        { id: 'opus-direct', configurationId: 'opus-5-5-direct' },
        { id: 'opus-sdk', configurationId: 'opus-5-5-agent' },
        { id: 'opus-ts', configurationId: 'opus-5-5-agent-ts' },
        { id: 'sdk-default', configurationId: 'agent-no-mode' },
        { id: 'local', configurationId: 'bomber-gemma' },
    ],
    configurations: [
        { id: 'opus-5-5-direct', model: 'claude-opus-5-5', transport: 'direct', historyMode: 'trim_and_summary' },
        { id: 'opus-5-5-agent', model: 'claude-opus-5-5', transport: 'agentSdk', historyMode: 'sdk-managed' },
        { id: 'opus-5-5-agent-ts', model: 'claude-opus-5-5', transport: 'agentSdk', historyMode: 'trim_and_summary' },
        { id: 'agent-no-mode', model: 'claude-haiku-5-5', transport: 'agentSdk' },
    ],
};

describe('session specs', () => {
    test('SP-1: names and specs', () => {
        assert.deepEqual(parseSessionSpec(' prep '), { ok: true, spec: { name: 'prep' } });
        assert.deepEqual(parseSessionSpec({ name: 'walk', basedOn: 'prep', mode: 'per-iteration', profile: 'opus-direct' }),
            { ok: true, spec: { name: 'walk', basedOn: 'prep', mode: 'per-iteration', profile: 'opus-direct' } });
        assert.deepEqual(parseSessionSpec({ name: 'todo', basedOn: 'prep', mode: 'fork-from-base' }),
            { ok: true, spec: { name: 'todo', basedOn: 'prep', mode: 'per-prompt' } }, 'the old name');
        assert.deepEqual(parseSessionSpec({ name: 'solo', mode: 'per-prompt' }), { ok: true, spec: { name: 'solo', mode: 'per-prompt' } },
            'no base needed');
        assert.deepEqual(parseSessionSpec({ name: 'x', basedOn: '', mode: '', profile: '' }), { ok: true, spec: { name: 'x' } }, 'empty = unset');
        const refused: Array<[unknown, RegExp]> = [
            ['bad name', /letters, digits/],
            [{ basedOn: 'prep' }, /name is required/],
            [{ name: 'x', basedOn: 'no good' }, /basedOn must be a session name/],
            [{ name: 'x', basedOn: 'x' }, /based on itself/],
            [{ name: 'x', mode: 'sometimes' }, /not continue, per-prompt or per-iteration/],
            [{ name: 'x', profile: 3 }, /profile must be a profile id/],
            [{ name: 'x', model: 'y' }, /unknown key\(s\) model/],
            [['x'], /a name or/],
            [42, /a name or/],
        ];
        for (const [raw, why] of refused) {
            const r = parseSessionSpec(raw);
            assert.equal(r.ok, false, JSON.stringify(raw));
            assert.match((r as { error: string }).error, why);
        }
        assert.equal(specExtras({ name: 'a' }), undefined);
        assert.deepEqual(specExtras({ name: 'a', mode: 'per-prompt' }), { mode: 'per-prompt' });
    });

    test('SP-2: profiles', () => {
        assert.deepEqual(lookupProfile(SECTION, 'opus-direct'), { id: 'opus-direct', model: 'claude-opus-5-5', continuity: 'history' });
        assert.deepEqual(lookupProfile(SECTION, 'opus-sdk'), { id: 'opus-sdk', model: 'claude-opus-5-5', continuity: 'sdk' });
        assert.deepEqual(lookupProfile(SECTION, 'opus-ts'), { id: 'opus-ts', model: 'claude-opus-5-5', continuity: 'history' },
            'Agent SDK with our own history');
        assert.equal(lookupProfile(SECTION, 'sdk-default')?.continuity, 'sdk', 'the Agent SDK default history mode');
        assert.deepEqual(lookupProfile(SECTION, 'local'), { id: 'local', continuity: 'history' }, 'a Local LLM configuration: no model here');
        assert.equal(lookupProfile(SECTION, 'nope'), undefined, 'no fallback to the default profile');
        assert.equal(lookupProfile(SECTION, undefined), undefined);
        assert.equal(lookupProfile(undefined, 'opus-direct'), undefined);
    });

    test('SP-3: item -> session -> queue default', () => {
        assert.equal(effectiveProfileId('item', 'session', 'queue'), 'item');
        assert.equal(effectiveProfileId(undefined, 'session', 'queue'), 'session');
        assert.equal(effectiveProfileId('', undefined, 'queue'), 'queue');
        assert.equal(effectiveProfileId(undefined, undefined, undefined), undefined);
    });

    test('SP-4: a conversation and the profile continuing it', () => {
        assert.equal(conversationKindOf({ name: 'a', mode: 'continue', sessionId: 'S' }, false), 'sdk');
        assert.equal(conversationKindOf({ name: 'a', mode: 'per-iteration', iteration: { key: 'k', sessionId: 'S' } }, false), 'sdk');
        assert.equal(conversationKindOf({ name: 'a', mode: 'continue' }, true), 'history');
        assert.equal(conversationKindOf({ name: 'a', mode: 'continue' }, false), undefined);
        assert.equal(conversationKindOf(undefined, false), undefined);
        const direct = lookupProfile(SECTION, 'opus-direct');
        const sdk = lookupProfile(SECTION, 'opus-sdk');
        assert.match(transportMismatch('walk', 'sdk', direct) ?? '', /Session "walk" has a conversation in an Agent SDK session.*"opus-direct"/);
        assert.match(transportMismatch('walk', 'history', sdk) ?? '', /our own history files.*cannot continue it/);
        assert.equal(transportMismatch('walk', 'sdk', sdk), undefined);
        assert.equal(transportMismatch('walk', 'history', direct), undefined);
        assert.equal(transportMismatch('walk', undefined, sdk), undefined, 'no conversation yet: any profile');
        assert.equal(transportMismatch('walk', 'sdk', undefined), undefined, 'no profile known: not refused here');
    });
});

describe('queue iteration keys', () => {
    test('QI-1: which iteration a prompt belongs to', () => {
        const item = { id: 'q1', runId: 'r1', iterationSeq: 0 };
        assert.equal(iterationKeyFor(item, 'prePrompt'), 'q1/r1/1', 'a pre-prompt runs in the first iteration');
        assert.equal(iterationKeyFor(item, 'main'), 'q1/r1/1', 'the same one the first main prompt starts');
        item.iterationSeq = 1;
        assert.equal(iterationKeyFor(item, 'main'), 'q1/r1/2', 'the next round or todo: the next iteration');
        item.iterationSeq = 3;
        assert.equal(iterationKeyFor(item, 'followUp'), 'q1/r1/3', 'a follow-up runs in the last iteration');
        assert.equal(iterationKeyFor({ id: 'q2' }, 'followUp'), 'q2/run/1', 'follow-ups without a main prompt: iteration 1');
        assert.notEqual(iterationKeyFor({ id: 'q1', runId: 'r2', iterationSeq: 0 }, 'main'), 'q1/r1/1', 'another run, another key');
        const fresh: { id: string; runId?: string } = { id: 'q3' };
        assert.equal(ensureRunId(fresh, () => 'abc'), 'abc');
        assert.equal(ensureRunId(fresh, () => 'other'), 'abc', 'kept while the run lasts');
    });

    test('QI-2: rollback and reset', () => {
        const item = {
            id: 'q1', runId: 'r1', iterationSeq: 3, repeatIndex: 3,
            inFlightRepetition: { stage: 'main' as const, prevRepeatIndex: 2, prevIterationSeq: 2 },
        };
        rollbackInFlightRepetition(item);
        assert.deepEqual([item.repeatIndex, item.iterationSeq], [2, 2]);
        assert.equal(iterationKeyFor(item, 'main'), 'q1/r1/3', 'the re-send runs in the iteration that failed');
        const sent: { id: string; runId?: string; iterationSeq?: number } = { id: 'q1', runId: 'r1', iterationSeq: 4 };
        resetItemRunState(sent);
        assert.deepEqual([sent.runId, sent.iterationSeq], [undefined, 0], 'Send Now on a sent item: a new run');
    });
});
