/**
 * The @TOM VSC › PREREQUISITES view (media/prerequisites/) in a JSDOM running its real script against a
 * stand-in host, with a tree built by buildPrerequisitesTree.
 *
 *   PD-1 before the first check: Check now and the explanation, no Refresh; the repository open, the file
 *        closed (its open state from the host's storage when given); the without-file group closed, opening it
 *        shows Create, which posts the project's folder; a click on Check now posts check
 *   PD-2 after a check: Refresh and the time; opening the file shows the section (open by default) and its
 *        items with ✓ / ✗, an optional badge; opening a secret shows its options with the default badge and the
 *        two marks (VS Code, terminal) of env; every toggle posts the node and its new state
 *   PD-3 details on click (paragraphs, fields, the check's detail); the open button posts file and node id;
 *        missing only hides what is set and posts the filter; a file with problems shows the warning
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { optionKey, parsePrerequisites, toolKey } from '../prerequisites';
import { buildPrerequisitesTree } from '../prerequisitesTree';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'prerequisites', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.eval(asset('main.js'));
    return { w, posted };
}
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];
const text = (w: Win): string => w.document.getElementById('root').textContent;

const FILE = '/ws/repo/app/prerequisites.yaml';
const parsed = parsePrerequisites(`formatVersion: 1
sections:
  - id: main
    title: Main part
    description: What main needs.
    secrets:
      - id: key
        title: The key
        type: api_key
        description: For the calls.
        obtain: From the console.
        options:
          - via: env
            name: APP_KEY
          - via: file
            path: ~/.app/key
      - id: hook
        title: Hook secret
        type: webhook_secret
        required: false
        options:
          - via: env
            name: HOOK
    tools:
      - id: dart
        title: Dart
        command: dart
`);
const RES = (status: string, extra: Record<string, unknown> = {}) => ({ status, detail: `detail-${status}`, checkedAt: '2026-11-17T12:00:00.000Z', ...extra });
function tree(results: Record<string, unknown>) {
    return buildPrerequisitesTree(
        [
            { file: FILE, kind: 'project', name: 'app', dir: '/ws/repo/app', repoDir: '/ws/repo', parsed },
            { file: '/ws/repo/broken/prerequisites.yaml', kind: 'project', name: 'broken', dir: '/ws/repo/broken', repoDir: '/ws/repo', parsed: { ok: false, error: 'not YAML', problems: [] } },
        ],
        [{ name: 'lib', dir: '/ws/repo/lib', repoDir: '/ws/repo' }],
        results as never, '/ws',
    );
}
const base = (over: Record<string, unknown>) => ({ type: 'state', scanned: true, checking: null, expanded: {}, filter: { missingOnly: false, requiredOnly: false }, note: null, checkedAt: null, durationMs: null, ...over });
const CHECKED = {
    [optionKey(FILE, 'main', 'key', 0, 'env')]: RES('set', { host: 'set', shell: 'missing', warning: 'not in a terminal' }),
    [optionKey(FILE, 'main', 'key', 1, 'file')]: RES('missing'),
    [optionKey(FILE, 'main', 'hook', 0, 'env')]: RES('missing', { host: 'missing', shell: 'missing' }),
    [toolKey(FILE, 'main', 'dart')]: RES('set', { host: 'set', shell: 'set' }),
};

describe('the PREREQUISITES webview', () => {
    test('PD-1: before the first check', () => {
        const { w, posted } = setup();
        assert.deepEqual(posted, [{ type: 'ready' }]);
        send(w, base({ tree: tree({}) }));
        assert.ok($(w, 'button.primary[data-check]').length === 1, 'Check now');
        assert.match(text(w), /Not checked on this installation yet/);
        assert.equal($(w, '[data-check].codicon-refresh').length, 0, 'no Refresh yet');
        assert.match(text(w), /repo/);
        assert.match(text(w), /app/);
        assert.doesNotMatch(text(w), /Main part/, 'the file is closed');
        assert.doesNotMatch(text(w), /Create/, 'the without-file group is closed');
        const without = $(w, '[data-toggle="without"]')[0];
        without.click();
        assert.deepEqual(posted.at(-1), { type: 'toggle', node: 'without', expanded: true });
        $(w, '[data-create]')[0].click();
        assert.deepEqual(posted.at(-1), { type: 'create', dir: '/ws/repo/lib' });
        $(w, 'button.primary[data-check]')[0].click();
        assert.deepEqual(posted.at(-1), { type: 'check' });

        const again = setup();
        send(again.w, base({ tree: tree({}), expanded: { [FILE]: true } }));
        assert.match(text(again.w), /Main part/, 'opened from the stored state');
    });

    test('PD-2: after a check', () => {
        const { w, posted } = setup();
        send(w, base({ tree: tree(CHECKED), checkedAt: '2026-11-17T12:00:00.000Z', durationMs: 2500 }));
        assert.equal($(w, 'button.primary[data-check]').length, 0);
        assert.equal($(w, '[data-check].codicon-refresh').length, 1, 'Refresh');
        assert.match(text(w), /Last checked .*\(2\.5 s\)/);
        $(w, `[data-toggle="${FILE}"]`)[0].click();
        assert.deepEqual(posted.at(-1), { type: 'toggle', node: FILE, expanded: true });
        assert.match(text(w), /Main part/, 'the section is open by default');
        const rows = $(w, '.row.d3').map((r) => r.textContent);
        assert.equal(rows.length, 3);
        assert.match(rows[0], /✓The key/);
        assert.match(rows[1], /✗Hook secret optional/);
        assert.match(rows[2], /✓Dart tool✓VS Code✓terminal/, 'a tool: two marks');
        $(w, `[data-toggle="${FILE}#main/key"]`)[0].click();
        const opts = $(w, '.row.d4').map((r) => r.textContent);
        assert.match(opts[0], /✓env APP_KEY default✓VS Code✗terminal/);
        assert.match(opts[1], /✗file ~\/\.app\/key/);
        assert.equal($(w, '.row.d4 .codicon-warning').length, 1, 'the warning');
    });

    test('PD-3: details, open, filter, problems', () => {
        const { w, posted } = setup();
        send(w, base({ tree: tree(CHECKED), checkedAt: '2026-11-17T12:00:00.000Z', durationMs: 10, expanded: { [FILE]: true, [`${FILE}#main/key`]: true } }));
        $(w, `[data-details="${FILE}#main/key"]`)[0].click();
        assert.match(text(w), /What for For the calls\./);
        assert.match(text(w), /How to get it From the console\./);
        $(w, `[data-details="${optionKey(FILE, 'main', 'key', 0, 'env')}"]`)[0].click();
        assert.match(text(w), /name: APP_KEY/);
        assert.match(text(w), /detail-set/);
        assert.match(text(w), /⚠ not in a terminal/);
        $(w, '[data-open][data-nodeid="main/key"]')[0].click();
        assert.deepEqual(posted.at(-1), { type: 'open', file: FILE, nodeId: 'main/key' });
        const missing = $(w, 'input[data-filter="missingOnly"]')[0];
        missing.checked = true;
        missing.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.at(-1), { type: 'filter', filter: { missingOnly: true, requiredOnly: false } });
        assert.doesNotMatch(text(w), /The key/, 'set items hidden');
        assert.match(text(w), /Hook secret/);
        assert.equal($(w, `[data-node="${'/ws/repo/broken/prerequisites.yaml'}"] .codicon-warning`).length, 1, 'a broken file shows its problem');
    });
});
