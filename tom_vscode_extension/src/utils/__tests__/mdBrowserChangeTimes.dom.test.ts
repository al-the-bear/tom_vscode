/**
 * The Markdown Browser shows and records change times (SOM §11.9.10), in a JSDOM running the real webview script
 * (media/markdownBrowser/main.js + blocks.js + teamReview.js + media/shared/mdQuestions.js + marked).
 *
 *   CT-1 mdbChangeTimeLabel: relative while recent (just now, min, h, d), the time as written after a week or in the
 *        future; the tooltip names the full time and its offset; mdbLatestChangeTime picks the latest instant
 *   CT-2 a comment block's, a question header's, a team answer's, a change mark's, a change comment's and an inline
 *        comment's time is a small label (`.mdb-time`, `data-changed-at`, the full time in `title`), never notation
 *        text; the elements the navigation finds carry `data-changed-at`
 *   CT-3 the navigation's "Changed since" steps only through what changed at or after the chosen time; markers stay
 *   CT-4 the browser's own writes record the time: a new comment `(author, <time>)`, an edited comment's time
 *        replaced, a team answer `**Answer (<time>):**`; an emptied answer reopens as `**Answer:**`
 *   CT-5 the shared writers: mdbWriteComment and mdbWriteAnswer with `at`, mdbReviewTime's shape
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

function setup(): { window: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined });
    window.eval(MARKED);
    window.eval(OVERLAY);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    return { window, posted };
}
const send = (window: Win, msg: Record<string, unknown>): void => { window.dispatchEvent(new window.MessageEvent('message', { data: msg })); };
const show = (window: Win, text: string): void =>
    send(window, { type: 'mdContent', content: text, filePath: '/ws/review.md', relativePath: 'review.md', crlf: false });
const $ = (window: Win, sel: string): Win[] => [...window.document.querySelectorAll(sel)];
const pickKinds = (window: Win, kinds: string[]): void => {
    const boxes = $(window, '#navKindPop input[data-nav-kind]');
    boxes.forEach((b) => { b.checked = kinds.includes(b.dataset.navKind); });
    boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
};
const count = (window: Win): string => window.document.getElementById('navCount').textContent;

const MIN = 60000;
/** A change time `ago` ms before now, in UTC (`Z`), minutes precision. */
const timeAgo = (ago: number): string => new Date(Date.now() - ago).toISOString().slice(0, 16) + 'Z';

