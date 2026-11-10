/**
 * One-prompt sessions (src/services/temporarySessions.ts): the ANTHROPIC panel's Fresh send and the assist runs.
 *
 *   TS-1 created as `tmp-<yymmdd-hhmmss>-<token>` based on the given session when it has a file, fresh otherwise;
 *        a refused creation names why
 *   TS-2 discarded completely: the session file and its storage folder (trail, live trail, history) are gone, so
 *        neither the SESSIONS view nor the Logs session switch lists it; discarding one already gone is no error
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { createTemporarySession, discardSessionCompletely, type TemporarySessionDeps } from '../temporarySessions.js';
import { createSession, readSession } from '../agentSdkSessionStore.js';
import { sessionRoot, sessionsWithStorage } from '../sessionStorage.js';

const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-sessions-')));
after(() => fs.rmSync(folder, { recursive: true, force: true }));
const NOW = new Date(2026, 10, 10, 18, 30, 5);

describe('one-prompt sessions', () => {
    test('TS-1: created, based on the panel\'s session', () => {
        const made: Array<{ name: string; basedOn?: string }> = [];
        const deps = (has: boolean, ok = true): TemporarySessionDeps => ({
            sessionsFolder: () => '/q/history',
            hasSession: () => has,
            createSession: (_f, name, opts) => { made.push({ name, ...opts }); return ok ? { ok: true } : { ok: false, error: 'disk full' }; },
        });
        assert.deepEqual(createTemporarySession(deps(true), 'chat', 'fresh', NOW), { ok: true, session: 'tmp-261110-183005-fresh', basedOn: 'chat' });
        assert.deepEqual(made.pop(), { name: 'tmp-261110-183005-fresh', basedOn: 'chat' });
        assert.deepEqual(createTemporarySession(deps(false), 'chat', 'fresh', NOW), { ok: true, session: 'tmp-261110-183005-fresh', basedOn: null }, 'no session file yet: fresh');
        assert.deepEqual(made.pop(), { name: 'tmp-261110-183005-fresh' });
        assert.deepEqual(createTemporarySession(deps(true, false), 'chat', 'fresh', NOW), { ok: false, error: 'the temporary session could not be created: disk full' });
    });

    test('TS-2: discarded completely', () => {
        assert.equal(createSession(folder, 'chat', {}).ok, true);
        const made = createTemporarySession({ sessionsFolder: () => folder, hasSession: (f, n) => readSession(f, n) !== undefined, createSession }, 'chat', 'fresh', NOW);
        assert.ok(made.ok);
        const name = (made as { session: string }).session;
        assert.equal(readSession(folder, name)?.basedOn, 'chat');
        // What a send leaves: its trail and live trail.
        fs.mkdirSync(path.join(sessionRoot(folder, name), 'trail'), { recursive: true });
        fs.writeFileSync(path.join(sessionRoot(folder, name), 'live-trail.md'), '# trail\n');
        assert.ok(sessionsWithStorage(folder).includes(name));
        discardSessionCompletely(folder, 'q', name);
        assert.equal(readSession(folder, name), undefined, 'the session file');
        assert.ok(!fs.existsSync(sessionRoot(folder, name)), 'its storage');
        assert.ok(!sessionsWithStorage(folder).includes(name));
        assert.ok(readSession(folder, 'chat'), 'the base stays');
        assert.doesNotThrow(() => discardSessionCompletely(folder, 'q', name), 'gone already');
    });
});
