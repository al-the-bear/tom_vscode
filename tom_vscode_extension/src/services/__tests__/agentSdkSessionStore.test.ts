/**
 * The session files in a quest's history folder (src/services/agentSdkSessionStore.ts).
 *
 *   SS-1  list: every `<name>.session.json`, sorted, unreadable files skipped, `.tmp` ignored
 *   SS-2  create: a new session, fresh or based on another, continue or fork-from-base; refuses a bad
 *         name, an existing session, a missing base, fork-from-base without a base
 *   SS-3  saving an id keeps the file's other fields (basedOn, mode, createdAt)
 *   SS-5  clearing a session forgets its conversation; a session with a base keeps its definition
 *   SS-4  the start of a prompt is planned from the files (a session based on another forks its base)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    clearSessionId,
    createSession,
    listSessions,
    planSessionStartIn,
    readSession,
    saveSessionId,
} from '../agentSdkSessionStore.js';

const folder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));

describe('session files', () => {
    test('SS-1: list', () => {
        const dir = folder();
        fs.writeFileSync(path.join(dir, 'chat.session.json'), JSON.stringify({ sessionId: 'S1', updatedAt: 't', model: 'm' }));
        fs.writeFileSync(path.join(dir, 'b.session.json'), JSON.stringify({ basedOn: 'chat', mode: 'fork-from-base' }));
        fs.writeFileSync(path.join(dir, 'broken.session.json'), '{ not json');
        fs.writeFileSync(path.join(dir, 'x.session.json.tmp'), '{}');
        fs.writeFileSync(path.join(dir, 'history.json'), '{}');
        assert.deepEqual(listSessions(dir).map((r) => [r.name, r.mode]), [['b', 'fork-from-base'], ['chat', 'continue']]);
        assert.deepEqual(listSessions(path.join(dir, 'missing')), []);
    });

    test('SS-2: create', () => {
        const dir = folder();
        const prep = createSession(dir, 'prep', {});
        assert.equal(prep.ok, true);
        assert.equal(readSession(dir, 'prep')?.mode, 'continue');
        const per = createSession(dir, 'per-prompt', { basedOn: 'prep', mode: 'fork-from-base' });
        assert.equal(per.ok, true);
        assert.deepEqual([readSession(dir, 'per-prompt')?.basedOn, readSession(dir, 'per-prompt')?.mode], ['prep', 'fork-from-base']);
        assert.match(readSession(dir, 'per-prompt')?.createdAt ?? '', /^\d{4}-/);
        const refusal = (r: ReturnType<typeof createSession>): string => (r.ok ? '' : r.error);
        assert.match(refusal(createSession(dir, 'prep', {})), /already exists/);
        assert.match(refusal(createSession(dir, 'bad name', {})), /letters, digits/);
        assert.match(refusal(createSession(dir, 'x', { basedOn: 'nope' })), /no session "nope"/);
        assert.match(refusal(createSession(dir, 'y', { mode: 'fork-from-base' })), /needs a base/);
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
});
