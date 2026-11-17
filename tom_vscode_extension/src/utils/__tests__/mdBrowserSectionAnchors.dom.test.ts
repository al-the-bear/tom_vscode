/**
 * MD Browser: `#<SECTION-ID>` anchors (vscimpb150, tom_specs irout3), in a JSDOM running the real webview script
 * (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   SA-1 `#TOKEN` scrolls to the heading carrying `<!--[TOKEN]-->` (its last id, case-sensitive); a dotted full id
 *        names the heading as a whole; the same last id under two parents: the first in document order
 *   SA-2 the order: an element with that exact id first, then the section id, then the heading text (the slug,
 *        of the heading's own words: without its id label and fold controls, trimmed); a slug anchor still works,
 *        on a plain heading and a sectioned one; an unknown anchor scrolls nowhere
 *   SA-3 a cross-document `file.md#TOKEN`: the anchor applied once the target document renders
 *   SA-4 mdbSectionAnchorIndex, the pure lookup
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

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    w.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { /* JSDOM has none */ };
    w.eval(MARKED);
    w.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    w.eval(asset('blocks.js'));
    w.eval(asset('teamReview.js'));
    w.eval(asset('main.js'));
    return w;
}
const show = (w: Win, text: string, anchor?: string, filePath = '/ws/spec.md'): void => {
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath, crlf: false, ...(anchor ? { anchor } : {}) } }));
};
/** Clear every flash, so the next jump's target is the only flashed element. */
const unflash = (w: Win): void => {
    for (const el of w.document.querySelectorAll('[style]')) { (el as Win).style.backgroundColor = ''; }
};
const scrollTo = (w: Win, anchor: string): void => {
    unflash(w);
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'scrollToAnchor', anchor } }));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The element the last jump went to (both jump paths flash it), by its text. */
const target = (w: Win): string | undefined => {
    const el = [...w.document.querySelectorAll('#contentArea [style]')]
        .find((e: Win) => /findMatchHighlight/.test(e.style.backgroundColor));
    return el ? (el as Win).textContent.replace(/\s+/g, ' ').trim() : undefined;
};

const SPEC = transformMarkdown([
    '# <!--[SBP]--> Blueprint',
    '',
    'Intro.',
    '',
    '## <!--[A]--> Part A',
    '',
    '### <!--[CRIT]--> Criterion in A',
    '',
    '## <!--[STKG]--> Stakeholders',
    '',
    '### <!--[CRIT]--> Criterion in STKG',
    '',
    '#### <!--[TOENV]--> Tooling',
    '',
    '## Tooling notes',
    '',
    '## <!--[tooling-notes]--> Something else',
    '',
    '<span id="EXACT">an element with an exact id</span>',
    '',
    '## <!--[EXACT]--> The heading named EXACT',
    '',
    '## A plain heading',
].join('\n'));

describe('MD Browser section-id anchors', () => {
    test('SA-1: #TOKEN reaches the heading carrying it', () => {
        const w = setup();
        show(w, SPEC);
        scrollTo(w, 'TOENV');
        assert.match(target(w) ?? '', /Tooling$/, 'the heading with <!--[TOENV]-->');
        scrollTo(w, 'toenv');
        assert.notEqual(target(w), 'TOENV Tooling', 'case-sensitive: no section id `toenv`');
        scrollTo(w, 'CRIT');
        assert.match(target(w) ?? '', /Criterion in A$/, 'the same last id twice: the first in document order');
        scrollTo(w, 'SBP.STKG.CRIT');
        assert.match(target(w) ?? '', /Criterion in STKG$/, 'a dotted full id names its heading as a whole');
        scrollTo(w, 'SBP.NOPE.CRIT');
        assert.equal(target(w), undefined, 'an unknown full id reaches nothing');
    });

    test('SA-2: the order: exact id, section id, slug', () => {
        const w = setup();
        show(w, SPEC);
        scrollTo(w, 'EXACT');
        assert.equal(target(w), 'an element with an exact id', 'an element with that exact id first');
        scrollTo(w, 'tooling-notes');
        assert.match(target(w) ?? '', /Something else$/, 'a section id before a heading whose text slugs to it');
        scrollTo(w, 'a-plain-heading');
        assert.equal(target(w), 'A plain heading', 'a slug anchor still works');
        scrollTo(w, 'stakeholders');
        assert.match(target(w) ?? '', /Stakeholders$/, 'a sectioned heading by its words, without its id label');
        scrollTo(w, 'nowhere-at-all');
        assert.equal(target(w), undefined);
    });

    test('SA-3: a cross-document file.md#TOKEN', async () => {
        const w = setup();
        show(w, '# Other document\n\nSee [the tooling](spec.md#TOENV).', undefined, '/ws/other.md');
        unflash(w);
        // The host resolves `spec.md#TOENV` (navigate-md-anchor) and opens spec.md with the anchor.
        show(w, SPEC, 'TOENV');
        await sleep(120);
        assert.match(target(w) ?? '', /Tooling$/, 'scrolled once the target document rendered');
    });

    test('SA-4: mdbSectionAnchorIndex', () => {
        const w = setup();
        const ids = ['SBP', 'SBP.A', 'SBP.A.CRIT', 'SBP.STKG', 'SBP.STKG.CRIT', '', 'SBP.STKG.CRIT.TOENV'];
        assert.equal(w.mdbSectionAnchorIndex('CRIT', ids), 2);
        assert.equal(w.mdbSectionAnchorIndex('SBP.STKG.CRIT', ids), 4);
        assert.equal(w.mdbSectionAnchorIndex('STKG.CRIT', ids), -1, 'a dotted anchor matches a full id as a whole');
        assert.equal(w.mdbSectionAnchorIndex('TOENV', ids), 6);
        assert.equal(w.mdbSectionAnchorIndex('crit', ids), -1, 'case-sensitive');
        assert.equal(w.mdbSectionAnchorIndex('', ids), -1);
    });
});
