/**
 * The Markdown Browser's links, navigation and search, in a JSDOM running the
 * real webview script (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   MN-1  section references `OUTER > INNER` become links to their heading; unknown ones stay text
 *   MN-2  following a reference is recorded: the document back / forward arrows walk it
 *   MN-3  plain-text .md paths become links that navigate like Markdown links; code blocks are left alone
 *   MN-4  hovering a link to a .md document offers "open here" and "open in a new MD Browser"
 *   MN-5  search: counts the matches, Enter / Shift+Enter and the arrows step through them,
 *         a match in a folded section unfolds it, Escape clears
 *   MN-6  switching edit mode does not touch the document's DOM
 *   MN-7  the search box's clear button: shown with text, empties the box and the results
 *   MN-8  leaving a document reports where the reader was (source line + offset); a document
 *         shown again with that position opens there; scrolling reports it too
 *   MN-9  the line indicator: the line of the block at the top of the view, of all lines
 *   MN-10 search starts at the reading position, however many matches lie before it (no cap),
 *         typing on keeps the current match, and next after the last match goes to the first
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined });
    w.eval(MARKED);
    w.eval(asset('blocks.js'));
    w.eval(asset('main.js'));
    return { w, posted };
}
const show = (w: Win, text: string): void => {
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath: '/ws/spec.md', crlf: false } }));
};
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A navigation message without the reading position it carries (MN-8 checks that). */
const nav = (m: Record<string, unknown> | undefined): Record<string, unknown> => {
    const { filePath: _f, position: _p, ...rest } = m ?? {};
    return rest;
};

const SPEC = transformMarkdown([
    '# <!--[SBP]--> Blueprint',
    '',
    'See `STKG > TOENV`, and A > CRIT, and NOPE > TOENV-X, and see iterations/notes.md.',
    '',
    '## <!--[A]--> Part A',
    '',
    '### <!--[CRIT]--> Criterion in A',
    '',
    'needle one',
    '',
    '## <!--[STKG]--> Stakeholders',
    '',
    '### <!--[CRIT]--> Criterion in STKG',
    '',
    '#### <!--[TOENV]--> Tooling',
    '',
    'needle two and NEEDLE three',
    '',
    '```',
    'not/linked.md and STKG > TOENV',
    '```',
].join('\n'));

