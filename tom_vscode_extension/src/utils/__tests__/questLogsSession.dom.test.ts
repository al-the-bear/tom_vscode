/**
 * The @CHAT Logs viewer's session choice (media/questLogs/main.js): one session
 * for the whole viewer, so MD Trail and Trail (the same live-trail.md) never
 * disagree.
 *
 *   QS-1 a session chosen on one tab (button click) is the session every other tab asks for, and is saved once
 *   QS-2 the host settling the choice (a plan for a deleted session) settles it for every tab
 *   QS-3 state saved per tab (`sessions`, tab → name) is read as one session: the active tab's, else the first
 *   QS-4 every session action behind the switch (raw trail, trail summary, history, live trail, memory, clear) posts
 *        the selected session, not `default`, and its title names it
 */

import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import * as path from 'path';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { getQuestLogsHtmlFragment, getQuestLogsScript } from '../../handlers/questLogs-handler.js';

setExtensionPath(path.resolve(__dirname, '..', '..', '..'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
interface Posted { type: string; viewer?: string; tab?: string; session?: string; action?: string }

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
    win.eval(getQuestLogsScript());
    return { win, posted, state: () => state };
}

const logs = (win: Win) => win.qlogViewerList[0];
const lastRequest = (posted: Posted[]) => [...posted].reverse().find((m) => m.type === 'qlogRequest' && m.viewer === 'logs');
const plan = (tab: string, sessions: string[], selected: string) => ({
    type: 'qlogSessions', viewer: 'logs', tab, variant: 'chat-literal',
    plan: { sessions, buttons: sessions, showDropdown: false, selected },
});

describe('@CHAT Logs: one session for every tab', () => {
    test('QS-1: chosen on one tab, used on all', () => {
        const { win, posted, state } = mount();
        const viewer = logs(win);
        assert.equal(viewer.state.tab, 'mdTrail');
        viewer.onMessage(plan('mdTrail', ['default', 'chat', 'op5'], 'default'));
        const btn = win.document.querySelector('[data-qlog-session="op5"]');
        assert.ok(btn, 'the plan draws a button per session');
        viewer.start();
        btn.click();
        assert.deepEqual([lastRequest(posted)?.tab, lastRequest(posted)?.session], ['mdTrail', 'op5']);
        for (const tab of ['trail', 'prompts', 'answers', 'currentPrompt']) {
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
        assert.equal(lastRequest(active.posted)?.session, 'op5_5-direct-default', 'MD Trail follows Trail');
        const first = mount({ qlog_logs: { tab: 'prompts', sessions: { mdTrail: '', trail: 'walk' } } });
        assert.equal(logs(first.win).state.session, 'walk', 'else the first choice made');
        const none = mount({ qlog_logs: { tab: 'trail' } });
        assert.equal(logs(none.win).state.session, '');
    });
    test('QS-4: the session actions act on the selected session', () => {
        const { win, posted } = mount();
        const viewer = logs(win);
        viewer.onMessage(plan('mdTrail', ['default', 'chat', 'op5'], 'default'));
        viewer.start();
        win.document.querySelector('[data-qlog-session="op5"]').click();
        const buttons = [...win.document.querySelectorAll('[data-qlog-session-action]')] as Array<{ getAttribute(n: string): string; click(): void }>;
        assert.deepEqual(buttons.map((b) => b.getAttribute('data-qlog-session-action')), ['rawTrail', 'trailSummary', 'history', 'liveTrail', 'memory', 'clearHistory']);
        for (const b of buttons) {
            b.click();
            const sent = posted.filter((m) => m.type === 'qlogSessionAction').at(-1)!;
            assert.deepEqual([sent.action, sent.session], [b.getAttribute('data-qlog-session-action'), 'op5']);
            assert.match(b.getAttribute('title'), /op5/, `${b.getAttribute('data-qlog-session-action')}: the title names the session`);
        }
    });
});
