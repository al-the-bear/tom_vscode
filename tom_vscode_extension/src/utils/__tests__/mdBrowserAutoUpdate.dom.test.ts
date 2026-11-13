/**
 * The MD Browser updates by itself when Grill me (or any md question tool) writes a proposal or an answer
 * (vscimpb66b). A JSDOM runs the real webview (main.js, blocks.js, mdQuestions.js, marked); the host side is
 * checked on its source and through the write notifier.
 *
 *   AU-1 what changed: mdbChangedQuestions names a question whose block changed (an answer written, a proposal
 *        written or removed) or that is new, by id with its header line in the new text; an unchanged question
 *        is not named; a repeated id by its occurrence
 *   AU-2 nothing typed: a refresh while an answer editor is open (opened, nothing typed — the DP-19 case) closes
 *        the editor and shows the new version at once; the panel reports no open editor (no unsaved edits);
 *        the changed question is scrolled to and marked for a moment
 *   AU-3 typed text: the refresh waits and a bar names the changed questions; Show the new version drops the text
 *        and renders; Keep my text keeps typing and renders when the editor closes; a save of text typed against
 *        the old version sends the old lines as `expected`, so the host refuses it over the new answer
 *   AU-4 Grill me end to end in the panel: the proposal shows as soon as it is written, the Answer line as soon as
 *        it is accepted (the proposal gone), with an answer editor left open and nothing typed
 *   AU-5 the host: every write of the spec / md question tools (vscodeSomDocumentIo, through the editor or on
 *        disk) notifies the panels on the file, which render it again at once; the file watcher also takes
 *        create events (an atomic rename); the notifier tells every listener and survives a failing one
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { changedMdQuestions, proposeMdAnswer, settleProposedAnswer } from '../mdQuestions.js';
import { notifyDocumentWritten, onDocumentWritten } from '../../services/documentWrites.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

const DOC = [
    '# Decisions',
    '',
    'Some intro text.',
    '',
    '> **❓ DP-18 — Storage:** Where do the secrets live?',
    '> - (a) a file',
    '> - **(b)** the OS keychain',
    '>',
    '> **Answer:** (b)',
    '',
    'Between the questions.',
    '',
    '> **❓ DP-19 — Sync:** How do machines share the vault?',
    '> - (a) git',
    '> - **(b)** a server',
    '>',
    '> **Answer:**',
    '',
    'The end.',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { window: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined });
    window.HTMLElement.prototype.scrollIntoView = function (this: { __scrolled?: boolean }) { this.__scrolled = true; };
    window.eval(MARKED);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    window.mdbReviewTime = () => '';
    return { window, posted };
}
const send = (window: Win, msg: Record<string, unknown>): void => { window.dispatchEvent(new window.MessageEvent('message', { data: msg })); };
const content = (text: string): Record<string, unknown> => ({ type: 'mdContent', content: text, filePath: '/ws/tsm.md', relativePath: 'tsm.md', crlf: false });
const $ = (window: Win, sel: string): Win[] => [...window.document.querySelectorAll(sel)];
const shownText = (window: Win): string => window.document.getElementById('contentArea').textContent.replace(/\s+/g, ' ');
const lastEditState = (posted: Array<Record<string, unknown>>): unknown => [...posted].reverse().find((m) => m.type === 'editState')?.openEditors;
/** The answer button of question `index` (0 DP-18, 1 DP-19). */
const answerButton = (window: Win, index: number): Win => $(window, '.mdb-answer-btn')[index];

const PROPOSED = proposeMdAnswer(DOC, 'DP-19', '(b) a server, git as the fallback', 'grill me', '2026-11-11').text;
const ACCEPTED = settleProposedAnswer(PROPOSED, 'DP-19', 'accept').text;

