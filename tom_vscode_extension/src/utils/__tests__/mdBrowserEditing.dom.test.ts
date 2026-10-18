/**
 * The Markdown Browser's in-place editing, in a JSDOM running the real
 * webview script (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   MD-1  an answer button follows every `**Answer:**` outside code
 *   MD-2  the answer editor: 5 rows, its button hidden while open, Save sends
 *         the line, what was there and the line with the answer inserted
 *   MD-3  a successful save closes the editor; a refused one keeps it open with the reason
 *   MD-4  edit mode: an edit and an insert button at the end of every editable block
 *   MD-5  edit sends the block's source and the new text; insert appends to it
 *   MD-6  a refresh of the same file is held while an editor is open, applied when it closes
 *   MD-7  with CR/LF on there are no editing controls
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
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
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
            { startLine: 3, endLine: 4, expected: '**Answer:**', replacement: '**Answer:** Yes, go ahead. ', filePath: '/ws/review.md' },
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
        assert.equal($(window, '.mdb-block-actions').length, 0, 'off by default');
        window.document.getElementById('editModeBtn').click();
        const actions = $(window, '.mdb-block-actions');
        assert.equal(actions.length, 3, 'paragraph, list, code — not the heading');

        actions[0].querySelector('.mdb-edit-btn').click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.value, 'Is the plan right?\n**Answer:**');
        area.value = 'Is the plan right? (v2)\n**Answer:**';
        $(window, '.mdb-editor-btn')[0].click();
        assert.deepEqual(
            (({ startLine, endLine, expected, replacement }) => ({ startLine, endLine, expected, replacement }))(lastEdit(posted) as never),
            { startLine: 2, endLine: 4, expected: 'Is the plan right?\n**Answer:**', replacement: 'Is the plan right? (v2)\n**Answer:**' },
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
});
