/**
 * The MD Browser writes inline marks itself (media/markdownBrowser/blocks.js, main.js; SOM §11.9.3):
 * edit mode's right-click menu on a selection, and Track changes for paragraph edits.
 *
 *   WM-1 mdbLocateSelection: the selection by the text around it, the only occurrence, the n-th of as many as
 *        rendered, white space flexible; a point between two texts; more than once / not in the source refused
 *   WM-2 mdbSelectionMark: highlight + comment, deletion, replacement, a comment at a point, the token after the
 *        mark, edge white space outside it; refused: empty text, a delimiter, a blank line, inside another mark
 *   WM-3 mdbTrackedEdit: a word replaced, added, removed; a run replaced as one; punctuation stays; lines added
 *        and removed with their list marker outside the mark; a removed paragraph stays, marked; the token after
 *        every mark; code blocks, table rows and edits of existing marks written as they are (untracked)
 *   WM-4 the menu: only in edit mode; on a selection Comment / Mark for deletion / Replace with, on a point
 *        Insert comment here; Mark for deletion posts the block with `{-- --}`; Comment opens an editor and Save
 *        posts `{== ==}{>> <<}`; signed with the review member id and the time when one is set; inside a mark
 *        or code the menu says why not
 *   WM-5 Track changes: the toggle (pressed, aria-pressed); off, a paragraph edit posts the text as typed; on,
 *        it posts the marks
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');
const OVERLAY = readFileSync(join(ROOT, 'media', 'shared', 'mdOverlay.js'), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined });
    w.eval(MARKED);
    w.eval(OVERLAY);
    w.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    w.eval(asset('blocks.js'));
    w.eval(asset('teamReview.js'));
    w.eval(asset('main.js'));
    return { w, posted };
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];
const DOC = ['# Doc', '', 'The cat sat on the mat, the cat slept.', '', 'A `code` word and {++ an added ++} one.', '', '- one', '- two'].join('\n');
const show = (w: Win, extra: Record<string, unknown> = {}): void => {
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: DOC, filePath: '/ws/doc.md', relativePath: 'doc.md', crlf: false, ...extra } }));
};
/** The text node of the rendered document holding `text`. */
function textNode(w: Win, text: string): Win {
    const walker = w.document.createTreeWalker(w.document.getElementById('contentArea'), 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (String(n.nodeValue).includes(text)) { return n; } }
    throw new Error(`no text node with ${text}`);
}
/** Select the `nth` occurrence of `text` in its text node and right-click there. */
function rightClick(w: Win, text: string, nth = 0, collapsed = false): void {
    const node = textNode(w, text);
    let at = -1;
    for (let i = 0; i <= nth; i++) { at = String(node.nodeValue).indexOf(text, at + 1); }
    const range = w.document.createRange();
    range.setStart(node, at);
    range.setEnd(node, collapsed ? at : at + text.length);
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.parentElement.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
}
const menu = (w: Win): string[] => $(w, '.mdb-sel-menu .mdb-option').map((e) => e.textContent);
const lastEdit = (posted: Array<Record<string, unknown>>): Record<string, string> => [...posted].reverse().find((m) => m.type === 'applyEdit') as Record<string, string>;