describe('the MD Browser follows what Grill me writes', () => {
    test('AU-1: what changed', () => {
        const dp19 = DOC.split('\n').findIndex((l) => l.includes('DP-19'));
        assert.deepEqual(changedMdQuestions(DOC, PROPOSED), [{ id: 'DP-19', line: dp19 }], 'a proposal written');
        assert.deepEqual(changedMdQuestions(PROPOSED, ACCEPTED), [{ id: 'DP-19', line: dp19 }], 'accepted: the Answer line, the proposal gone');
        assert.deepEqual(changedMdQuestions(DOC, DOC.replace('The end.', 'The real end.')), [], 'text outside the questions');
        const added = `${DOC}\n\n> **❓ DP-20 — New:** Another?\n>\n> **Answer:**`;
        assert.deepEqual(changedMdQuestions(DOC, added).map((q) => q.id), ['DP-20'], 'a new question');
        const twice = `${DOC}\n\n> **❓ DP-19 — Sync:** again\n>\n> **Answer:**`;
        assert.deepEqual(changedMdQuestions(twice, twice.replace(/again\n>\n> \*\*Answer:\*\*$/, 'again\n>\n> **Answer:** yes')).map((q) => q.id), ['DP-19'], 'the second DP-19 only');
    });

    test('AU-2: nothing typed — the editor goes, the new version shows, the question is marked', () => {
        const { window, posted } = setup();
        send(window, content(DOC));
        answerButton(window, 1).click();
        assert.equal($(window, '.mdb-editor').length, 1);
        assert.equal(lastEditState(posted), 1, 'the panel reports an open editor');
        send(window, content(PROPOSED));
        assert.equal($(window, '.mdb-editor').length, 0, 'the untouched editor went');
        assert.match(shownText(window), /Proposed answer \(grill me, 2026-11-11\): \(b\) a server, git as the fallback/, 'the proposal shows at once');
        assert.equal(lastEditState(posted), 0, 'no unsaved edits left');
        assert.equal(window.document.getElementById('mdbChangeBar'), null, 'no question asked');
        const marked = $(window, '.mdb-block.mdb-changed');
        assert.equal(marked.length, 1);
        assert.match(marked[0].textContent, /DP-19/);
        assert.equal(marked[0].__scrolled, true, 'scrolled to');
    });

    test('AU-3: typed text — asked first; Show / Keep; no stale write', () => {
        const { window, posted } = setup();
        send(window, content(DOC));
        answerButton(window, 1).click();
        $(window, '.mdb-editor textarea')[0].value = '(a) git';
        send(window, content(PROPOSED));
        const bar = window.document.getElementById('mdbChangeBar');
        assert.ok(bar && !bar.hidden, 'the bar asks');
        assert.match(bar.textContent, /DP-19 was changed on disk while you are typing in an editor\./);
        assert.equal($(window, '.mdb-editor').length, 1, 'the typed text stays meanwhile');
        assert.ok(!/Proposed answer/.test(shownText(window)), 'not shown yet');
        // Show the new version: the text goes, the proposal shows.
        bar.querySelector('[data-change-action="show"]').click();
        assert.equal($(window, '.mdb-editor').length, 0);
        assert.match(shownText(window), /Proposed answer/);
        assert.equal(bar.hidden, true);
        assert.equal(lastEditState(posted), 0);

        // Keep my text: typing goes on; a save sends the lines it was opened on, which the host refuses once they changed.
        const second = setup();
        send(second.window, content(DOC));
        answerButton(second.window, 1).click();
        $(second.window, '.mdb-editor textarea')[0].value = '(a) git';
        send(second.window, content(PROPOSED));
        second.window.document.querySelector('#mdbChangeBar [data-change-action="keep"]').click();
        assert.equal(second.window.document.getElementById('mdbChangeBar').hidden, true);
        $(second.window, '.mdb-editor-btn')[0].click();
        const edit = [...second.posted].reverse().find((m) => m.type === 'applyEdit')!;
        assert.equal(edit.expected, '> **Answer:**', 'the old lines: the host checks them against the file');
        const host = readFileSync(join(ROOT, 'src', 'utils', 'markdownBrowserEdits.ts'), 'utf-8');
        assert.match(host, /expected/, 'applyMdLineEdit compares them');
        send(second.window, { type: 'editResult', ok: false, error: 'The lines changed since they were shown', editId: edit.editId });
        assert.equal($(second.window, '.mdb-editor').length, 1, 'refused: the text stays for the user');
        $(second.window, '.mdb-editor-btn')[1].click();
        assert.match(shownText(second.window), /Proposed answer/, 'closed: the held version shows');
    });

    test('AU-4: Grill me end to end', () => {
        const { window, posted } = setup();
        send(window, content(DOC));
        answerButton(window, 1).click();
        send(window, content(PROPOSED));
        assert.match(shownText(window), /Proposed answer/, 'the proposal, as soon as it is written');
        send(window, content(ACCEPTED));
        const text = shownText(window);
        assert.match(text, /Answer: \(b\) a server, git as the fallback/, 'the Answer line, as soon as it is accepted');
        assert.ok(!/Proposed answer/.test(text), 'the proposal is gone');
        assert.equal(lastEditState(posted), 0);
    });

    test('AU-5: the host', () => {
        const seen: string[] = [];
        const stop = onDocumentWritten((p) => seen.push(p));
        const stopBad = onDocumentWritten(() => { throw new Error('a broken listener'); });
        notifyDocumentWritten('/ws/tsm.md');
        stop();
        stopBad();
        notifyDocumentWritten('/ws/other.md');
        assert.deepEqual(seen, ['/ws/tsm.md'], 'told once, a failing listener does not stop it, unsubscribed after');
        const io = readFileSync(join(ROOT, 'src', 'services', 'som-document-io-vscode.ts'), 'utf-8');
        assert.equal((io.match(/notifyDocumentWritten\(path\.resolve\(filePath\)\)/g) ?? []).length, 2, 'on disk and through the editor');
        const md = readFileSync(join(ROOT, 'src', 'handlers', 'markdownBrowser-handler.ts'), 'utf-8');
        assert.match(md, /onDocumentWritten\(\(absPath\) => \{ for \(const panel of allPanels\) \{ panel\.refreshIfShowing\(absPath\); \} \}\)/);
        assert.match(md, /refreshIfShowing\(absPath: string\): void \{[\s\S]*?this\._sendFileContent\(absPath\);/);
        assert.match(md, /createFileSystemWatcher\(pattern, false, false, true\)/, 'create events too');
        assert.match(md, /this\._fileWatcher\.onDidCreate\(onChanged\);/);
    });
});
