/**
 * "My Repos (<account>)" in the @WS Issues panel (media/issuesPanel/main.js), in a JSDOM running the real script.
 *
 *   IM-1 the host's accountRepos adds "My Repos (<account>)" after "All Repos" without changing the selection;
 *        a second message adds no second option
 *   IM-2 choosing it loads the issues of the account's repos only and lists them together; refresh reloads them;
 *        a new issue needs a specific repo
 *   IM-3 without an account (no message) there is no such option
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const REPOS = [
    { id: 'al-the-bear/tom_vscode', displayName: 'al-the-bear/tom_vscode' },
    { id: 'dart-lang/sdk', displayName: 'dart-lang/sdk' },
    { id: 'al-the-bear/tom_d4rt', displayName: 'al-the-bear/tom_d4rt' },
];

function setup(t: { after(fn: () => void): void }) {
    const html = `<!DOCTYPE html><body>${media('issuesPanel', 'fragment.html').replace(/\{\{prefix\}\}/g, 'issues')}</body>`;
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined };
    w.ResizeObserver = class { observe() { /* JSDOM has none */ } disconnect() { /* none */ } };
    w._issuesPrefix = 'issues';
    w._issuesMode = 'issues';
    w.eval(media('issuesPanel', 'main.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { panelMode: 'issues', ...data } }));
    send({ type: 'issuesInit', repos: REPOS, statuses: ['open', 'closed'], allReposOption: true, columnDefs: [{ key: 'title', required: true, minWidth: 80 }], defaultColumns: ['title'] });
    const select = w.document.getElementById('issues-repoSelect');
    const options = () => [...select.options].map((o: Win) => [o.value, o.textContent]);
    const loads = () => posted.filter((m) => m.type === 'loadIssues').map((m) => m.repoId);
    const choose = (value: string) => { select.value = value; select.dispatchEvent(new w.Event('change')); };
    return { w, posted, send, select, options, loads, choose };
}

describe('Issues panel: My Repos', () => {
    test('IM-1: the option arrives after the list', (t) => {
        const s = setup(t);
        const before = s.select.value;
        s.posted.length = 0;
        s.send({ type: 'accountRepos', account: 'al-the-bear', repoIds: ['al-the-bear/tom_vscode', 'al-the-bear/tom_d4rt'] });
        const values = s.options().map((o) => o[0]);
        assert.deepEqual(values.slice(0, 3), ['', '__all__', '__mine__']);
        assert.equal(s.options()[2][1], 'My Repos (al-the-bear)');
        assert.equal(s.select.value, before, 'the selection stays');
        assert.deepEqual(s.loads(), [], 'nothing is reloaded');
        s.send({ type: 'accountRepos', account: 'al-the-bear', repoIds: ['al-the-bear/tom_vscode'] });
        assert.equal(s.options().filter((o) => o[0] === '__mine__').length, 1);
    });

    test('IM-2: choosing it', (t) => {
        const s = setup(t);
        s.send({ type: 'accountRepos', account: 'al-the-bear', repoIds: ['al-the-bear/tom_vscode', 'al-the-bear/tom_d4rt'] });
        s.posted.length = 0;
        s.choose('__mine__');
        assert.deepEqual(s.loads(), ['al-the-bear/tom_vscode', 'al-the-bear/tom_d4rt'], 'only the account\'s repos');
        const issue = (n: number) => ({ id: String(n), number: n, title: `t${n}`, state: 'open', labels: [], author: { name: 'a' }, createdAt: '', updatedAt: '', commentCount: 0 });
        s.send({ type: 'issues', repoId: 'al-the-bear/tom_vscode', issues: [issue(1)] });
        s.send({ type: 'issues', repoId: 'al-the-bear/tom_d4rt', issues: [issue(2)] });
        const list = s.w.document.getElementById('issues-issueList').textContent as string;
        assert.match(list, /t1/);
        assert.match(list, /t2/, 'both repos\' issues are listed together');
        s.posted.length = 0;
        s.w.document.getElementById('issues-refreshBtn').click();
        assert.deepEqual(s.loads(), ['al-the-bear/tom_vscode', 'al-the-bear/tom_d4rt']);
    });

    test('IM-3: no account, no option', (t) => {
        const s = setup(t);
        assert.equal(s.options().some((o) => o[0] === '__mine__'), false);
    });
});
