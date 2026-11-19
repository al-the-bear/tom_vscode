/**
 * The speech bubble at the right end of a queue item's header (media/shared/queueEntryRenderFunctions.js
 * renderRunningMessageBox, media/queueEditor/main.js postRunningMessage).
 *
 *   RB-1 a running item whose prompt takes a message (`canMessageRunning`): the bubble opens a message box under
 *        the header (text, Send, Cancel, Open live trail) instead of the live trail; Send posts
 *        `messageRunningItem` with the item id and the text and closes the box; Ctrl/Cmd+Enter sends; an empty
 *        text sends nothing; Cancel closes it and drops the draft; the draft survives a redraw; Open live trail
 *        posts `openItemLiveTrail`
 *   RB-2 any other item: the bubble opens the live trail as before; on a running item that takes no message its
 *        tooltip says why
 *   RB-3 the messages written stay listed under the header with their answers, also after the item ended
 *   RB-4 the host: `messageRunningItem` goes to the waiting turn when it waits, else into the running prompt and
 *        is shown as a chat send of source `update`; the state carries `canMessageRunning` /
 *        `runningMessageUnavailable` and the messages of an item that has ended
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const EXT = join(__dirname, '..', '..', '..');
const readMedia = (...parts: string[]): string => readFileSync(join(EXT, 'media', ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[]; doc: Win } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default'], currentRun: 'default' },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted, doc: w.document };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-19T10:00:00.000Z' };
const item = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...base, id, status, originalText: id, expandedText: id, ...extra });
const bubble = (doc: Win, id: string): Win => doc.querySelector(`.queue-item[data-qid="${id}"] .queue-live-trail-btn`);
const box = (doc: Win, id: string): Win => doc.querySelector(`.queue-item[data-qid="${id}"] .run-msg-box`);
const redraw = (w: Win, items: unknown[]): void => { w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items, autoSend: false, processRuns: ['default'], currentRun: 'default' } })); };

describe('Prompt Queue editor — the speech bubble writes into the running prompt', () => {
    test('RB-1: the message box', (t) => {
        const items = [item('a', 'sending', { canMessageRunning: true })];
        const { w, posted, doc } = setup(t, items);
        assert.ok(bubble(doc, 'a').classList.contains('queue-message-btn'));
        assert.match(bubble(doc, 'a').getAttribute('title'), /^Write to the running prompt/);
        assert.equal(box(doc, 'a'), null, 'closed at first');
        // Inline handlers do not run in JSDOM: each button names its function, which the test calls.
        const click = (el: Win): void => { w.eval(String(el.getAttribute('onclick')).replace(/^event\.stopPropagation\(\);\s*/, '')); };
        assert.match(bubble(doc, 'a').getAttribute('onclick'), /toggleRunningMessage\('a'\)/);
        click(bubble(doc, 'a'));
        assert.equal(posted.filter((m) => m.type === 'openItemLiveTrail').length, 0, 'no live trail');
        const ta = box(doc, 'a').querySelector('textarea');
        assert.deepEqual([...box(doc, 'a').querySelectorAll('button')].map((b: Win) => b.textContent), ['Send', 'Cancel', 'Open live trail']);
        // An empty text sends nothing.
        click(box(doc, 'a').querySelector('[data-run-msg="send"]'));
        assert.equal(posted.filter((m) => m.type === 'messageRunningItem').length, 0);
        ta.value = 'Also the changelog';
        w.runningMessageDraft('a', ta.value);
        redraw(w, items);
        assert.equal(box(doc, 'a').querySelector('textarea').value, 'Also the changelog', 'the draft survives a redraw');
        click(box(doc, 'a').querySelector('[data-run-msg="send"]'));
        assert.deepEqual(posted.filter((m) => m.type === 'messageRunningItem'), [{ type: 'messageRunningItem', id: 'a', text: 'Also the changelog' }]);
        assert.equal(box(doc, 'a'), null, 'closed after Send');
        click(bubble(doc, 'a'));
        const ta2 = box(doc, 'a').querySelector('textarea');
        assert.equal(ta2.value, '', 'the draft went with the send');
        ta2.value = 'by keyboard';
        assert.match(ta2.getAttribute('onkeydown'), /runningMessageKey\(event, 'a'\)/);
        w.runningMessageKey(new w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }), 'a');
        assert.equal(posted.filter((m) => m.type === 'messageRunningItem').pop().text, 'by keyboard');
        click(bubble(doc, 'a'));
        box(doc, 'a').querySelector('textarea').value = 'dropped';
        w.runningMessageDraft('a', 'dropped');
        click(box(doc, 'a').querySelector('[data-run-msg="cancel"]'));
        assert.equal(box(doc, 'a'), null);
        click(bubble(doc, 'a'));
        assert.equal(box(doc, 'a').querySelector('textarea').value, '', 'Cancel drops the draft');
        click(box(doc, 'a').querySelector('[data-run-msg="trail"]'));
        assert.deepEqual(posted.filter((m) => m.type === 'openItemLiveTrail'), [{ type: 'openItemLiveTrail', id: 'a' }]);
    });

    test('RB-2: the live trail otherwise', (t) => {
        const { w, posted, doc } = setup(t, [
            item('p', 'pending'),
            item('c', 'sending', { runningMessageUnavailable: 'it runs on Copilot, which takes no message while it runs' }),
        ]);
        assert.ok(!bubble(doc, 'p').classList.contains('queue-message-btn'));
        assert.match(bubble(doc, 'p').getAttribute('title'), /^Open the live trail of session /);
        assert.doesNotMatch(bubble(doc, 'p').getAttribute('title'), /No message/);
        assert.match(bubble(doc, 'c').getAttribute('title'), /\. No message can go into this prompt: it runs on Copilot, which takes no message while it runs\.$/);
        assert.match(bubble(doc, 'c').getAttribute('onclick'), /openItemLiveTrail\('c'\)/);
        w.openItemLiveTrail('c');
        assert.deepEqual(posted.filter((m) => m.type === 'openItemLiveTrail'), [{ type: 'openItemLiveTrail', id: 'c' }]);
        assert.equal(box(doc, 'c'), null);
        void w;
    });

    test('RB-3: the messages with their answers, also after the item ended', (t) => {
        const view = { at: '2026-11-19T12:00:00.000Z', into: 'running', text: 'Also <this>', answer: 'Done.', state: 'answered' };
        const { doc } = setup(t, [item('s', 'sent', { waitMessagesView: [view] })]);
        const alone = doc.querySelector('.wait-msgs-alone[data-qid="s"]');
        assert.ok(alone, 'listed although the item has ended');
        assert.equal(alone.querySelector('.wait-msg-body').textContent, 'Also <this>');
        assert.equal(alone.querySelector('.wait-msg-answer').textContent, 'Answer: Done.');
    });

    test('RB-4: the host', () => {
        const host = readFileSync(join(EXT, 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(host, /case 'messageRunningItem': \{[\s\S]{0,700}if \(qm\.canMessageWaitingItem\(id\)\) \{[\s\S]{0,200}qm\.messageWaitingItem\(id, text\)[\s\S]{0,200}qm\.messageRunningItem\(id, text\)[\s\S]{0,400}trackChatSend\(\{ text: text\.trim\(\), session: r\.session, source: 'update' \}/);
        assert.match(host, /\.\.\.\(item\.waitMessages\?\.length \? \{ waitMessagesView: waitMessageViews\(item\.waitMessages\) \} : \{\}\)/);
        assert.match(host, /\.\.\.runningMessageOf\(item\)/);
        assert.match(host, /qm\.canMessageRunningItem\(item\.id\) \|\| qm\.canMessageWaitingItem\(item\.id\)/);
    });
});
