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
 *   MF-9  a large document renders in linear time, in batches that yield to the event loop; it is
 *         lexed in parts, and its blocks keep their file lines across the parts. Linear time is measured
 *         as a ratio, not a wall-clock limit (vscimpa16): twice the document may take at most 3x the time
 *         (the sizes interleaved, each the faster of two runs), so a busy machine slows both sides alike
 *         while a quadratic render (4x) still fails; MF-9b checks the rule on counted linear and quadratic work
 *   MF-10 blocks are grouped into sections of 150; only a large document lays sections out lazily
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
    [...window.document.querySelectorAll('#contentArea > .mdb-doc > .mdb-section > *')]
        .filter((el: Win) => !el.classList.contains('mdb-folded-away'))
        .map((el: Win) => el.textContent.trim().replace(/\s+/g, ' '));
const heading = (window: Win, text: string): Win =>
    [...window.document.querySelectorAll('h1, h2, h3')].find((h: Win) => h.textContent.trim() === text);
const toggle = (window: Win, text: string): void => heading(window, text).querySelector('.mdb-fold-btn').click();

/** Twice the work in at most this many times the time: linear is about 2, quadratic about 4. */
const LINEAR_RATIO = 3;

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
        const margins = (): string[] => [...w.document.querySelectorAll('#contentArea > .mdb-doc > .mdb-section > *')].map((el: Win) => el.style.marginLeft);
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
        const doc = (sections: number): string => {
            const parts: string[] = [];
            const filler = 'the quick brown fox jumps over the lazy dog and keeps on running past the fence';
            for (let i = 0; i < sections; i++) { parts.push(`## Section ${i}`, '', `text ${i} ${filler}`, ''); }
            return parts.join('\n');
        };
        /** Render a document in a fresh window; the time until it is done, and the window. */
        const render = async (sections: number): Promise<{ ms: number; w: Win }> => {
            const w = setup();
            const text = doc(sections);
            const area = w.document.getElementById('contentArea');
            const started = performance.now();
            show(w, text);
            assert.equal(area.getAttribute('aria-busy'), 'true', 'not done in one task: the window gets turns');
            while (area.getAttribute('aria-busy') === 'true') { await new Promise((r) => setTimeout(r, 5)); }
            return { ms: performance.now() - started, w };
        };
        const N = 2000;
        assert.ok(doc(N).length > 200000, 'both sizes are large documents: lexed in parts, laid out lazily');
        // Interleaved (N, 2N, N, 2N) and the faster run of each size: a busy machine, or a move to another
        // CPU core, then slows both sizes alike instead of one.
        const runs = [await render(N), await render(2 * N), await render(N), await render(2 * N)];
        const fastest = (a: { ms: number; w: Win }, b: { ms: number; w: Win }): { ms: number; w: Win } => (a.ms <= b.ms ? a : b);
        const once = fastest(runs[0], runs[2]);
        const twice = fastest(runs[1], runs[3]);

        const w = twice.w;
        assert.equal(w.document.querySelectorAll('.mdb-fold-btn').length, 2 * N);
        const lastTitle = `Section ${2 * N - 1}`;
        assert.equal(heading(w, lastTitle).dataset.foldKey, `2|${lastTitle}#1`);
        const last = heading(w, lastTitle).closest('.mdb-block');
        assert.equal(last.__mdbBlock.startLine, 4 * (2 * N - 1), 'file lines hold across the lexed parts');

        const ratio = twice.ms / once.ms;
        assert.ok(ratio < LINEAR_RATIO,
            `twice the document took ${ratio.toFixed(2)}x the time (${once.ms.toFixed(0)} ms for ${N} sections, `
            + `${twice.ms.toFixed(0)} ms for ${2 * N}); linear is about 2, quadratic about 4`);
    });

    test('MF-9b: the ratio rule tells linear from quadratic', () => {
        // Counted work, not timed (a timed micro-benchmark measures the CPU's moods): a linear render does
        // twice the work for twice the document, a quadratic one four times — the rule passes the first
        // and fails the second whatever the machine.
        const work = { linear: (n: number): number => 3 * n + 40, quadratic: (n: number): number => n * n / 2 + 3 * n };
        for (const n of [2000, 4000, 12000]) {
            assert.ok(work.linear(2 * n) / work.linear(n) < LINEAR_RATIO, `linear passes at ${n}`);
            assert.ok(work.quadratic(2 * n) / work.quadratic(n) >= LINEAR_RATIO, `quadratic fails at ${n}`);
        }
    });

    test('MF-10: sections', () => {
        const w = setup();
        const parts: string[] = [];
        for (let i = 0; i < 400; i++) { parts.push(`para ${i}`, ''); }
        show(w, parts.join('\n'));
        const sections = [...w.document.querySelectorAll('.mdb-doc > .mdb-section')];
        assert.deepEqual(sections.map((s: Win) => s.children.length), [150, 150, 100]);
        assert.ok(!w.document.querySelector('.mdb-doc').classList.contains('mdb-large'), 'a small document is laid out whole');
        assert.match(sections[0].style.containIntrinsicSize, /^auto \d+px$/);
    });
});
