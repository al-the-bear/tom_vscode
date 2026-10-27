/**
 * The SESSIONS view (src/utils/sessionsViewRows.ts, media/sessionsView, src/handlers/sessionsView-handler.ts).
 *
 *   SV-1 the rows: `default` (the queue's) and `chat` (the panel's) first, marked, even without a file; then
 *        every session file by name; base, lifetime, profile, model, conversation, last use, dependents
 *   SV-2 the view renders each row with its description line; Reset is offered for a session file with a
 *        conversation and for `default` / `chat` (their history), Delete for a file nothing is based on (its
 *        tooltip names the dependents otherwise);
 *        a click posts the row's name
 *   SV-4 a temporary session (`tmp-<yymmdd-hhmmss>-<token>`, of an item another quest sent) is listed last and
 *        tagged temporary; a lasting session whose name merely starts with `tmp` is not
 *   SV-3 the host: Reset clears the id, Delete asks first and goes through deleteSession; the add command
 *        is the picker's new-session path; the folder is watched with an error listener and the store's
 *        notifications refresh the view
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { sessionRows } from '../sessionsViewRows.js';
import type { SessionRecord } from '../agentSdkSessions.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const RECORDS: SessionRecord[] = [
    { name: 'walk', mode: 'per-iteration', basedOn: 'prep', profileId: 'opus', model: 'claude-opus-5-5', updatedAt: '2026-10-26T20:00:00Z' },
    { name: 'prep', mode: 'continue', sessionId: 'S-prep', createdAt: '2026-10-26T18:00:00Z' },
    { name: 'default', mode: 'continue', sessionId: 'S-q', updatedAt: '2026-10-26T19:00:00Z' },
    { name: 'solo', mode: 'per-prompt', iteration: { key: 'k', sessionId: 'S-i' } },
];

function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

describe('SESSIONS view', () => {
    test('SV-1: the rows', () => {
        const rows = sessionRows(RECORDS);
        assert.deepEqual(rows.map((r) => [r.name, r.usedBy ?? '', r.hasFile]), [
            ['default', 'the prompt queue', true], ['chat', 'the ANTHROPIC panel', false],
            ['prep', '', true], ['solo', '', true], ['walk', '', true],
        ]);
        const by = Object.fromEntries(rows.map((r) => [r.name, r]));
        assert.deepEqual(by.walk, {
            name: 'walk', hasFile: true, basedOn: 'prep', lifetime: 'per iteration', profileId: 'opus', model: 'claude-opus-5-5',
            hasConversation: false, lastUse: '2026-10-26T20:00:00Z', dependents: [],
        });
        assert.deepEqual([by.prep.hasConversation, by.prep.lastUse, by.prep.dependents, by.prep.lifetime], [true, '2026-10-26T18:00:00Z', ['walk'], undefined]);
        assert.deepEqual([by.solo.lifetime, by.solo.hasConversation], ['per prompt', true], 'an iteration\'s conversation counts');
        assert.deepEqual([by.chat.hasConversation, by.chat.dependents], [false, []]);
    });

    test('SV-4: temporary sessions', (t) => {
        const records: SessionRecord[] = [
            { name: 'tmp-261027-123456-a1b2c3d4', mode: 'continue', basedOn: 'prep' },
            { name: 'prep', mode: 'continue' },
            { name: 'tmpl', mode: 'continue' },
        ];
        const rows = sessionRows(records);
        assert.deepEqual(rows.map((r) => [r.name, !!r.temporary]), [
            ['default', false], ['chat', false], ['prep', false], ['tmpl', false], ['tmp-261027-123456-a1b2c3d4', true],
        ]);
        const dom = new JSDOM(source('media', 'sessionsView', 'index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined });
        w.__INIT__ = {};
        w.eval(source('media', 'sessionsView', 'main.js'));
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', quest: 'q', rows } }));
        const tags = (name: string): string[] => [...w.document.querySelectorAll(`.session[data-name="${name}"] .tag`)].map((e: Win) => e.textContent);
        assert.deepEqual(tags('tmp-261027-123456-a1b2c3d4'), ['temporary']);
        assert.deepEqual(tags('tmpl'), []);
    });

    test('SV-2: the view', (t) => {
        const dom = new JSDOM(source('media', 'sessionsView', 'index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        const posted: Array<Record<string, unknown>> = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
        w.__INIT__ = {};
        w.eval(source('media', 'sessionsView', 'main.js'));
        assert.deepEqual(posted.shift(), { type: 'ready' });
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', quest: 'q', rows: sessionRows(RECORDS) } }));
        const row = (name: string): Win => w.document.querySelector(`.session[data-name="${name}"]`);
        assert.equal(row('default').querySelector('.tag').textContent, 'the prompt queue');
        assert.match(row('walk').querySelector('.meta').textContent, /^based on prep — per iteration — opus · claude-opus-5-5 — no conversation yet — used /);
        const btn = (name: string, op: string): Win => row(name).querySelector(`button[data-op="${op}"]`);
        assert.equal(btn('prep', 'reset').disabled, false, 'a conversation to forget');
        assert.equal(btn('walk', 'reset').disabled, true, 'nothing to reset');
        assert.equal(btn('chat', 'reset').disabled, false, 'no file, but chat has a history of its own to reset (per-session storage)');
        assert.equal(btn('chat', 'delete').disabled, true, 'the panel\'s session is not deleted');
        assert.equal(btn('prep', 'delete').disabled, true, 'walk is based on it');
        assert.match(btn('prep', 'delete').title, /Cannot delete: walk is based on it/);
        assert.equal(btn('walk', 'delete').disabled, false);
        btn('walk', 'delete').click();
        btn('prep', 'reset').click();
        btn('prep', 'delete').click();
        assert.deepEqual(posted, [{ type: 'delete', name: 'walk' }, { type: 'reset', name: 'prep' }], 'a disabled button posts nothing');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', quest: '', rows: [] } }));
        assert.match(w.document.getElementById('root').textContent, /No active quest/);
    });

    test('SV-3: the host', () => {
        const handler = source('src', 'handlers', 'sessionsView-handler.ts');
        assert.match(handler, /case 'reset':[\s\S]*?clearSessionId\(folder, msg\.name\)/);
        const del = handler.slice(handler.indexOf("case 'delete':"));
        assert.ok(del.indexOf('showWarningMessage(') < del.indexOf('deleteSession(folder, msg.name)'), 'Delete asks first');
        assert.match(handler, /registerCommand\(ADD_SESSION_COMMAND,[\s\S]*?newSessionViaPicker\(quest\)/);
        assert.match(handler, /fs\.watch\(folder,[\s\S]*?watcher\.on\('error'/);
        assert.match(handler, /onSessionsChanged\(\(\) => this\.send\(\)\)/);
        const pkg = JSON.parse(source('package.json'));
        assert.deepEqual(pkg.contributes.menus['view/title'].find((m: { command: string }) => m.command === 'tomAi.sessions.add'),
            { command: 'tomAi.sessions.add', when: 'view == tomAi.sessions', group: 'navigation' });
        assert.match(source('src', 'extension.ts'), /registerSessionsView\(context\);/);
    });
});
