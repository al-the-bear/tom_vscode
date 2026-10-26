/**
 * The Agent SDK session tools (src/tools/session-tools.ts).
 *
 *   ST-S1 list: the quest's sessions with mode, base, whether they have a conversation, and how the next
 *         prompt in each starts
 *   ST-S2 create: fresh, based on another (continue / per-prompt, the old fork-from-base name too), with a
 *         profile and its model; refusals (existing name, unknown lifetime, unknown profile) come back as errors
 *   ST-S3 registration: list reads only, create writes and needs no approval
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';
import { SESSION_TOOLS, createSessionImpl, listSessionsImpl, type SessionToolDeps } from '../session-tools.js';
import { saveSessionId } from '../../services/agentSdkSessionStore.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tools-'));
const deps: SessionToolDeps = {
    folder: () => dir,
    quest: () => 'q1',
    profile: (id) => (id === 'opus-direct' ? { id, model: 'claude-opus-5-5', continuity: 'history' } : undefined),
};

describe('session tools', () => {
    test('ST-S1/ST-S2: create and list', async () => {
        const prep = JSON.parse(await withTiming('tomAi_createSession:typical', () => createSessionImpl(deps, { name: 'prep' })));
        assert.equal(prep.ok, true, JSON.stringify(prep));
        saveSessionId(dir, 'prep', 'S-prep');
        const per = JSON.parse(await createSessionImpl(deps, { name: 'per-prompt', basedOn: 'prep', mode: 'fork-from-base' }));
        assert.equal(per.ok, true);
        const bad = JSON.parse(await createSessionImpl(deps, { name: 'per-prompt' }));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /already exists/);
        const badMode = JSON.parse(await createSessionImpl(deps, { name: 'x', mode: 'sometimes' }));
        assert.equal(badMode.ok, false);
        const badProfile = JSON.parse(await createSessionImpl(deps, { name: 'x', profile: 'nope' }));
        assert.match(badProfile.error, /no Anthropic profile "nope"/);
        const opus = JSON.parse(await createSessionImpl(deps, { name: 'opus', mode: 'per-iteration', profile: 'opus-direct' }));
        assert.deepEqual([opus.session.mode, opus.session.profileId, opus.session.model], ['per-iteration', 'opus-direct', 'claude-opus-5-5']);

        const list = JSON.parse(await withTiming('tomAi_listSessions:typical', () => listSessionsImpl(deps, {})));
        assert.equal(list.quest, 'q1');
        const byName = Object.fromEntries(list.sessions.map((s: Json) => [s.name, s]));
        assert.deepEqual([byName.prep.mode, byName.prep.hasConversation, byName.prep.nextPrompt], ['continue', true, 'continues its conversation']);
        assert.deepEqual([byName['per-prompt'].mode, byName['per-prompt'].basedOn, byName['per-prompt'].nextPrompt],
            ['per-prompt', 'prep', 'starts from a fork of the base\'s conversation; nothing is saved']);
        assert.deepEqual([byName.opus.profile, byName.opus.model], ['opus-direct', 'claude-opus-5-5']);
    });

    test('ST-S3: registration', () => {
        assert.deepEqual(SESSION_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_listSessions', true, false],
            ['tomAi_createSession', false, false],
        ]);
    });
});
