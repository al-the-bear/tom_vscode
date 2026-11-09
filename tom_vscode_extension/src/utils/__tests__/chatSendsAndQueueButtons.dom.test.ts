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
 *   CB-5 the host: Save to Queue pins nothing unless usePanelTarget; Queue next goes through
 *        enqueueNext, pending; queueAdded names the section and slot; the Logs actions go to the chat
 *        panel's runSessionAction
 *   CB-6 Queue next (+ and the send-between icon) posts addToQueue with next, on Anthropic, nothing pinned
 *   CB-8 a chat send in the queue shown like a normal entry: the complete prompt (every line, nothing cut, as
 *        mainprompt-content), the header without a prompt excerpt; a long answer's first 600 characters with
 *        the expand / collapse toggle opening the whole answer in place and the two Markdown buttons; a running
 *        `chat` item without an answer has the prompt and no answer block, and the answer block once it arrived
 *   CB-7 Keep per prompt slot: checked by default; an unchecked slot is cleared after Send and after the
 *        host confirms a queue add (only that slot; the Copilot text is untouched); the flag follows the
 *        slot, is saved with the drafts (slotKeep) and restored from them
 */

/* eslint-disable @typescript-eslint/naming-convention -- prompt slots "1"-"9" are the keys the drafts store */
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
        assert.match(panel, /transport === 'anthropic' && transportOpts\?\.usePanelTarget && !next\s*\?\s*\{ anthropicProfileId: transportOpts\.anthropicProfileId, anthropicConfigId: transportOpts\.anthropicConfigId, session: this\._chatSessionKey\(\) \}/);
        // Queue next goes through enqueueNext, pending (not deferred); the origin is echoed in queueAdded.
        assert.match(panel, /await \(next \? queue\.enqueueNext\.bind\(queue\) : queue\.enqueue\.bind\(queue\)\)\(\{/);
        assert.match(panel, /deferSend: !next,/);
        assert.match(panel, /type: 'queueAdded', count, \.\.\.\(origin\?\.section \? \{ section: origin\.section \} : \{\}\), \.\.\.\(origin\?\.slot \? \{ slot: origin\.slot \} : \{\}\)/);
        assert.match(panel, /export async function runChatSessionAction/);
        const logs = src('handlers', 'questLogs-handler.ts');
        assert.match(logs, /case 'qlogSessionAction':[\s\S]{0,400}runChatSessionAction\(action, session\)/);
    });

    test('CB-6: Queue next', () => {
        const { w, posted } = chatPanel();
        const btn = w.document.querySelector('[data-action="addToQueueNext"][data-id="anthropic"]');
        assert.ok(btn.querySelector('.codicon-add') && btn.querySelector('.codicon-debug-step-into'), '+ and the send-between icon');
        w.document.getElementById('anthropic-profile').innerHTML = '<option value="opus-direct" selected>Opus</option>';
        w.document.getElementById('anthropic-text').value = 'Now';
        btn.click();
        const m = posted.filter((x) => x.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.equal(m.next, true);
        assert.equal(m.transport, 'anthropic');
        assert.equal(m.anthropicProfileId, undefined, 'the queue\'s profile and session');
        assert.equal(m.section, 'anthropic');
        assert.equal(m.slot, 1);
    });

    test('CB-7: Keep per prompt slot', () => {
        const { w, posted } = chatPanel();
        const doc = w.document;
        const fire = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        // Slot 2 does not keep its text (as saved before a reload); slot 1 has no entry: it keeps.
        fire({ type: 'draftsLoaded', sections: { anthropic: { activeSlot: 1, slots: { '1': 'one', '2': 'two' }, slotKeep: { '2': false } } } });
        const keep = doc.getElementById('anthropic-keep-slot');
        const text = doc.getElementById('anthropic-text');
        assert.equal(keep.checked, true, 'slot 1 keeps (the default)');
        // Send from slot 1: kept.
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(text.value, 'one');
        fire({ type: 'anthropicResult', toolCallCount: 0 });
        // Slot 2: the box follows the slot; Send clears it.
        doc.querySelector('.slot-btn[data-id="anthropic"][data-slot="2"]').click();
        assert.equal(keep.checked, false);
        assert.equal(text.value, 'two');
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'sendAnthropic').pop()?.text, 'two', 'sent first');
        assert.equal(text.value, '', 'then cleared');
        // A queue add clears the slot it came from once the host confirms — not the Copilot text.
        text.value = 'queued';
        doc.querySelector('[data-action="addToQueue"][data-id="anthropic"]').click();
        assert.equal(text.value, 'queued', 'not before the host confirms');
        doc.getElementById('copilot-text').value = 'copilot stays';
        fire({ type: 'queueAdded', count: 1, section: 'anthropic', slot: 2 });
        assert.equal(text.value, '');
        assert.equal(doc.getElementById('copilot-text').value, 'copilot stays');
        // Checking the box on slot 1 sets slot 1 only, and the drafts carry the map.
        doc.querySelector('.slot-btn[data-id="anthropic"][data-slot="1"]').click();
        keep.checked = false;
        keep.dispatchEvent(new w.Event('change'));
        doc.querySelector('.slot-btn[data-id="anthropic"][data-slot="2"]').click();
        assert.equal(keep.checked, false);
        assert.deepEqual(JSON.parse(JSON.stringify(w.ensureSlotState('anthropic').keep)), { '1': false, '2': false });
        const src2 = media('chatPanel', 'main.js');
        assert.match(src2, /slotKeep: anthrSectionState\.keep \|\| \{\}/, 'saved with the drafts');
    });

    test('CB-8: a chat send shown like a normal entry', () => {
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        open.push(w);
        const posted: Array<Record<string, unknown>> = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined });
        const longLine = 'word '.repeat(60).trim();
        const prompt = `First line of the prompt\n${longLine}\nthird line`;
        const answer = `# Answer\n\n${'x'.repeat(700)}\nTHE-END`;
        const base = { type: 'normal', transport: 'anthropic', template: '(none)', anthropicProfileId: 'opus-direct', session: 'chat', chatSource: 'panel', createdAt: new Date().toISOString() };
        const items = [
            { ...base, id: 'c1', status: 'chat-sent', originalText: prompt, expandedText: prompt, answerText: answer, sendUsageLine: 'in 10 · out 20' },
            { ...base, id: 'c2', status: 'chat', originalText: 'still running\nsecond line', expandedText: 'still running' },
        ];
        w.__INIT__ = { state: { items, autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
        w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
        const entry = (id: string): Win => w.document.querySelector(`.queue-item.chat-item[data-qid="${id}"]`);
        const sent = entry('c1');
        // The complete prompt, every line, nothing cut; the header keeps its meta and no excerpt.
        const text = sent.querySelector('.mainprompt-content');
        assert.equal(text.textContent, prompt);
        assert.equal(text.getAttribute('style'), 'margin:4px 0; white-space:pre-wrap;');
        assert.equal(sent.querySelector('.chat-item-prompt'), null);
        assert.match(sent.querySelector('.chat-item-meta').textContent, /panel · opus-direct · session chat · Σ in 10 · out 20/);
        // The answer: the first 600 characters, the toggle, the two Markdown buttons.
        const ans = sent.querySelector('.answer-preview');
        assert.ok(ans, 'the answer block');
        assert.ok(!ans.textContent.includes('THE-END'), 'cut at 600 characters');
        assert.ok(ans.querySelector('.qe-md-btn[data-qe-md-mode="overlay"]') && ans.querySelector('.qe-md-btn[data-qe-md-mode="editor"]'), 'both Markdown buttons');
        const toggle = ans.querySelector('.answer-toggle-icon');
        assert.ok(toggle, 'the expand / collapse toggle');
        const ansId = /toggleAnswerExpand\('([^']+)'\)/.exec(toggle.getAttribute('onclick'))![1];
        w.toggleAnswerExpand(ansId);
        assert.ok(entry('c1').querySelector('.answer-preview').textContent.includes('THE-END'), 'the whole answer in place');
        w.toggleAnswerExpand(ansId);
        assert.ok(!entry('c1').querySelector('.answer-preview').textContent.includes('THE-END'), 'collapsed again');
        // A running chat send without an answer: the prompt, no answer block, no error.
        const running = entry('c2');
        assert.equal(running.querySelector('.chat-badge').textContent, 'CHAT');
        assert.equal(running.querySelector('.mainprompt-content').textContent, 'still running\nsecond line');
        assert.equal(running.querySelector('.answer-preview'), null);
        assert.equal(running.querySelector('.chat-error'), null);
        // Its answer arrives while it still runs: the answer block appears.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: [items[0], { ...items[1], answerText: 'partial answer' }], autoSend: false } }));
        assert.match(entry('c2').querySelector('.answer-preview').textContent, /partial answer/);
    });
});