describe('MD Browser: writing marks', () => {
    test('WM-1: locating a selection in the source', () => {
        const { w } = setup();
        const src = 'The cat sat on the mat, the cat slept.\nA **bold** move.';
        const loc = (...a: unknown[]) => plain(w.mdbLocateSelection(src, ...a));
        assert.deepEqual(loc('cat', '', ' sat', 0, 2), { start: 4, end: 7 }, 'by what follows it');
        assert.deepEqual(loc('cat', 'the ', ' slept', 1, 2), { start: 28, end: 31 }, 'by what surrounds it');
        assert.deepEqual(loc('cat', '', '', 1, 2), { start: 28, end: 31 }, 'the second of two, as rendered');
        assert.match(loc('cat', '', '', 1, 3).error, /more than once/, 'counts differ: ambiguous');
        assert.deepEqual(loc('mat, the', '', '', 0, 1), { start: 19, end: 27 });
        assert.deepEqual(loc('slept. A', '', '', 0, 1), { start: 32, end: 40 }, 'across a line break of the paragraph');
        assert.match(loc('bold move', '', '', 0, 1).error, /could not be found/, 'across formatting');
        assert.deepEqual(loc('', 'sat on', ' the mat', 0, 0), { start: 14, end: 14 }, 'a point');
        assert.match(loc('', '', '', 0, 0).error, /Click inside/);
    });

    test('WM-2: writing a mark', () => {
        const { w } = setup();
        const src = 'after 30 minutes of {++ new ++} rest';
        const mark = (...a: unknown[]) => plain(w.mdbSelectionMark(src, ...a));
        assert.equal(mark({ start: 6, end: 16 }, 'comment', ' why? ', '').text, 'after {== 30 minutes ==}{>> why? <<} of {++ new ++} rest');
        assert.equal(mark({ start: 5, end: 9 }, 'delete', '', '{@al}').text, 'after {-- 30 --}{@al} minutes of {++ new ++} rest', 'edge white space stays outside; the token follows');
        assert.equal(mark({ start: 6, end: 8 }, 'replace', '15', '').text, 'after {~~ 30 ~> 15 ~~} minutes of {++ new ++} rest');
        assert.equal(mark({ start: 8, end: 8 }, 'point', 'really?', '{@al 2026-11-20T12:00+01:00}').text, 'after 30{>> really? <<}{@al 2026-11-20T12:00+01:00} minutes of {++ new ++} rest');
        assert.match(mark({ start: 6, end: 8 }, 'comment', '  ', '').error, /Write the comment first/);
        assert.match(mark({ start: 6, end: 8 }, 'replace', '', '').error, /Write the replacement first/);
        assert.match(mark({ start: 6, end: 8 }, 'comment', 'a {>> b', '').error, /mark delimiter/);
        assert.match(mark({ start: 6, end: 8 }, 'comment', 'a\n\nb', '').error, /blank line/);
        assert.match(mark({ start: 24, end: 27 }, 'delete', '', '').error, /inside another mark/);
        assert.match(mark({ start: 17, end: 31 }, 'delete', '', '').error, /holds a mark already/);
        assert.match(mark({ start: 25, end: 25 }, 'point', 'x', '').error, /inside another mark/);
        assert.match(plain(w.mdbSelectionMark('a\n\nb', { start: 0, end: 4 }, 'delete', '', '')).error, /blank line/);
        assert.equal(w.mdbOwnToken('alice', '2026-11-20T12:00+01:00'), '{@alice 2026-11-20T12:00+01:00}');
        assert.equal(w.mdbOwnToken('', '2026-11-20T12:00+01:00'), '', 'no member id: unsigned');
    });

    test('WM-3: a tracked edit', () => {
        const { w } = setup();
        const t = (a: string, b: string, token = '') => plain(w.mdbTrackedEdit(a, b, token));
        assert.equal(t('Sessions expire after 30 minutes of inactivity.', 'Sessions expire after 15 minutes of inactivity on shared devices.').text,
            'Sessions expire after {~~ 30 ~> 15 ~~} minutes of inactivity {++ on shared devices ++}.');
        assert.equal(t('The big red house', 'The small blue house').text, 'The {~~ big red ~> small blue ~~} house', 'a run is one replacement');
        assert.equal(t('remove the last word here', 'remove the last word').text, 'remove the last word {-- here --}');
        assert.deepEqual(t('same', 'same'), { text: 'same', marks: 0, untracked: 0 });
        assert.equal(t('- one\n- two\n- three', '- one\n- three\n- four', '{@al}').text, '- one\n- {-- two --}{@al}\n- three\n- {++ four ++}{@al}',
            'the list marker outside the mark, the token after each');
        assert.equal(t('A first paragraph.\n\nA second one.', 'A first paragraph.').text, 'A first paragraph.\n\n{-- A second one. --}', 'a removed paragraph stays, marked');
        assert.equal(t('Para one.', 'Para one.\n\nA new paragraph here.').text, 'Para one.\n\n{++ A new paragraph here. ++}');
        assert.equal(t('> quoted old text', '> quoted new text').text, '> quoted {~~ old ~> new ~~} text');
        assert.deepEqual(t('Keep {++ this ++} and that', 'Keep this and those'), { text: 'Keep this and {~~ that ~> those ~~}', marks: 1, untracked: 1 },
            'an edited mark is written as typed');
        assert.deepEqual(t('```\ncode a\n```\ntext old', '```\ncode b\n```\ntext new'), { text: '```\ncode b\n```\ntext {~~ old ~> new ~~}', marks: 1, untracked: 1 });
        assert.deepEqual(t('| a | b |', '| a | c |'), { text: '| a | c |', marks: 0, untracked: 1 }, 'a table row');
        assert.equal(t('# Title old', '# Title new').text, '# Title {~~ old ~> new ~~}');
        assert.equal(t('a b', 'a {>> x <<} b').untracked, 1, 'a typed mark is not wrapped');
        // What is written reads back as marks, and accepting them gives the new text.
        const tracked = t('Sessions expire after 30 minutes.', 'Sessions end after 15 minutes of rest.').text;
        const accepted = tracked.replace(/\{~~ .*? ~> (.*?) ~~\}/g, '$1').replace(/\{\+\+ (.*?) \+\+\}/g, '$1').replace(/\{-- .*? --\}/g, '');
        assert.equal(accepted.replace(/\s+/g, ' ').trim(), 'Sessions end after 15 minutes of rest.');
    });

    test('WM-4: the right-click menu', () => {
        const { w, posted } = setup();
        show(w);
        rightClick(w, 'cat');
        assert.deepEqual(menu(w), [], 'not in edit mode: the browser\'s own menu');
        w.document.getElementById('editModeBtn').click();
        rightClick(w, 'cat', 1);
        assert.deepEqual(menu(w), ['Comment on “cat”…', 'Mark for deletion', 'Replace with…']);
        $(w, '.mdb-sel-menu [data-sel-action="trash"]')[0].click();
        assert.equal($(w, '.mdb-sel-menu').length, 0, 'the menu closes');
        let edit = lastEdit(posted);
        assert.equal(edit.expected, 'The cat sat on the mat, the cat slept.');
        assert.equal(edit.replacement, 'The cat sat on the mat, the {-- cat --} slept.', 'the second cat, unsigned without a member id');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'editResult', ok: false, error: 'x', editId: edit.editId } }));

        // Comment: an editor under the block; Save writes highlight + comment, signed with the member id.
        show(w, { memberId: 'alexis', content: DOC + '\n' });
        rightClick(w, 'mat');
        $(w, '.mdb-sel-menu [data-sel-action="comment"]')[0].click();
        const area = $(w, '.mdb-editor textarea')[0];
        assert.match(area.placeholder, /The comment on “mat”/);
        $(w, '.mdb-editor-btn')[0].click();
        assert.match($(w, '.mdb-editor-status')[0].textContent, /Write the comment first/, 'held until there is a text');
        area.value = 'which mat?';
        $(w, '.mdb-editor-btn')[0].click();
        edit = lastEdit(posted);
        assert.match(edit.replacement, /^The cat sat on the \{== mat ==\}\{>> which mat\? <<\}\{@alexis \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}\}, the cat slept\.$/);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'editResult', ok: false, error: 'x', editId: edit.editId } }));
        $(w, '.mdb-editor-btn')[1]?.click();

        // A point: Insert comment here.
        rightClick(w, 'slept', 0, true);
        assert.deepEqual(menu(w), ['Insert comment here…']);
        // Where no mark can go, the menu says why.
        rightClick(w, 'an added');
        assert.match($(w, '.mdb-sel-menu .mdb-sel-reason')[0].textContent, /inside another mark/);
        rightClick(w, 'code');
        assert.match($(w, '.mdb-sel-menu .mdb-sel-reason')[0].textContent, /into code/);
        w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
        assert.equal($(w, '.mdb-sel-menu').length, 0, 'Escape closes it');
    });

    test('WM-5: Track changes', () => {
        const { w, posted } = setup();
        show(w);
        w.document.getElementById('editModeBtn').click();
        const track = w.document.getElementById('trackBtn');
        assert.equal(track.getAttribute('aria-pressed'), 'false');
        const editPara = (value: string): Record<string, string> => {
            const block = textNode(w, 'The cat sat').parentElement.closest('.mdb-block');
            block.querySelector('.mdb-edit-btn').click();
            const area = $(w, '.mdb-editor textarea')[0];
            assert.match(area.value, /The cat sat on the mat, the cat slept\.$/);
            area.value = area.value.replace(/The cat sat.*$/, value);
            $(w, '.mdb-editor-btn')[0].click();
            const edit = lastEdit(posted);
            w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'editResult', ok: false, error: 'x', editId: edit.editId } }));
            $(w, '.mdb-editor-btn')[1]?.click();
            return edit;
        };
        assert.match(editPara('The dog sat on the mat, the cat slept.').replacement, /The dog sat on the mat, the cat slept\.$/, 'off: as typed');
        track.click();
        assert.equal(track.getAttribute('aria-pressed'), 'true');
        assert.ok(track.classList.contains('active'));
        assert.match(track.title, /^Track changes: on/);
        assert.match(editPara('The dog sat on the mat, the cat slept well.').replacement, /The \{~~ cat ~> dog ~~\} sat on the mat, the cat slept \{\+\+ well \+\+\}\.$/, 'on: as marks');
        track.click();
        assert.equal(track.getAttribute('aria-pressed'), 'false');
    });
});
