/**
 * Markdown preview buttons: a todo's Description, Notes and Answer, and a queue
 * item's Answer, shown rendered in an overlay over the whole panel or opened in
 * the markdown preview editor (media/shared/mdOverlay.js, media/questTodoPanel/main.js,
 * media/shared/queueEntryRenderFunctions.js / queueEntryMessageHandlers.js).
 *
 *   MP-1 the shared overlay shows a title and the host's HTML over the whole panel; the close
 *        button, Escape and a click on the backdrop close it; a second show reuses it
 *   MP-2 the todo detail has the two buttons beside Description and Notes, and beside the Answer of a
 *        completed todo; overlay posts qtRenderMarkdown and editor posts qtOpenMarkdownPreview with
 *        the text as it is in the form (unsaved edits included) and a title naming the todo and field
 *   MP-3 the new-todo form has the buttons too, titled "New todo"
 *   MP-4 the host's qtMarkdownHtml opens the overlay
 *   MP-5 a queue item's Answer block has the two buttons; they post renderMarkdown / openMarkdownPreview
 *        with the full answer, and the host's markdownHtml opens the overlay
 *   MP-6 both hosts render with the safe renderer and open the editor with showMarkdownHtmlPreview;
 *        both webviews load the overlay's script and stylesheet
 */

/* eslint-disable @typescript-eslint/naming-convention -- `last_answer` is the todo schema's YAML key */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const ROOT = join(__dirname, '..', '..', '..');
const media = (...parts: string[]): string => readFileSync(join(ROOT, 'media', ...parts), 'utf-8');
const src = (...parts: string[]): string => readFileSync(join(ROOT, 'src', ...parts), 'utf-8');

function todoPanel(t: { after(fn: () => void): void }): { w: Win; posted: Array<Record<string, unknown>> } {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.vscode = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('shared', 'mdOverlay.js') + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return { w, posted };
}

const DONE = { id: 'qr1', title: 'Done one', status: 'completed', description: 'Do **it**.', notes: 'A note.', completed_date: '2026-11-05', last_answer: '# Done\n\nAll **green**.' };

function overlay(w: Win): Win { return w.document.querySelector('.tom-md-overlay'); }
const visible = (w: Win): boolean => !!overlay(w) && overlay(w).classList.contains('visible');

