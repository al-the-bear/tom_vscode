/**
 * The todo panel shows a todo walk's final answer (`last_answer`,
 * media/questTodoPanel/main.js; cc_parity_a_start-18).
 *
 *   QA-1 the detail form's Dates section shows an "Answer" label and button only for a completed todo
 *        that has an answer; no input, so it is not editable
 *   QA-2 the button asks the host to render the answer; the host's HTML opens in the popup with the
 *        todo id, and Close closes it
 *   QA-3 the form data never carries last_answer (an autosave cannot change or drop it)
 *   QA-4 the host renders the answer with the safe renderer (raw HTML escaped)
 */

/* eslint-disable @typescript-eslint/naming-convention -- `last_answer` is the todo schema's YAML key */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { renderQuestLogMarkdown } from '../questLogMarkdown.js';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return { w, posted };
}

const DONE = { id: 'qr1', title: 'Done one', status: 'completed', completed_date: '2026-11-05', last_answer: '# Done\n\nAll **green**.' };

describe('todo panel: the last answer', () => {
    test('QA-1: shown only for a completed todo with an answer, not editable', (t) => {
        const { w } = setup(t);
        const html = w.qtRenderDatesSection(DONE);
        assert.match(html, /qt-answer-row/);
        assert.match(html, /id="qt-d-show-answer"/);
        assert.doesNotMatch(html.split('qt-answer-row')[1], /<input|<textarea/, 'no editable field');
        assert.doesNotMatch(w.qtRenderDatesSection({ ...DONE, status: 'in-progress' }), /qt-answer-row/, 'not for an open todo');
        assert.doesNotMatch(w.qtRenderDatesSection({ ...DONE, last_answer: undefined }), /qt-answer-row/, 'not without an answer');
    });

    test('QA-2: the button and the popup', (t) => {
        const { w, posted } = setup(t);
        const pane = w.document.getElementById('qt-detail-pane');
        pane.innerHTML = w.qtRenderDatesSection(DONE);
        w.eval(`qtDetailTodo = ${JSON.stringify(DONE)};`);
        w.qtAttachDateAutoSave();
        w.document.getElementById('qt-d-show-answer').click();
        assert.deepEqual(posted.pop(), { type: 'qtRenderAnswer', title: 'qr1', markdown: DONE.last_answer });
        w.qtHandleMessage({ type: 'qtAnswerHtml', title: 'qr1', html: '<h1>Done</h1><p>All <strong>green</strong>.</p>' });
        const overlay = w.document.getElementById('qt-popup-overlay');
        assert.ok(overlay.classList.contains('visible'), 'the popup opens');
        assert.match(w.document.getElementById('qt-popup-content').textContent, /Answer — qr1/);
        assert.equal(w.document.querySelector('.qt-answer-body strong').textContent, 'green');
        w.document.getElementById('qt-answer-close').click();
        assert.equal(overlay.classList.contains('visible'), false, 'Close closes it');
    });

    test('QA-3: the form data does not carry it', (t) => {
        const { w } = setup(t);
        const pane = w.document.getElementById('qt-detail-pane');
        pane.innerHTML = w.qtRenderDatesSection(DONE);
        w.eval(`qtDetailTodo = ${JSON.stringify(DONE)};`);
        assert.equal('last_answer' in w.qtCollectFormData(), false);
    });

    test('QA-4: the host renders it safely', () => {
        const html = renderQuestLogMarkdown('# Done\n\n<script>alert(1)</script> and [x](javascript:alert(1))');
        assert.match(html, /<h1>Done<\/h1>/);
        assert.doesNotMatch(html, /<script>/);
        assert.doesNotMatch(html, /href="javascript:/, "no executable link");
        assert.match(readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8'), /case 'qtRenderAnswer':[\s\S]{0,200}renderQuestLogMarkdown/);
    });
});
