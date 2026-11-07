/**
 * The @WS Issues and Tests tables show which repository an issue is from:
 * a "Repo" column right of the comment count, written `<repo-name>/<owner>`
 * so the part that tells repositories apart comes first. The real panel
 * script (media/issuesPanel/main.js) in a JSDOM, with the handler's own
 * default configuration.
 *
 *   IR-1 the default columns: Repo is shown, right after the comment count, in both panels
 *   IR-2 its text: `tom_vscode/al-the-bear` for `al-the-bear/tom_vscode`, per issue, across repos (All Repos);
 *        a repository id without an owner (a local tracker) shows as it is
 *   IR-3 it sorts (the sort picker offers Repo)
 *   IR-4 the workspace config lists the column in both panels too
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

// Safe to import after the stub is wired into the resolver.
import { loadPanelConfig } from '../../handlers/issuesPanel-handler.js';

const media = (...parts: string[]): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', ...parts), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, mode: 'issues' | 'tests') {
    const prefix = mode;
    const dom = new JSDOM(`<body>${media('issuesPanel', 'fragment.html').replace(/\{\{prefix\}\}/g, prefix)}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined };
    // JSDOM has no ResizeObserver; the panel only uses it to re-lay the columns out.
    w.ResizeObserver = class { observe(): void { /* none */ } disconnect(): void { /* none */ } };
    w._issuesPrefix = prefix;
    w._issuesMode = mode;
    w.eval(media('issuesPanel', 'main.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data: { panelMode: mode, ...data } }));
    const config = loadPanelConfig(mode);
    send({
        type: 'issuesInit',
        repos: [{ id: '__all__', displayName: 'All Repos' }, { id: 'al-the-bear/tom_vscode', displayName: 'al-the-bear/tom_vscode' }, { id: 'acme/widgets', displayName: 'acme/widgets' }],
        statuses: config.statuses, statusColors: config.statusColors, labels: config.labels,
        columnDefs: config.availableColumns, defaultColumns: config.defaultColumns,
        allReposOption: true, columnLabels: config.columnLabels, growthPriority: config.growthPriority,
    });
    const issue = (n: number) => ({ number: n, title: `Issue ${n}`, state: 'open', labels: [], commentCount: n, author: { name: 'al', avatarUrl: '' }, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' });
    send({ type: 'issues', repoId: 'al-the-bear/tom_vscode', issues: [issue(1)] });
    send({ type: 'issues', repoId: 'acme/widgets', issues: [issue(2)] });
    const rows = (): string[][] => [...w.document.querySelectorAll(`#${prefix}-issueList .issue-row`)]
        .map((row: Win) => [...row.querySelectorAll('.issue-cell')].map((c: Win) => c.getAttribute('title') ?? 'dot'));
    return { w, rows, prefix };
}

describe('@WS Issues / Tests: the Repo column', () => {
    for (const mode of ['issues', 'tests'] as const) {
        test(`IR-1/2: ${mode} — Repo right of the comment count, <repo-name>/<owner>`, (t) => {
            const s = setup(t, mode);
            const rows = s.rows();
            assert.equal(rows.length, 2, 'both repositories\' issues (All Repos)');
            for (const cells of rows) {
                const i = cells.findIndex((c) => c.startsWith('# of Comments:'));
                assert.ok(i >= 0, 'the comment count is shown');
                assert.match(cells[i + 1], /^Repo: /, 'Repo comes right after it');
            }
            const repoCells = rows.map((cells) => cells.find((c) => c.startsWith('Repo: ')));
            assert.deepEqual(repoCells.sort(), ['Repo: tom_vscode/al-the-bear', 'Repo: widgets/acme']);
        });
    }

    test('IR-2: a repository without an owner', (t) => {
        const s = setup(t, 'issues');
        s.w.dispatchEvent(new s.w.MessageEvent('message', { data: { panelMode: 'issues', type: 'issues', repoId: 'Local Todos', issues: [{ number: 3, title: 'x', state: 'open', labels: [], commentCount: 0, author: { name: 'al' } }] } }));
        assert.ok(s.rows().some((cells) => cells.includes('Repo: Local Todos')));
    });

    test('IR-3: it sorts', (t) => {
        const s = setup(t, 'issues');
        s.w.document.getElementById(`${s.prefix}-sortBtn`).click();
        const options = [...s.w.document.querySelectorAll(`#${s.prefix}-sortPicker .picker-option`)].map((el: Win) => el.dataset.field);
        assert.ok(options.includes('repo'), 'Repo is a sort field');
    });

    test('IR-4: the workspace config', () => {
        const ws = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
        const panels = JSON.parse(fs.readFileSync(path.join(ws, '.tom', 'tom_vscode_extension.json'), 'utf8')).issuePanels;
        for (const name of ['issueKit', 'testkit']) {
            const cols: string[] = panels[name].availableColumns.map((c: string) => c.split('{')[0]);
            assert.equal(cols[cols.indexOf('commentCount') + 1], 'repo', `${name}: repo right of commentCount`);
            assert.match(panels[name].defaultColumns, /\bcommentCount,repo\b/, `${name}: shown by default`);
        }
        assert.equal(panels.common.columnLabels.repo, 'Repo');
    });
});
