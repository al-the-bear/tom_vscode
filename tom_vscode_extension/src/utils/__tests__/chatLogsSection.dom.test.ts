/**
 * The Logs section in @CHAT (moved from @WS): the chat panel's webview (media/chatPanel/) hosts the session logs
 * viewer (media/questLogs/main.js) with the HTML and config the host hands over in its init data.
 *
 *   CL-1 the chat panel has a Logs section after Copilot and Anthropic/LLM, holding the logs viewer's HTML; the viewer
 *        script, loaded after the panel's, finds its config and asks the host for the session's MD Trail once the
 *        section is open
 *   CL-2 opening and closing sections (the panel's saveState) keeps the viewer's saved state (`qlog_logs`): the
 *        webview state is merged, never replaced
 *   CL-3 the hosts: the chat panel passes the fragment and the `logs` viewer's config and routes `qlog*` messages to
 *        the viewer's handler; its page loads the viewer's style and script; @WS keeps only the Documentation viewer
 */

import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { setExtensionPath } from '../../handlers/handler_shared.js';
import { getQuestLogsClientConfig, getQuestLogsHtmlFragment } from '../../handlers/questLogs-handler.js';

const ROOT = join(__dirname, '..', '..', '..');
setExtensionPath(path.resolve(ROOT));
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
// The viewer polls every 2.5 s: every window is closed after its test.
const open: Win[] = [];
afterEach(() => { while (open.length) { open.pop().close(); } });

function chatPanel(saved: Record<string, unknown>): { w: Win; posted: Array<Record<string, unknown>>; state: () => Record<string, unknown> } {
    const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    open.push(w);
    const posted: Array<Record<string, unknown>> = [];
    let state: Record<string, unknown> = JSON.parse(JSON.stringify(saved));
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        getState: () => state,
        setState: (s: Record<string, unknown>) => { state = JSON.parse(JSON.stringify(s)); },
    });
    w.__INIT__ = { questLogs: { html: getQuestLogsHtmlFragment(), config: getQuestLogsClientConfig(['logs']) } };
    w.eval(media('chatPanel', 'main.js'));
    w.eval(media('questLogs', 'main.js'));
    return { w, posted, state: () => state };
}

const requests = (posted: Array<Record<string, unknown>>) => posted.filter((m) => m.type === 'qlogRequest');

describe('@CHAT Logs section', () => {
    test('CL-1: the section and its viewer', async () => {
        const { w, posted } = chatPanel({ expanded: ['logs'], pinned: [] });
        const ids = [...w.document.querySelectorAll('.accordion-section')].map((s: Win) => s.getAttribute('data-section'));
        assert.deepEqual(ids, ['copilot', 'anthropic', 'logs']);
        const section = w.document.querySelector('[data-section="logs"]');
        assert.match(section.querySelector('.title').textContent, /Logs/);
        assert.ok(section.querySelector('#qlog-sessions'), 'the session switch');
        assert.ok(section.querySelector('[data-qlog-tab="mdTrail"]'), 'the tabs');
        assert.equal(w.qlogViewerList.length, 1, 'only the Logs viewer');
        await new Promise((r) => setTimeout(r, 10));
        const first = requests(posted)[0];
        assert.equal(first?.viewer, 'logs');
        assert.equal(first?.tab, 'mdTrail');
    });

    test('CL-2: section toggles keep the viewer state', async () => {
        const { w, state } = chatPanel({ expanded: ['anthropic'], pinned: [], qlog_logs: { tab: 'trail', session: 'op5' } });
        await new Promise((r) => setTimeout(r, 10));
        w.document.querySelector('.header-collapsed[data-toggle="logs"]').click();
        assert.deepEqual(state().expanded, ['logs']);
        const saved = state().qlog_logs as Record<string, unknown>;
        assert.equal(saved?.tab, 'trail');
        assert.equal(saved?.session, 'op5');
        assert.equal(w.qlogViewerList[0].state.tab, 'trail', 'the saved tab is the one shown');
    });

    test('CL-3: the hosts', () => {
        const panel = src('handlers', 'chatPanel-handler.ts');
        assert.match(panel, /questLogs: \{ html: getQuestLogsHtmlFragment\(\), config: getQuestLogsClientConfig\(\['logs'\]\) \}/);
        assert.match(panel, /message\.type\.startsWith\('qlog'\)\) \{\s*await handleQuestLogsMessage\(message, webviewView\.webview\);/);
        const page = media('chatPanel', 'index.html');
        assert.ok(page.indexOf('/main.js') < page.indexOf('../questLogs/main.js'), 'the viewer script after the panel script');
        assert.match(page, /\.\.\/questLogs\/style\.css/);
        const ws = src('handlers', 'wsPanel-handler.ts');
        assert.doesNotMatch(ws, /getQuestLogsHtmlFragment|id: 'logs'/, '@WS has no Logs section');
        assert.match(ws, /getQuestLogsScript\(\['docs'\]\)/);
        assert.deepEqual(getQuestLogsClientConfig(['docs']).viewers.map((v) => (v as { id: string }).id), ['docs']);
    });
});
