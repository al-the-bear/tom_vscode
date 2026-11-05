/**
 * The queue editor's Send next button under a running loop
 * (media/shared/queueEntryRenderFunctions.js, media/queueEditor/main.js).
 *
 *   QSB-1 an item the host flags `canSendBetween` shows "Send between iterations" instead of Send next,
 *         and clicking it posts toggleSendBetween; any other pending item keeps Send next (moveToFront)
 *   QSB-2 a marked item shows the [⇄ between iterations] badge and the button to unmark it
 *   QSB-3 the host puts canSendBetween into the state
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
});
