/**
 * The Prompt Queue editor's done-notification section and sender chips (media/shared/queueEntryRenderFunctions.js).
 *
 *   QN-1 an item with a prompt shows it open under its prompt; editing posts `updateDoneNotification`; the bell
 *        switches it off (`setDoneNotificationDisabled` true) and a switched-off one back on
 *   QN-2 an item without a prompt has the section collapsed (to add one); a sent item shows its prompt read-only,
 *        and nothing when it had none
 *   QN-3 an item sent by another quest shows `from <quest>`; a notification item names the item it reports on
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: Array<Record<string, unknown>>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items, autoSend: false, context: { quest: 'q', role: '', activeProjects: [] } } };
    window.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { window, posted };
}

const base = { status: 'pending', type: 'normal', originalText: 'Do X', template: '(None)', createdAt: '2026-10-27T12:00:00.000Z' };

/** Run the inline handler an element carries (jsdom does not run inline attributes here). */
function fire(window: Win, el: Win, attr: 'onclick' | 'onchange'): void {
    const code = el.getAttribute(attr);
    window.eval(`(function(event){ ${code} }).call(document.querySelector('[data-qn="${el.dataset.qn}"]'), { preventDefault: function(){} })`);
}

function mark(el: Win, id: string): Win { el.dataset.qn = id; return el; }

describe('Prompt Queue editor — done notification', () => {
    test('QN-1: edit and switch', (t) => {
        const { window, posted } = setup(t, [{ ...base, id: 'it-1', doneNotificationPrompt: 'Tell tom_uam: ${itemOutcome}' }]);
        const section = window.document.querySelector('details.done-notification');
        assert.ok(section, 'the section is there');
        assert.equal(section.hasAttribute('open'), true, 'open: the item has a prompt');
        const input = mark(section.querySelector('textarea.done-notification-input'), 'input');
        assert.equal(input.value, 'Tell tom_uam: ${itemOutcome}');
        input.value = 'Tell tom_uam: ${itemOutcome} (changed)';
        fire(window, input, 'onchange');
        assert.deepEqual(posted.pop(), { type: 'updateDoneNotification', id: 'it-1', prompt: 'Tell tom_uam: ${itemOutcome} (changed)' });
        const bell = mark(section.querySelector('summary .codicon-bell'), 'bell');
        fire(window, bell, 'onclick');
        assert.deepEqual(posted.pop(), { type: 'setDoneNotificationDisabled', id: 'it-1', disabled: true });

        const off = setup(t, [{ ...base, id: 'it-2', doneNotificationPrompt: 'x', doneNotificationDisabled: true }]);
        const offSection = off.window.document.querySelector('details.done-notification');
        assert.ok(offSection.classList.contains('disabled'));
        fire(off.window, mark(offSection.querySelector('summary .codicon-bell-slash'), 'slash'), 'onclick');
        assert.deepEqual(off.posted.pop(), { type: 'setDoneNotificationDisabled', id: 'it-2', disabled: false });
    });

    test('QN-2: empty and finished items', (t) => {
        const { window } = setup(t, [
            { ...base, id: 'empty' },
            { ...base, id: 'done', status: 'sent', doneNotificationPrompt: 'it went: ${itemOutcome}' },
            { ...base, id: 'done-none', status: 'sent' },
        ]);
        const sections = [...window.document.querySelectorAll('details.done-notification')];
        assert.equal(sections.length, 2, 'the sent item without one shows none');
        assert.equal(sections[0].hasAttribute('open'), false, 'collapsed: nothing set yet');
        assert.ok(sections[0].querySelector('textarea'), 'but a prompt can be added');
        assert.equal(sections[1].querySelector('textarea'), null, 'a sent item is read-only');
        assert.equal(sections[1].querySelector('.done-notification-text').textContent, 'it went: ${itemOutcome}');
    });

    test('QN-3: sender and notification chips', (t) => {
        const { window } = setup(t, [
            { ...base, id: 'sent-in', from: { quest: 'tom_uam', windowId: 'w', host: 'mbp', sentAt: '2026-10-27T12:00:00.000Z' } },
            { ...base, id: 'note', notificationOf: 'abcdef1234567890' },
        ]);
        const chips = [...window.document.querySelectorAll('.queue-from-chip')].map((c: Win) => c.textContent.trim());
        assert.deepEqual(chips, ['from tom_uam', 'notification of abcdef12']);
    });
});
