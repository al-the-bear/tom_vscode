/**
 * Named Agent SDK sessions (src/utils/agentSdkSessions.ts): what a session
 * file holds and how a prompt starts in it.
 *
 *   SN-1  names: letters, digits, `_` and `-`, starting with a letter or digit
 *   SN-2  reading a session file: the legacy `{sessionId, updatedAt, model}` shape is a `continue`
 *         session; `basedOn` and `mode` are kept; anything unreadable is no record
 *   SN-3  a continue session resumes its own id; without one it forks its base once (and keeps the
 *         fork as its own); without either it starts fresh — and in every case its id is saved
 *   SN-4  a fork-from-base session forks its base's current id for every prompt and never saves an
 *         id of its own; a base that is itself fork-from-base resolves to the base below; a base with
 *         no id yet starts fresh, unsaved; a cycle is refused
 *   SN-5  a retry forks only when it resumes the original base id, never the fork it produced
 *   SN-6  the picker list: sessions sorted, each described by its mode and base
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    SESSION_NAME_PATTERN,
    describeSession,
    isValidSessionName,
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
            { name: 'step', mode: 'fork-from-base', basedOn: 'prep', createdAt: 'c' });
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

    test('SN-4: a fork-from-base session', () => {
        const read = store([
            { name: 'prep', mode: 'continue', sessionId: 'S-prep' },
            { name: 'per-prompt', mode: 'fork-from-base', basedOn: 'prep', sessionId: 'S-stale' },
            { name: 'chain', mode: 'fork-from-base', basedOn: 'per-prompt' },
            { name: 'unprepared', mode: 'fork-from-base', basedOn: 'empty' },
            { name: 'empty', mode: 'continue' },
            { name: 'loop-a', mode: 'fork-from-base', basedOn: 'loop-b' },
            { name: 'loop-b', mode: 'fork-from-base', basedOn: 'loop-a' },
            { name: 'orphan', mode: 'fork-from-base' },
        ]);
        assert.deepEqual(planSessionStart('per-prompt', read), { resume: 'S-prep', fork: true, persist: false },
            'every prompt forks the base; its own id (if any) is ignored');
        assert.deepEqual(planSessionStart('chain', read), { resume: 'S-prep', fork: true, persist: false });
        const unprepared = planSessionStart('unprepared', read);
        assert.deepEqual([unprepared.resume, unprepared.fork, unprepared.persist], [undefined, false, false]);
        assert.match(unprepared.note ?? '', /empty/);
        assert.throws(() => planSessionStart('loop-a', read), /cycle/);
        assert.throws(() => planSessionStart('orphan', read), /names no base/);
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
            { name: 'per-prompt', mode: 'fork-from-base', basedOn: 'prep' },
        ]);
        assert.deepEqual(list.map((r) => r.name), ['chat', 'per-prompt', 'zeta']);
        assert.equal(describeSession(list[1]), 'fresh from "prep" for every prompt');
        assert.equal(describeSession({ name: 'c', mode: 'continue', basedOn: 'prep' }), 'continues; started from "prep"');
        assert.equal(describeSession(list[0]), 'continues');
        assert.equal(describeSession(list[2]), 'continues (not started yet)');
    });
});