describe('Markdown Browser links, navigation and search', () => {
    test('MN-1: section references', () => {
        const { w } = setup();
        show(w, SPEC);
        const refs = $(w, 'a.mdb-secref');
        assert.deepEqual(refs.map((a) => a.dataset.secref), ['STKG > TOENV', 'A > CRIT'], 'NOPE > TOENV-X names no heading; code blocks are skipped');
        assert.ok(refs[0].closest('code'), 'inside inline code too');
        refs[1].click();
        const heading = $(w, 'h3').find((h) => h.textContent.includes('Criterion in A'));
        assert.notEqual(heading.style.backgroundColor, '', 'the CRIT under A, not the one under STKG, is flashed');
    });

    test('MN-2: document back / forward', () => {
        const { w } = setup();
        show(w, SPEC);
        const back = w.document.getElementById('docBackBtn');
        const forward = w.document.getElementById('docForwardBtn');
        assert.equal(back.disabled, true);
        $(w, 'a.mdb-secref')[0].click();
        assert.equal(back.disabled, false, 'the jump is recorded');
        assert.equal(forward.disabled, true);
        back.click();
        assert.equal(back.disabled, true);
        assert.equal(forward.disabled, false);
        forward.click();
        assert.equal(back.disabled, false);
        show(w, '# Other');
        assert.equal(back.disabled, false, 'a re-render of the same file keeps the trail');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: '# x', filePath: '/ws/other.md', crlf: false } }));
        assert.equal(back.disabled, true, 'another file starts a new trail');
    });

    test('MN-3: plain-text .md paths', () => {
        const { w, posted } = setup();
        show(w, SPEC);
        const links = $(w, 'a.mdb-autolink');
        assert.deepEqual(links.map((a) => a.getAttribute('href')), ['iterations/notes.md']);
        links[0].click();
        assert.deepEqual(posted.filter((m) => m.type === 'navigateLink').map(nav), [{ type: 'navigateLink', href: 'iterations/notes.md' }]);
    });

    test('MN-4: the link popup', async () => {
        const { w, posted } = setup();
        show(w, 'A [doc](sub/doc.md#part) and [site](https://x.org) and iterations/notes.md');
        const popup = w.document.querySelector('.mdb-link-popup');
        const site = $(w, 'a').find((a) => a.textContent === 'site');
        site.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
        await sleep(350);
        assert.ok(!popup.classList.contains('visible'), 'not for a URL');
        const doc = $(w, 'a').find((a) => a.textContent === 'doc');
        doc.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
        await sleep(350);
        assert.ok(popup.classList.contains('visible'));
        popup.querySelector('[data-target="new"]').click();
        assert.deepEqual(nav(posted.filter((m) => m.type === 'navigateLink').pop()), { type: 'navigateLink', href: 'sub/doc.md#part', newPanel: true });
        assert.ok(!popup.classList.contains('visible'));
        $(w, 'a.mdb-autolink')[0].dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
        await sleep(350);
        popup.querySelector('[data-target="same"]').click();
        assert.deepEqual(nav(posted.filter((m) => m.type === 'navigateLink').pop()), { type: 'navigateLink', href: 'iterations/notes.md', newPanel: false });
    });

    test('MN-5: search', async () => {
        const { w } = setup();
        show(w, SPEC);
        const input = w.document.getElementById('searchInput');
        const count = w.document.getElementById('searchCount');
        const stkg = $(w, 'h2').find((h) => h.textContent.includes('Stakeholders'));
        stkg.querySelector('.mdb-fold-btn').click();
        const tooling = $(w, 'h4')[0].parentNode;
        assert.ok(tooling.classList.contains('mdb-folded-away'));
        input.value = 'needle';
        input.dispatchEvent(new w.Event('input'));
        await sleep(5);
        assert.equal(count.textContent, '1 of 3', 'case-insensitive, from the top');
        const key = (k: string, shiftKey = false): void => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, shiftKey }));
        key('Enter');
        assert.equal(count.textContent, '2 of 3');
        assert.ok(!tooling.classList.contains('mdb-folded-away'), 'the match in the folded section is revealed');
        w.document.getElementById('searchNextBtn').click();
        assert.equal(count.textContent, '3 of 3');
        key('Enter');
        assert.equal(count.textContent, '1 of 3', 'wraps around');
        key('Enter', true);
        assert.equal(count.textContent, '3 of 3');
        input.value = 'zzz';
        input.dispatchEvent(new w.Event('input'));
        await sleep(5);
        assert.equal(count.textContent, 'No results');
        key('Escape');
        assert.equal(input.value, '');
        assert.equal(count.textContent, '');
    });

    test('MN-6: edit mode touches no block', () => {
        const { w } = setup();
        show(w, SPEC);
        const records: unknown[] = [];
        const observer = new w.MutationObserver((r: unknown[]) => records.push(...r));
        observer.observe(w.document.getElementById('contentArea'), { childList: true, subtree: true, attributes: true });
        w.document.getElementById('editModeBtn').click();
        w.document.getElementById('editModeBtn').click();
        assert.deepEqual(observer.takeRecords(), []);
        assert.equal(records.length, 0);
    });

    test('MN-7: clearing the search', async () => {
        const { w } = setup();
        show(w, SPEC);
        const input = w.document.getElementById('searchInput');
        const clear = w.document.getElementById('searchClearBtn');
        assert.equal(w.getComputedStyle(clear).display, 'none', 'hidden while empty');
        input.value = 'needle';
        input.dispatchEvent(new w.Event('input'));
        await sleep(5);
        assert.equal(w.getComputedStyle(clear).display, 'flex');
        clear.click();
        assert.equal(input.value, '');
        assert.equal(w.document.getElementById('searchCount').textContent, '');
        assert.equal(w.getComputedStyle(clear).display, 'none');
    });

    test('MN-8: the reading position across documents', async () => {
        const { w, posted } = setup();
        const doc = ['# T', '', 'first', '', 'second', '', 'third', '', 'see other.md'].join('\n');
        show(w, doc);
        const area = w.document.getElementById('contentArea');
        let scrollTop = 0;
        Object.defineProperty(area, 'scrollTop', { get: () => scrollTop, set: (v: number) => { scrollTop = v; }, configurable: true });
        // Layout stand-ins: the block reading "third" starts 1534px into the
        // document and moves with the scroll offset; the view's top is 0.
        w.Element.prototype.getBoundingClientRect = function (this: Win) {
            return { top: this !== area && /third/.test(this.textContent) ? 1534 - scrollTop : 0, bottom: 0, left: 0, right: 0, width: 100, height: 10 };
        };
        const third = (): Win => [...w.document.querySelectorAll('.mdb-block')].find((b: Win) => b.textContent.includes('third'));
        w.document.elementFromPoint = () => third().querySelector('p');
        scrollTop = 1234;
        w.document.querySelector('a.mdb-autolink').click();
        assert.deepEqual(posted.filter((m) => m.type === 'navigateLink').pop(),
            { type: 'navigateLink', href: 'other.md', filePath: '/ws/spec.md', position: { line: 6, delta: 300, scrollTop: 1234 } });

        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: '# Other', filePath: '/ws/other.md', crlf: false } }));
        scrollTop = 0;
        w.dispatchEvent(new w.MessageEvent('message', {
            data: { type: 'mdContent', content: doc, filePath: '/ws/spec.md', crlf: false, position: { line: 6, delta: 10, scrollTop: 999 } },
        }));
        assert.equal(scrollTop, 1524, 'the block of line 6 is put back 10px below the top');

        area.dispatchEvent(new w.Event('scroll'));
        await sleep(350);
        assert.deepEqual(posted.filter((m) => m.type === 'readingPosition').pop(),
            { type: 'readingPosition', filePath: '/ws/spec.md', position: { line: 6, delta: 10, scrollTop: 1524 } }, 'and stays there');
    });

    test('MN-9: line X / N', async () => {
        const { w } = setup();
        const doc = ['# T', '', 'first', '', 'second', '', 'third'].join('\n');
        show(w, doc);
        const second = [...w.document.querySelectorAll('.mdb-block')].find((b: Win) => b.textContent.includes('second'));
        w.document.elementFromPoint = () => second.querySelector('p');
        w.document.getElementById('contentArea').dispatchEvent(new w.Event('scroll'));
        await sleep(50);
        assert.equal(w.document.getElementById('linePos').textContent, 'Line 5 / 7');
    });

    test('MN-10: search from the reading position', async () => {
        const { w } = setup();
        const parts: string[] = [];
        for (let i = 0; i < 11000; i++) { parts.push(`x${i} needle`, ''); }
        show(w, parts.join('\n'));
        const block = (i: number): Win => w.document.querySelectorAll('.mdb-block')[i];
        w.document.elementFromPoint = () => block(10500).querySelector('p');
        const input = w.document.getElementById('searchInput');
        const count = w.document.getElementById('searchCount');
        const type = async (text: string): Promise<void> => {
            input.value = text;
            input.dispatchEvent(new w.Event('input'));
            await sleep(5);
        };
        await type('ne');
        assert.equal(count.textContent, '10501 of 11000', 'from the block at the top of the view, past 10 000 earlier matches');
        w.document.elementFromPoint = () => block(10400).querySelector('p');
        await type('needle');
        assert.equal(count.textContent, '10501 of 11000', 'typing on stays on the current match while it is in view');
        const next = w.document.getElementById('searchNextBtn');
        for (let i = 0; i < 499; i++) { next.click(); }
        assert.equal(count.textContent, '11000 of 11000');
        next.click();
        assert.equal(count.textContent, '1 of 11000', 'after the last, the first from the top');
    });
});
