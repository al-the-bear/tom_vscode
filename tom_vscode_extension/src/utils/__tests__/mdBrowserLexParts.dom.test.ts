/**
 * The MD Browser lexes in small parts (media/markdownBrowser/main.js LEX_PART_CHARS, blocks.js mdbSplitForLexing;
 * webwork mdprobe3: marked's anchored block rules make lexing a part O(n²) in WebKit).
 *
 *   LP-1 the split: parts of at least the target size, starting before a heading or at a line at column 0 after a
 *        blank line that is no list item — never inside fenced code, an open html element, a reading-notation div,
 *        a list (a following item, an indented continuation) or before a lazy continuation; a long stretch without
 *        headings is split too; the parts joined are the text
 *   LP-2 the page renders the reference documents the same lexed whole and in small parts (the block phase of every
 *        part first, then the inline phase with every part's link definitions; each part lexed with the newline
 *        that joins it to the next): the same HTML and the
 *        same block line map — a crafted document (tables, loose and tight lists, nested lists, HTML groups,
 *        review marks, reading-notation divs, link definitions used in other parts, indented and fenced code,
 *        setext headings, block quotes and comment blocks), the Meridian rendition (a SOM document) and the user
 *        guide (large: rendered in sliced tasks)
 *   LP-3 every document above the part size is lexed in parts (not only those above LARGE_DOC_CHARS)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');
const MERIDIAN = join(ROOT, '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents', 'meridian_order_management.tomspecs.md');
const USER_GUIDE = join(ROOT, 'doc', 'user_guide.md');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(partChars?: number): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    if (partChars !== undefined) { window.__mdbLexPartChars = partChars; }
    window.eval(MARKED);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    return window;
}

/** Show `text` and wait until the render is done (the content area is no longer busy). */
async function render(window: Win, text: string): Promise<void> {
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath: '/ws/doc.md', crlf: false } }));
    const content = window.document.getElementById('contentArea');
    for (let i = 0; i < 6000 && (content.hasAttribute('aria-busy') || !content.querySelector('.mdb-doc')); i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(!content.hasAttribute('aria-busy'), 'the render finished');
}

/** The rendered document, and its block line map (type, start, end of every block). */
function snapshot(window: Win): { html: string; blocks: string[] } {
    const doc = window.document.querySelector('#contentArea > .mdb-doc');
    const blocks = [...doc.querySelectorAll('.mdb-section > *')]
        .map((el: Win) => el.__mdbBlock)
        .filter(Boolean)
        .map((b: Win) => `${b.type}:${b.startLine}-${b.endLine}`);
    return { html: doc.innerHTML, blocks };
}

/** A paragraph of `n` sentences (no heading for a long stretch). */
const para = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `Sentence ${i} of ${tag}, with a [link][def-${tag}] and some words.`).join(' ');

const CRAFTED = [
    '# Crafted', '',
    para(8, 'p1'), '',
    '| Column | Value |', '| --- | --- |', '| a | 1 |', '| b | 2 |', '',
    para(6, 'p2'), '',
    '- tight one', '- tight two', '- tight three', '',
    para(5, 'p3'), '',
    '- loose one', '', '- loose two', '', '  continued in two', '', '- loose three', '',
    para(5, 'p4'), '',
    '1. first', '   - nested a', '   - nested b', '2. second', '', '   its paragraph', '',
    'A paragraph', 'with a lazy', 'continuation.', '',
    '<details><summary>An HTML group</summary>', '', para(4, 'html'), '', '</details>', '',
    para(4, 'p5'), '',
    'A change {~~ old ~> new ~~}{@alexis 2026-11-24T10:00+01:00}, an addition {++ added ++} and a comment {>> why? <<}.', '',
    ':::aside', '', para(4, 'aside'), '', 'Another paragraph in the div.', '', ':::', '',
    para(4, 'p6'), '',
    '```js', 'const a = 1;', '', 'const b = 2;', '```', '',
    '    indented code', '', '    more indented code', '',
    'Setext heading', '==============', '',
    para(4, 'p7'), '',
    '> A quote', '> over two lines', '',
    '> ⬆️ **C-3** (alexis): a review comment', '',
    '---', '',
    para(6, 'p8'), '',
    ...['p1', 'p2', 'p3', 'p4', 'html', 'p5', 'aside', 'p6', 'p7', 'p8'].map((t) => `[def-${t}]: https://example.com/${t}`),
    '',
].join('\n');

