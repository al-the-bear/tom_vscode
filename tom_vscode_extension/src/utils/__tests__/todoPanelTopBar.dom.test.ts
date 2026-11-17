/**
 * The todo panel's top bar (media/questTodoPanel): the Done notification toggle, the template button and its
 * picker, and no Open Trail button — in a JSDOM running the real script.
 *
 *   TB-1 Done notification is an icon toggle: aria-pressed, pressed by default; a click turns it off and posts
 *        qtSetDoneNotification {on: false}, a second click on; the host's qtDoneNotification sets it; the tooltip names
 *        what it does and its state
 *   TB-2 the template button shows only the selected template's name, at most 20 characters (cut with an ellipsis),
 *        the full name in its tooltip; no "Template:" label, no visible dropdown
 *   TB-3 a click posts qtPickTemplate with the templates the select offers and the selection; the host's answer
 *        (qtTemplatePicked) sets it as the select did — the template the queue and send buttons use — and the
 *        button shows it; a template list refresh keeps a pick still offered
 *   TB-4 Open Trail is gone (qt-btn-open-trail, qtOpenTrailFiles)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): { w: Win; posted: Win[] } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.vscode = { postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    w.eval("qtCurrentQuestId = 'q1';");
    return { w, posted };
}

const TEMPLATES = {
    type: 'qtTemplates',
    templates: [
        { id: '__none__', label: '(None)' },
        { id: 'short', label: 'Short' },
        { id: 'long', label: 'Todo — Execute with full verification' },
    ],
    selected: 'long',
};

describe('todo panel top bar', () => {
    test('TB-1: the Done notification toggle', (t) => {
        const { w, posted } = setup(t);
        const btn = w.document.getElementById('qt-done-notification');
        assert.equal(btn.tagName, 'BUTTON', 'a button, not a checkbox');
        assert.equal(btn.getAttribute('aria-pressed'), 'true', 'on by default');
        assert.ok(btn.classList.contains('pressed'));
        assert.match(btn.title, /^Done notification: ON\. .*report back when they finish.*Click to turn it off\./);
        btn.click();
        assert.equal(btn.getAttribute('aria-pressed'), 'false');
        assert.ok(!btn.classList.contains('pressed'));
        assert.match(btn.title, /^Done notification: OFF\..*Click to turn it on\./);
        assert.deepEqual(posted.filter((m) => m.type === 'qtSetDoneNotification').pop(), { type: 'qtSetDoneNotification', on: false });
        btn.click();
        assert.deepEqual(posted.filter((m) => m.type === 'qtSetDoneNotification').pop(), { type: 'qtSetDoneNotification', on: true });
        w.qtHandleMessage({ type: 'qtDoneNotification', on: false });
        assert.equal(btn.getAttribute('aria-pressed'), 'false', 'the host\'s stored setting');
        assert.ok(btn.querySelector('.codicon-bell-slash'));
        assert.equal(w.document.querySelector('#qt-done-notification + label, label.qt-done-notification'), null, 'no checkbox label');
    });

    test('TB-2: the template button', (t) => {
        const { w } = setup(t);
        const bar = w.document.querySelector('.qt-top-chat-group');
        assert.ok(!/Template:/.test(bar.textContent), 'no "Template:" label');
        const sel = w.document.getElementById('qt-template-select');
        assert.ok(sel.hidden, 'no visible dropdown');
        const btn = w.document.getElementById('qt-template-btn');
        w.qtHandleMessage(TEMPLATES);
        const name = btn.querySelector('.qt-template-name').textContent;
        assert.equal(name, 'Todo — Execute with…');
        assert.equal(name.length, 20, 'at most 20 characters');
        assert.match(btn.title, /^Template: Todo — Execute with full verification — /);
        sel.value = 'short';
        sel.dispatchEvent(new w.Event('change'));
        assert.equal(btn.querySelector('.qt-template-name').textContent, 'Short', 'a short name in full');
    });

    test('TB-3: the picker', (t) => {
        const { w, posted } = setup(t);
        w.qtHandleMessage(TEMPLATES);
        w.document.getElementById('qt-template-btn').click();
        assert.deepEqual(posted.filter((m) => m.type === 'qtPickTemplate').pop(), {
            type: 'qtPickTemplate',
            templates: TEMPLATES.templates,
            selected: 'long',
        });
        w.qtHandleMessage({ type: 'qtTemplatePicked', id: 'short' });
        assert.equal(w.document.getElementById('qt-template-select').value, 'short');
        assert.equal(w.qtSelectedTemplateId(), 'short', 'the queue and send buttons use it');
        assert.equal(w.eval('qtCurrentTemplate'), 'short');
        assert.equal(w.document.querySelector('#qt-template-btn .qt-template-name').textContent, 'Short');
        w.qtHandleMessage(TEMPLATES);
        assert.equal(w.qtSelectedTemplateId(), 'short', 'a refresh keeps a pick still offered');
        w.qtHandleMessage({ type: 'qtTemplatePicked', id: 'gone' });
        assert.equal(w.qtSelectedTemplateId(), 'short', 'an id not offered changes nothing');
    });

    test('TB-4: Open Trail is gone', (t) => {
        const { w } = setup(t);
        assert.equal(w.document.getElementById('qt-btn-open-trail'), null);
        assert.ok(!media('questTodoPanel', 'main.js').includes('qtOpenTrailFiles'));
        const host = readFileSync(join(ROOT, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        assert.ok(!host.includes('qtOpenTrailFiles'), 'its host handler too');
        assert.match(host, /case 'qtPickTemplate':[\s\S]{0,700}showQuickPick[\s\S]{0,200}qtTemplatePicked/);
    });
});
