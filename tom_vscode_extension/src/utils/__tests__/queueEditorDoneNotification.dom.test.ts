/**
 * The Prompt Queue editor's done-notification section and sender chips (media/shared/queueEntryRenderFunctions.js).
 *
 *   QN-1 an item with a prompt shows it open under its prompt; editing posts `updateDoneNotification`; the bell
 *        switches it off (`setDoneNotificationDisabled` true) and a switched-off one back on
 *   QN-2 an item without a prompt has the section collapsed (to add one); a sent item shows its prompt read-only,
 *        and nothing when it had none
 *   QN-3 an item sent by another quest shows `from <quest>`; a notification item names the item it reports on
 *   QN-4 where it goes (vscimpb71): `this queue`, `run <r> of this quest`, `quest <q>, run <r>`; the button posts
 *        `pickDoneNotificationTarget`; a notification posted to another quest says whether it waits there, and a
 *        waiting one puts a chip in the item's header; a sent item shows the target without a button
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
        const chips = [...window.document.querySelectorAll('.queue-from-chip:not(.queue-run-chip)')].map((c: Win) => c.textContent.trim());
        assert.deepEqual(chips, ['from tom_uam', 'notification of abcdef12']);
    });

    test('QN-4: where it goes', (t) => {
        const { window, posted } = setup(t, [
            // In the default run: the editor shows one run tab at a time, the window's run (default) here.
            { ...base, id: 'own', doneNotificationPrompt: 'x' },
            { ...base, id: 'run2', doneNotificationPrompt: 'x', doneNotificationRun: 'r2' },
            { ...base, id: 'other', doneNotificationPrompt: 'x', doneNotificationQuest: 'tom_uam' },
            { ...base, id: 'waits', status: 'sent', doneNotificationPrompt: 'x', doneNotificationQuest: 'tom_uam', doneNotificationRun: 'rx',
                doneNotificationPosted: { quest: 'tom_uam', run: 'rx', file: 'f.inbox.queue.yaml', waiting: true, at: '2026-11-13T20:00:00.000Z' } },
        ]);
        // The entries in queue order (a queue entry carries no id attribute).
        const rows: Win[] = [...window.document.querySelectorAll('.queue-item .done-notification-target')];
        assert.equal(rows.length, 4);
        const ids = ['own', 'run2', 'other', 'waits'];
        const row = (id: string): Win => rows[ids.indexOf(id)];
        const texts = ids.map((id) => row(id)?.textContent.replace(/\s+/g, ' ').trim());
        assert.deepEqual(texts.slice(0, 3), ['Posted to: this queue', 'Posted to: run r2 of this quest', 'Posted to: quest tom_uam, run default'], JSON.stringify(texts));
        assert.match(texts[3] ?? '', /^Posted to: quest tom_uam, run rx posted to tom_uam \/ rx: no window of that quest is running, it waits in its inbox$/);
        assert.equal(row('waits').querySelector('button'), null, 'a sent item: no button');
        const button = mark(row('other').querySelector('button'), 'pick');
        fire(window, button, 'onclick');
        assert.deepEqual(posted.filter((m) => m.type === 'pickDoneNotificationTarget'), [{ type: 'pickDoneNotificationTarget', id: 'other' }]);
        const chips = [...window.document.querySelectorAll('.queue-from-chip')].map((c: Win) => c.textContent.trim());
        assert.ok(chips.includes('notification waits in tom_uam'), chips.join(' | '));
    });
});
