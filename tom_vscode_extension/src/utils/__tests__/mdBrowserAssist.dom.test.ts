/**
 * Grill me / Explain in detail and proposed answers in the MD Browser webview
 * (ccparity_i_assist-6), with the real script (main.js + blocks.js + the
 * shared question parser + marked) in a JSDOM.
 *
 *   GE-1 the buttons: Grill me and Explain in detail after the answer button of every unanswered question
 *        block, none on an answered one, none on an Answer line that has no question
 *   GE-2 a click posts `assistQuestion` with the use, the shown file, the question id and its Answer line
 *   GE-3 a proposed answer shows Accept / Edit / Discard; Accept posts the edit that writes it into the Answer
 *        line and removes it (with its separator line); Discard removes it and leaves the answer; Edit opens the
 *        editor with the proposal and saving accepts the edited text
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
    '# Review',                                          // 0
    '',                                                  // 1
    '> **❓ CC-1 — Open:** which way?',                  // 2
    '> - (a) left',                                      // 3
    '> - **(b)** right',                                 // 4
    '>',                                                 // 5
    '> **Answer:**',                                     // 6
    '',                                                  // 7
    '> **❓ CC-2 — Answered:** done already?',           // 8
    '>',                                                 // 9
    '> **Answer:** (a)',                                 // 10
    '',                                                  // 11
    'A plain paragraph.',                                // 12
    '**Answer:**',                                       // 13
    '',                                                  // 14
    '> **❓ PR-1 — Proposed:** keep it?',                // 15
    '>',                                                 // 16
    '> **Answer:**',                                     // 17
    '>',                                                 // 18
    '> **Proposed answer** (grill me, 2026-11-08): (a) keep it,', // 19
    '> because it works.',                               // 20
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): { window: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined });
    window.eval(MARKED);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    // The writes' change times (SOM §11.9.10) are mdBrowserChangeTimes.dom.test.ts's: here the clock gives none, so
    // each write is compared with its text exactly.
    window.mdbReviewTime = () => '';
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mdContent', content: DOC, filePath: '/ws/review.md', relativePath: 'review.md', crlf: false } }));
    return { window, posted };
}
const $ = (window: Win, sel: string): Win[] => [...window.document.querySelectorAll(sel)];
const edits = (posted: Array<Record<string, unknown>>) => posted.filter((m) => m.type === 'applyEdit')
    .map((m) => ({ startLine: m.startLine, endLine: m.endLine, expected: m.expected, replacement: m.replacement }));

describe('MD Browser: Grill me, Explain in detail, proposed answers', () => {
    test('GE-1: the buttons on open questions', (t) => {
        const { window } = setup(t);
        const answerButtons = $(window, '.mdb-answer-btn');
        assert.equal(answerButtons.length, 4, 'every Answer marker has its answer button');
        const assist = $(window, '.mdb-assist-btn').map((b) => b.dataset.assist);
        assert.deepEqual(assist, ['grillMe', 'explainInDetail', 'grillMe', 'explainInDetail'], 'CC-1 and PR-1, both open; CC-2 answered, the plain marker has no question');
        const first = answerButtons[0];
        assert.equal(first.nextElementSibling.dataset.assist, 'grillMe', 'right after the answer button');
        assert.equal(first.nextElementSibling.nextElementSibling.dataset.assist, 'explainInDetail');
    });

    test('GE-2: a click asks the host', (t) => {
        const { window, posted } = setup(t);
        $(window, '.mdb-assist-grillMe')[0].click();
        $(window, '.mdb-assist-explainInDetail')[1].click();
        assert.deepEqual(posted.filter((m) => m.type === 'assistQuestion'), [
            { type: 'assistQuestion', use: 'grillMe', filePath: '/ws/review.md', questionId: 'CC-1', answerLine: 6 },
            { type: 'assistQuestion', use: 'explainInDetail', filePath: '/ws/review.md', questionId: 'PR-1', answerLine: 17 },
        ]);
        assert.ok($(window, '.mdb-assist-grillMe')[0].classList.contains('mdb-assist-started'));
    });

    test('GE-3: Accept, Edit, Discard', (t) => {
        const { window, posted } = setup(t);
        const strong = $(window, 'strong').find((s) => s.textContent.trim() === 'Proposed answer');
        const buttons = [strong.nextElementSibling, strong.nextElementSibling.nextElementSibling, strong.nextElementSibling.nextElementSibling.nextElementSibling];
        assert.deepEqual(buttons.map((b) => [...b.classList].find((c: string) => c.startsWith('mdb-proposal-') && c !== 'mdb-proposal-btn')), ['mdb-proposal-accept', 'mdb-proposal-edit', 'mdb-proposal-discard']);
        const block = '> **Answer:**\n>\n> **Proposed answer** (grill me, 2026-11-08): (a) keep it,\n> because it works.';
        buttons[0].click();
        assert.deepEqual(edits(posted).pop(), { startLine: 17, endLine: 21, expected: block, replacement: '> **Answer:** (a) keep it,\n> because it works.' }, 'Accept');
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'editResult', ok: false, editId: 0, error: 'test' } }));
        buttons[2].click();
        assert.deepEqual(edits(posted).pop(), { startLine: 17, endLine: 21, expected: block, replacement: '> **Answer:**' }, 'Discard: the answer stays, separator and proposal go');
        buttons[1].click();
        const area = $(window, '.mdb-editor textarea')[0];
        assert.equal(area.value, '(a) keep it,\nbecause it works.', 'Edit opens with the proposal');
        area.value = '(a) keep it as it is';
        $(window, '.mdb-editor-btn')[0].click();
        assert.deepEqual(edits(posted).pop(), { startLine: 17, endLine: 21, expected: block, replacement: '> **Answer:** (a) keep it as it is' }, 'saving accepts the edited text');
    });
});
