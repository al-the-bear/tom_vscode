/**
 * The Agent SDK session tools (src/tools/session-tools.ts).
 *
 *   ST-S1 list: the quest's sessions with mode, base, whether they have a conversation, and how the next
 *         prompt in each starts
 *   ST-S2 create: fresh, based on another (continue / fork-from-base); refusals come back as errors
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
const deps: SessionToolDeps = { folder: () => dir, quest: () => 'q1' };

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
        const badMode = JSON.parse(await createSessionImpl(deps, { name: 'x', mode: 'sometimes' as never }));
        assert.equal(badMode.ok, false);

        const list = JSON.parse(await withTiming('tomAi_listSessions:typical', () => listSessionsImpl(deps, {})));
        assert.equal(list.quest, 'q1');
        const byName = Object.fromEntries(list.sessions.map((s: Json) => [s.name, s]));
        assert.deepEqual([byName.prep.mode, byName.prep.hasConversation, byName.prep.nextPrompt], ['continue', true, 'continues its conversation']);
        assert.deepEqual([byName['per-prompt'].basedOn, byName['per-prompt'].nextPrompt], ['prep', 'starts from a fork of the base\'s conversation; nothing is saved']);
    });

    test('ST-S3: registration', () => {
        assert.deepEqual(SESSION_TOOLS.map((t) => [t.name, t.readOnly, t.requiresApproval ?? false]), [
            ['tomAi_listSessions', true, false],
            ['tomAi_createSession', false, false],
        ]);
    });
});
