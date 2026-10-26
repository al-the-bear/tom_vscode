/**
 * Named Agent SDK sessions (src/utils/agentSdkSessions.ts): what a session
 * file holds and how a prompt starts in it.
 *
 *   SN-1  names: letters, digits, `_` and `-`, starting with a letter or digit
 *   SN-2  reading a session file: the legacy `{sessionId, updatedAt, model}` shape is a `continue`
 *         session; `basedOn` and `mode` are kept; anything unreadable is no record
 *   SN-3  a continue session resumes its own id; without one it forks its base once (and keeps the
 *         fork as its own); without either it starts fresh — and in every case its id is saved
 *   SN-4  a per-prompt session (legacy name fork-from-base) forks its base's current id for every
 *         prompt and never saves an id of its own; a base that is itself per-prompt resolves to the base
 *         below; a base with no id yet starts fresh, unsaved; without a base every prompt starts fresh,
 *         unsaved; a cycle is refused
 *   SN-5  a retry forks only when it resumes the original base id, never the fork it produced
 *   SN-6  the picker list: sessions sorted, each described by its lifetime, base and model
 *   SN-7  a per-iteration session: a new iteration key starts fresh (or forks the base) and saves the
 *         id as that iteration's; the same key resumes it; no key behaves per prompt; as a base it has
 *         no lasting conversation
 *   SN-8  the profile and the iteration are read from the file; the modes normalise
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    SESSION_NAME_PATTERN,
    describeSession,
    isValidSessionName,
    normalizeSessionMode,
    parseSessionRecord,
    planSessionStart,
    shouldForkAttempt,
    sortSessions,
    type SessionRecord,
} from '../agentSdkSessions.js';

const store = (records: SessionRecord[]) => (name: string): SessionRecord | undefined => records.find((r) => r.name === name);

describe('Agent SDK sessions', () => {
    test('SN-1: names', () => {
        for (const ok of ['chat', 'default', 'prep-1', 'p2s2_ss3', '7up']) { assert.ok(isValidSessionName(ok), ok); }
        for (const bad of ['', '-x', 'a b', 'a/b', '../x', 'x.session']) { assert.ok(!isValidSessionName(bad), bad); }
        assert.ok(SESSION_NAME_PATTERN.test('abc'));
    });

    test('SN-2: reading a session file', () => {
        assert.deepEqual(parseSessionRecord('chat', { sessionId: 'abc', updatedAt: 't', model: 'm' }),
            { name: 'chat', sessionId: 'abc', mode: 'continue', updatedAt: 't', model: 'm' });
        assert.deepEqual(parseSessionRecord('step', { basedOn: 'prep', mode: 'fork-from-base', createdAt: 'c' }),
            { name: 'step', mode: 'per-prompt', basedOn: 'prep', createdAt: 'c' }, 'the legacy name reads as per-prompt');
        assert.equal(parseSessionRecord('x', null), undefined);
        assert.equal(parseSessionRecord('x', 'text'), undefined);
        assert.equal(parseSessionRecord('x', { mode: 'weird' })?.mode, 'continue', 'an unknown mode reads as continue');
    });

    test('SN-3: a continue session', () => {
        const read = store([
            { name: 'own', mode: 'continue', sessionId: 'S-own' },
            { name: 'prep', mode: 'continue', sessionId: 'S-prep' },
            { name: 'child', mode: 'continue', basedOn: 'prep' },
            { name: 'empty', mode: 'continue' },
        ]);
        assert.deepEqual(planSessionStart('own', read), { resume: 'S-own', fork: false, persist: true });
        assert.deepEqual(planSessionStart('child', read), { resume: 'S-prep', fork: true, persist: true },
            'its first prompt forks the base; the fork becomes its own session');
        assert.deepEqual(planSessionStart('empty', read), { fork: false, persist: true });
        assert.deepEqual(planSessionStart('missing', read), { fork: false, persist: true }, 'no file: a new session, as before');
    });

    test('SN-4: a per-prompt session', () => {
        const read = store([
            { name: 'prep', mode: 'continue', sessionId: 'S-prep' },
            { name: 'per-prompt', mode: 'per-prompt', basedOn: 'prep', sessionId: 'S-stale' },
            { name: 'chain', mode: 'per-prompt', basedOn: 'per-prompt' },
            { name: 'unprepared', mode: 'per-prompt', basedOn: 'empty' },
            { name: 'empty', mode: 'continue' },
            { name: 'loop-a', mode: 'per-prompt', basedOn: 'loop-b' },
            { name: 'loop-b', mode: 'per-prompt', basedOn: 'loop-a' },
            { name: 'orphan', mode: 'per-prompt' },
        ]);
        assert.deepEqual(planSessionStart('per-prompt', read), { resume: 'S-prep', fork: true, persist: false },
            'every prompt forks the base; its own id (if any) is ignored');
        assert.deepEqual(planSessionStart('chain', read), { resume: 'S-prep', fork: true, persist: false });
        const unprepared = planSessionStart('unprepared', read);
        assert.deepEqual([unprepared.resume, unprepared.fork, unprepared.persist], [undefined, false, false]);
        assert.match(unprepared.note ?? '', /empty/);
        assert.throws(() => planSessionStart('loop-a', read), /cycle/);
        assert.deepEqual(planSessionStart('orphan', read), { fork: false, persist: false }, 'no base: every prompt starts fresh, unsaved');
    });

    test('SN-5: a retry forks only from the original base', () => {
        assert.equal(shouldForkAttempt(true, 'S-base', 'S-base'), true);
        assert.equal(shouldForkAttempt(true, 'S-base', 'S-fork'), false, 'resuming the fork it produced');
        assert.equal(shouldForkAttempt(true, 'S-base', undefined), false, 'a fresh retry');
        assert.equal(shouldForkAttempt(false, 'S-base', 'S-base'), false);
    });

    test('SN-6: the picker list', () => {
        const list = sortSessions([
            { name: 'zeta', mode: 'continue' },
            { name: 'chat', mode: 'continue', sessionId: 'x' },
            { name: 'per-prompt', mode: 'per-prompt', basedOn: 'prep' },
        ]);
        assert.deepEqual(list.map((r) => r.name), ['chat', 'per-prompt', 'zeta']);
        assert.equal(describeSession(list[1]), 'fresh from "prep" for every prompt');
        assert.equal(describeSession({ name: 'c', mode: 'continue', basedOn: 'prep' }), 'continues; started from "prep"');
        assert.equal(describeSession(list[0]), 'continues');
        assert.equal(describeSession(list[2]), 'continues (not started yet)');
        assert.equal(describeSession({ name: 'x', mode: 'per-prompt' }), 'fresh for every prompt');
        assert.equal(describeSession({ name: 'x', mode: 'per-iteration', basedOn: 'prep' }), 'fresh from "prep" for every iteration');
        assert.equal(describeSession({ name: 'x', mode: 'continue', sessionId: 's', profileId: 'opus-5-5-direct', model: 'claude-opus-5-5' }),
            'continues · claude-opus-5-5');
        assert.equal(describeSession({ name: 'x', mode: 'per-prompt', profileId: 'haiku-5-5-direct' }), 'fresh for every prompt · haiku-5-5-direct');
    });

    test('SN-7: a per-iteration session', () => {
        const records: SessionRecord[] = [
            { name: 'prep', mode: 'continue', sessionId: 'S-prep' },
            { name: 'walk', mode: 'per-iteration', basedOn: 'prep', iteration: { key: 'item/run/1', sessionId: 'S-it1' } },
            { name: 'fresh', mode: 'per-iteration' },
            { name: 'on-walk', mode: 'per-prompt', basedOn: 'walk' },
        ];
        const read = store(records);
        assert.deepEqual(planSessionStart('walk', read, 'item/run/1'), { resume: 'S-it1', fork: false, persist: true, iterationKey: 'item/run/1' },
            'the same iteration continues its conversation');
        assert.deepEqual(planSessionStart('walk', read, 'item/run/2'), { resume: 'S-prep', fork: true, persist: true, iterationKey: 'item/run/2' },
            'a new iteration forks the base and keeps the fork as that iteration\'s');
        assert.deepEqual(planSessionStart('fresh', read, 'k'), { fork: false, persist: true, iterationKey: 'k' }, 'no base: a new iteration starts fresh');
        assert.deepEqual(planSessionStart('walk', read), { resume: 'S-prep', fork: true, persist: false }, 'no iteration key: per prompt');
        assert.deepEqual(planSessionStart('on-walk', read), { resume: 'S-prep', fork: true, persist: false },
            'as a base it has no lasting conversation: its own base is used');
    });

    test('SN-8: profile, iteration and modes from the file', () => {
        assert.deepEqual(parseSessionRecord('s', { mode: 'per-iteration', profileId: 'opus-5-5-agent-sdk-mm', model: 'claude-opus-5-5', iteration: { key: 'k', sessionId: 'S' } }),
            { name: 's', mode: 'per-iteration', profileId: 'opus-5-5-agent-sdk-mm', model: 'claude-opus-5-5', iteration: { key: 'k', sessionId: 'S' } });
        assert.equal(parseSessionRecord('s', { iteration: { sessionId: 'S' } })?.iteration, undefined, 'an iteration without a key is dropped');
        assert.equal(normalizeSessionMode('fork-from-base'), 'per-prompt');
        assert.equal(normalizeSessionMode('per-iteration'), 'per-iteration');
        assert.equal(normalizeSessionMode('sometimes'), undefined);
    });
});