describe('Markdown Browser: change times', () => {
    test('CT-1: the label', () => {
        const { window } = setup();
        const now = Date.parse('2026-11-10T12:00Z');
        const label = (t: string) => JSON.parse(JSON.stringify(window.mdbChangeTimeLabel(t, now)));
        assert.equal(label('2026-11-10T12:00Z').label, 'just now');
        assert.equal(label('2026-11-10T11:55Z').label, '5 min ago');
        assert.equal(label('2026-11-10T13:05+02:00').label, '55 min ago', 'compared as instants');
        assert.equal(label('2026-11-10T09:00Z').label, '3 h ago');
        assert.equal(label('2026-11-08T12:00Z').label, '2 d ago');
        assert.deepEqual(label('2026-11-01T08:30+01:00'), { label: '2026-11-01 08:30', title: 'Changed 2026-11-01 08:30 (UTC+01:00)' });
        assert.equal(label('2026-11-11T08:30Z').label, '2026-11-11 08:30', 'a future time as written');
        assert.equal(label('2026-11-10T09:00Z').title, 'Changed 2026-11-10 09:00 (UTC), 3 h ago');
        assert.equal(window.mdbChangeTimeLabel('2026-11-10', now), null);
        assert.equal(window.mdbLatestChangeTime('a (2026-11-10T09:00Z) b (2026-11-10T10:30+02:00) c (2026-11-10T08:45Z)'), '2026-11-10T09:00Z');
        assert.equal(window.mdbLatestChangeTime('no time'), '');
    });

    test('CT-2: labels, not notation', () => {
        const { window } = setup();
        const t1 = timeAgo(2 * 24 * 60 * MIN);
        const t2 = timeAgo(5 * MIN);
        show(window, [
            '# Review',
            '',
            `Kept {~~30~>15~~}{@alice ${t1}} days and {++ more ++}{@${t2}}.`,
            '',
            `> ⬆️ **C-1** (Alexis, ${t2}): timed.`,
            '',
            `A change: {++ new ++}{@bob ${t1}}{>>[++ new ++] why? <<}{@agent_spec_author ${t2}} and {>> note <<}{@carol ${t1}}`,
            '',
            `> **❓ BQ-1 (${t1}) — scope:** In scope?`,
            '> - (a) yes',
            '> - (b) no',
            '>',
            `> **Answer (${t2}):** (a)`,
        ].join('\n'));
        const text = window.document.querySelector('.markdown-body').textContent;
        assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no time is shown as notation');
        const labels = $(window, '.mdb-time');
        assert.ok(labels.length >= 7, `labels: ${labels.length}`);
        assert.ok(labels.every((l) => /^Changed \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)/.test(l.title)), 'the full time in the tooltip');
        assert.ok(labels.some((l) => l.textContent === '2 d ago') && labels.some((l) => l.textContent === '5 min ago'));
        assert.match(text, /\{@alice\}/, 'the authors stay');
        const comment = $(window, '.mdb-comment-block')[0];
        assert.equal(comment.dataset.changedAt, t2);
        assert.equal(comment.dataset.authors, 'Alexis');
        const changes = $(window, '.mdb-rm[data-kind="change"]');
        assert.deepEqual(changes.map((c) => c.dataset.changedAt ?? ''), [t1, t2, t1]);
        const notes = $(window, '.mdb-rm[data-kind="note"]');
        assert.deepEqual(notes.map((n) => n.dataset.changedAt ?? ''), [t2, t1], 'the change comment and the inline comment');
        const question = $(window, '.mdb-answer-btn')[0];
        assert.ok(question, 'the answer marker with its time is still an answer marker');
        assert.equal(question.dataset.changedAt, t2, 'the latest of header and answer');
        assert.equal(question.dataset.unanswered, undefined);
    });

    test('CT-3: changed since', () => {
        const { window } = setup();
        const old = timeAgo(3 * 24 * 60 * MIN);
        const fresh = timeAgo(10 * MIN);
        show(window, [
            '# Review',
            '',
            `Old {++ a ++}{@alice ${old}} and new {++ b ++}{@bob ${fresh}} and none {++ c ++}.`,
            '',
            `> ⬆️ **C-1** (Alexis, ${old}): old.`,
            '',
            `> ⬆️ **C-2** (Alexis, ${fresh}): new.`,
            '',
            `> **❓ BQ-1 (${old}) — q:** Old question?`,
            '> **Answer:**',
            '',
            `> **❓ BQ-2 (${fresh}) — q:** New question?`,
            '> **Answer:**',
            '',
            'Look ___check here___',
        ].join('\n'));
        pickKinds(window, ['changes', 'comments', 'questions', 'marked']);
        assert.equal(count(window), '–/8');
        const since = window.document.getElementById('navSince');
        since.value = '24h';
        since.dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.equal(count(window), '–/4', 'the new change, comment and question, and the marker');
        assert.match(window.document.getElementById('navKindBtn').textContent, /· since$/);
        window.document.getElementById('navNextBtn').click();
        assert.equal(window.document.querySelector('.mdb-nav-current').dataset.changedAt, fresh);
        since.value = 'custom';
        since.dispatchEvent(new window.Event('change', { bubbles: true }));
        const at = window.document.getElementById('navSinceAt');
        assert.equal(at.hidden, false, 'a chosen time is entered beside');
        assert.equal(count(window), '2/8', 'no time chosen yet: nothing filtered (the second change is current)');
        const d = new Date(Date.now() - 4 * 24 * 60 * MIN);
        const two = (n: number) => String(n).padStart(2, '0');
        at.value = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
        at.dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.match(count(window), /\/7$/, 'everything with a time after it, without the untimed change');
        since.value = '';
        since.dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.equal(at.hidden, true);
        assert.match(count(window), /\/8$/);
    });

    test('CT-4: the browser\'s writes record the time', () => {
        const { window, posted } = setup();
        const TIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}';
        const lastEdit = (): Record<string, string> => [...posted].reverse().find((m) => m.type === 'applyEdit') as Record<string, string>;
        const fail = (): void => send(window, { type: 'editResult', ok: false, error: 'x', editId: lastEdit().editId });
        send(window, { type: 'mdContent', content: ['# Doc', '', 'First para.', '', '> ⬆️ **C-4** (Bob, 2026-11-01T08:00Z): old remark',
            '', '> **❓ BQ-1 — q:** Sure?', '> **Answer:**'].join('\n'), filePath: '/ws/review.md', relativePath: 'review.md', crlf: false, author: 'Alexis' });

        $(window, '.mdb-answer-btn')[0].click();
        $(window, '.mdb-editor textarea')[0].value = 'yes';
        $(window, '.mdb-editor-btn')[0].click();
        assert.match(lastEdit().replacement, new RegExp(`^> \\*\\*Answer \\(${TIME}\\):\\*\\* yes$`), 'a team answer');
        fail();
        $(window, '.mdb-editor-btn')[1].click();

        const first = $(window, '.mdb-block').find((b: Win) => b.textContent.includes('First para.'));
        first.querySelector('.mdb-comment-btn').click();
        const area = $(window, '.mdb-editor textarea')[0];
        area.value += 'new remark';
        $(window, '.mdb-editor-btn')[0].click();
        assert.match(lastEdit().replacement, new RegExp(`^First para\\.\\n\\n> ⬆️ \\*\\*C-5\\*\\* \\(Alexis, ${TIME}\\): new remark$`), 'a new comment');
        fail();
        $(window, '.mdb-editor-btn')[1].click();

        const comment = $(window, '.mdb-comment-block')[0];
        comment.querySelector('.mdb-comment-edit-btn').click();
        const again = $(window, '.mdb-editor textarea')[0];
        assert.equal(again.value, '⬆️ **C-4** (Bob, 2026-11-01T08:00Z): old remark', 'the editor shows the source');
        again.value = '⬆️ **C-4** (Bob, 2026-11-01T08:00Z): new remark';
        $(window, '.mdb-editor-btn')[0].click();
        const edited = lastEdit().replacement;
        assert.match(edited, new RegExp(`^> ⬆️ \\*\\*C-4\\*\\* \\(Bob, ${TIME}\\): new remark$`), 'an edited comment: its author kept, its time the edit\'s');
        assert.doesNotMatch(edited, /2026-11-01T08:00Z/);
    });

    test('CT-5: the shared writers', () => {
        const { window } = setup();
        const T = '2026-11-10T09:15+01:00';
        assert.match(window.mdbReviewTime(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
        assert.equal(window.mdbReviewTime(new Date(2026, 10, 10, 9, 5)).slice(0, 16), '2026-11-10T09:05');
        assert.equal(window.mdbWriteComment('text', 'C-3', 'Alexis', T), `> ⬆️ **C-3** (Alexis, ${T}): text`);
        assert.equal(window.mdbWriteComment('text', 'C-3', '', T), `> ⬆️ **C-3** (${T}): text`);
        assert.equal(window.mdbWriteComment('⬆️ **C-2** (Eve, 2026-11-01T08:00Z): edited', 'C-3', 'Alexis', T),
            `> ⬆️ **C-2** (Eve, ${T}): edited`, 'an edit keeps the author and takes the new time');
        assert.equal(window.mdbWriteComment('⬆️ **C-2** (Eve): edited', 'C-3', 'Alexis'), '> ⬆️ **C-2** (Eve): edited', 'no time given: none added');
        assert.equal(window.mdbWriteComment('⬆️ **C-2**', 'C-3', 'Alexis', T), '', 'nothing but the header: no comment');
        const quote = ['> **❓ BQ-1 — q:** Sure?', '> - (a) yes', '> **Answer:** old'];
        assert.equal(window.mdbWriteAnswer(quote, 2, 13, 'new', T), `> **Answer (${T}):** new`);
        assert.equal(window.mdbWriteAnswer([`> **Answer (2026-11-01T08:00Z):** old`], 0, 33, '', T), '> **Answer:**', 'emptied: reopened');
        assert.equal(window.mdbWriteAnswer([`> **Answer (2026-11-01T08:00Z):** old`], 0, 33, 'new', T), `> **Answer (${T}):** new`, 'the old time replaced');
        assert.equal(window.mdbWriteAnswer(quote, 2, 13, 'new'), '> **Answer:** new', 'no time given: the marker as written');
    });
});
