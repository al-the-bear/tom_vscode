/**
 * The session switch of the @WS Logs tabs (src/utils/sessionSwitch.ts) and its rendering in the webview
 * (media/questLogs/main.js).
 *
 *   SW-1 the plan for 0, 1, 4, 5 and 9 sessions: one button per session up to four; with more, a dropdown with
 *        every session and buttons for the four most recently used
 *   SW-2 the order: most recently used first, never-used sessions by name; a duplicate counts once
 *   SW-3 the choice: kept while the session exists; unknown or deleted → `default` when there is one, else the
 *        most recently used
 *   SW-4 the webview: draws the plan's buttons (and the dropdown only with more than four), a click asks for that
 *        session's file and the choice is remembered per tab; a reply for another session is not painted; the
 *        Documentation viewer shows its Documents pane on that tab and polls nothing there
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { MAX_SESSION_BUTTONS, orderSessionsByUse, planSessionSwitch, type SwitchSession } from '../sessionSwitch.js';

const at = (n: number): number => Date.parse('2026-10-27T12:00:00Z') + n * 60_000;
const many = (n: number): SwitchSession[] => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, lastUse: at(i) }));

describe('session switch plan', () => {
    test('SW-1: 0, 1, 4, 5, 9 sessions', () => {
        assert.equal(MAX_SESSION_BUTTONS, 4);
        assert.deepEqual(planSessionSwitch([], undefined, 'default'), { sessions: [], buttons: [], showDropdown: false, selected: 'default' });
        assert.deepEqual(planSessionSwitch([{ name: 'default' }], undefined, 'default'),
            { sessions: ['default'], buttons: ['default'], showDropdown: false, selected: 'default' });
        const four = planSessionSwitch(many(4), 's1', 'default');
        assert.deepEqual([four.buttons, four.showDropdown, four.selected], [['s3', 's2', 's1', 's0'], false, 's1'], 'four: buttons only');
        const five = planSessionSwitch(many(5), undefined, 'default');
        assert.deepEqual([five.sessions, five.buttons, five.showDropdown], [['s4', 's3', 's2', 's1', 's0'], ['s4', 's3', 's2', 's1'], true],
            'five: the dropdown holds every session, the four most recent get buttons');
        const nine = planSessionSwitch(many(9), 's0', 'default');
        assert.deepEqual([nine.buttons, nine.showDropdown, nine.selected, nine.sessions.length], [['s8', 's7', 's6', 's5'], true, 's0', 9],
            'a choice without a button is shown in the dropdown');
    });

    test('SW-2: the order', () => {
        assert.deepEqual(orderSessionsByUse([
            { name: 'old', lastUse: at(1) }, { name: 'never-b' }, { name: 'new', lastUse: at(5) }, { name: 'never-a' }, { name: 'new', lastUse: at(0) },
        ]), ['new', 'old', 'never-a', 'never-b']);
    });

    test('SW-3: the choice', () => {
        const list = [{ name: 'default', lastUse: at(1) }, { name: 'chat', lastUse: at(2) }, { name: 'walk', lastUse: at(3) }];
        assert.equal(planSessionSwitch(list, 'chat', 'default').selected, 'chat');
        assert.equal(planSessionSwitch(list, 'deleted', 'default').selected, 'default', 'a deleted session falls back');
        assert.equal(planSessionSwitch(list.slice(1), undefined, 'default').selected, 'walk', 'no default: the most recent');
    });
});

// ---------------------------------------------------------------------------
// The webview
// ---------------------------------------------------------------------------

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const VIEWERS = [
    { id: 'logs', prefix: 'qlog', section: 'logs', tabIds: ['mdTrail', 'trail', 'prompts', 'answers', 'currentPrompt'], defaultTab: 'mdTrail', sessions: true },
    {
        id: 'docs', prefix: 'qdoc', section: 'documentation', tabIds: ['documents', 'progress', 'overview'],
        defaultTab: 'documents', paneTabs: { documents: 'qdoc-documents-pane' }, sessions: false,
    },
];

const HTML = `<body>
<div id="qlog-sessions"></div>
<div id="qlog-tabs"><button data-qlog-tab="mdTrail"></button><button data-qlog-tab="trail"></button></div>
<select id="qlog-variant"></select><button id="qlog-refresh"></button><button id="qlog-open"></button>
<div id="qlog-body"></div><div id="qlog-status"></div>
<div id="qdoc-tabs"><button data-qlog-tab="documents"></button><button data-qlog-tab="progress"></button></div>
<button id="qdoc-refresh"></button><button id="qdoc-open"></button>
<div id="qdoc-documents-pane">editor</div><div id="qdoc-body" hidden></div><div id="qdoc-status" hidden></div>
</body>`;

function setup(t: { after(fn: () => void): void }, state?: Record<string, unknown>): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    let saved: Record<string, unknown> | undefined = state;
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s: Record<string, unknown>) => { saved = s; } };
    w.isExpanded = () => true;
    w.__saved = () => saved;
    w.eval(`var qlogViewers = ${JSON.stringify(VIEWERS)}; var qlogVariantTabs = ['currentPrompt']; var qlogVariantIds = ['chatLiteral','queueUser']; var qlogDefaultVariant = 'chatLiteral';\n`
        + readMedia('questLogs', 'main.js'));
    return { w, posted };
}

const flush = (w: Win): Promise<void> => new Promise((r) => w.setTimeout(r, 5));
const send = (w: Win, data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
const plan = (sessions: string[], selected: string) => ({ sessions, buttons: sessions.slice(0, 4), showDropdown: sessions.length > 4, selected });

describe('session switch in the webview', () => {
    test('SW-4: drawing, switching, remembering', async (t) => {
        const { w, posted } = setup(t);
        await flush(w);
        const first = posted.find((m) => m.viewer === 'logs');
        assert.deepEqual(first, { type: 'qlogRequest', viewer: 'logs', tab: 'mdTrail', variant: 'chatLiteral', session: '', force: true },
            'the first request lets the host choose the session');
        assert.equal(posted.some((m) => m.viewer === 'docs'), false, 'the Documents pane polls nothing');

        send(w, { type: 'qlogSessions', viewer: 'logs', tab: 'mdTrail', plan: plan(['default', 'chat', 'walk'], 'default') });
        const box = w.document.getElementById('qlog-sessions');
        assert.equal(box.querySelector('select'), null, 'three sessions: no dropdown');
        assert.deepEqual([...box.querySelectorAll('button')].map((b: Win) => [b.textContent, b.classList.contains('active')]),
            [['default', true], ['chat', false], ['walk', false]]);

        send(w, { type: 'qlogContent', viewer: 'logs', tab: 'mdTrail', session: 'default', exists: true, html: '<p>default trail</p>', newestAt: 'end', fileName: 'live-trail.md', bytes: 10 });
        assert.match(w.document.getElementById('qlog-body').innerHTML, /default trail/);

        posted.length = 0;
        box.querySelector('[data-qlog-session="chat"]').click();
        assert.deepEqual(posted.pop(), { type: 'qlogRequest', viewer: 'logs', tab: 'mdTrail', variant: 'chatLiteral', session: 'chat', force: true });
        send(w, { type: 'qlogContent', viewer: 'logs', tab: 'mdTrail', session: 'default', exists: true, html: '<p>late reply</p>', newestAt: 'end', fileName: 'x', bytes: 1 });
        assert.doesNotMatch(w.document.getElementById('qlog-body').innerHTML, /late reply/, 'a reply for the previous session is dropped');
        send(w, { type: 'qlogContent', viewer: 'logs', tab: 'mdTrail', session: 'chat', exists: false, fileName: 'sessions/chat/live-trail.md', newestAt: 'end' });
        assert.equal(w.document.getElementById('qlog-body').textContent, 'Session "chat" has no live-trail.md yet', 'an empty state, not an error');
        assert.deepEqual(JSON.parse(JSON.stringify(w.__saved())).qlog_logs.sessions, { mdTrail: 'chat' }, 'remembered per tab');

        send(w, { type: 'qlogSessions', viewer: 'logs', tab: 'mdTrail', plan: plan(['a', 'b', 'c', 'd', 'chat', 'default'], 'chat') });
        const select = box.querySelector('select');
        assert.ok(select, 'six sessions: the dropdown');
        assert.equal(select.value, 'chat', 'the choice without a button is shown there');
        assert.equal(box.querySelectorAll('button').length, 4);
        posted.length = 0;
        select.value = 'default';
        select.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(posted.pop()?.session, 'default');
    });

    test('SW-4: the Documentation viewer', async (t) => {
        const { w, posted } = setup(t);
        await flush(w);
        assert.equal(w.document.getElementById('qdoc-documents-pane').hidden, false);
        assert.equal(w.document.getElementById('qdoc-body').hidden, true);
        w.document.querySelector('#qdoc-tabs [data-qlog-tab="progress"]').click();
        assert.equal(w.document.getElementById('qdoc-documents-pane').hidden, true);
        assert.equal(w.document.getElementById('qdoc-body').hidden, false);
        assert.deepEqual(posted.pop(), { type: 'qlogRequest', viewer: 'docs', tab: 'progress', variant: 'chatLiteral', session: '', force: true });
    });

    test('SW-4: the single-viewer state is read', async (t) => {
        const { w, posted } = setup(t, { qlogTab: 'trail', qlogVariant: 'queueUser' });
        await flush(w);
        assert.equal(posted.find((m) => m.viewer === 'logs')?.tab, 'trail', 'the tab chosen before this build');
    });
});
