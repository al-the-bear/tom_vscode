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
 *   MF-7  the indent toggle: headings by level, content one step deeper, spaces from the dropdown (default 2)
 *   MF-8  <details> blocks keep their content inside them (rendered as one group)
 *   MF-9  a large document renders in linear time, in batches that yield to the event loop
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
    [...window.document.querySelector('#contentArea > .mdb-doc').children]
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

    test('MF-7: indent by heading level', () => {
        const w = setup();
        show(w, DOC);
        const margins = (): string[] => [...w.document.querySelector('#contentArea > .mdb-doc').children].map((el: Win) => el.style.marginLeft);
        assert.ok(margins().every((m) => m === ''), 'off by default');
        const select = w.document.getElementById('indentSizeSelect');
        assert.equal(select.value, '2');
        w.document.getElementById('indentBtn').click();
        // A, a text, B, b text, C, c text, D, d text, E, e text
        assert.deepEqual(margins(), ['0ch', '2ch', '2ch', '4ch', '4ch', '6ch', '2ch', '4ch', '0ch', '2ch']);
        select.value = '4';
        select.dispatchEvent(new w.Event('change'));
        assert.deepEqual(margins().slice(0, 4), ['0ch', '4ch', '4ch', '8ch']);
        show(w, `${DOC}\n\nmore`);
        assert.equal(margins()[margins().length - 1], '4ch', 'kept across a re-render');
        w.document.getElementById('indentBtn').click();
        assert.ok(margins().every((m) => m === ''), 'off again');
    });

    test('MF-8: details keep their content', () => {
        const w = setup();
        show(w, '## Tool\n\n<details><summary>result</summary>\n\n```text\nbig output\n```\n\n</details>\n\nafter');
        const details = w.document.querySelectorAll('details');
        assert.equal(details.length, 1);
        assert.ok(details[0].querySelector('pre'), 'the code block is inside <details>');
        assert.ok(!w.document.querySelector('details') .open, 'collapsed, as written');
    });

    test('MF-9: a large document renders in linear time, in batches', async () => {
        const w = setup();
        const parts: string[] = [];
        for (let i = 0; i < 12000; i++) { parts.push(`## Section ${i}`, '', `text ${i}`, ''); }
        const area = w.document.getElementById('contentArea');
        const started = Date.now();
        show(w, parts.join('\n'));
        assert.equal(area.getAttribute('aria-busy'), 'true', 'not done in one task: the window gets turns');
        while (area.getAttribute('aria-busy') === 'true') { await new Promise((r) => setTimeout(r, 5)); }
        const ms = Date.now() - started;
        assert.equal(w.document.querySelectorAll('.mdb-fold-btn').length, 12000);
        assert.equal(heading(w, 'Section 11999').dataset.foldKey, '2|Section 11999#1');
        assert.ok(ms < 10000, `rendering 24 000 blocks took ${ms} ms`);
    });
});
