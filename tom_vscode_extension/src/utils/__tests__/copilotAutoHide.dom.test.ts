/**
 * Auto-hide in the Copilot subpanel's action bar (vscimpb74, src/utils/copilotAutoHide.ts, media/chatPanel/main.js,
 * chatPanel-handler.ts). Decision (c): a dropdown Off / 3s / 5s / 10s / 20s beside Keep / Wrap.
 *
 *   AH-1 the rules: the offered delays; a stored value not offered becomes the next one up (an older 1 s is 3 s),
 *        at most 20 s; anything not a positive number is Off; numeric strings are read
 *   AH-2 the webview: the dropdown sits in the Copilot action bar beside Keep and Wrap with the five options; the
 *        panel asks for the stored delay at start (`getAutoHideDelay`) and shows the answer (`autoHideDelay`), so
 *        the choice survives a reload; a change posts `setAutoHideDelay` with the delay in ms
 *   AH-3 the other two places are gone: the chat panels' overlay carries no auto-hide field and the Context &
 *        Settings editor is retired; the handler keeps the delay per window (workspaceState) normalized, and
 *        closes the auxiliary bar that long after a Copilot send
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { AUTO_HIDE_DELAYS, AUTO_HIDE_STATE_KEY, normalizeAutoHideDelay } from '../copilotAutoHide.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }) {
    const html = read('media', 'chatPanel', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
        setState: () => undefined,
        getState: () => ({ expanded: ['copilot'], pinned: [] }),
    });
    w.__INIT__ = {};
    w.eval(read('media', 'chatPanel', 'main.js'));
    const send = (data: Record<string, unknown>) => w.dispatchEvent(new w.MessageEvent('message', { data }));
    return { w, posted, send, $: (id: string) => w.document.getElementById(id) };
}

describe('Copilot auto-hide', () => {
    test('AH-1: the rules', () => {
        assert.equal(AUTO_HIDE_STATE_KEY, 'tomAi.copilot.autoHideDelay');
        assert.deepEqual(AUTO_HIDE_DELAYS, [0, 3000, 5000, 10000, 20000]);
        for (const d of AUTO_HIDE_DELAYS) { assert.equal(normalizeAutoHideDelay(d), d); }
        assert.equal(normalizeAutoHideDelay(1000), 3000, 'the older 1 s');
        assert.equal(normalizeAutoHideDelay(7000), 10000);
        assert.equal(normalizeAutoHideDelay(60000), 20000);
        assert.equal(normalizeAutoHideDelay('5000'), 5000);
        for (const v of [undefined, null, -1, 0, NaN, 'x', {}, true]) { assert.equal(normalizeAutoHideDelay(v), 0, String(v)); }
    });

    test('AH-2: the dropdown in the Copilot action bar', (t) => {
        const s = setup(t);
        const select = s.$('copilot-autohide');
        assert.ok(select, 'rendered');
        assert.equal(select.closest('#copilot-context-overlay'), null, 'not in the overlay');
        const toolbar = select.closest('.copilot-compact-toolbar');
        assert.ok(toolbar, 'in the Copilot toolbar');
        assert.ok(toolbar.querySelector('#copilot-keep-content') && toolbar.querySelector('#copilot-wrap'), 'beside Keep and Wrap');
        assert.equal(select.previousElementSibling.textContent, 'Auto-hide');
        assert.deepEqual([...select.options].map((o: Win) => [o.value, o.textContent]),
            [['0', 'Off'], ['3000', '3s'], ['5000', '5s'], ['10000', '10s'], ['20000', '20s']]);
        assert.ok(s.posted.some((m) => m.type === 'getAutoHideDelay'), 'asks for the stored delay at start');
        s.send({ type: 'autoHideDelay', value: 10000 });
        assert.equal(select.value, '10000', 'shows the stored delay');
        select.value = '20000';
        select.dispatchEvent(new s.w.Event('change'));
        assert.deepEqual(s.posted.filter((m) => m.type === 'setAutoHideDelay').at(-1), { type: 'setAutoHideDelay', value: 20000 });
        select.value = '0';
        select.dispatchEvent(new s.w.Event('change'));
        assert.deepEqual(s.posted.filter((m) => m.type === 'setAutoHideDelay').at(-1), { type: 'setAutoHideDelay', value: 0 });
    });

    test('AH-3: the other two places are gone; the handler keeps it', () => {
        const chat = read('media', 'chatPanel', 'main.js');
        assert.doesNotMatch(chat, /<legend>Auto-Hide<\/legend>/);
        assert.equal((chat.match(/id="copilot-autohide"/g) ?? []).length, 1, 'one dropdown');
        assert.ok(!existsSync(join(ROOT, 'media', 'contextSettingsEditor')), 'the Context & Settings editor is retired');
        assert.ok(!existsSync(join(ROOT, 'src', 'handlers', 'contextSettingsEditor-handler.ts')));
        const handler = read('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(handler, /this\._autoHideDelay = normalizeAutoHideDelay\(context\.workspaceState\.get\(AUTO_HIDE_STATE_KEY, 0\)\);/);
        assert.match(handler, /case 'setAutoHideDelay':[\s\S]{0,200}this\._autoHideDelay = normalizeAutoHideDelay\(message\.value\);\s+await this\._context\.workspaceState\.update\(AUTO_HIDE_STATE_KEY, this\._autoHideDelay\);/);
        assert.match(handler, /case 'getAutoHideDelay':\s+this\._view\?\.webview\.postMessage\(\{ type: 'autoHideDelay', value: this\._autoHideDelay \}\);/);
        assert.match(handler, /if \(this\._autoHideDelay > 0\) \{\s+setTimeout\(\(\) => \{\s+vscode\.commands\.executeCommand\('workbench\.action\.closeAuxiliaryBar'\);\s+\}, this\._autoHideDelay\);/);
    });
});
