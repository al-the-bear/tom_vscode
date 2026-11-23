/**
 * Chat sends, Save to Queue and the session actions (webview side).
 *
 *   CB-1 the ANTHROPIC/LLM panel has two Save to Queue buttons: the first posts addToQueue on
 *        Anthropic without a profile (the queue's own profile and session), the second pins the
 *        panel's profile (usePanelTarget, the host adds the panel's session)
 *   CB-2 the trail, history and memory buttons are no longer in the panel's action bar
 *   CB-3 the queue editor shows a chat send (no queue controls): SENDING CHAT while it runs, SENT CHAT with its answer (vscimpb128)
 *        (and the markdown buttons) or its error; no queue controls; the count line says a chat runs
 *   CB-4 the @CHAT Logs panel shows the six session actions behind the session switch; each posts
 *        qlogSessionAction with the selected session; the host runs runChatSessionAction
 *   CB-5 the host: Save to Queue / Queue next pin nothing unless usePanelTarget, and then go to the default run
 *        with the queue's default template; with the panel's target they take the panel's run, session, profile
 *        and template; Queue next goes through enqueueNext, pending; queueAdded names the section and slot; the
 *        Logs actions go to the chat panel's runSessionAction
 *   CB-14 the action rows (vscimpb151): ANTHROPIC/LLM — Save to Queue and Queue next (the default run) before the
 *        session button and the Run select, Send, Stop and the two panel-target queue buttons after them; the new
 *        "Queue next with this panel's session and run" posts addToQueue with next and usePanelTarget; Copilot —
 *        Save to Queue before its Run select, Send and Save to Queue in this panel's run after it; every action
 *        button an icon button; the Run select narrow, its options without a "Run:" prefix
 *   CB-15 the host's run switch (vscimpb151): switching the ANTHROPIC/LLM run selects Run default, that run's
 *        default session, created when missing
 *   CB-6 Queue next (+ and the send-between icon) posts addToQueue with next, on Anthropic, nothing pinned
 *   CB-8 a chat send in the queue shown like a normal entry: the complete prompt (every line, nothing cut, as
 *        mainprompt-content), the header without a prompt excerpt; a long answer's first 600 characters with
 *        the expand / collapse toggle opening the whole answer in place and the two Markdown buttons; a running
 *        `chat` item without an answer has the prompt and no answer block, and the answer block once it arrived
 *   CB-9 a busy session: the panel's send not sent (anthropicNotSent) frees the Send button and keeps the text;
 *        queued instead clears an unkept slot; in the queue editor a pending item waiting for its session shows
 *        "[waiting for session X]", and a running chat item's Remove is enabled (stops the send)
 *   CB-10 a second Send while a send runs: the button stays enabled (its title says it offers an update or the
 *        queue), the second Send is posted and does not reset the status; the host's reply with panelBusy
 *        (sent as an update, queued, not sent) keeps the running send's state, a reply without it ends it
 *   CB-11 Fresh: a box after Keep, off by default; Send posts `fresh` as it is; restored from the drafts and saved
 *        with them; the status line after the answer names the fresh session's base; the host runs a Fresh send in a
 *        temporary session based on the panel's session (never busy) and discards it completely afterwards
 *   CB-13 a chat send drawn like every item (vscimpb132): the normal header with SENDING CHAT / SENT CHAT, its source,
 *        run and session chips; the headline colour class `chat-kind` (`running` while it runs); collapse / expand
 *        per item and Collapse / Expand all; no move, edit, reminder, pause-after, transport, stage / pending,
 *        preview or resend controls; Delete stays
 *   CB-12 the icon toggles (vscimpb130): Keep, Fresh, Copilot's Keep and Wrap and each subpanel's queue mode are
 *        buttons with aria-pressed (keyboard: buttons, focusable), switched by a click with a `change`; the queue mode
 *        sits right before Save to Queue, pressed (pending) by default; its tooltip and icon name the mode; Save to
 *        Queue posts `initialStatus` pending / staged as it is (Queue next stays pending); kept in the webview state
 *        and saved with the drafts (`queuePending`), restored from either; Copilot's Keep posts setKeepContent
 *   CB-7 Keep per prompt slot: checked by default; an unchecked slot is cleared once the send started
 *        (anthropicSendStarted) and after the host confirms a queue add (only that slot; the Copilot text is untouched); the flag follows the
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

function chatPanel(expanded: string[] = ['anthropic']): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    open.push(w);
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded, pinned: [] }) });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    return { w, posted };
}

/** The 2 s double-click pause of the Send and queue buttons is over (stands in for the time passing). */
function pauseOver(w: Win): void {
    w.eval("document.querySelectorAll('[data-paused-until]').forEach(function (b) { b.removeAttribute('data-paused-until'); b.disabled = false; });");
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
        assert.equal(first.anthropicProfileId, undefined, 'the queue\'s own profile (and the default run, on the host)');
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
        assert.equal(entry('c1').querySelector('.status-kind').textContent, 'SENDING CHAT');
        assert.equal(entry('c2').querySelector('.status-kind').textContent, 'SENT CHAT');
        assert.ok(entry('c2').querySelector('.answer-preview .qe-md-btn[data-qe-md-mode="overlay"]'), 'the answer with its markdown buttons');
        assert.match(entry('c3').textContent, /overloaded/);
        assert.match(entry('c1').querySelector('.status-bar').textContent, /opus-direct.*\[panel\]chat/);
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
        assert.match(panel, /transport === 'anthropic' && panelTarget\s*\?\s*\{[\s\S]{0,200}isRunDefaultChoice\(transportOpts\?\.anthropicProfileId\) \? \{\} : \{ anthropicProfileId: transportOpts\?\.anthropicProfileId, anthropicConfigId: transportOpts\?\.anthropicConfigId \}\),\s*\.\.\.\(isRunDefaultChoice\(this\._chatSessionChoice\(\)\) \? \{\} : \{ session: this\._chatSessionKey\(\) \}\)/,
            'the panel\'s profile and session with its target, Queue next too; Run default sets neither');
        assert.match(panel, /const run = panelTarget \? this\._chatRun\(section\) : DEFAULT_RUN;/, 'the default run unless the panel\'s target');
        assert.match(panel, /const queueTemplate = queue\.runQueueSettings\(DEFAULT_RUN\)\.defaultMessageTemplateId \|\| undefined;/);
        assert.match(panel, /template: panelTarget \? \(template \|\| undefined\) : queueTemplate,/, 'the queue\'s default template unless the panel\'s target');
        assert.match(panel, /run,\s*\/\/ The default run named outright[^\n]*\n\s*runIsExplicit: true,/);
        // Queue next goes through enqueueNext, pending (not deferred); the origin is echoed in queueAdded.
        assert.match(panel, /await \(next \? queue\.enqueueNext\.bind\(queue\) : queue\.enqueue\.bind\(queue\)\)\(\{/);
        assert.match(panel, /deferSend: !next,/);
        assert.match(panel, /initialStatus: !next && transportOpts\?\.staged \? 'staged' : 'pending',/, 'pending unless the queue mode says staged');
        assert.match(panel, /staged: message\.initialStatus === 'staged',/);
        assert.match(panel, /type: 'queueAdded', count, \.\.\.\(origin\?\.section \? \{ section: origin\.section \} : \{\}\), \.\.\.\(origin\?\.slot \? \{ slot: origin\.slot \} : \{\}\)/);
        assert.match(panel, /export async function runChatSessionAction/);
        const logs = src('handlers', 'questLogs-handler.ts');
        assert.match(logs, /case 'qlogSessionAction':[\s\S]{0,400}runChatSessionAction\(action, session\)/);
    });

    test('CB-6: Queue next', () => {
        const { w, posted } = chatPanel();
        const btn = w.document.querySelector('[data-action="addToQueueNext"][data-id="anthropic"]');
        assert.ok(btn.querySelector('.codicon-add') && btn.querySelector('.codicon-arrow-circle-up'), '+ and the arrow up in a circle, the queue item\'s Send next icon');
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
        pauseOver(w);
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'sendAnthropic').pop()?.text, 'two', 'sent first');
        assert.equal(text.value, 'two', 'not before the send started (its session may be busy)');
        fire({ type: 'anthropicSendStarted', slot: 2 });
        assert.equal(text.value, '', 'then cleared');
        fire({ type: 'anthropicResult', toolCallCount: 0 });
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
        assert.match(sent.querySelector('.status-bar').textContent, /opus-direct.*\[Σ in 10 · out 20\].*\[panel\]chat/);
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
        assert.equal(running.querySelector('.status-kind').textContent, 'SENDING CHAT');
        assert.equal(running.querySelector('.mainprompt-content').textContent, 'still running\nsecond line');
        assert.equal(running.querySelector('.answer-preview'), null);
        assert.doesNotMatch(running.textContent, /Error:/);
        // Its answer arrives while it still runs: the answer block appears.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: [items[0], { ...items[1], answerText: 'partial answer' }], autoSend: false } }));
        assert.match(entry('c2').querySelector('.answer-preview').textContent, /partial answer/);
    });

    test('CB-13: a chat send drawn like every item', () => {
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        open.push(w);
        const posted: Array<Record<string, unknown>> = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined });
        const base = { type: 'normal', transport: 'anthropic', template: '(none)', anthropicProfileId: 'opus-direct', session: 'chat', chatSource: 'panel', createdAt: new Date().toISOString() };
        const items = [
            { ...base, id: 'c1', status: 'chat', originalText: 'running prompt', expandedText: 'running prompt', chatActive: true },
            { ...base, id: 'c2', status: 'chat-sent', originalText: 'ended prompt', expandedText: 'ended prompt', answerText: 'the answer', sentAt: new Date().toISOString() },
            { ...base, id: 'p1', status: 'pending', originalText: 'queued', expandedText: 'queued', session: undefined },
        ];
        w.__INIT__ = { state: { items, autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
        w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
        const entry = (id: string): Win => w.document.querySelector(`.queue-item[data-qid="${id}"]`);
        for (const [id, label, running] of [['c1', 'SENDING CHAT', true], ['c2', 'SENT CHAT', false]] as const) {
            const e = entry(id);
            const bar = e.querySelector('.item-header .status-bar');
            assert.ok(bar, `${id}: the normal header`);
            assert.equal(bar.querySelector('.status-kind').textContent, label);
            assert.ok(bar.querySelector('.status-kind').classList.contains('kind-chat'));
            assert.ok(bar.classList.contains('chat-kind'), `${id}: the chat headline colour`);
            assert.equal(bar.classList.contains('running'), running);
            assert.equal(bar.classList.contains('sending') || bar.classList.contains('sent'), false, 'not the colour of a queue item');
            assert.match(bar.querySelector('.chat-source-chip').textContent, /\[panel\]/);
            assert.ok(bar.querySelector('.queue-run-chip:not(.movable)'), `${id}: the run chip, not movable`);
            assert.ok(bar.querySelector('.queue-session-chip:not([onclick])'), `${id}: the session chip, read-only`);
            assert.ok(bar.querySelector('.queue-live-trail-btn'), `${id}: the live trail button`);
            assert.ok(bar.querySelector('[onclick^="remove("]'), `${id}: Delete stays`);
            for (const fn of ['moveUp', 'moveDown', 'moveToFront', 'startTextEdit', 'toggleReminder', 'setPauseAfter', 'editItemTransport', 'applyQueueDefaultTransport', 'setItemStatus', 'sendNow', 'previewItem', 'resend', 'interruptForContinuation', 'continueSending', 'letNextGoFirst', 'moveItemToRun', 'editItemSession']) {
                assert.equal(e.querySelectorAll(`[onclick*="${fn}("]`).length, 0, `${id}: no ${fn}`);
            }
            assert.equal(e.querySelectorAll('select, textarea').length, 0, `${id}: nothing to edit`);
        }
        assert.ok(!entry('p1').querySelector('.status-bar').classList.contains('chat-kind'), 'a queue item keeps its colour');
        // Collapse / expand: per item, then all.
        const body = (id: string): Win => entry(id).querySelector('.mainprompt-content').parentElement;
        assert.ok(!body('c2').classList.contains('details-hidden'));
        w.toggleDetails('c2');
        assert.ok(body('c2').classList.contains('details-hidden'), 'collapsed');
        assert.equal(JSON.stringify(posted.filter((m) => m.type === 'setDetailsExpanded').pop()), JSON.stringify({ type: 'setDetailsExpanded', id: 'c2', expanded: false }));
        w.expandAll();
        assert.ok(!body('c2').classList.contains('details-hidden') && !body('c1').classList.contains('details-hidden'), 'Expand all');
        w.collapseAll();
        assert.ok(body('c1').classList.contains('details-hidden') && body('c2').classList.contains('details-hidden'), 'Collapse all');
        assert.ok(body('c2').querySelector('.answer-preview'), 'the answer is in the collapsible body, as for a sent item');
    });

    test('CB-10: a second Send while a send runs', () => {
        const { w, posted } = chatPanel();
        const doc = w.document;
        const fire = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        fire({ type: 'draftsLoaded', sections: { anthropic: { activeSlot: 1, slots: { '1': 'first' }, slotKeep: { '1': true } } } });
        const sendBtn = doc.getElementById('anthropic-send-btn');
        const status = (): string => doc.getElementById('anthropic-status')?.textContent ?? '';
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.match(status(), /Sending/);
        assert.equal(sendBtn.disabled, true, 'paused for 2 s after the click (the double-click guard)');
        pauseOver(w);
        w.eval('updateAnthropicSendButton()');
        assert.equal(sendBtn.disabled, false, 'not disabled while it runs');
        assert.match(sendBtn.title, /Send offers to send this as an update to it, or to queue it/);
        fire({ type: 'anthropicStatus', text: 'Working on it' });
        doc.getElementById('anthropic-text').value = 'also check X';
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'sendAnthropic').length, 2, 'the second Send is posted');
        assert.match(status(), /Working on it/, 'the running send\'s status stays');
        fire({ type: 'anthropicNotSent', message: 'Sent as an update to the running prompt in session chat.', queued: true, panelBusy: true, slot: 1 });
        assert.match(sendBtn.title, /A prompt is running/, 'still running');
        fire({ type: 'anthropicStatus', text: 'Still working' });
        assert.match(status(), /Still working/, 'status updates of the running send still show');
        fire({ type: 'anthropicResult', text: 'done', turnsUsed: 1, toolCallCount: 0 });
        assert.equal(sendBtn.title, 'Send to Anthropic', 'ended by its result');
    });

    test('CB-9: a busy session', () => {
        const { w } = chatPanel();
        const doc = w.document;
        const fire = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        fire({ type: 'draftsLoaded', sections: { anthropic: { activeSlot: 1, slots: { '1': 'one' }, slotKeep: { '1': false } } } });
        const text = doc.getElementById('anthropic-text');
        const sendBtn = doc.getElementById('anthropic-send-btn');
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.match(sendBtn.title, /A prompt is running/, 'sending');
        fire({ type: 'anthropicNotSent', message: 'Not sent: session walk is busy.' });
        assert.equal(sendBtn.title, 'Send to Anthropic', 'free again');
        assert.equal(text.value, 'one', 'not sent: the text stays even in an unkept slot');
        assert.match(doc.getElementById('anthropic-status')?.textContent ?? doc.body.textContent, /Not sent: session walk is busy\./);
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        fire({ type: 'anthropicNotSent', message: 'Queued to run next in session walk.', queued: true, slot: 1 });
        assert.equal(text.value, '', 'queued instead: an unkept slot is cleared');

        // The queue editor.
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const q = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        open.push(q);
        q.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined, getState: () => undefined });
        const base = { type: 'normal', transport: 'anthropic', template: '(none)', createdAt: new Date().toISOString(), expandedText: '' };
        const items = [
            { ...base, id: 'c1', status: 'chat', originalText: 'a chat send', session: 'walk', chatActive: true },
            { ...base, id: 'c2', status: 'chat', originalText: 'a hung chat send', session: 'chat' },
            { ...base, id: 'p1', status: 'pending', originalText: 'queued in walk', session: 'walk', waitingForSession: 'walk' },
        ];
        q.__INIT__ = { state: { items, autoSend: true, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
        q.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
        const removeOf = (id: string): Win => q.document.querySelector(`.queue-item.chat-item[data-qid="${id}"] [onclick^="remove("]`);
        assert.ok(removeOf('c1'), 'a running chat send can be removed');
        assert.match(removeOf('c1').title, /Stop this chat send and remove it/);
        assert.ok(removeOf('c2'), 'a hung one too');
        assert.equal(removeOf('c2').title, 'Remove from the list');
        assert.match(q.document.body.textContent, /\[waiting for session walk\]/);
    });
    test('CB-12: the icon toggles', async () => {
        const html = media('chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
        open.push(w);
        const posted: Array<Record<string, unknown>> = [];
        let saved: Record<string, unknown> = { expanded: ['anthropic', 'copilot'], pinned: [], queuePending: { copilot: false } };
        w.acquireVsCodeApi = () => ({
            postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
            setState: (v: Record<string, unknown>) => { saved = JSON.parse(JSON.stringify(v)); },
            getState: () => saved,
        });
        w.__INIT__ = {};
        w.eval(media('chatPanel', 'main.js'));
        const doc = w.document;
        const fire = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        for (const id of ['anthropic-keep-slot', 'anthropic-fresh-session', 'copilot-keep-content', 'copilot-wrap', 'anthropic-queue-pending', 'copilot-queue-pending']) {
            const b = doc.getElementById(id);
            assert.equal(b?.tagName, 'BUTTON', `${id} is a button`);
            assert.equal(b.type, 'button');
            assert.ok(b.classList.contains('toggle-btn'));
            assert.match(String(b.getAttribute('aria-pressed')), /^(true|false)$/, `${id} has aria-pressed`);
            assert.ok(b.getAttribute('aria-label') && b.title, `${id}: label and tooltip`);
            assert.ok(b.querySelector('.codicon'), `${id}: an icon`);
            assert.notEqual(b.tabIndex, -1, `${id} is reached by Tab`);
        }
        assert.equal(doc.querySelectorAll('#container input[type="checkbox"]').length, 0, 'no checkbox left in the action bars');
        // The queue mode: before Save to Queue in each subpanel; pending by default; copilot staged from the webview state.
        const aq = doc.getElementById('anthropic-queue-pending');
        const cq = doc.getElementById('copilot-queue-pending');
        assert.equal(aq.nextElementSibling, doc.querySelector('[data-action="addToQueue"][data-id="anthropic"]'));
        assert.equal(cq.nextElementSibling, doc.querySelector('[data-action="addToQueue"][data-id="copilot"]'));
        assert.equal(aq.getAttribute('aria-pressed'), 'true', 'pending: today\'s behaviour');
        assert.match(aq.title, /adds the prompt pending/);
        assert.ok(aq.querySelector('.codicon-play'));
        assert.equal(cq.getAttribute('aria-pressed'), 'false', 'from the webview state');
        assert.match(cq.title, /adds the prompt staged/);
        assert.ok(cq.querySelector('.codicon-debug-pause'));
        fire({ type: 'draftsLoaded', sections: {} });
        // Save to Queue sends the mode.
        doc.getElementById('anthropic-text').value = 'a';
        doc.querySelector('[data-action="addToQueue"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'addToQueue').pop()?.initialStatus, 'pending');
        aq.click();
        assert.equal(aq.getAttribute('aria-pressed'), 'false');
        assert.ok(!aq.classList.contains('pressed'));
        assert.match(aq.title, /adds the prompt staged/);
        assert.deepEqual(saved.queuePending, { copilot: false, anthropic: false }, 'kept in the webview state');
        pauseOver(w);
        doc.getElementById('anthropic-text').value = 'b';
        doc.querySelector('[data-action="addToQueuePanelTarget"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'addToQueue').pop()?.initialStatus, 'staged', 'both Save to Queue buttons');
        pauseOver(w);
        doc.getElementById('anthropic-text').value = 'c';
        doc.querySelector('[data-action="addToQueueNext"][data-id="anthropic"]').click();
        const nextMsg = posted.filter((m) => m.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.equal(nextMsg.next, true);
        assert.equal(nextMsg.initialStatus, undefined, 'Queue next stays pending');
        doc.getElementById('copilot-text').value = 'cp';
        doc.querySelector('[data-action="addToQueue"][data-id="copilot"]').click();
        assert.equal(posted.filter((m) => m.type === 'addToQueue').pop()?.initialStatus, 'staged');
        // Saved with the drafts, and restored from them.
        await new Promise((r) => setTimeout(r, 1100));
        const drafts = (posted.filter((m) => m.type === 'saveDrafts').pop() as { drafts: Record<string, { queuePending: boolean }> }).drafts;
        assert.equal(drafts.anthropic.queuePending, false);
        assert.equal(drafts.copilot.queuePending, false);
        fire({ type: 'draftsLoaded', sections: { anthropic: { queuePending: true }, copilot: { queuePending: true } } });
        assert.equal(aq.getAttribute('aria-pressed'), 'true');
        assert.equal(cq.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(saved.queuePending, { copilot: true, anthropic: true });
        // Copilot's Keep posts setKeepContent; the host's keepContent sets it.
        const ck = doc.getElementById('copilot-keep-content');
        ck.click();
        assert.deepEqual(posted.filter((m) => m.type === 'setKeepContent').pop(), { type: 'setKeepContent', value: true });
        fire({ type: 'keepContent', value: false });
        assert.equal(ck.getAttribute('aria-pressed'), 'false');
        // Wrap: the preview posts it as it is.
        doc.getElementById('copilot-wrap').click();
        doc.querySelector('[data-action="preview"][data-id="copilot"]').click();
        assert.equal(posted.filter((m) => m.type === 'preview').pop()?.wrap, true);
        // A keyboard user: Enter on a focused button is its click (the browser's default action), so the same handler runs.
        const fresh = doc.getElementById('anthropic-fresh-session');
        fresh.focus();
        assert.equal(doc.activeElement, fresh, 'focusable');
    });

    test('CB-11: Fresh', async () => {
        const { w, posted } = chatPanel();
        const doc = w.document;
        const fire = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        const fresh = doc.getElementById('anthropic-fresh-session');
        const keep = doc.getElementById('anthropic-keep-slot');
        assert.ok(fresh, 'the Fresh box');
        assert.equal(keep.nextElementSibling, fresh, 'right after Keep');
        assert.equal(fresh.checked, false, 'off by default');
        doc.getElementById('anthropic-text').value = 'one';
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'sendAnthropic').pop()?.fresh, false);
        fire({ type: 'anthropicResult', toolCallCount: 0 });
        fire({ type: 'draftsLoaded', sections: { anthropic: { activeSlot: 1, slots: { '1': 'one' }, fresh: true } } });
        assert.equal(fresh.checked, true, 'restored from the drafts');
        pauseOver(w);
        doc.querySelector('[data-action="send"][data-id="anthropic"]').click();
        assert.equal(posted.filter((m) => m.type === 'sendAnthropic').pop()?.fresh, true);
        fire({ type: 'anthropicResult', toolCallCount: 0, freshBase: 'chat' });
        assert.match(doc.body.textContent, /Fresh session \(based on chat, discarded\)/);
        // Saved with the drafts (after the panel's 1 s debounce).
        fresh.checked = false;
        fresh.dispatchEvent(new w.Event('change'));
        await new Promise((r) => setTimeout(r, 1100));
        const saved = posted.filter((m) => m.type === 'saveDrafts').pop() as { drafts: { anthropic: { fresh: boolean } } };
        assert.equal(saved.drafts.anthropic.fresh, false);
        // The host side.
        const panel = src('handlers', 'chatPanel-handler.ts');
        assert.match(panel, /const busy = fresh \? \{ kind: 'free' as const \} : await resolveBusySession\(/, 'a fresh session is never busy');
        assert.match(panel, /createTemporarySession\(\{[\s\S]*?\}, targetSession, 'fresh'\)/, 'based on the panel\'s session');
        assert.match(panel, /if \(freshSession\) \{ discardSessionCompletely\(folder, quest, freshSession\); \}/, 'discarded when the turn ends');
        assert.match(panel, /message\.fresh === true/);
        assert.match(src('services', 'assistLiveDeps.ts'), /deleteSession: \(folder, name\) => \{ discardSessionCompletely\(/, 'the assists discard theirs completely too');
    });

    test('CB-14: the action rows', () => {
        const { w, posted } = chatPanel(['anthropic', 'copilot']);
        const actions = (section: string): string[] => [...w.document.querySelectorAll(`[data-section="${section}"] .toolbar [data-action], #${section}-run`)]
            .filter((el: Win) => el.closest('[data-action]') === el || el.id === `${section}-run`)
            .map((el: Win) => (el.id === `${section}-run` ? 'RUN' : el.getAttribute('data-action')));
        const a = actions('anthropic');
        const at = (x: string): number => a.indexOf(x);
        for (const x of ['addToQueue', 'addToQueueNext', 'pickAnthropicSession', 'RUN', 'send', 'cancel', 'addToQueuePanelTarget', 'addToQueueNextPanelTarget']) {
            assert.ok(at(x) >= 0, `${x} in ${a.join(', ')}`);
        }
        assert.ok(at('addToQueue') < at('pickAnthropicSession') && at('addToQueueNext') < at('pickAnthropicSession'), 'the default-run buttons first');
        assert.ok(at('pickAnthropicSession') < at('RUN'));
        for (const x of ['send', 'cancel', 'addToQueuePanelTarget', 'addToQueueNextPanelTarget']) { assert.ok(at(x) > at('RUN'), `${x} after the run`); }
        const c = actions('copilot');
        assert.ok(c.indexOf('addToQueue') < c.indexOf('RUN') && c.indexOf('RUN') < c.indexOf('send') && c.indexOf('send') < c.indexOf('addToQueuePanelTarget'), c.join(', '));
        // Every action button an icon button.
        for (const section of ['anthropic', 'copilot']) {
            const plain = [...w.document.querySelectorAll(`[data-section="${section}"] .toolbar button[data-action]`)].filter((b: Win) => !b.classList.contains('icon-btn') && !b.closest('.modal-popup') && b.getAttribute('data-action') !== 'switchSlot');
            assert.deepEqual(plain.map((b: Win) => b.getAttribute('data-action')), [], section);
        }
        // The new button: next with the panel's target.
        w.document.getElementById('anthropic-profile').innerHTML = '<option value="opus-direct" selected>Opus</option>';
        w.document.getElementById('anthropic-text').value = 'Mine';
        w.document.querySelector('[data-action="addToQueueNextPanelTarget"][data-id="anthropic"]').click();
        const m = posted.filter((x) => x.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.deepEqual([m.next, m.usePanelTarget, m.anthropicProfileId, m.transport, m.section], [true, true, 'opus-direct', 'anthropic', 'anthropic']);
        // Copilot's Save to Queue in this panel's run.
        pauseOver(w);
        w.document.getElementById('copilot-text').value = 'Copilot here';
        w.document.querySelector('[data-action="addToQueuePanelTarget"][data-id="copilot"]').click();
        const cm = posted.filter((x) => x.type === 'addToQueue').pop() as Record<string, unknown>;
        assert.deepEqual([cm.usePanelTarget, cm.section, cm.transport], [true, 'copilot', undefined]);
        // Session above run: two lines of link text; the run's name, its full label in the tooltip, marked when
        // it is not the PROCESS view's run; a click asks the host for VS Code's run picker.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'chatRuns', options: [{ run: 'default', label: 'default' }, { run: 'collab', label: 'collab — the subject' }], selected: { anthropic: 'collab' }, windowRun: 'default' } }));
        const runLink = w.document.getElementById('anthropic-run');
        assert.equal(runLink.tagName, 'A');
        assert.equal(runLink.textContent, 'collab');
        assert.match(runLink.title, /^Run: collab — the subject/);
        assert.ok(runLink.classList.contains('run-other'), 'another run than the PROCESS view\'s');
        const lines = runLink.parentElement;
        assert.ok(lines.classList.contains('session-run-lines'));
        assert.deepEqual([...lines.children].map((c: Win) => c.id), ['anthropic-session-link', 'anthropic-run'], 'session above run');
        posted.length = 0;
        runLink.click();
        w.document.getElementById('anthropic-session-link').click();
        w.document.getElementById('copilot-run').click();
        assert.deepEqual(posted.map((m: Win) => m.type === 'pickChatRun' ? [m.type, m.section] : [m.type]), [['pickChatRun', 'anthropic'], ['pickAnthropicSession'], ['pickChatRun', 'copilot']]);
        assert.equal(w.document.querySelector('select#anthropic-run, select#copilot-run'), null, 'no run dropdowns');
        assert.match(media('chatPanel', 'style.css'), /\.chat-link \{ color: var\(--vscode-textLink-foreground\); text-decoration: underline; cursor: pointer;/, 'marked clickable');
        assert.match(src('handlers', 'chatPanel-handler.ts'), /case 'pickChatRun':[\s\S]{0,800}showQuickPick\([\s\S]{0,600}this\._setChatRun\(section, picked\.run\)/, 'the host picks and switches');
    });

    test('CB-15: the run switch selects the run\'s default session', () => {
        const panel = src('handlers', 'chatPanel-handler.ts');
        assert.match(panel, /case 'setChatRun':[\s\S]{0,300}this\._setChatRun\(section, message\.run\)/);
        assert.match(panel, /if \(section === 'anthropic'\) \{\s*try \{ ensureRunDefaultSession\(sessionsFolder\(quest\), name\); \} catch[^\n]*\n\s*await setChatSessionFor\(this\._context\.workspaceState, quest, RUN_DEFAULT_CHOICE\);/,
            'the panel goes to Run default: the run\'s default session');
    });
});