describe('markdown preview buttons', () => {
    test('MP-1: the shared overlay', (t) => {
        const { w } = todoPanel(t);
        w.tomMdOverlayShow('Answer — qr1', '<h1>Done</h1><p>All <strong>green</strong>.</p>');
        assert.ok(visible(w));
        assert.equal(w.document.querySelector('.tom-md-overlay .tom-md-title').textContent, 'Answer — qr1');
        assert.equal(w.document.querySelector('.tom-md-overlay .tom-md-body strong').textContent, 'green');
        w.document.querySelector('.tom-md-overlay .tom-md-close').click();
        assert.equal(visible(w), false, 'the close button');
        w.tomMdOverlayShow('Again', '<p>x</p>');
        assert.equal(w.document.querySelectorAll('.tom-md-overlay').length, 1, 'reused');
        w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
        assert.equal(visible(w), false, 'Escape');
        w.tomMdOverlayShow('Again', '<p>x</p>');
        overlay(w).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        assert.equal(visible(w), false, 'a click on the backdrop');
        w.tomMdOverlayShow('Again', '<p>x</p>');
        w.document.querySelector('.tom-md-overlay .tom-md-body').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        assert.ok(visible(w), 'a click inside stays open');
    });

    test('MP-2: the todo detail', (t) => {
        const { w, posted } = todoPanel(t);
        w.eval(`qtDetailTodo = ${JSON.stringify(DONE)};`);
        w.qtRenderDetail(DONE);
        const pane = w.document.getElementById('qt-detail-pane');
        for (const field of ['desc', 'notes', 'answer']) {
            for (const mode of ['overlay', 'editor']) {
                assert.ok(pane.querySelector(`.qt-md-btn[data-qt-md-field="${field}"][data-qt-md-mode="${mode}"]`), `${field} ${mode}`);
            }
        }
        w.document.getElementById('qt-d-desc').value = 'Edited **text**';
        pane.querySelector('.qt-md-btn[data-qt-md-field="desc"][data-qt-md-mode="overlay"]').click();
        assert.deepEqual(posted.pop(), { type: 'qtRenderMarkdown', title: 'qr1 — Description', markdown: 'Edited **text**' });
        w.document.getElementById('qt-d-notes').value = 'A note.';
        pane.querySelector('.qt-md-btn[data-qt-md-field="notes"][data-qt-md-mode="editor"]').click();
        assert.deepEqual(posted.pop(), { type: 'qtOpenMarkdownPreview', title: 'qr1 — Notes', markdown: 'A note.' });
        pane.querySelector('.qt-md-btn[data-qt-md-field="answer"][data-qt-md-mode="overlay"]').click();
        assert.equal(posted.pop()?.type, 'qtShowAgentAnswer', 'the agent answer is looked up by the host (questTodoAgentAnswerAndGuide.dom.test.ts)');
        assert.match(w.qtRenderDatesSection(DONE).split('qt-answer-row')[1], /^(?![\s\S]*(<input|<textarea))/, 'the answer is not editable');
    });

    test('MP-3: the new-todo form', (t) => {
        const { w, posted } = todoPanel(t);
        w.qtShowNewTodoForm('vbs9');
        const pane = w.document.getElementById('qt-detail-pane');
        assert.equal(pane.querySelectorAll('.qt-md-btn').length, 4, 'description and notes, two each');
        w.document.getElementById('qt-d-desc').value = 'New **one**';
        pane.querySelector('.qt-md-btn[data-qt-md-field="desc"][data-qt-md-mode="overlay"]').click();
        assert.deepEqual(posted.pop(), { type: 'qtRenderMarkdown', title: 'New todo — Description', markdown: 'New **one**' });
    });

    test('MP-4: the host answer opens the overlay', (t) => {
        const { w } = todoPanel(t);
        w.qtHandleMessage({ type: 'qtMarkdownHtml', title: 'qr1 — Answer', html: '<p>All <strong>green</strong>.</p>' });
        assert.ok(visible(w));
        assert.equal(w.document.querySelector('.tom-md-overlay .tom-md-title').textContent, 'qr1 — Answer');
    });

    test('MP-5: the queue editor', (t) => {
        const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const w = dom.window as Win;
        t.after(() => w.close());
        const posted: Array<Record<string, unknown>> = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined, getState: () => undefined });
        const answer = '# Result\n\n' + 'x'.repeat(700);
        const item = {
            id: 'q1', status: 'sent', type: 'normal', transport: 'anthropic', originalText: 'Do the thing',
            expandedText: 'Do the thing', template: '(none)', createdAt: new Date().toISOString(), answerText: answer,
        };
        w.__INIT__ = { state: { items: [item], autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
        w.eval([
            media('shared', 'mdOverlay.js'),
            media('shared', 'queueEntryUtils.js'),
            media('shared', 'queueEntryRenderFunctions.js'),
            media('shared', 'queueEntryMessageHandlers.js'),
            media('queueEditor', 'main.js'),
        ].join('\n;\n'));
        const block = w.document.querySelector('.answer-preview');
        assert.ok(block, 'the answer block');
        block.querySelector('.qe-md-btn[data-qe-md-mode="overlay"]').click();
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'renderMarkdown', title: 'Answer — Do the thing', markdown: answer });
        block.querySelector('.qe-md-btn[data-qe-md-mode="editor"]').click();
        assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'openMarkdownPreview', title: 'Answer — Do the thing', markdown: answer });
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'markdownHtml', title: 'Answer — Do the thing', html: '<h1>Result</h1>' } }));
        assert.ok(visible(w), 'the overlay opens');
        assert.equal(w.document.querySelector('.tom-md-overlay h1').textContent, 'Result');
    });

    test('MP-6: the hosts and the assets', () => {
        const todoHost = src('handlers', 'questTodoPanel-handler.ts');
        assert.match(todoHost, /case 'qtRenderMarkdown':[\s\S]{0,300}renderQuestLogMarkdown/);
        assert.match(todoHost, /case 'qtOpenMarkdownPreview':[\s\S]{0,400}showMarkdownHtmlPreview/);
        assert.match(todoHost, /readMediaText\('shared', 'mdOverlay\.js'\)/);
        assert.match(src('handlers', 'questTodo', 'questTodoAssets.ts'), /readMediaText\('shared', 'mdOverlay\.css'\)/);
        const queueHost = src('handlers', 'queueEditor-handler.ts');
        assert.match(queueHost, /case 'renderMarkdown':[\s\S]{0,300}renderQuestLogMarkdown/);
        assert.match(queueHost, /case 'openMarkdownPreview':[\s\S]{0,400}showMarkdownHtmlPreview/);
        const queueHtml = media('queueEditor', 'index.html');
        assert.match(queueHtml, /\{\{sharedUri\}\}\/mdOverlay\.css/);
        assert.match(queueHtml, /\{\{sharedUri\}\}\/mdOverlay\.js/);
    });
});
