/**
 * The queue editor's Send next button under a running loop
 * (media/shared/queueEntryRenderFunctions.js, media/queueEditor/main.js).
 *
 *   QSB-1 an item the host flags `canSendBetween` shows "Send between iterations" instead of Send next,
 *         and clicking it posts toggleSendBetween; any other pending item keeps Send next (moveToFront)
 *   QSB-2 a marked item shows the [⇄ between iterations] badge and the button to unmark it
 *   QSB-3 the host puts canSendBetween into the state
 *   QSB-4 editing a pending item's prompt: the edit button opens a textarea with Save / Cancel (posts
 *         beginTextEdit), typing survives a state push (draft, focus kept), Save posts saveTextEdit with the
 *         text and closes it, Cancel posts cancelTextEdit; an item that is no longer pending drops the edit;
 *         a refused edit closes; staged and sending items show no edit button
 *   QSB-5 the host: the edit messages reach the queue manager, the state flags textEditing, closing the
 *         editor ends every edit
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined });
    w.__INIT__ = {
        state: { items, autoSend: true },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        media('shared', 'queueEntryUtils.js'),
        media('shared', 'queueEntryRenderFunctions.js'),
        media('shared', 'queueEntryMessageHandlers.js'),
        media('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-05T10:00:00.000Z', expandedText: '' };
const ITEMS = [
    { ...base, id: 'loop', status: 'sending', originalText: 'loop', repeatCount: 'qr*' },
    { ...base, id: 'a', status: 'pending', originalText: 'a', canSendBetween: true },
    { ...base, id: 'b', status: 'pending', originalText: 'b' },
];

describe('queue editor: send between iterations', () => {
    test('QSB-1: the button\'s two meanings', (t) => {
        const { w, posted } = setup(t, ITEMS);
        const btns = [...w.document.querySelectorAll('.send-between-btn')];
        assert.equal(btns.length, 1, 'only the item under the loop');
        assert.match(btns[0].title, /Send between iterations/);
        // Inline handlers do not run under this DOM; call what they name.
        assert.equal(btns[0].getAttribute('onclick'), "toggleSendBetween('a')");
        w.toggleSendBetween('a');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'toggleSendBetween', id: 'a' });
        const sendNext = [...w.document.querySelectorAll('.codicon-arrow-circle-up')];
        assert.equal(sendNext.length, 1, 'b keeps Send next');
        assert.equal(sendNext[0].getAttribute('onclick'), "moveToFront('b')");
    });

    test('QSB-2: a marked item', (t) => {
        const { w } = setup(t, [ITEMS[0], { ...ITEMS[1], sendBetween: true }, ITEMS[2]]);
        assert.match(w.document.body.textContent, /\[⇄ between iterations\]/);
        assert.match(w.document.querySelector('.send-between-btn').title, /Click to unmark/);
    });

    test('QSB-3: the host flags it', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(src, /runningLoopAbove\(items, item\.id\) \? \{ canSendBetween: true \}/);
        assert.match(src, /case 'toggleSendBetween':\s*qm\.toggleSendBetween\(msg\.id\)/);
    });

    test('QSB-4: editing a pending item\'s prompt', (t) => {
        const items = [ITEMS[0], ITEMS[1], { ...base, id: 's', status: 'staged', originalText: 's' }];
        const { w, posted } = setup(t, items);
        const doc = w.document;
        const editBtns = [...doc.querySelectorAll('.codicon-edit')].filter((e: Win) => /startTextEdit/.test(e.getAttribute('onclick') || ''));
        assert.deepEqual(editBtns.map((e: Win) => e.getAttribute('onclick')), ["startTextEdit('a')"], 'only the pending item');
        w.startTextEdit('a');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'beginTextEdit', id: 'a' });
        let ta = doc.getElementById('qe-edit-a');
        assert.equal(ta.value, 'a', 'the prompt in a textarea');
        assert.equal(doc.querySelectorAll('.codicon-edit[onclick="startTextEdit(\'a\')"]').length, 0, 'no edit button while editing');
        // Typing, then a state push (the host flags it): the draft and the focus survive the redraw.
        ta.value = 'a, changed';
        w.textEditInput('a', ta.value);
        ta.focus();
        ta.setSelectionRange(3, 3);
        const push = (list: unknown[]): void => { w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', items: list, autoSend: true } })); };
        push([ITEMS[0], { ...ITEMS[1], textEditing: true }, items[2]]);
        ta = doc.getElementById('qe-edit-a');
        assert.equal(ta.value, 'a, changed');
        assert.equal(doc.activeElement, ta, 'focus kept');
        assert.equal(ta.selectionStart, 3, 'caret kept');
        assert.match(doc.body.textContent, /The queue waits for this edit/);
        w.saveTextEdit('a');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'saveTextEdit', id: 'a', text: 'a, changed' });
        assert.equal(doc.getElementById('qe-edit-a'), null, 'closed');
        // Cancel.
        w.startTextEdit('a');
        posted.pop();
        w.cancelTextEdit('a');
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'cancelTextEdit', id: 'a' });
        // The item went out meanwhile: the edit is dropped.
        w.startTextEdit('a');
        push([ITEMS[0], { ...ITEMS[1], status: 'sending' }, items[2]]);
        assert.equal(doc.getElementById('qe-edit-a'), null);
        // A refused edit closes.
        push(items);
        w.startTextEdit('a');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'textEditRefused', id: 'a' } }));
        assert.equal(doc.getElementById('qe-edit-a'), null);
    });

    test('QSB-5: the host side of editing', () => {
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        assert.match(src, /case 'beginTextEdit':\s*if \(!qm\.beginTextEdit\(String\(msg\.id\)\)\)/);
        assert.match(src, /case 'saveTextEdit':\s*await qm\.endTextEdit\(String\(msg\.id\), String\(msg\.text \?\? ''\)\)/);
        assert.match(src, /case 'cancelTextEdit':\s*await qm\.endTextEdit\(String\(msg\.id\)\)/);
        assert.match(src, /isTextBeingEdited\(item\.id\) \? \{ textEditing: true \}/);
        assert.match(src, /onDidDispose\(\(\) => \{[\s\S]{0,200}endTextEdit\(undefined\)/);
    });
});
