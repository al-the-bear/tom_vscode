/**
 * The Markdown Browser's in-place editing, in a JSDOM running the real
 * webview script (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   MD-1  an answer button follows every `**Answer:**` outside code
 *   MD-2  the answer editor: 5 rows, its button hidden while open, Save sends
 *         the answer's lines, what was there and the lines with the answer written
 *   MD-3  a successful save closes the editor; a refused one keeps it open with the reason
 *   MD-4  edit mode: an edit and an insert button at the end of every editable block, shown only in edit mode
 *   MD-5  edit opens the block's source with the blank line before it and sends the
 *         text as typed (removing that newline merges); insert appends to the block
 *   MD-6  a refresh of the same file is held while an editor is open, applied when it closes
 *   MD-7  with CR/LF on there are no editing controls
 *   MD-8  GFM: a table renders as a table (marked's defaults are kept)
 *   MD-9  a save patches the shown document in place; the file's refresh with the same text renders nothing
 *   MD-10 a refresh with unchanged text keeps the rendered nodes
 *   MD-11 an existing answer opens in the editor and saving replaces it, quote lines included
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

const DOC = [
    '# Review',
    '',
    'Is the plan right?',
    '**Answer:**',
    '',
    '- item one',
    '- item two',
    '',
    '```',
    '**Answer:** not a marker',
    '```',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { window: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined });
    window.eval(MARKED);
    window.eval(asset('blocks.js'));
    window.eval(asset('main.js'));
    return { window, posted };
}

function send(window: Win, msg: Record<string, unknown>): void {
    window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
}
const content = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ type: 'mdContent', content: text, filePath: '/ws/review.md', relativePath: 'review.md', crlf: false, ...extra });
const $ = (window: Win, sel: string): Win[] => [...window.document.querySelectorAll(sel)];
const lastEdit = (posted: Array<Record<string, unknown>>): Record<string, unknown> =>
    [...posted].reverse().find((m) => m.type === 'applyEdit')!;

describe('Markdown Browser editing', () => {
    test('MD-1: answer buttons', () => {
        const { window } = setup();
        send(window, content(DOC));
        const buttons = $(window, '.mdb-answer-btn');
        assert.equal(buttons.length, 1, 'the marker inside code gets none');
        assert.equal(buttons[0].previousElementSibling.textContent, 'Answer:');
    });

    test('MD-2/MD-3: the answer editor', () => {
        const { window, posted } = setup();
        send(window, content(DOC));
        const btn = $(window, '.mdb-answer-btn')[0];
        btn.click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.rows, 5);
        assert.equal(btn.style.display, 'none', 'the button gives way to save / discard');
        area.value = 'Yes, go ahead.';
        $(window, '.mdb-editor-btn')[0].click();
        const edit = lastEdit(posted);
        assert.deepEqual(
            { startLine: edit.startLine, endLine: edit.endLine, expected: edit.expected, replacement: edit.replacement, filePath: edit.filePath },
            { startLine: 3, endLine: 4, expected: '**Answer:**', replacement: '**Answer:** Yes, go ahead.', filePath: '/ws/review.md' },
        );

        send(window, { type: 'editResult', ok: false, error: 'The file changed', editId: edit.editId });
        assert.equal($(window, '.mdb-editor').length, 1, 'a refused save keeps the text');
        assert.match($(window, '.mdb-editor-status')[0].textContent, /changed/);
        $(window, '.mdb-editor-btn')[0].click();
        send(window, { type: 'editResult', ok: true, editId: lastEdit(posted).editId });
        assert.equal($(window, '.mdb-editor').length, 0);
        assert.equal(btn.style.display, '');
    });

    test('MD-4/MD-5: edit mode', () => {
        const { window, posted } = setup();
        send(window, content(DOC));
        const actions = $(window, '.mdb-block-actions');
        assert.equal(actions.length, 3, 'paragraph, list, code — not the heading');
        const shown = (): string => window.getComputedStyle(actions[0]).display;
        assert.equal(shown(), 'none', 'hidden by default');
        window.document.getElementById('editModeBtn').click();
        assert.equal(shown(), 'flex', 'edit mode shows them');

        actions[0].querySelector('.mdb-edit-btn').click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.value, '\nIs the plan right?\n**Answer:**', 'with the newline that separates it from the block before');
        area.value = 'Is the plan right? (v2)\n**Answer:**\n';
        $(window, '.mdb-editor-btn')[0].click();
        assert.deepEqual(
            (({ startLine, endLine, expected, replacement }) => ({ startLine, endLine, expected, replacement }))(lastEdit(posted) as never),
            { startLine: 1, endLine: 4, expected: '\nIs the plan right?\n**Answer:**', replacement: 'Is the plan right? (v2)\n**Answer:**\n' },
            'sent exactly as typed',
        );
        $(window, '.mdb-editor-btn')[1].click();

        $(window, '.mdb-block-actions')[1].querySelector('.mdb-insert-btn').click();
        const insert = $(window, '.mdb-editor textarea')[0];
        assert.equal(insert.value, '');
        insert.value = '\n\nA new paragraph.';
        $(window, '.mdb-editor-btn')[0].click();
        const e = lastEdit(posted);
        assert.equal(e.startLine, 5);
        assert.equal(e.endLine, 7);
        assert.equal(e.replacement, '- item one\n- item two\n\nA new paragraph.', 'appended directly at the end');
    });

    test('MD-6: a refresh is held while an editor is open', () => {
        const { window } = setup();
        send(window, content(DOC));
        $(window, '.mdb-answer-btn')[0].click();
        send(window, content(`${DOC}\n\nAdded elsewhere.`));
        assert.equal($(window, '.mdb-editor').length, 1, 'the open editor survives');
        assert.ok(!window.document.getElementById('contentArea').textContent.includes('Added elsewhere'));
        $(window, '.mdb-editor-btn')[1].click();
        assert.ok(window.document.getElementById('contentArea').textContent.includes('Added elsewhere'), 'applied once closed');
    });

    test('MD-7: no controls with CR/LF on', () => {
        const { window } = setup();
        window.document.getElementById('editModeBtn').click();
        send(window, content(DOC, { crlf: true }));
        assert.equal($(window, '.mdb-answer-btn').length, 0);
        assert.equal($(window, '.mdb-block-actions').length, 0);
    });

    test('MD-8: GFM tables', () => {
        const { window } = setup();
        send(window, content('Intro\n\n| Field | Meaning |\n|---|---|\n| a | first |\n| b | ~~second~~ |'));
        assert.equal($(window, 'table').length, 1);
        assert.equal($(window, 'tbody tr').length, 2);
        assert.equal($(window, 'del').length, 1, 'strikethrough');
    });

    test('MD-9: a save patches in place', () => {
        const { window, posted } = setup();
        const doc = '# T\n\nfirst\n\nsecond\n\nthird';
        send(window, content(doc));
        window.document.getElementById('editModeBtn').click();
        const firstNode = $(window, '#contentArea p')[0];
        $(window, '.mdb-block-actions')[1].querySelector('.mdb-edit-btn').click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.value, '\nsecond');
        area.value = 'second, merged';
        $(window, '.mdb-editor-btn')[0].click();
        const edit = lastEdit(posted);
        send(window, { type: 'editResult', editId: edit.editId, ok: true });
        assert.equal($(window, '.mdb-editor').length, 0, 'closed');
        assert.deepEqual($(window, '#contentArea p').map((p: Win) => p.textContent.trim()), ['first\nsecond, merged', 'third']);
        assert.equal($(window, '#contentArea h1').length, 1);
        const merged = $(window, '#contentArea p')[0];
        assert.notEqual(merged, firstNode, 'the region was re-rendered');
        // The refresh the save causes carries the same text: nothing re-renders.
        send(window, content('# T\n\nfirst\nsecond, merged\n\nthird'));
        assert.equal($(window, '#contentArea p')[0], merged);
        // The patched block is editable at its new lines.
        $(window, '.mdb-block-actions')[1].querySelector('.mdb-edit-btn').click();
        const again = $(window, '.mdb-editor textarea')[0];
        assert.equal(again.value, '\nthird');
        again.value = '\nthird!';
        $(window, '.mdb-editor-btn')[0].click();
        assert.deepEqual([lastEdit(posted).startLine, lastEdit(posted).endLine], [4, 6]);
    });

    test('MD-10: unchanged text keeps the nodes', () => {
        const { window } = setup();
        send(window, content(DOC));
        const p = $(window, '#contentArea p')[0];
        send(window, content(DOC));
        assert.equal($(window, '#contentArea p')[0], p);
        send(window, content(`${DOC}\n\nmore`));
        assert.notEqual($(window, '#contentArea p')[0], p, 'changed text renders again');
    });

    test('MD-11: editing an existing answer', () => {
        const { window, posted } = setup();
        const doc = ['> **BQ-1:** Which?', '>', '> **Answer:** (c) ', '>', '> *Next:* x', '', 'after'].join('\n');
        send(window, content(doc));
        $(window, '.mdb-answer-btn')[0].click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.value, '(c)', 'the answer as written, to edit');
        area.value = '(c) and\nmore detail';
        $(window, '.mdb-editor-btn')[0].click();
        const edit = lastEdit(posted);
        assert.deepEqual([edit.startLine, edit.endLine, edit.expected, edit.replacement],
            [2, 3, '> **Answer:** (c) ', '> **Answer:** (c) and\n> more detail']);
        send(window, { type: 'editResult', ok: true, editId: edit.editId });
        // Shown again after the save: the two-line answer opens whole.
        $(window, '.mdb-answer-btn')[0].click();
        assert.equal($(window, '.mdb-editor textarea')[0].value, '(c) and\nmore detail');
        $(window, '.mdb-editor-btn')[1].click();
        $(window, '.mdb-answer-btn')[0].click();
        $(window, '.mdb-editor-btn')[0].click();
        assert.equal(lastEdit(posted).editId, edit.editId, 'unchanged: nothing is sent');
    });
});
