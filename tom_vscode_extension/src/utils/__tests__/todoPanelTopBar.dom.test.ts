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
 *   TB-5 one row of elements: the send group is no box of its own pushed to the right (`display: contents`, no
 *        auto margin, the spacer takes no room); with the quest scope picker shown, the quest label behind the file
 *        picker is hidden (the picker names the quest); a view without the picker keeps its label
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
    test('TB-1: the Done notification toggle (vscimpb146: off by default, disabled without a template)', (t) => {
        const { w, posted } = setup(t);
        const btn = w.document.getElementById('qt-done-notification');
        assert.equal(btn.tagName, 'BUTTON', 'a button, not a checkbox');
        assert.equal(btn.getAttribute('aria-pressed'), 'false', 'off by default');
        assert.equal(btn.disabled, true, 'disabled until the host says a template is set');
        assert.match(btn.title, /^Done notification: unavailable — no Todo — Done Notification template is set/);
        btn.click();
        assert.equal(posted.some((m) => m.type === 'qtSetDoneNotification'), false, 'a disabled box sends nothing');
        w.qtHandleMessage({ type: 'qtDoneNotification', on: false, available: true });
        assert.equal(btn.disabled, false);
        assert.match(btn.title, /^Done notification: OFF\. .*into the run and session it was queued into.*Click to turn it on\./);
        btn.click();
        assert.equal(btn.getAttribute('aria-pressed'), 'true');
        assert.ok(btn.classList.contains('pressed'));
        assert.deepEqual(posted.filter((m) => m.type === 'qtSetDoneNotification').pop(), { type: 'qtSetDoneNotification', on: true });
        btn.click();
        assert.deepEqual(posted.filter((m) => m.type === 'qtSetDoneNotification').pop(), { type: 'qtSetDoneNotification', on: false });
        w.qtHandleMessage({ type: 'qtDoneNotification', on: true, available: false });
        assert.equal(btn.getAttribute('aria-pressed'), 'false', 'no template: off whatever is stored');
        assert.equal(btn.disabled, true);
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

    test('TB-5: one row; the scope picker replaces the quest label', (t) => {
        const css = media('questTodoPanel', 'style.css');
        assert.match(css, /\.qt-top-chat-group \{ display: contents; \}/);
        assert.match(css, /\.qt-spacer \{ display: none; \}/);
        assert.ok(!/\.qt-top-chat-group[^}]*margin-left: auto/.test(css), 'not pushed to the right');
        const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
        w.eval('var qtViewConfig = { fixedFileLabel: "q1", hideQuestSelect: true };\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
        const label = w.document.getElementById('qt-fixed-file-label');
        assert.equal(label.textContent, 'q1');
        assert.notEqual(label.style.display, 'none', 'shown while no scope picker is');
        w.qtHandleMessage({ type: 'qtScope', available: false });
        assert.notEqual(label.style.display, 'none', 'a view without the picker keeps it');
        w.qtHandleMessage({ type: 'qtScope', available: true, plain: true, quests: ['q1'], prefix: false, scope: { kind: 'one', quest: 'q1', files: { live: true, archived: false, deleted: false }, order: 'combined' }, buttonText: 'q1' });
        assert.equal(label.style.display, 'none', 'the picker names the quest');
        assert.equal(w.document.querySelector('#qt-scope-btn .qt-scope-name').textContent, 'q1');
    });
});
