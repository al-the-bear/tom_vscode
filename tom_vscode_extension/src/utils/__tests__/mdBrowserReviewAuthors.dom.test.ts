/**
 * The Markdown Browser's review authors, the check-here marker and long comments, in a JSDOM running the
 * real webview script (media/markdownBrowser/main.js + blocks.js + marked + media/shared/mdOverlay.js).
 *
 *   RA-1 `___check here___` is drawn as a badge; the navigation kind "Marked: check here" steps through them
 *   RA-2 authors: a comment block's `(author)`, an attribution token after a mark (`{@alice}`) and after a
 *        change's own comment become `data-authors`; an agent's (`agent_<role>`, `agent:<role>`) `data-agent`;
 *        the token is shown once
 *   RA-3 the kind "Agent comments" finds the agents' comment blocks and inline comments only
 *   RA-4 Whose: the popup lists the document's authors and "(no author)"; unticking one leaves its comments
 *        and changes out of the arrows and the count; questions are not filtered
 *   RA-5 a comment longer than 200 characters (block or inline) gets the overlay and preview-editor buttons,
 *        a short one none; they post renderMarkdown / openMarkdownPreview with the whole comment, and the host's
 *        markdownHtml opens the overlay
 *   RA-6 the helpers: mdbCommentAuthor, mdbCommentBody, mdbAttribution, mdbIsAgentAuthor
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
const openPopup = (window: Win): void => { window.document.getElementById('navKindBtn').click(); };

const LONG = 'This needs a closer look because the retention rule contradicts the archive section, '
    + 'and the two cannot both hold once the ledger is replayed after a restore; the reviewer should decide '
    + 'which of the two wins before the gate.';

const DOC = [
    '# Review',
    '',
    'The retention period is {~~30~>15~~}{@alice} days. ___check here___',
    '',
    '> ⬆️ **C-1** (agent_spec_author): ___check here___ the retention conflicts with §4.',
    '',
    'Archive after a year.{>> keep it? <<}{@agent:reviewer} And {>> short note <<}',
    '',
    '> ⬆️ **C-2** (Alexis): ' + LONG,
    '',
    '> ⬆️ **C-3**: unsigned',
    '',
    'A change with a comment: {++ new ++}{>>[++ new ++] why added? <<}{@agent_spec_author}',
    '',
    'Is the plan right?',
    '**Answer:**',
].join('\n');

describe('Markdown Browser: review authors, check-here, long comments', () => {
    test('RA-1: the check-here marker', () => {
        const { window } = setup();
        show(window, DOC);
        const marks = $(window, '.mdb-check-here');
        assert.equal(marks.length, 2);
        assert.match(marks[0].textContent, /check here/);
        assert.doesNotMatch(window.document.querySelector('.markdown-body').textContent, /___/);
        pickKinds(window, ['marked']);
        assert.equal(count(window), '–/2');
    });

    test('RA-2: authors on comments and marks', () => {
        const { window } = setup();
        show(window, DOC);
        const blocks = $(window, '.mdb-comment-block');
        assert.deepEqual(blocks.map((b) => [b.dataset.authors ?? '', b.dataset.agent ?? '']),
            [['agent_spec_author', '1'], ['Alexis', ''], ['', '']]);
        const change = $(window, '.mdb-rm[data-kind="change"]')[0];
        assert.equal(change.dataset.authors, 'alice');
        assert.equal(change.dataset.agent, undefined);
        const notes = $(window, '.mdb-rm[data-kind="note"]');
        assert.deepEqual(notes.map((n) => n.dataset.authors ?? ''), ['agent:reviewer', '', 'agent_spec_author']);
        assert.deepEqual(notes.map((n) => n.dataset.agent ?? ''), ['1', '', '1']);
        const text = window.document.querySelector('.markdown-body').textContent;
        assert.equal(text.split('{@alice}').length - 1, 1, 'the token is shown once');
        assert.equal(text.split('{@agent_spec_author}').length - 1, 1);
    });

    test('RA-3: agent comments', () => {
        const { window } = setup();
        show(window, DOC);
        pickKinds(window, ['agent']);
        assert.equal(count(window), '–/3', 'C-1, the inline comment and the change comment');
        window.document.getElementById('navNextBtn').click();
        assert.ok(window.document.querySelector('.mdb-nav-current').classList.contains('mdb-comment-block'));
    });

    test('RA-4: whose comments and changes', () => {
        const { window } = setup();
        show(window, DOC);
        openPopup(window);
        const authors = $(window, '#navAuthors input[data-nav-author]');
        assert.deepEqual(authors.map((b) => b.dataset.navAuthor), ['Alexis', 'alice', 'agent_spec_author', 'agent:reviewer', '']);
        assert.ok(authors.every((b) => b.checked));
        assert.match(window.document.getElementById('navAuthors').textContent, /\(no author\)/);
        pickKinds(window, ['comments', 'changes', 'inline', 'questions']);
        assert.equal(count(window), '–/9', '3 blocks, 2 changes, 3 inline comments, 1 question');
        const untick = (name: string) => {
            const box = authors.find((b) => b.dataset.navAuthor === name);
            box.checked = false;
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        };
        untick('alice');
        assert.equal(count(window), '–/8');
        untick('');
        assert.equal(count(window), '–/5', 'C-3, the unsigned inline comment and the unsigned change go too');
        untick('agent_spec_author');
        assert.equal(count(window), '–/3', 'C-1 and the change comment go; the question stays');
        openPopup(window);
        openPopup(window);
        assert.equal($(window, '#navAuthors input[data-nav-author="alice"]')[0].checked, false, 'the choice survives reopening');
    });

    test('RA-5: long comments open in the overlay or the preview editor', () => {
        const { window, posted } = setup();
        show(window, DOC + '\n\nInline: {>> ' + LONG + ' <<}\n');
        const views = $(window, '.mdb-md-view');
        assert.equal(views.length, 2, 'C-2 and the long inline comment; the short ones none');
        const [overlayBtn, editorBtn] = [...views[0].querySelectorAll('.mdb-md-btn')] as Win[];
        overlayBtn.click();
        editorBtn.click();
        assert.deepEqual(posted.filter((m) => m.type === 'renderMarkdown' || m.type === 'openMarkdownPreview').map((m) => [m.type, m.markdown, m.title]),
            [['renderMarkdown', LONG, 'Comment — Alexis'], ['openMarkdownPreview', LONG, 'Comment — Alexis']]);
        send(window, { type: 'markdownHtml', title: 'Comment — Alexis', html: '<p>rendered</p>' });
        const overlay = window.document.querySelector('.tom-md-overlay');
        assert.ok(overlay.classList.contains('visible'));
        assert.match(overlay.textContent, /rendered/);
        const inline = views[1].querySelector('.mdb-md-btn');
        assert.equal(inline.dataset.md, LONG);
    });

    test('RA-6: the helpers', () => {
        const { window } = setup();
        assert.equal(window.mdbCommentAuthor('> ⬆️ **C-12** (agent_spec_author): text'), 'agent_spec_author');
        assert.equal(window.mdbCommentAuthor('> ⬆️ **C-3**: text'), '');
        assert.equal(window.mdbCommentBody('⬆️ **C-12** (Alexis): the text'), 'the text');
        assert.deepEqual(JSON.parse(JSON.stringify(window.mdbAttribution('{@agent_x +bob -carol} rest'))),
            { raw: '{@agent_x +bob -carol}', authors: ['agent_x'], voters: ['bob', 'carol'] });
        assert.equal(window.mdbAttribution('no token'), null);
        assert.deepEqual(['agent', 'agent_spec_author', 'agent:reviewer', 'Agent_X', 'agentur', 'alice'].map(window.mdbIsAgentAuthor),
            [true, true, true, true, false, false]);
    });
});
