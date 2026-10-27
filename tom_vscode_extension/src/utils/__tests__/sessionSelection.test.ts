/**
 * The session selection of actions on a quest's conversation storage (src/utils/sessionSelection.ts).
 *
 *   SL-1 the items: "All sessions" first, then default, chat and the session files in the SESSIONS view's order,
 *        temporary ones marked; the current session preselected; storage without a session file listed too
 *   SL-2 the choice: one session, several, or All sessions (every session listed, temporary ones included)
 *   SL-3 the confirmation names the sessions, and says ALL when all are chosen
 *   SL-4 the tools' `sessions`: absent → the caller's own session; a name; a list; "all"; an unknown or malformed
 *        one refused naming the sessions there are
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { chosenSessions, confirmationText, deleteSessionDetail, resolveSessionsArg, sessionSelectionItems, subsystemInSessions, ALL_SESSIONS_LABEL } from '../sessionSelection.js';
import { sessionRows } from '../sessionsViewRows.js';
import type { SessionRecord } from '../agentSdkSessions.js';

const RECORDS: SessionRecord[] = [
    { name: 'prep', mode: 'continue', model: 'claude-haiku-5-5', sessionId: 'S1' },
    { name: 'walk', mode: 'per-prompt', basedOn: 'prep' },
    { name: 'tmp-261027-120000-ab12', mode: 'continue', basedOn: 'prep' },
];
const ROWS = sessionRows(RECORDS);
const KNOWN = ROWS.map((r) => r.name);

describe('session selection', () => {
    test('SL-1: the items', () => {
        const items = sessionSelectionItems(ROWS, 'chat');
        assert.deepEqual(items.map((i) => i.label), [ALL_SESSIONS_LABEL, 'default', 'chat', 'prep', 'walk', 'tmp-261027-120000-ab12']);
        assert.deepEqual(items.filter((i) => i.picked).map((i) => i.label), ['chat'], 'the current session preselected');
        assert.equal(items[0].all, true);
        assert.equal(items[0].description, '5 sessions');
        assert.match(items.find((i) => i.label === 'tmp-261027-120000-ab12')!.description, /temporary/);
        assert.match(items.find((i) => i.label === 'walk')!.description, /based on prep · per prompt · no conversation yet/);
        assert.match(items.find((i) => i.label === 'default')!.description, /the prompt queue/);
        const withOrphan = sessionSelectionItems(ROWS, 'gone', ['prep', 'gone']);
        assert.deepEqual(withOrphan.slice(-1).map((i) => [i.label, i.description, i.picked]), [['gone', 'storage only (no session file)', true]]);
        assert.equal(withOrphan[0].description, '6 sessions');
    });

    test('SL-2: the choice', () => {
        const items = sessionSelectionItems(ROWS, 'chat');
        const by = (label: string) => items.find((i) => i.label === label)!;
        assert.deepEqual(chosenSessions([by('walk')], items), ['walk']);
        assert.deepEqual(chosenSessions([by('chat'), by('prep')], items), ['chat', 'prep']);
        assert.deepEqual(chosenSessions([by(ALL_SESSIONS_LABEL), by('walk')], items), KNOWN, 'All sessions: every one, temporary included');
        assert.deepEqual(chosenSessions([], items), []);
    });

    test('SL-3: the confirmation', () => {
        assert.equal(confirmationText('Clear history', ['chat'], 5), 'Clear history for the session "chat"?');
        assert.equal(confirmationText('Clear history', ['chat', 'walk'], 5), 'Clear history for 2 sessions: chat, walk?');
        assert.equal(confirmationText('Clear history', KNOWN, KNOWN.length), `Clear history for ALL 5 sessions (${KNOWN.join(', ')})?`);
    });

    test('SL-4: the tools\' sessions parameter', () => {
        assert.deepEqual(resolveSessionsArg(undefined, KNOWN, 'walk'), { ok: true, sessions: ['walk'] }, "the caller's own session");
        assert.deepEqual(resolveSessionsArg('prep', KNOWN, 'walk'), { ok: true, sessions: ['prep'] });
        assert.deepEqual(resolveSessionsArg(['prep', 'chat', 'prep'], KNOWN, 'walk'), { ok: true, sessions: ['prep', 'chat'] });
        assert.deepEqual(resolveSessionsArg('all', KNOWN, 'walk'), { ok: true, sessions: KNOWN });
        const unknown = resolveSessionsArg(['prep', 'nope'], KNOWN, 'walk');
        assert.deepEqual(unknown, { ok: false, code: 'unknownSession', error: 'No session "nope" in this quest.', sessions: KNOWN });
        for (const bad of [[], [''], [3], 42, {}]) {
            const r = resolveSessionsArg(bad, KNOWN, 'walk');
            assert.equal(r.ok, false, JSON.stringify(bad));
            assert.equal((r as { code: string }).code, 'invalidSessions');
        }
    });
});

describe('session selection — helpers', () => {
    test('SL-5: what Delete removes; which prompt-history pairs a choice keeps', () => {
        const detail = deleteSessionDetail('tom_uam', 'walk');
        assert.match(detail, /history\/sessions\/walk\//);
        assert.match(detail, /_ai\/memory\/tom_uam\/walk\//);
        assert.match(detail, /cannot be undone/);
        assert.equal(subsystemInSessions('anthropic:walk', ['walk']), true);
        assert.equal(subsystemInSessions('anthropic:chat', ['walk']), false);
        assert.equal(subsystemInSessions('copilot', ['walk']), true, 'subsystems without sessions are kept');
        assert.equal(subsystemInSessions('anthropic', ['walk']), true, 'the pair from before per-session storage');
        assert.equal(subsystemInSessions('anthropic:chat', undefined), true, 'no choice: everything');
    });
});
