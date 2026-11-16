/**
 * The MD Browser in live mode renders only what was appended (appendRender in media/markdownBrowser/main.js):
 * a live trail grows at its end every second, and a full render of it each time kept the window busy (the macOS
 * wait cursor). A JSDOM runs the real webview.
 *
 *   LA-1 the file grew: the earlier blocks keep their DOM nodes; the result (blocks, lines, text, fold keys,
 *        heading ids) equals a full render of the same text — headings, a repeated heading, a `<details>` group
 *        and a code fence appended
 *   LA-2 the last paragraph grew (streamed text): it is rendered again, the blocks before it are kept
 *   LA-3 the start was cut (the trail trimmed at a new prompt), or a line further up changed: a full render
 *   LA-4 not in live mode: a full render, as before
 *   LA-5 a folded section stays folded, and what is appended under it is hidden
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    window.HTMLElement.prototype.scrollIntoView = function () { /* none in JSDOM */ };
    window.eval(MARKED);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    return window;
}
const show = (window: Win, text: string, liveMode = true): void => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath: '/ws/live-trail.md', relativePath: 'live-trail.md', crlf: false, liveMode } }));
};
const blocks = (window: Win): Win[] => [...window.document.querySelectorAll('#contentArea .mdb-block')];
/** What a render shows: each block's lines and text, and every fold key. */
const shape = (window: Win): string[] => [
    ...blocks(window).map((b: Win) => `${b.__mdbBlock.startLine}-${b.__mdbBlock.endLine}:${b.textContent.replace(/\s+/g, ' ').trim()}`),
    ...[...window.document.querySelectorAll('#contentArea [data-fold-key]')].map((h: Win) => `fold ${h.dataset.foldKey}`),
];
const fullRender = (text: string): string[] => { const w = setup(); show(w, text); return shape(w); };

const PROMPT = (n: number): string => [
    `## 🚀 PROMPT 2026111${n}_120000 [agentSdk / opus]`,
    '',
    `> User: prompt ${n}`,
    '',
    '### 💬 assistant',
    '',
    `Answer text of prompt ${n}.`,
    '',
].join('\n');
const TOOL = [
    '### 🔧 Bash [toolu_1]',
    '',
    '```json',
    '{ "command": "ls" }',
    '```',
    '',
    '<details><summary>📤 result (12 chars)</summary>',
    '',
    '```text',
    'a.md',
    'b.md',
    '```',
    '',
    '</details>',
    '',
].join('\n');
const START = `<!-- tom-ai live-trail -->\n\n${PROMPT(1)}`;

describe('MD Browser live mode: only the appended part is rendered', () => {
    test('LA-1: the file grew — earlier nodes kept, the result equals a full render', () => {
        const w = setup();
        show(w, START);
        const firstBefore = blocks(w)[0];
        const grown = `${START}${TOOL}### 💬 assistant\n\nMore text.\n\n${PROMPT(2)}${TOOL}`;
        show(w, grown);
        assert.equal(blocks(w)[0], firstBefore, 'the first block is the same node (not rendered again)');
        assert.deepEqual(shape(w), fullRender(grown), 'the same blocks, lines, text and fold keys as a full render');
        assert.match(w.document.getElementById('contentArea').textContent, /b\.md/, 'the details group is rendered');
    });

    test('LA-2: the last paragraph grew', () => {
        const w = setup();
        const streaming = `${START}### 💬 assistant\n\nPart one`;
        show(w, streaming);
        const kept = blocks(w)[1];
        const grown = `${streaming} and part two.`;
        show(w, grown);
        assert.equal(blocks(w)[1], kept, 'blocks before the last kept');
        assert.match(blocks(w).at(-1).textContent, /Part one and part two\./);
        assert.deepEqual(shape(w), fullRender(grown));
    });

    test('LA-3: the start cut, or a change further up — a full render', () => {
        const w = setup();
        const long = `${START}${TOOL}${PROMPT(2)}`;
        show(w, long);
        const first = blocks(w)[0];
        const trimmed = `<!-- tom-ai live-trail -->\n\n${PROMPT(2)}${PROMPT(3)}`;
        show(w, trimmed);
        assert.notEqual(blocks(w)[0], first, 'rendered in full');
        assert.deepEqual(shape(w), fullRender(trimmed));
        const changed = trimmed.replace('prompt 2', 'prompt two') + 'Appended.\n';
        const before = blocks(w)[0];
        show(w, changed);
        assert.notEqual(blocks(w)[0], before, 'a change further up: rendered in full');
        assert.deepEqual(shape(w), fullRender(changed));
    });

    test('LA-4: not in live mode — a full render', () => {
        const w = setup();
        show(w, START, false);
        const first = blocks(w)[0];
        show(w, `${START}${TOOL}`, false);
        assert.notEqual(blocks(w)[0], first);
    });

    test('LA-5: a folded section stays folded', () => {
        const w = setup();
        show(w, `${START}${TOOL}`);
        const heading = [...w.document.querySelectorAll('#contentArea h2')].find((h: Win) => /PROMPT 20261111/.test(h.textContent));
        heading.querySelector('.mdb-fold-btn').click();
        show(w, `${START}${TOOL}Appended under the prompt.\n`);
        const appended = blocks(w).at(-1);
        assert.match(appended.textContent, /Appended under the prompt/);
        assert.ok(appended.classList.contains('mdb-folded-away'), 'hidden under the folded heading');
    });
});
