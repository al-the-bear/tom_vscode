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
        assert.deepEqual(posted.filter((m) => m.type === 'navigateLink'), [{ type: 'navigateLink', href: 'iterations/notes.md' }]);
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
        assert.deepEqual(posted.filter((m) => m.type === 'navigateLink').pop(), { type: 'navigateLink', href: 'sub/doc.md#part', newPanel: true });
        assert.ok(!popup.classList.contains('visible'));
        $(w, 'a.mdb-autolink')[0].dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
        await sleep(350);
        popup.querySelector('[data-target="same"]').click();
        assert.deepEqual(posted.filter((m) => m.type === 'navigateLink').pop(), { type: 'navigateLink', href: 'iterations/notes.md', newPanel: false });
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
});