describe('MD Browser: lexing in small parts', () => {
    test('LP-1: the split', (t) => {
        const w = setup();
        t.after(() => w.close());
        const parts = JSON.parse(JSON.stringify(w.mdbSplitForLexing(CRAFTED, 200))) as Array<{ startLine: number; text: string }>;
        assert.ok(parts.length > 8, `many parts (${parts.length})`);
        assert.equal(parts.map((p) => p.text).join('\n'), CRAFTED, 'the parts are the text');
        const lines = CRAFTED.split('\n');
        const at = (s: string): number => lines.indexOf(s);
        const starts = parts.map((p) => p.startLine);
        for (const s of starts.slice(1)) {
            const line = lines[s];
            assert.ok(/^#{1,6}\s/.test(line) || (/^\S/.test(line) && lines[s - 1].trim() === '' && !/^(?:[*+-]|\d+[.)])\s/.test(line)), `a part starts at a heading or a safe boundary: ${JSON.stringify(line)}`);
        }
        // Never inside the fence, the HTML group, the div, a list, or before an indented / lazy continuation.
        const inside = (from: string, to: string): number[] => starts.filter((s) => s > at(from) && s <= at(to) - (to === '```' ? 0 : 0));
        assert.deepEqual(starts.filter((s) => s > at('```js') && s <= at('const b = 2;')), [], 'not inside the fence');
        assert.deepEqual(starts.filter((s) => s > at('<details><summary>An HTML group</summary>') && s <= at('</details>')), [], 'not inside the HTML group');
        assert.deepEqual(starts.filter((s) => s > at(':::aside') && s <= at('Another paragraph in the div.') + 2), [], 'not inside the div');
        assert.deepEqual(inside('- loose one', '- loose three'), [], 'not inside the loose list');
        assert.ok(!starts.includes(at('  continued in two')) && !starts.includes(at('   its paragraph')) && !starts.includes(at('continuation.')), 'not before a continuation');
        assert.ok(!starts.includes(at('    more indented code')), 'not before indented code');
        // A long stretch without headings is split too.
        const flat = Array.from({ length: 40 }, (_, i) => para(3, `f${i}`)).join('\n\n');
        assert.ok(JSON.parse(JSON.stringify(w.mdbSplitForLexing(flat, 2000))).length > 3, 'no heading needed');
        assert.equal(w.mdbSplitForLexing('short', 1000).length, 1, 'below the target: one part');
    });

    const cases: Array<[string, () => string, number]> = [
        ['the crafted document', () => CRAFTED, 150],
        ['the Meridian rendition', () => readFileSync(MERIDIAN, 'utf8'), 2000],
        ['the user guide', () => readFileSync(USER_GUIDE, 'utf8'), 4000],
    ];
    for (const [name, load, partChars] of cases) {
        const missing = name === 'the Meridian rendition' && !existsSync(MERIDIAN) ? `no ${MERIDIAN}` : false;
        test(`LP-2: ${name} renders the same in parts`, { skip: missing }, async (t) => {
            const text = load();
            const whole = setup(1e12);
            const parted = setup(partChars);
            t.after(() => { whole.close(); parted.close(); });
            assert.ok(parted.mdbSplitForLexing(text, partChars).length > 2, 'the document is split into several parts');
            await render(whole, text);
            await render(parted, text);
            const a = snapshot(whole);
            const b = snapshot(parted);
            assert.ok(a.blocks.length > 10, `${a.blocks.length} blocks`);
            assert.deepEqual(b.blocks, a.blocks, 'the same block line map');
            assert.equal(b.html, a.html, 'the same HTML');
            if (name === 'the crafted document') {
                assert.match(b.html, /<a href="https:\/\/example\.com\/p1">link<\/a>/, 'a reference link uses a definition of another part');
                // Every definition is used as a link (a reading-notation div's collapsed preview shows its source text).
                for (const tag of ['p1', 'p2', 'p3', 'p4', 'html', 'p5', 'aside', 'p6', 'p7', 'p8']) {
                    assert.ok(b.html.includes(`href="https://example.com/${tag}"`), `def-${tag} resolved`);
                }
            }
        });
    }

    test('LP-3: every document above the part size is lexed in parts', () => {
        const main = asset('main.js');
        assert.match(main, /var LEX_PART_CHARS = (\d+);/);
        const size = Number(/var LEX_PART_CHARS = (\d+);/.exec(main)![1]);
        assert.ok(size >= 4000 && size <= 8000, `LEX_PART_CHARS ${size} is between 4,000 and 8,000`);
        assert.match(main, /var parts = lexParts\(text \|\| ''\);/, 'the render splits by the part size, not by LARGE_DOC_CHARS');
        assert.match(main, /text\.length > chars \? mdbSplitForLexing\(text, chars\)/);
        assert.match(main, /i < parts\.length - 1 \? part\.text \+ '\\n' : part\.text/, 'a part is lexed with its joining newline');
    });
});
