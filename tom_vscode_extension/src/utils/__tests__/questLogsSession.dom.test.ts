/**
 * The @CHAT Logs viewer (media/questLogs/main.js): its tabs, the session choice
 * (one session for the whole viewer, so Trail, Live Trail and Live Source never
 * disagree) and the Trail tab's pairs.
 *
 *   QS-1 a session chosen on one tab (button click) is the session every other tab asks for, and is saved once
 *   QS-2 the host settling the choice (a plan for a deleted session) settles it for every tab
 *   QS-3 state saved per tab (`sessions`, tab → name) is read as one session: the active tab's, else the first
 *   QS-4 every session action behind the switch (raw trail, trail summary, history, live trail, memory, clear) posts
 *        the selected session, not `default`, and its title names it — but the memory button's: the quest memory
 *        has no session level, its title says it is shared by every session
 *   QS-5 the tabs: Trail (the default), Live Trail, Live Source — no Prompts, Answers or Current Prompt tab, no
 *        prompt selector
 *   QS-6 the Trail tab shows the host's pairs; each pair's buttons post `qlogTurnAction` with the pair's turn and
 *        the session, its todo links `qlogGotoTodo`; `qlogMarkdown` opens the Markdown overlay
 */

import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import * as path from 'path';
import { readFileSync } from 'fs';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { getQuestLogsHtmlFragment, getQuestLogsScript } from '../../handlers/questLogs-handler.js';
import { renderSessionTrailHtml, sessionTrailTurns } from '../sessionTrailTurns.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
setExtensionPath(EXT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
interface Posted { type: string; viewer?: string; tab?: string; session?: string; action?: string; turn?: string; todo?: string }

// The viewer polls every 2.5 s: every window is closed after its test, passed or failed.
const open: Win[] = [];
afterEach(() => { while (open.length) { open.pop().close(); } });

function mount(saved: Record<string, unknown> = {}): { win: Win; posted: Posted[]; state: () => Record<string, Record<string, unknown>> } {
    const dom = new JSDOM(`<!DOCTYPE html><body>${getQuestLogsHtmlFragment()}</body>`, { runScripts: 'outside-only' });
    const win: Win = dom.window;
    open.push(win);
    const posted: Posted[] = [];
    let state: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(saved));
    win.vscode = {
        postMessage: (m: Posted) => posted.push(m),
        getState: () => state,
        setState: (s: Record<string, Record<string, unknown>>) => { state = s; },
    };
    win.isExpanded = () => true;
    win.eval(readFileSync(path.join(EXT, 'media', 'shared', 'mdOverlay.js'), 'utf-8'));
    win.eval(getQuestLogsScript());
    return { win, posted, state: () => state };
}

const logs = (win: Win) => win.qlogViewerList[0];
const lastRequest = (posted: Posted[]) => [...posted].reverse().find((m) => m.type === 'qlogRequest' && m.viewer === 'logs');
const plan = (tab: string, sessions: string[], selected: string) => ({
    type: 'qlogSessions', viewer: 'logs', tab,
    plan: { sessions, buttons: sessions, showDropdown: false, selected },
});

