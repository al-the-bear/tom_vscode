/**
 * The Markdown Browser's section folding, in a JSDOM running the real webview
 * script (media/markdownBrowser/main.js + blocks.js + marked).
 *
 *   MF-1  every heading starts with a triangle; folding hides its section, not the next sibling section
 *   MF-2  unfolding a section restores its subsections' own folded state
 *   MF-3  fold all / unfold all with one toggle button
 *   MF-4  the level dropdown lists the document's levels; its button folds / unfolds that level only
 *   MF-5  the folded state survives a re-render of the same file and resets for another file
 *   MF-6  the backend's heading transform: ids and levels beyond 6 fold by their true level
 *   MF-7  the indent toggle: headings by level, content one step deeper, spaces from the dropdown (default 2)
 *   MF-8  <details> blocks keep their content inside them (rendered as one group)
 *   MF-9  a large document renders in linear time, in batches that yield to the event loop; it is
 *         lexed in parts, and its blocks keep their file lines across the parts. Linear time is measured
 *         as a ratio, not a limit (vscimpa16): twice the document may take at most 3x the time. The time is
 *         this process's CPU time, not wall-clock time (qrfix7: a full npm test after two installs measured
 *         3.40x on the wall clock): the sizes interleaved for three rounds, the least time of each size
 *         compared, and a ratio at the bound measured once more (the lower counts)
 *   MF-9b the rule tells linear from quadratic: on counted work, and measured — the real renderer made
 *         quadratic (work per marked.parser call in proportion to the calls before it) fails the check
 *   MF-9c the check holds on a busy machine: a CPU burner on every core for the whole measurement
 *   MF-10 blocks are grouped into sections of 150; only a large document lays sections out lazily
 *   MF-9b also: a reading-div `start` that searches the whole remaining source (not only the paragraph) makes the
 *         render quadratic and fails the check — the bound blocks.js mdbReadingBlockStart keeps
 *   MF-12 a large document with the reading notation (a provenance div, two trace citations, a span and a records
 *         div per section) renders in linear time too
 *   MF-13 changing a kind's reading mode writes exactly one attribute (the content area's class), however many
 *         elements of the kind the document holds
 *   MF-11 a heading's +/- open / collapse every section of its level inside its parent section (vscimpb100):
 *         other sections and levels keep their flags, a collapsed section opens with its siblings, the buttons
 *         are hidden where the level has one section in its parent, and they say what they act on
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { transformMarkdown } from '../markdownHeadings.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');

const DOC = [
    '# A', '', 'a text', '',
    '## B', '', 'b text', '',
    '### C', '', 'c text', '',
    '## D', '', 'd text', '',
    '# E', '', 'e text',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    window.eval(MARKED);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    return window;
}
const show = (window: Win, text: string, filePath = '/ws/doc.md'): void => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath, crlf: false } }));
};
/** The visible text of the content, one entry per visible top-level element. */
const visible = (window: Win): string[] =>
    [...window.document.querySelectorAll('#contentArea > .mdb-doc > .mdb-section > *')]
        .filter((el: Win) => !el.classList.contains('mdb-folded-away'))
        .map((el: Win) => el.textContent.trim().replace(/\s+/g, ' '));
const heading = (window: Win, text: string): Win =>
    [...window.document.querySelectorAll('h1, h2, h3')].find((h: Win) => h.textContent.trim() === text);
const toggle = (window: Win, text: string): void => heading(window, text).querySelector('.mdb-fold-btn').click();

/** Twice the work in at most this many times the time: linear is about 2, quadratic about 4. */
const LINEAR_RATIO = 3;

/** A large document: `sections` level-2 sections of one paragraph each. */
const largeDoc = (sections: number): string => {
    const parts: string[] = [];
    const filler = 'the quick brown fox jumps over the lazy dog and keeps on running past the fence';
    for (let i = 0; i < sections; i++) { parts.push(`## Section ${i}`, '', `text ${i} ${filler}`, ''); }
    return parts.join('\n');
};

/** A large document with the reading notation: per section a provenance div, two trace citations, a span and a records div. */
const notationDoc = (sections: number): string => {
    const parts: string[] = [];
    for (let i = 0; i < sections; i++) {
        parts.push(`## Section ${i}`, '', '::: {.provenance}', `_Extrapolated — see iterations/notes_${i}.md._`, ':::', '',
            `Rights scoped to node ${i} apply to its subtree (-> C${i}.1) and to [its children]{.aside} (-> TR-${i}, BQ-${i}).`, '',
            '::: records', '| Id | Given | Then |', '| --- | --- | --- |', `| R-${i} | a node | it applies |`, ':::', '');
    }
    return parts.join('\n');
};

