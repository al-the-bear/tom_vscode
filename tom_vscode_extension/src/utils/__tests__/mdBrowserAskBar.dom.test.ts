/**
 * The tomAi_askInMdBrowser bar in the MD Browser webview
 * (media/markdownBrowser/askBar.js), in a JSDOM with the browser's own shell.
 *
 *   AB-1 the shell: the bar element is above the action bar, hidden, and askBar.js is loaded after main.js
 *   AB-2 `askBar` shows the title, the buttons in order (the first primary) and "Keep this file" checked as sent
 *   AB-3 the checkbox posts `askKeepFile`; a click posts `askAnswer` with the button id and the checkbox, and
 *        disables the bar against a second click
 *   AB-4 `askBarClear` leaves the note (or hides the bar without one); a clear for another request is ignored
 */

import * as fs from 'fs';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const media = (...parts: string[]): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', ...parts), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }) {
    const shell = media('markdownBrowser', 'index.html');
    const start = shell.indexOf('<body>') + 6;
    const body = shell.slice(start, shell.indexOf('<script', start));
    const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    // Copied out of the window's realm, so deepEqual compares plain objects.
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) };
    w.eval(media('markdownBrowser', 'askBar.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data }));
    const bar = () => w.document.getElementById('askBar');
    return { w, posted, send, bar };
}

const SPEC = { requestId: 'r1', title: 'Go on?', buttons: [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel' }], keepFile: true };

describe('MD Browser: the ask bar', () => {
    test('AB-1: the shell', () => {
        const shell = media('markdownBrowser', 'index.html');
        assert.ok(shell.indexOf('id="askBar"') > 0 && shell.indexOf('id="askBar"') < shell.indexOf('class="action-bar"'), 'above the action bar');
        assert.match(shell, /<div class="ask-bar" id="askBar" hidden><\/div>/);
        assert.ok(shell.indexOf('/askBar.js') > shell.indexOf('/main.js'), 'after main.js, which publishes window.vscode');
    });

    test('AB-2: shown as sent', (t) => {
        const s = setup(t);
        assert.equal(s.bar().hidden, true);
        s.send({ type: 'askBar', bar: SPEC });
        assert.equal(s.bar().hidden, false);
        assert.equal(s.bar().querySelector('.ask-bar-title').textContent, 'Go on?');
        const buttons = [...s.bar().querySelectorAll('button')];
        assert.deepEqual(buttons.map((b: Win) => [b.textContent, b.getAttribute('data-ask-button')]), [['Continue', 'continue'], ['Cancel', 'cancel']]);
        assert.ok(buttons[0].classList.contains('primary'));
        assert.ok(!buttons[1].classList.contains('primary'));
        const keep = s.w.document.getElementById('askKeepFile');
        assert.equal(keep.checked, true);
        assert.match(keep.parentElement.textContent, /Keep this file/);
        s.send({ type: 'askBar', bar: { ...SPEC, requestId: 'r2', keepFile: false } });
        assert.equal(s.w.document.getElementById('askKeepFile').checked, false, 'unchecked when sent so');
        assert.equal(s.bar().querySelectorAll('button').length, 2, 'replaced, not added');
    });

    test('AB-3: the checkbox and a click', (t) => {
        const s = setup(t);
        s.send({ type: 'askBar', bar: SPEC });
        const keep = s.w.document.getElementById('askKeepFile');
        keep.click();
        assert.deepEqual(s.posted, [{ type: 'askKeepFile', requestId: 'r1', keepFile: false }]);
        s.bar().querySelector('[data-ask-button="cancel"]').click();
        assert.deepEqual(s.posted[1], { type: 'askAnswer', requestId: 'r1', button: 'cancel', keepFile: false });
        assert.ok([...s.bar().querySelectorAll('button')].every((b: Win) => b.disabled));
        assert.equal(keep.disabled, true);
    });

    test('AB-4: cleared', (t) => {
        const s = setup(t);
        s.send({ type: 'askBar', bar: SPEC });
        s.send({ type: 'askBarClear', requestId: 'other', note: 'x' });
        assert.equal(s.bar().querySelectorAll('button').length, 2, 'another request: ignored');
        s.send({ type: 'askBarClear', requestId: 'r1', note: 'Answered: Continue' });
        assert.equal(s.bar().querySelectorAll('button').length, 0);
        assert.equal(s.bar().textContent, 'Answered: Continue');
        assert.ok(s.bar().classList.contains('answered'));
        s.send({ type: 'askBar', bar: { ...SPEC, requestId: 'r3' } });
        s.send({ type: 'askBarClear', requestId: 'r3', note: '' });
        assert.equal(s.bar().hidden, true, 'no note: hidden');
    });
});
