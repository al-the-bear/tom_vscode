/**
 * No duplicate item from a double click on Queue or Send (src/utils/duplicateSubmitGuard.ts,
 * src/handlers/chatPanel-handler.ts, media/chatPanel/main.js, the todo detail's buttons).
 *
 *   DG-1 the host check: a submission whose text, transport, profile and template equal one accepted
 *        within 3 s is a duplicate; any field different, or 3 s passed, is not; an ignored duplicate
 *        does not extend the window; queue adds and sends are guarded apart
 *   DG-2 the chat panel host checks addToQueue (text, transport — copilot when unset — profile, template),
 *        sendCopilot and sendAnthropic before handling them, says "Already queued" / "Already sent" in the
 *        status bar, and answers an ignored Anthropic send with anthropicNotSent (keeping a running send's state)
 *   DG-3 the panel: Send and the three queue buttons are paused (disabled) for 2 s after a click, a second
 *        click in that time posts nothing, after it the button works again; other buttons are not paused
 *   DG-4 the todo detail's Send / Queue and Guide me: paused for 2 s; the host ignores the same todo sent
 *        the same way within 3 s
 */

import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { DUPLICATE_WINDOW_MS, DuplicateSubmitGuard, submissionKey } from '../duplicateSubmitGuard.js';

const ROOT = join(__dirname, '..', '..', '..');
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
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded: ['anthropic', 'copilot'], pinned: [] }) });
    w.__INIT__ = {};
    w.eval(media('chatPanel', 'main.js'));
    return { w, posted };
}