/** Where injected busy work leaves its result, so it is not optimised away. */
let burnSink = 0;

/** CPU burners in other processes: one per core (every core busy), until stopped. */
function startBurners(): () => void {
    const kids = Array.from({ length: availableParallelism() }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    return () => { for (const k of kids) { k.kill('SIGKILL'); } };
}

/**
 * Render a large document in a fresh window until it is done. Timed as this process's CPU time
 * (process.cpuUsage), not wall-clock time: the waits between the render's batches and the turns other
 * processes get on a busy machine are not counted.
 */
async function renderTimed(sections: number, patch?: (w: Win) => void, expectBatches = false, make: (n: number) => string = largeDoc): Promise<{ ms: number; wallMs: number; w: Win }> {
    const w = setup();
    patch?.(w);
    const text = make(sections);
    const area = w.document.getElementById('contentArea');
    const cpu = process.cpuUsage();
    const started = performance.now();
    show(w, text);
    if (expectBatches) { assert.equal(area.getAttribute('aria-busy'), 'true', 'not done in one task: the window gets turns'); }
    while (area.getAttribute('aria-busy') === 'true') { await new Promise((r) => setTimeout(r, 5)); }
    const used = process.cpuUsage(cpu);
    return { ms: (used.user + used.system) / 1000, wallMs: performance.now() - started, w };
}

interface RatioOptions {
    rounds?: number;
    /** Changes each window before it renders. */
    patch?: (w: Win) => void;
    /** Asserts the render yields between batches (a large document). */
    expectBatches?: boolean;
    /** The document of `n` sections (default: largeDoc). */
    make?: (n: number) => string;
}

/**
 * How much longer twice the document takes: the sizes interleaved (n, 2n, n, 2n, …) for `rounds` rounds (default
 * 3), the least CPU time of each size compared, so a burst of load on one run does not decide it. Answers the
 * ratio, a message naming both sizes' times, and the last window of the larger size (the caller closes it).
 */
async function measureRatio(n: number, opts: RatioOptions = {}): Promise<{ ratio: number; message: string; window: Win }> {
    const once: Array<{ ms: number; wallMs: number }> = [];
    const twice: Array<{ ms: number; wallMs: number }> = [];
    let window: Win;
    for (let r = 0; r < (opts.rounds ?? 3); r++) {
        const small = await renderTimed(n, opts.patch, opts.expectBatches, opts.make);
        small.w.close();
        once.push(small);
        const large = await renderTimed(2 * n, opts.patch, opts.expectBatches, opts.make);
        window?.close();
        window = large.w;
        twice.push(large);
    }
    const least = (xs: Array<{ ms: number }>): number => Math.min(...xs.map((x) => x.ms));
    const ratio = least(twice) / least(once);
    const wall = Math.min(...twice.map((x) => x.wallMs)) / Math.min(...once.map((x) => x.wallMs));
    const message = `twice the document took ${ratio.toFixed(2)}x the CPU time (${least(once).toFixed(0)} ms for ${n} sections, `
        + `${least(twice).toFixed(0)} ms for ${2 * n}; wall-clock ${wall.toFixed(2)}x); linear is about 2, quadratic about 4`;
    return { ratio, message, window };
}

/**
 * The linear-time check: {@link measureRatio}, and when the ratio reaches {@link LINEAR_RATIO} it is measured
 * once more and the lower of the two counts — a quadratic render fails both, a burst of load seldom hits both.
 */
async function linearCheck(n: number, opts: RatioOptions = {}): Promise<{ ratio: number; message: string; window: Win }> {
    const first = await measureRatio(n, opts);
    if (first.ratio < LINEAR_RATIO) { return first; }
    const again = await measureRatio(n, opts);
    const better = again.ratio < first.ratio ? again : first;
    (better === again ? first : again).window.close();
    return { ...better, message: `${better.message} (measured twice: ${first.ratio.toFixed(2)}x, then ${again.ratio.toFixed(2)}x)` };
}

describe('Markdown Browser folding', () => {
    test('MF-1: a triangle per heading; folding hides the section', () => {
        const w = setup();
        show(w, DOC);
        assert.equal(w.document.querySelectorAll('.mdb-fold-btn').length, 5);
        toggle(w, 'B');
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'd text', 'E', 'e text']);
        assert.ok(heading(w, 'B').querySelector('.codicon-chevron-right'));
    });

    test('MF-2: subsections keep their own state', () => {
        const w = setup();
        show(w, DOC);
        toggle(w, 'C');
        toggle(w, 'A');
        assert.deepEqual(visible(w), ['A', 'E', 'e text']);
        toggle(w, 'A');
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'b text', 'C', 'D', 'd text', 'E', 'e text'], 'C stays folded');
    });

    test('MF-3: fold all / unfold all', () => {
        const w = setup();
        show(w, DOC);
        const btn = w.document.getElementById('foldAllBtn');
        btn.click();
        assert.deepEqual(visible(w), ['A', 'E']);
        assert.ok(btn.querySelector('.codicon-expand-all'), 'the button now offers unfold');
        btn.click();
        assert.equal(visible(w).length, 10);
    });

    test('MF-4: fold one level', () => {
        const w = setup();
        show(w, DOC);
        const select = w.document.getElementById('foldLevelSelect');
        assert.deepEqual([...select.options].map((o: Win) => o.textContent), ['H1', 'H2', 'H3']);
        assert.equal(select.value, '2', 'level 2 preselected');
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'E', 'e text']);
        assert.ok(w.document.getElementById('foldLevelBtn').querySelector('.codicon-unfold'));
        select.value = '1';
        select.dispatchEvent(new w.Event('change'));
        assert.ok(w.document.getElementById('foldLevelBtn').querySelector('.codicon-fold'), 'level 1 is still open');
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'E']);
        w.document.getElementById('foldLevelBtn').click();
        assert.deepEqual(visible(w), ['A', 'a text', 'B', 'D', 'E', 'e text'], 'level 2 still folded');
    });

    test('MF-5: state across re-renders', () => {
        const w = setup();
        show(w, DOC);
        toggle(w, 'B');
        show(w, `${DOC}\n\nmore`);
        assert.ok(!visible(w).includes('b text'), 'same file: B stays folded');
        show(w, DOC, '/ws/other.md');
        assert.ok(visible(w).includes('b text'), 'another file starts unfolded');
    });

    test('MF-6: transformed headings, levels beyond 6', () => {
        const w = setup();
        const raw = ['## <!--[SEC]--> Section', '', 'sec text', '', '####### Deep', '', 'deep text', '', '######## Deeper', '', 'deeper text', '', '## Next'].join('\n');
        show(w, transformMarkdown(raw));
        const select = w.document.getElementById('foldLevelSelect');
        assert.deepEqual([...select.options].map((o: Win) => o.textContent), ['H2', 'H7', 'H8']);
        select.value = '7';
        select.dispatchEvent(new w.Event('change'));
        w.document.getElementById('foldLevelBtn').click();
        const text = visible(w).join(' | ');
        assert.ok(!text.includes('deep text') && !text.includes('deeper text'), text);
        assert.ok(text.includes('sec text') && text.includes('Next'), text);
    });

    test('MF-7: indent by heading level', () => {
        const w = setup();
        show(w, DOC);
        const margins = (): string[] => [...w.document.querySelectorAll('#contentArea > .mdb-doc > .mdb-section > *')].map((el: Win) => el.style.marginLeft);
        assert.ok(margins().every((m) => m === ''), 'off by default');
        const select = w.document.getElementById('indentSizeSelect');
        assert.equal(select.value, '2');
        w.document.getElementById('indentBtn').click();
        // A, a text, B, b text, C, c text, D, d text, E, e text
        assert.deepEqual(margins(), ['0ch', '2ch', '2ch', '4ch', '4ch', '6ch', '2ch', '4ch', '0ch', '2ch']);
        select.value = '4';
        select.dispatchEvent(new w.Event('change'));
        assert.deepEqual(margins().slice(0, 4), ['0ch', '4ch', '4ch', '8ch']);
        show(w, `${DOC}\n\nmore`);
        assert.equal(margins()[margins().length - 1], '4ch', 'kept across a re-render');
        w.document.getElementById('indentBtn').click();
        assert.ok(margins().every((m) => m === ''), 'off again');
    });

    test('MF-8: details keep their content', () => {
        const w = setup();
        show(w, '## Tool\n\n<details><summary>result</summary>\n\n```text\nbig output\n```\n\n</details>\n\nafter');
        const details = w.document.querySelectorAll('details');
        assert.equal(details.length, 1);
        assert.ok(details[0].querySelector('pre'), 'the code block is inside <details>');
        assert.ok(!w.document.querySelector('details') .open, 'collapsed, as written');
    });

    test('MF-9: a large document renders in linear time, in batches', async (t) => {
        const N = 2000;
        assert.ok(largeDoc(N).length > 200000, 'both sizes are large documents: lexed in parts, laid out lazily');
        const m = await linearCheck(N, { expectBatches: true });
        const w = m.window;
        assert.equal(w.document.querySelectorAll('.mdb-fold-btn').length, 2 * N);
        const lastTitle = `Section ${2 * N - 1}`;
        assert.equal(heading(w, lastTitle).dataset.foldKey, `2|${lastTitle}#1`);
        const last = heading(w, lastTitle).closest('.mdb-block');
        assert.equal(last.__mdbBlock.startLine, 4 * (2 * N - 1), 'file lines hold across the lexed parts');
        w.close();
        t.diagnostic(m.message);
        assert.ok(m.ratio < LINEAR_RATIO, m.message);
    });

    test('MF-9b: the ratio rule tells linear from quadratic', async (t) => {
        // Counted work: a linear render does twice the work for twice the document, a quadratic one four times.
        const work = { linear: (n: number): number => 3 * n + 40, quadratic: (n: number): number => n * n / 2 + 3 * n };
        for (const n of [2000, 4000, 12000]) {
            assert.ok(work.linear(2 * n) / work.linear(n) < LINEAR_RATIO, `linear passes at ${n}`);
            assert.ok(work.quadratic(2 * n) / work.quadratic(n) >= LINEAR_RATIO, `quadratic fails at ${n}`);
        }
        // Measured: the real renderer made quadratic — each marked.parser call (one per token group) does work in
        // proportion to the calls before it — fails the same measurement MF-9 passes.
        const quadratic = (w: Win): void => {
            let calls = 0;
            const parser = w.marked.parser;
            w.marked.parser = function (this: unknown, ...args: unknown[]): unknown {
                calls++;
                let x = 0;
                for (let i = 0, n = calls * 300; i < n; i++) { x = (x * 31 + i) | 0; }
                burnSink ^= x;
                return parser.apply(this, args);
            };
        };
        const m = await linearCheck(250, { patch: quadratic });
        m.window.close();
        t.diagnostic(`quadratic: ${m.message}`);
        assert.ok(m.ratio >= LINEAR_RATIO, `a quadratic render must fail the check: ${m.message}`);
        // The reading div's `start` searching the whole remaining source, as an unbounded one would: marked asks it
        // before every top-level paragraph with everything after it (4,000 paragraphs: 127 million characters), so the
        // render is quadratic. A real search of the rest plus work in proportion to the characters it scans (a scan in
        // script, as the bounded one never does on the rest) makes that show above jsdom's own cost per paragraph.
        const unbounded = (w: Win): void => {
            w.mdbReadingBlockStart = (src: string): number | undefined => {
                const m = /\n {0,3}:{3}/.exec(src);
                let x = 0;
                for (let i = 0, n = src.length * 40; i < n; i++) { x = (x * 31 + i) | 0; }
                burnSink ^= x;
                return m ? m.index : undefined;
            };
        };
        // Many short paragraphs and no heading: one lexed part, whatever its size.
        const shortParagraphs = (n: number): string => Array.from({ length: n }, (_, i) => `paragraph ${i}`).join('\n\n');
        // Measured as MF-9 measures (the least CPU time of each size over two rounds); the lower ratio would only help it pass.
        const u = await measureRatio(1500, { patch: unbounded, make: shortParagraphs, rounds: 2 });
        u.window.close();
        t.diagnostic(`unbounded start: ${u.message}`);
        assert.ok(u.ratio >= LINEAR_RATIO, `an unbounded block start must fail the check: ${u.message}`);
    });

    test('MF-12: a large document with the reading notation renders in linear time', async (t) => {
        const N = 1000;
        const m = await linearCheck(N, { make: notationDoc, expectBatches: true });
        const w = m.window;
        assert.equal(w.document.querySelectorAll('.mdb-rd[data-kind="provenance"]').length, 2 * N);
        assert.equal(w.document.querySelectorAll('.mdb-rs[data-kind="trace"]').length, 4 * N);
        assert.equal(w.document.querySelectorAll('.mdb-rd[data-kind="records"] table').length, 2 * N);
        w.close();
        t.diagnostic(m.message);
        assert.ok(m.ratio < LINEAR_RATIO, m.message);
    });

    test('MF-13: a reading mode change writes one attribute', async () => {
        const w = setup();
        show(w, notationDoc(300));
        const area = w.document.getElementById('contentArea');
        while (area.getAttribute('aria-busy') === 'true') { await new Promise((r) => setTimeout(r, 5)); }
        w.document.getElementById('readKindBtn').click();
        const select = w.document.querySelector('#readKindPop select[data-read-kind="provenance"][data-read-part="block"]');
        assert.ok(select, 'the provenance row');
        const records: Win[] = [];
        const observer = new w.MutationObserver((list: Win[]) => records.push(...list));
        observer.observe(w.document.body, { subtree: true, attributes: true, childList: true, characterData: true });
        select.value = 'shown';
        select.dispatchEvent(new w.Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        records.push(...observer.takeRecords());
        observer.disconnect();
        assert.equal(records.length, 1, `one mutation, not one per element (${records.length}: ${records.map((r) => r.type + ' ' + (r.target.id || r.target.className)).join(', ')})`);
        assert.equal(records[0].target, area);
        assert.equal(records[0].attributeName, 'class');
        assert.ok(!area.classList.contains('mdb-read-provenance-collapsed'));
        assert.ok(area.classList.contains('mdb-read-provenance-marker'), 'the spans keep their mode');
        w.close();
    });

    test('MF-9c: the check holds on a busy machine', async (t) => {
        // Other processes keep every core busy (a CPU burner per core) for the whole measurement. The render's
        // batches then wait for their turns, which wall-clock time counts (on mbp it measured anywhere from 1.7x
        // to 4.9x like this) and this process's own CPU time does not.
        const stop = startBurners();
        let m: { ratio: number; message: string; window: Win };
        try {
            await new Promise((res) => setTimeout(res, 200));
            m = await linearCheck(1000);
        } finally {
            stop();
        }
        m.window.close();
        t.diagnostic(`under load: ${m.message}`);
        assert.ok(m.ratio < LINEAR_RATIO, `under load: ${m.message}`);
    });

    test('MF-10: sections', () => {
        const w = setup();
        const parts: string[] = [];
        for (let i = 0; i < 400; i++) { parts.push(`para ${i}`, ''); }
        show(w, parts.join('\n'));
        const sections = [...w.document.querySelectorAll('.mdb-doc > .mdb-section')];
        assert.deepEqual(sections.map((s: Win) => s.children.length), [150, 150, 100]);
        assert.ok(!w.document.querySelector('.mdb-doc').classList.contains('mdb-large'), 'a small document is laid out whole');
        assert.match(sections[0].style.containIntrinsicSize, /^auto \d+px$/);
    });

    test('MF-11: +/- open / collapse the sections of one level inside the parent', () => {
        const w = setup();
        show(w, ['# A', '', 'a', '', '## B', '', 'b', '', '### C', '', 'c', '', '### C2', '', 'c2', '',
            '## D', '', 'd', '', '# E', '', 'e', '', '## F', '', 'f'].join('\n'));
        const box = (t: string): Win => heading(w, t).querySelector('.mdb-fold-level');
        const level = (t: string, op: 'open' | 'close'): void => box(t).querySelector(`[data-op="${op}"]`).click();
        assert.deepEqual(['A', 'B', 'C', 'C2', 'D', 'E', 'F'].map((t) => box(t).hidden), [false, false, false, false, false, false, true],
            'F is the only level-2 section in E');
        assert.equal(box('B').querySelector('[data-op="open"]').title, 'Open all level 2 sections in "A"');
        assert.equal(box('A').querySelector('[data-op="close"]').title, 'Collapse all level 1 sections in the document');
        assert.ok(box('C').querySelector('.codicon-add') && box('C').querySelector('.codicon-remove'));
        assert.equal(box('C').querySelector('button').tagName, 'BUTTON', 'keyboard-reachable');
        toggle(w, 'C2');
        level('B', 'close');
        assert.deepEqual(visible(w), ['A', 'a', 'B', 'D', 'E', 'e', 'F', 'f'], 'B and D collapsed; E\'s section untouched');
        level('D', 'open');
        assert.deepEqual(visible(w), ['A', 'a', 'B', 'b', 'C', 'c', 'C2', 'D', 'd', 'E', 'e', 'F', 'f'], 'reopened; C2 keeps its own flag');
        toggle(w, 'B');
        level('B', 'open');
        assert.ok(visible(w).includes('b'), '+ on a collapsed section opens it with its siblings');
        level('C', 'open');
        assert.ok(visible(w).includes('c2'), 'C2 opened with C');
        level('A', 'close');
        assert.deepEqual(visible(w), ['A', 'E']);
        level('E', 'open');
        assert.deepEqual(visible(w), ['A', 'a', 'B', 'b', 'C', 'c', 'C2', 'c2', 'D', 'd', 'E', 'e', 'F', 'f'], 'both level-1 sections open, the inner flags as they were');
    });
});
