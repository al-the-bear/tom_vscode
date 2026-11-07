/**
 * Chat sends, Save to Queue and the session actions (webview side).
 *
 *   CB-1 the ANTHROPIC/LLM panel has two Save to Queue buttons: the first posts addToQueue on
 *        Anthropic without a profile (the queue's own profile and session), the second pins the
 *        panel's profile (usePanelTarget, the host adds the panel's session)
 *   CB-2 the trail, history and memory buttons are no longer in the panel's action bar
 *   CB-3 the queue editor shows a chat send read-only: CHAT while it runs, CHAT SENT with its answer
 *        (and the markdown buttons) or its error; no queue controls; the count line says a chat runs
 *   CB-4 the @WS Logs panel shows the six session actions behind the session switch; each posts
 *        qlogSessionAction with the selected session; the host runs runChatSessionAction
 *   CB-5 the host: Save to Queue pins nothing unless usePanelTarget; the Logs actions go to the chat
 *        panel's runSessionAction
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
import { getQuestLogsHtmlFragment, getQuestLogsScript } from '../../handlers/questLogs-handler.js';

const ROOT = join(__dirname, '..', '..', '..');
setExtensionPath(path.resolve(ROOT));
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
const open: Win[] = [];
afterEach(() => { while (open.length) { open.pop().close(); } });

function chatPanel(): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    open.push(w);
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded: ['anthropic'], pinned: [] }) });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    return { w, posted };
}

describe('chat sends and the queue buttons', () => {
    test('CB-1: two Save to Queue buttons', () => {
        const { w, posted } = chatPanel();
        const profile = w.document.getElementById('anthropic-profile');
        profile.innerHTML = '<option value="opus-direct" selected>Opus</option>';
        w.document.getElementById('anthropic-text').value = 'Do it';
        w.document.querySelector('[data-action="addToQueue"][data-id="anthropic"]').click();
        const first = posted.filter((m) => m.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.equal(first.transport, 'anthropic');
        assert.equal(first.anthropicProfileId, undefined, 'the queue\'s own profile');
        assert.equal(first.usePanelTarget, undefined);
        w.document.getElementById('anthropic-text').value = 'Do it';
        w.document.querySelector('[data-action="addToQueuePanelTarget"][data-id="anthropic"]').click();
        const second = posted.filter((m) => m.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.equal(second.anthropicProfileId, 'opus-direct');
        assert.equal(second.usePanelTarget, true);
    });

    test('CB-2: the moved buttons are gone from the panel', () => {
        const { w } = chatPanel();
        for (const action of ['openTrailRawFiles', 'openTrailSummaryViewer', 'openSessionHistory', 'openLiveTrail', 'openAnthropicMemory', 'clearAnthropicHistory']) {
            assert.equal(w.document.querySelector(`[data-action="${action}"][data-id="anthropic"]`), null, action);
        }
        assert.ok(w.document.querySelector('[data-action="openQueueEditor"][data-id="anthropic"]'), 'the queue editor button stays');
    });

    test('CB-3: chat sends in the queue editor', () => {
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        open.push(w);
        w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        const base = { type: 'normal', transport: 'anthropic', template: '(none)', anthropicProfileId: 'opus-direct', session: 'chat', chatSource: 'panel', createdAt: new Date().toISOString() };
        const items = [
            { ...base, id: 'c1', status: 'chat', originalText: 'Running one', expandedText: 'Running one' },
            { ...base, id: 'c2', status: 'chat-sent', originalText: 'Done one', expandedText: 'Done one', answerText: '# Answer\n\nGreen.' },
            { ...base, id: 'c3', status: 'chat-sent', originalText: 'Failed one', expandedText: 'Failed one', error: 'overloaded' },
        ];
        w.__INIT__ = { state: { items, autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
        w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
        const entry = (id: string): Win => w.document.querySelector(`.queue-item.chat-item[data-qid="${id}"]`);
        assert.equal(entry('c1').querySelector('.chat-badge').textContent, 'CHAT');
        assert.equal(entry('c2').querySelector('.chat-badge').textContent, 'CHAT SENT');
        assert.ok(entry('c2').querySelector('.answer-preview .qe-md-btn[data-qe-md-mode="overlay"]'), 'the answer with its markdown buttons');
        assert.match(entry('c3').textContent, /overloaded/);
        assert.match(entry('c1').textContent, /panel · opus-direct · session chat/);
        for (const id of ['c1', 'c2']) {
            assert.equal(entry(id).querySelectorAll('[onclick*="sendNow"], [onclick*="resend"], select').length, 0, `${id}: no queue controls`);
        }
        assert.match(w.document.getElementById('countLabel').textContent, /Chat: running/);
    });

    test('CB-4: the session actions in the Logs panel', () => {
        const dom = new JSDOM(`<!DOCTYPE html><body>${getQuestLogsHtmlFragment()}</body>`, { runScripts: 'outside-only' });
        const win: Win = dom.window;
        open.push(win);
        const posted: Array<Record<string, unknown>> = [];
        let state: Record<string, unknown> = {};
        win.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(m), getState: () => state, setState: (s: Record<string, unknown>) => { state = s; } };
        win.isExpanded = () => true;
        win.eval(getQuestLogsScript());
        const viewer = win.qlogViewerList[0];
        viewer.onMessage({ type: 'qlogSessions', viewer: 'logs', tab: 'mdTrail', variant: 'chat-literal', plan: { sessions: ['default', 'chat'], buttons: ['default', 'chat'], showDropdown: false, selected: 'chat' } });
        viewer.start();
        win.document.querySelector('[data-qlog-session="chat"]').click();
        const actions = [...win.document.querySelectorAll('[data-qlog-session-action]')].map((b: Win) => b.getAttribute('data-qlog-session-action'));
        assert.deepEqual(actions, ['rawTrail', 'trailSummary', 'history', 'liveTrail', 'memory', 'clearHistory']);
        win.document.querySelector('[data-qlog-session-action="liveTrail"]').click();
        const sent = posted.filter((m) => m.type === 'qlogSessionAction').pop();
        assert.equal(sent?.action, 'liveTrail');
        assert.equal(sent?.session, 'chat');
    });

    test('CB-5: the hosts', () => {
        const panel = src('handlers', 'chatPanel-handler.ts');
        assert.match(panel, /transport === 'anthropic' && transportOpts\?\.usePanelTarget\s*\?\s*\{ anthropicProfileId: transportOpts\.anthropicProfileId, anthropicConfigId: transportOpts\.anthropicConfigId, session: this\._chatSessionKey\(\) \}/);
        assert.match(panel, /export async function runChatSessionAction/);
        const logs = src('handlers', 'questLogs-handler.ts');
        assert.match(logs, /case 'qlogSessionAction':[\s\S]{0,400}runChatSessionAction\(action, session\)/);
    });
});
