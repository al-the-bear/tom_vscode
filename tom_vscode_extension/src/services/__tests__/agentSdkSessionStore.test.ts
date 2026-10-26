/**
 * The session files in a quest's history folder (src/services/agentSdkSessionStore.ts).
 *
 *   SS-1  list: every `<name>.session.json`, sorted, unreadable files skipped, `.tmp` ignored
 *   SS-2  create: a new session, fresh or based on another, with a lifetime (continue, per-prompt,
 *         per-iteration; fork-from-base reads as per-prompt); refuses a bad name, an existing session,
 *         a missing base, an unknown lifetime; per-prompt and per-iteration need no base
 *   SS-3  saving an id keeps the file's other fields (basedOn, mode, createdAt)
 *   SS-5  clearing a session forgets its conversation; a session with a base keeps its definition
 *   SS-4  the start of a prompt is planned from the files (a session based on another forks its base)
 *   SS-6  a session's profile and its model: stored at creation, taken from the base when the new
 *         session names none, kept by a reset
 *   SS-7  a per-iteration session saves each iteration's conversation under its key
 *   SS-8  ensureSession: a missing session is created from a bare name (fresh, continue) or a spec (its
 *         missing base first, plainly; the spec's profile, else the fallback profile, else the base's);
 *         an existing one is left alone; an unknown spec profile is refused and nothing is created
 *   SS-9  the transport check on files: an SDK conversation refuses a profile with our own history and
 *         the reverse; the shared sessions and sessions without a conversation take any profile
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    clearSessionId,
    createSession,
    ensureSession,
    listSessions,
    planSessionStartIn,
    readSession,
    saveSessionId,
} from '../agentSdkSessionStore.js';
import { sessionTransportMismatch } from '../directSessionHistory.js';
import type { SessionProfile } from '../../utils/sessionSpecs.js';

const folder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));

describe('session files', () => {
    test('SS-1: list', () => {
        const dir = folder();
        fs.writeFileSync(path.join(dir, 'chat.session.json'), JSON.stringify({ sessionId: 'S1', updatedAt: 't', model: 'm' }));
        fs.writeFileSync(path.join(dir, 'b.session.json'), JSON.stringify({ basedOn: 'chat', mode: 'fork-from-base' }));
        fs.writeFileSync(path.join(dir, 'broken.session.json'), '{ not json');
        fs.writeFileSync(path.join(dir, 'x.session.json.tmp'), '{}');
        fs.writeFileSync(path.join(dir, 'history.json'), '{}');
        assert.deepEqual(listSessions(dir).map((r) => [r.name, r.mode]), [['b', 'per-prompt'], ['chat', 'continue']]);
        assert.deepEqual(listSessions(path.join(dir, 'missing')), []);
    });

    test('SS-2: create', () => {
        const dir = folder();
        const prep = createSession(dir, 'prep', {});
        assert.equal(prep.ok, true);
        assert.equal(readSession(dir, 'prep')?.mode, 'continue');
        const per = createSession(dir, 'per-prompt', { basedOn: 'prep', mode: 'fork-from-base' });
        assert.equal(per.ok, true);
        assert.deepEqual([readSession(dir, 'per-prompt')?.basedOn, readSession(dir, 'per-prompt')?.mode], ['prep', 'per-prompt']);
        assert.match(readSession(dir, 'per-prompt')?.createdAt ?? '', /^\d{4}-/);
        const refusal = (r: ReturnType<typeof createSession>): string => (r.ok ? '' : r.error);
        assert.match(refusal(createSession(dir, 'prep', {})), /already exists/);
        assert.match(refusal(createSession(dir, 'bad name', {})), /letters, digits/);
        assert.match(refusal(createSession(dir, 'x', { basedOn: 'nope' })), /no session "nope"/);
        assert.match(refusal(createSession(dir, 'y', { mode: 'sometimes' as never })), /not a session lifetime/);
        assert.equal(createSession(dir, 'solo', { mode: 'per-prompt' }).ok, true, 'per prompt without a base: fresh every prompt');
        assert.equal(createSession(dir, 'iter', { mode: 'per-iteration' }).ok, true);
    });

    test('SS-3: saving an id keeps the other fields', () => {
        const dir = folder();
        createSession(dir, 'prep', {});
        createSession(dir, 'child', { basedOn: 'prep' });
        saveSessionId(dir, 'child', 'S-child', 'claude-x');
        const r = readSession(dir, 'child');
        assert.deepEqual([r?.sessionId, r?.basedOn, r?.mode, r?.model], ['S-child', 'prep', 'continue', 'claude-x']);
        assert.ok(r?.createdAt && r.updatedAt);
        saveSessionId(dir, 'fresh', 'S-new');
        assert.equal(readSession(dir, 'fresh')?.sessionId, 'S-new', 'a session saved for the first time gets a file');
    });

    test('SS-4: planning from the files', () => {
        const dir = folder();
        createSession(dir, 'prep', {});
        saveSessionId(dir, 'prep', 'S-prep');
        createSession(dir, 'per-prompt', { basedOn: 'prep', mode: 'fork-from-base' });
        assert.deepEqual(planSessionStartIn(dir, 'per-prompt'), { resume: 'S-prep', fork: true, persist: false });
        createSession(dir, 'walk', { basedOn: 'prep', mode: 'per-iteration' });
        assert.deepEqual(planSessionStartIn(dir, 'walk', 'i/1'), { resume: 'S-prep', fork: true, persist: true, iterationKey: 'i/1' });
        assert.deepEqual(planSessionStartIn(dir, 'prep'), { resume: 'S-prep', fork: false, persist: true });
        assert.deepEqual(planSessionStartIn(dir, 'new-one'), { fork: false, persist: true });
    });
    test('SS-5: clearing a session', () => {
        const dir = folder();
        saveSessionId(dir, 'chat', 'S-chat');
        clearSessionId(dir, 'chat');
        assert.equal(readSession(dir, 'chat'), undefined, 'a plain session is gone');
        createSession(dir, 'prep', {});
        createSession(dir, 'child', { basedOn: 'prep' });
        saveSessionId(dir, 'child', 'S-child');
        clearSessionId(dir, 'child');
        const r = readSession(dir, 'child');
        assert.deepEqual([r?.sessionId, r?.basedOn, r?.mode], [undefined, 'prep', 'continue'], 'it starts from its base again');
        createSession(dir, 'named', {});
        saveSessionId(dir, 'named', 'S-named');
        clearSessionId(dir, 'named');
        assert.deepEqual([readSession(dir, 'named')?.name, readSession(dir, 'named')?.sessionId], ['named', undefined], 'a created session stays listed');
        clearSessionId(dir, 'never-existed');
    });

    test('SS-6: profile and model', () => {
        const dir = folder();
        const made = createSession(dir, 'opus', { profile: { id: 'opus-5-5-direct', model: 'claude-opus-5-5' } });
        assert.ok(made.ok);
        assert.deepEqual([readSession(dir, 'opus')?.profileId, readSession(dir, 'opus')?.model], ['opus-5-5-direct', 'claude-opus-5-5']);
        createSession(dir, 'child', { basedOn: 'opus', mode: 'per-prompt' });
        assert.deepEqual([readSession(dir, 'child')?.profileId, readSession(dir, 'child')?.model], ['opus-5-5-direct', 'claude-opus-5-5'],
            'a based session without its own profile takes the base\'s');
        createSession(dir, 'haiku', { basedOn: 'opus', profile: { id: 'haiku-5-5-direct', model: 'claude-haiku-5-5' } });
        assert.equal(readSession(dir, 'haiku')?.profileId, 'haiku-5-5-direct', 'its own profile wins');
        saveSessionId(dir, 'opus', 'S-opus', 'claude-opus-5-5');
        clearSessionId(dir, 'opus');
        assert.deepEqual([readSession(dir, 'opus')?.sessionId, readSession(dir, 'opus')?.profileId, readSession(dir, 'opus')?.model],
            [undefined, 'opus-5-5-direct', 'claude-opus-5-5'], 'a reset keeps the profile and its model');
    });

    test('SS-7: per-iteration conversations', () => {
        const dir = folder();
        createSession(dir, 'walk', { mode: 'per-iteration' });
        saveSessionId(dir, 'walk', 'S-1', 'm', 'item/run/1');
        assert.deepEqual(readSession(dir, 'walk')?.iteration, { key: 'item/run/1', sessionId: 'S-1' });
        assert.equal(readSession(dir, 'walk')?.sessionId, undefined, 'not the session\'s own id');
        assert.deepEqual(planSessionStartIn(dir, 'walk', 'item/run/1'), { resume: 'S-1', fork: false, persist: true, iterationKey: 'item/run/1' });
        saveSessionId(dir, 'walk', 'S-2', 'm', 'item/run/2');
        assert.deepEqual(readSession(dir, 'walk')?.iteration, { key: 'item/run/2', sessionId: 'S-2' }, 'the next iteration replaces it');
        clearSessionId(dir, 'walk');
        assert.equal(readSession(dir, 'walk')?.iteration, undefined);
    });

    test('SS-8: ensureSession', () => {
        const dir = folder();
        const profiles: Record<string, SessionProfile> = {
            opus: { id: 'opus', model: 'claude-opus-5-5', continuity: 'history' },
            haiku: { id: 'haiku', model: 'claude-haiku-5-5', continuity: 'history' },
        };
        const of = (id: string): SessionProfile | undefined => profiles[id];
        assert.deepEqual(ensureSession(dir, { name: 'plain' }, of), { ok: true, created: ['plain'] });
        assert.deepEqual([readSession(dir, 'plain')?.mode, readSession(dir, 'plain')?.basedOn], ['continue', undefined], 'a bare name: fresh, continue');
        const walk = ensureSession(dir, { name: 'walk', basedOn: 'prep', mode: 'per-iteration', profile: 'opus' }, of, 'haiku');
        assert.deepEqual(walk, { ok: true, created: ['prep', 'walk'] }, 'the missing base first');
        assert.deepEqual([readSession(dir, 'prep')?.mode, readSession(dir, 'prep')?.profileId], ['continue', undefined], 'the base plainly');
        assert.deepEqual([readSession(dir, 'walk')?.mode, readSession(dir, 'walk')?.profileId, readSession(dir, 'walk')?.model],
            ['per-iteration', 'opus', 'claude-opus-5-5'], 'the spec\'s profile wins over the item\'s');
        ensureSession(dir, { name: 'item-profile' }, of, 'haiku');
        assert.equal(readSession(dir, 'item-profile')?.profileId, 'haiku', 'else the item\'s profile');
        assert.deepEqual(ensureSession(dir, { name: 'walk', mode: 'continue' }, of), { ok: true, created: [] }, 'an existing session stays');
        assert.equal(readSession(dir, 'walk')?.mode, 'per-iteration');
        const refused = ensureSession(dir, { name: 'ghost', basedOn: 'ghost-base', profile: 'nope' }, of);
        assert.equal(refused.ok, false);
        assert.match((refused as { error: string }).error, /no Anthropic profile "nope"/);
        assert.deepEqual([readSession(dir, 'ghost'), readSession(dir, 'ghost-base')], [undefined, undefined], 'nothing created');
    });

    test('SS-9: the transport check on files', () => {
        const dir = folder();
        const direct: SessionProfile = { id: 'd', continuity: 'history' };
        const sdk: SessionProfile = { id: 's', continuity: 'sdk' };
        createSession(dir, 'sdk-conv', {});
        saveSessionId(dir, 'sdk-conv', 'S-1');
        assert.match(sessionTransportMismatch(dir, 'sdk-conv', direct) ?? '', /cannot continue it/);
        assert.equal(sessionTransportMismatch(dir, 'sdk-conv', sdk), undefined);
        createSession(dir, 'ours', {});
        fs.mkdirSync(path.join(dir, 'sessions', 'ours'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sessions', 'ours', 'rawTurns.json'), '{"rounds":[["x"]]}');
        assert.match(sessionTransportMismatch(dir, 'ours', sdk) ?? '', /cannot continue it/);
        assert.equal(sessionTransportMismatch(dir, 'ours', direct), undefined);
        createSession(dir, 'empty', {});
        assert.equal(sessionTransportMismatch(dir, 'empty', sdk), undefined, 'no conversation yet');
        saveSessionId(dir, 'default', 'S-q');
        fs.writeFileSync(path.join(dir, 'rawTurns.json'), '{"rounds":[["q"]]}');
        assert.equal(sessionTransportMismatch(dir, 'default', direct), undefined, 'the shared sessions hold both');
    });
});