describe('@CHAT Logs: one session for every tab', () => {
    test('QS-1: chosen on one tab, used on all', () => {
        const { win, posted, state } = mount();
        const viewer = logs(win);
        assert.equal(viewer.state.tab, 'turns');
        viewer.onMessage(plan('turns', ['default', 'chat', 'op5'], 'default'));
        const btn = win.document.querySelector('[data-qlog-session="op5"]');
        assert.ok(btn, 'the plan draws a button per session');
        viewer.start();
        btn.click();
        assert.deepEqual([lastRequest(posted)?.tab, lastRequest(posted)?.session], ['turns', 'op5']);
        for (const tab of ['mdTrail', 'trail', 'turns']) {
            win.document.querySelector(`[data-qlog-tab="${tab}"]`).click();
            assert.deepEqual([lastRequest(posted)?.tab, lastRequest(posted)?.session], [tab, 'op5'], `${tab} asks for the chosen session`);
            assert.equal(win.document.querySelector('.qlog-session-btn.active')?.getAttribute('data-qlog-session'), 'op5', `${tab} marks the chosen session`);
        }
        assert.equal(state().qlog_logs.session, 'op5');
        assert.equal(state().qlog_logs.sessions, undefined, 'no per-tab map is saved any more');
    });

    test('QS-2: the host settles the choice for every tab', () => {
        const { win, posted } = mount({ qlog_logs: { tab: 'trail', session: 'gone' } });
        const viewer = logs(win);
        viewer.start();
        assert.equal(lastRequest(posted)?.session, 'gone');
        viewer.onMessage(plan('trail', ['default', 'chat'], 'default'));
        viewer.select.tab('mdTrail');
        assert.deepEqual([lastRequest(posted)?.tab, lastRequest(posted)?.session], ['mdTrail', 'default']);
    });

    test('QS-3: per-tab state of older builds', () => {
        const active = mount({ qlog_logs: { tab: 'trail', sessions: { mdTrail: 'chat', trail: 'op5_5-direct-default' } } });
        assert.equal(logs(active.win).state.session, 'op5_5-direct-default', 'the active tab\'s choice');
        logs(active.win).select.tab('mdTrail');
        assert.equal(lastRequest(active.posted)?.session, 'op5_5-direct-default', 'Live Trail follows Live Source');
        const first = mount({ qlog_logs: { tab: 'mdTrail', sessions: { mdTrail: '', trail: 'walk' } } });
        assert.equal(logs(first.win).state.session, 'walk', 'else the first choice made');
        const none = mount({ qlog_logs: { tab: 'trail' } });
        assert.equal(logs(none.win).state.session, '');
    });
    test('QS-4: the session actions act on the selected session', () => {
        const { win, posted } = mount();
        const viewer = logs(win);
        viewer.onMessage(plan('turns', ['default', 'chat', 'op5'], 'default'));
        viewer.start();
        win.document.querySelector('[data-qlog-session="op5"]').click();
        const buttons = [...win.document.querySelectorAll('[data-qlog-session-action]')] as Array<{ getAttribute(n: string): string; click(): void }>;
        assert.deepEqual(buttons.map((b) => b.getAttribute('data-qlog-session-action')), ['rawTrail', 'trailSummary', 'history', 'liveTrail', 'memory', 'clearHistory']);
        for (const b of buttons) {
            b.click();
            const sent = posted.filter((m) => m.type === 'qlogSessionAction').at(-1)!;
            assert.deepEqual([sent.action, sent.session], [b.getAttribute('data-qlog-session-action'), 'op5']);
            if (b.getAttribute('data-qlog-session-action') === 'memory') {
                assert.equal(b.getAttribute('title'), 'Open the memory panel: the quest memory (curated files and the candidates files of the hosts), shared by every session');
            } else {
                assert.match(b.getAttribute('title'), /op5/, `${b.getAttribute('data-qlog-session-action')}: the title names the session`);
            }
        }
    });

    test('QS-5: the tabs', () => {
        const { win } = mount({ qlog_logs: { tab: 'currentPrompt', variant: 'chatLiteral' } });
        const tabs = [...win.document.querySelectorAll('#qlog-tabs [data-qlog-tab]')] as Array<{ getAttribute(n: string): string; textContent: string }>;
        assert.deepEqual(tabs.map((t) => [t.getAttribute('data-qlog-tab'), t.textContent.trim()]),
            [['turns', 'Trail'], ['mdTrail', 'Live Trail'], ['trail', 'Live Source']]);
        assert.equal(win.document.querySelector('#qlog-variant'), null, 'no prompt selector');
        assert.equal(logs(win).state.tab, 'turns', 'a removed tab saved by an older build shows the Trail tab');
    });

    test('QS-6: the Trail tab\'s pairs and their actions', () => {
        const { win, posted } = mount();
        const viewer = logs(win);
        viewer.onMessage(plan('turns', ['default', 'chat'], 'chat'));
        viewer.start();
        const turns = sessionTrailTurns([
            { id: 'r1', time: '2026-11-25T10:00:00.000Z', host: 'h', session: 'chat', profile: 'p', model: 'm', prompt: 'first', answer: 'one\n\nvariables:\n - TODO = _ai/quests/q/todos.q.todo.yaml/q1\n' },
            { id: 'r2', time: '2026-11-25T11:00:00.000Z', host: 'h', session: 'chat', profile: 'p', model: 'm', prompt: 'second', answer: 'two' },
        ], 'chat');
        viewer.onMessage({ type: 'qlogContent', viewer: 'logs', tab: 'turns', session: 'chat', exists: true, newestAt: 'start', fileName: 'trail.h.md', bytes: 10, turns: 2, html: renderSessionTrailHtml('chat', turns) });
        const body = win.document.getElementById('qlog-body');
        assert.deepEqual([...body.querySelectorAll('.qlog-turn')].map((b: { getAttribute(n: string): string }) => b.getAttribute('data-qlog-turn')), ['r2', 'r1']);
        assert.match(win.document.getElementById('qlog-status').textContent, /^2 turns · trail\.h\.md/);

        body.querySelector('[data-qlog-turn="r1"] [data-qlog-turn-action="copyAnswer"]').click();
        const action = posted.filter((m) => m.type === 'qlogTurnAction').at(-1)!;
        assert.deepEqual([action.action, action.turn, action.session, action.tab], ['copyAnswer', 'r1', 'chat', 'turns']);
        body.querySelector('[data-qlog-turn="r1"] [data-qlog-todo]').click();
        const todo = posted.filter((m) => m.type === 'qlogGotoTodo').at(-1)!;
        assert.equal(todo.todo, '_ai/quests/q/todos.q.todo.yaml/q1');

        viewer.onMessage({ type: 'qlogMarkdown', viewer: 'logs', tab: 'turns', session: 'chat', title: 'the pair', html: '<h2>Prompt</h2><p>first</p>' });
        const overlay = win.document.querySelector('.tom-md-overlay');
        assert.ok(overlay && overlay.classList.contains('visible'), 'the Markdown overlay');
        assert.equal(overlay.querySelector('.tom-md-title').textContent, 'the pair');
        assert.match(overlay.querySelector('.tom-md-body').innerHTML, /<h2>Prompt<\/h2>/);
    });
});
