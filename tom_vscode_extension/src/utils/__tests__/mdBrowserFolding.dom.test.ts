/**
 * The Markdown Browser's section folding, in a JSDOM running the real webview
 * script (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   MF-1  every heading starts with a triangle; folding hides its section, not the next sibling section
 *   MF-2  unfolding a section restores its subsections' own folded state
 *   MF-3  fold all / unfold all with one toggle button
 *   MF-4  the level dropdown lists the document's levels; its button folds / unfolds that level only
 *   MF-5  the folded state survives a re-render of the same file and resets for another file
 *   MF-6  the backend's heading transform: ids and levels beyond 6 fold by their true level
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { transformMarkdown } from '../markdownHeadings.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

const DOC = [
    '# A', '', 'a text', '',
    '## B', '', 'b text', '',
    '### C', '', 'c text', '',
    '## D', '', 'd text', '',
    '# E', '', 'e text',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    window.eval(MARKED);
    window.eval(asset('blocks.js'));
    window.eval(asset('main.js'));
    return window;
}
const show = (window: Win, text: string, filePath = '/ws/doc.md'): void => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath, crlf: false } }));
};
/** The visible text of the content, one entry per visible top-level element. */
const visible = (window: Win): string[] =>
    [...window.document.getElementById('contentArea').children]
        .filter((el: Win) => !el.classList.contains('mdb-folded-away'))
        .map((el: Win) => el.textContent.trim().replace(/\s+/g, ' '));
const heading = (window: Win, text: string): Win =>
    [...window.document.querySelectorAll('h1, h2, h3')].find((h: Win) => h.textContent.trim() === text);
const toggle = (window: Win, text: string): void => heading(window, text).querySelector('.mdb-fold-btn').click();

describe('Markdown Browser folding', () => {
    test('MF-1: a triangle per heading; folding hides the section', () => {
        const w = setup();
        show(w, DOC);
        assert.equal(w.document.querySelectorAll('.mdb-fold-btn').length, 5);
        toggle(w, 'B');
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'd text', 'E', 'e text']);
        assert.ok(heading(w, 'B').querySelector('.codicon-chevron-right'));
    });

    test('MF-2: subsections keep their own state', () => {
        const w = setup();
        show(w, DOC);
        toggle(w, 'C');
        toggle(w, 'A');
        assert.deepEqual(visible(w), ['A', 'E', 'e text']);
        toggle(w, 'A');
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'b text', 'C', 'D', 'd text', 'E', 'e text'], 'C stays folded');
    });

    test('MF-3: fold all / unfold all', () => {
        const w = setup();
        show(w, DOC);
        const btn = w.document.getElementById('foldAllBtn');
        btn.click();
        assert.deepEqual(visible(w), ['A', 'E']);
        assert.ok(btn.querySelector('.codicon-expand-all'), 'the button now offers unfold');
        btn.click();
        assert.equal(visible(w).length, 10);
    });

    test('MF-4: fold one level', () => {
        const w = setup();
        show(w, DOC);
        const select = w.document.getElementById('foldLevelSelect');
        assert.deepEqual([...select.options].map((o: Win) => o.textContent), ['H1', 'H2', 'H3']);
        assert.equal(select.value, '2', 'level 2 preselected');
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'E', 'e text']);
        assert.ok(w.document.getElementById('foldLevelBtn').querySelector('.codicon-unfold'));
        select.value = '1';
        select.dispatchEvent(new w.Event('change'));
        assert.ok(w.document.getElementById('foldLevelBtn').querySelector('.codicon-fold'), 'level 1 is still open');
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'E']);
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'E', 'e text'], 'level 2 still folded');
    });

    test('MF-5: state across re-renders', () => {
        const w = setup();
        show(w, DOC);
        toggle(w, 'B');
        show(w, `${DOC}\n\nmore`);
        assert.ok(!visible(w).includes('b text'), 'same file: B stays folded');
        show(w, DOC, '/ws/other.md');
        assert.ok(visible(w).includes('b text'), 'another file starts unfolded');
    });

    test('MF-6: transformed headings, levels beyond 6', () => {
        const w = setup();
        const raw = ['## <!--[SEC]--> Section', '', 'sec text', '', '####### Deep', '', 'deep text', '', '######## Deeper', '', 'deeper text', '', '## Next'].join('\n');
        show(w, transformMarkdown(raw));
        const select = w.document.getElementById('foldLevelSelect');
        assert.deepEqual([...select.options].map((o: Win) => o.textContent), ['H2', 'H7', 'H8']);
        select.value = '7';
        select.dispatchEvent(new w.Event('change'));
        w.document.getElementById('foldLevelBtn').click();
        const text = visible(w).join(' | ');
        assert.ok(!text.includes('deep text') && !text.includes('deeper text'), text);
        assert.ok(text.includes('sec text') && text.includes('Next'), text);
    });
});
