/**
 * The multi-line text input's page (media/textInput/main.js), in a JSDOM running the real script.
 *
 *   TI-1 the texts of __INIT__ are shown: title, hint, the read-only context, the box's start value and
 *        the OK label; without a context there is no context box
 *   TI-2 OK (and Ctrl/Cmd+Enter) posts the text as typed, line breaks kept, once
 *   TI-3 Cancel (and Escape) posts a cancel, once
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const asset = (file: string): string => readFileSync(join(__dirname, '..', '..', '..', 'media', 'textInput', file), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(init: Record<string, unknown>): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0];
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.__INIT__ = init;
    w.eval(asset('main.js'));
    return { w, posted };
}
const key = (w: Win, k: string, ctrl = false): void => {
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, ctrlKey: ctrl, bubbles: true }));
};

describe('multi-line text input', () => {
    test('TI-1: what it shows', () => {
        const { w } = setup({ title: 'Queue Group Prompt: qr*', prompt: 'What to add', value: 'start', okLabel: 'Queue', contextLabel: 'Default', context: 'Do ${repeatTodoId}.' });
        const $ = (id: string): Win => w.document.getElementById(id);
        assert.equal($('tiTitle').textContent, 'Queue Group Prompt: qr*');
        assert.equal($('tiPrompt').textContent, 'What to add');
        assert.equal($('tiContext').hidden, false);
        assert.equal($('tiContextLabel').textContent, 'Default');
        assert.equal($('tiContextText').textContent, 'Do ${repeatTodoId}.');
        assert.equal($('tiText').value, 'start');
        assert.equal($('tiOk').textContent, 'Queue');
        assert.equal(setup({ title: 'x' }).w.document.getElementById('tiContext').hidden, true);
    });

    test('TI-2: OK', () => {
        const { w, posted } = setup({ title: 'x' });
        w.document.getElementById('tiText').value = 'line one\nline two';
        w.document.getElementById('tiOk').click();
        w.document.getElementById('tiOk').click();
        assert.deepEqual(posted, [{ type: 'ok', text: 'line one\nline two' }], 'once, line breaks kept');
        const other = setup({ title: 'x', value: 'typed' });
        key(other.w, 'Enter', true);
        assert.deepEqual(other.posted, [{ type: 'ok', text: 'typed' }]);
    });

    test('TI-3: Cancel', () => {
        const { w, posted } = setup({ title: 'x' });
        w.document.getElementById('tiCancel').click();
        key(w, 'Escape');
        assert.deepEqual(posted, [{ type: 'cancel' }]);
        const other = setup({ title: 'x' });
        key(other.w, 'Escape');
        assert.deepEqual(other.posted, [{ type: 'cancel' }]);
    });
});