describe('duplicate guard: Queue and Send', () => {
    test('DG-1: the host check', () => {
        assert.equal(DUPLICATE_WINDOW_MS, 3000);
        const g = new DuplicateSubmitGuard();
        const a = { text: 'Do it', transport: 'anthropic', profile: 'p1', template: 't1' };
        assert.equal(g.isDuplicate(a, 1000), false, 'the first is accepted');
        assert.equal(g.isDuplicate({ ...a }, 1300), true, 'the same within 3 s');
        for (const other of [{ ...a, text: 'Do it!' }, { ...a, transport: 'copilot' }, { ...a, profile: 'p2' }, { ...a, template: 't2' }]) {
            assert.equal(g.isDuplicate(other, 1400), false, JSON.stringify(other));
        }
        assert.equal(g.isDuplicate(a, 3999), true, 'still within 3 s of the accepted one');
        assert.equal(g.isDuplicate(a, 4000), false, '3 s after the accepted one (the ignored ones did not extend it)');
        assert.equal(submissionKey({ text: 'x' }), submissionKey({ text: 'x', transport: '', profile: undefined, template: '' }), 'unset = empty');
        const sends = new DuplicateSubmitGuard();
        const queue = new DuplicateSubmitGuard();
        assert.equal(queue.isDuplicate(a, 0), false);
        assert.equal(sends.isDuplicate(a, 10), false, 'a send after queuing the same text is not a duplicate');
    });

    test('DG-2: the chat panel host', () => {
        const host = src('handlers', 'chatPanel-handler.ts');
        const after = (from: string, to: string): string => { const i = host.indexOf(from); return host.slice(i, host.indexOf(to, i)); };
        const add = after("case 'addToQueue':", 'await this._handleAddToQueue(');
        assert.match(add, /this\._queueAddGuard\.isDuplicate\(\{\s*text: String\(message\.text \?\? ''\),\s*transport: message\.transport \|\| 'copilot',\s*profile: message\.anthropicProfileId,\s*template: message\.template,\s*\}\)/);
        assert.match(add, /setStatusBarMessage\('\$\(info\) Already queued[^']*'/);
        assert.match(add, /break;/, 'not handled');
        const sendCopilot = after("case 'sendCopilot':", 'await this._handleSendCopilot(');
        assert.match(sendCopilot, /this\._isDuplicateSend\(\{ text: String\(message\.text \?\? ''\), transport: 'copilot', template: message\.template \}\)\) \{ break; \}/);
        const sendAnthropic = after("case 'sendAnthropic':", 'await this._handleSendAnthropic(');
        assert.match(sendAnthropic, /this\._isDuplicateSend\(\{ text: String\(message\.text \?\? ''\), transport: 'anthropic', profile: message\.profile, template: message\.userMessageTemplate \}\)/);
        assert.match(sendAnthropic, /type: 'anthropicNotSent', message: 'Already sent[^']*', \.\.\.\(panelBusy \? \{ panelBusy \} : \{\}\)/);
        assert.match(host, /private _isDuplicateSend\(fields: SubmissionFields\): boolean \{\s*if \(!this\._sendGuard\.isDuplicate\(fields\)\) \{ return false; \}\s*vscode\.window\.setStatusBarMessage\('\$\(info\) Already sent/);
    });

    test('DG-3: the panel pauses the buttons', async () => {
        const { w, posted } = chatPanel();
        const doc = w.document;
        doc.getElementById('anthropic-text').value = 'Do it';
        doc.getElementById('copilot-text').value = 'Do it';
        const count = (type: string): number => posted.filter((m) => m.type === type).length;
        for (const [sel, type] of [
            ['[data-action="addToQueue"][data-id="anthropic"]', 'addToQueue'],
            ['[data-action="addToQueuePanelTarget"][data-id="anthropic"]', 'addToQueue'],
            ['[data-action="addToQueueNext"][data-id="anthropic"]', 'addToQueue'],
            ['[data-action="addToQueue"][data-id="copilot"]', 'addToQueue'],
            ['[data-action="send"][data-id="copilot"]', 'sendCopilot'],
            ['[data-action="send"][data-id="anthropic"]', 'sendAnthropic'],
        ] as const) {
            const btn = doc.querySelector(sel);
            const before = count(type);
            btn.click();
            assert.equal(count(type), before + 1, `${sel}: posted`);
            assert.equal(btn.disabled, true, `${sel}: paused`);
            btn.querySelector('.codicon')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
            btn.click();
            assert.equal(count(type), before + 1, `${sel}: a second click in the pause posts nothing`);
        }
        w.eval("updateAnthropicSendButton()");
        assert.equal(doc.getElementById('anthropic-send-btn').disabled, true, 'the send button\'s state keeps the pause');
        const other = doc.querySelector('[data-action="openQueueEditor"]');
        if (other) { other.click(); other.click(); assert.equal(other.disabled, false, 'other buttons are not paused'); }
        await new Promise((r) => setTimeout(r, 2100));
        const queueBtn = doc.querySelector('[data-action="addToQueue"][data-id="anthropic"]');
        assert.equal(queueBtn.disabled, false, 'after 2 s it works again');
        queueBtn.click();
        assert.equal(count('addToQueue'), 5);
        assert.equal(doc.getElementById('anthropic-send-btn').disabled, false);
    });

    test('DG-4: the todo detail buttons', () => {
        const js = media('questTodoPanel', 'main.js');
        assert.match(js, /function qtPauseButton\(btn\) \{\s*btn\.disabled = true;\s*setTimeout\(function\(\) \{ btn\.disabled = false; \}, 2000\);/);
        assert.match(js, /closest\('\.qt-todo-btn'\)[\s\S]{0,120}btn\.disabled\) \{ return; \}\s*e\.preventDefault\(\);\s*qtPauseButton\(btn\);/);
        assert.match(js, /closest\('\.qt-guide-btn'\)[\s\S]{0,120}btn\.disabled\) \{ return; \}\s*e\.preventDefault\(\);\s*qtPauseButton\(btn\);/);
        const host = src('handlers', 'questTodoPanel-handler.ts');
        assert.match(host, /_todoButtonGuard\.isDuplicate\(\{ text: `\$\{questId\}\/\$\{todo\.id\}`, transport: msg\.target === 'queue' \? 'queue' : 'chat', template: use \}\)\) \{[\s\S]{0,200}return true;/);
    });
});
