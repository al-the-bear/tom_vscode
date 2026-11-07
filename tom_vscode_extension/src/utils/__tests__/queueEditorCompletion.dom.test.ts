/**
 * The queue editor's add form gets the `/command`, `/skill` and `@file`
 * completion (ccparity_d_claudecode-3, CC-13 (a)): its real page, main.js and
 * the shared completion.js in a JSDOM.
 *
 *   QC-1 Ctrl+Shift+Space after `/rev` in the prompt asks the extension for a `skill`-kind completion with the
 *        query (one VS Code API handle shared: acquireVsCodeApi runs once); the answer (an expanded command)
 *        replaces the trigger token and the caret follows it
 *   QC-2 the repeat prefix / suffix fields have it too; a word without a trigger asks nothing
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

function setup(t: { after(fn: () => void): void }) {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    let acquired = 0;
    w.acquireVsCodeApi = () => {
        acquired += 1;
        if (acquired > 1) { throw new Error('An instance of the VS Code API has already been acquired'); }
        return { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined };
    };
    w.__INIT__ = { state: { items: [] } };
    // The page's scripts, in its order (media/queueEditor/index.html).
    for (const shared of ['mdOverlay.js', 'queueEntryUtils.js', 'queueEntryRenderFunctions.js', 'queueEntryMessageHandlers.js']) {
        w.eval(media('shared', shared));
    }
    w.eval(media('queueEditor', 'main.js'));
    w.eval(media('shared', 'completion.js'));
    const chord = (el: Win) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true }));
    const answer = (text: string) => w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'insertCompletion', text } }));
    return { w, posted, chord, answer, acquired: () => acquired, $: (id: string) => w.document.getElementById(id) };
}

describe('queue editor: completion in the add form', () => {
    test('QC-1: /command in the prompt', (t) => {
        const s = setup(t);
        const el = s.$('addText');
        el.value = 'Please /rev';
        el.setSelectionRange(11, 11);
        s.chord(el);
        const asked = s.posted.filter((m) => m.type === 'requestCompletion');
        assert.deepEqual(asked, [{ type: 'requestCompletion', kind: 'skill', query: 'rev' }]);
        assert.equal(s.acquired(), 1, 'one shared VS Code API handle');
        s.answer('Review PR #42 with a focus on tests.');
        assert.equal(el.value, 'Please Review PR #42 with a focus on tests.');
        assert.equal(el.selectionStart, el.value.length);
    });

    test('QC-2: the repeat fields; no trigger, no request', (t) => {
        const s = setup(t);
        for (const id of ['addRepeatPrefix', 'addRepeatSuffix']) {
            const el = s.$(id);
            el.value = '@READ';
            el.setSelectionRange(5, 5);
            s.chord(el);
        }
        assert.deepEqual(s.posted.filter((m) => m.type === 'requestCompletion').map((m) => m.kind), ['file', 'file']);
        const el = s.$('addText');
        el.value = 'plain words';
        el.setSelectionRange(11, 11);
        const before = s.posted.length;
        s.chord(el);
        assert.equal(s.posted.filter((m) => m.type === 'requestCompletion').length, s.posted.slice(0, before).filter((m) => m.type === 'requestCompletion').length);
    });
});
