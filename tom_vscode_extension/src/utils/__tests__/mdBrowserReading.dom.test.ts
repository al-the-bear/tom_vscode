/**
 * The reading notation in the Markdown Browser (DocSpecs specification § Reading Notation; media/markdownBrowser/
 * main.js, blocks.js, style.css), in a JSDOM running the real webview script with its stylesheet.
 *
 *   MR-1  each mode of each kind: a block collapsed (the one-line toggle with its kind and the first 60 characters)
 *         or shown; a span or citation as a marker (†), dimmed or shown; refs and records compact; the defaults are
 *         the kind table's (provenance, editorial, aside collapsed, trace as a marker, refs and records compact)
 *   MR-2  opening one element (toggle, tag, marker, keyboard) is kept across a re-render of the same file, reset for
 *         another file and cleared for a kind whose mode changes
 *   MR-3  the all-kinds switch shows every kind in its fullest mode without changing the stored modes; a second
 *         click goes back
 *   MR-4  unknown kinds and a div without a kind are shown (fences and braces hidden); the kinds popup lists the kinds
 *         the document holds with their counts, the unknown ones apart, the other kinds, and Reset to defaults
 *   MR-5  an unclosed div ends at the next heading and is shown whatever its mode, with a warning; a stray closing
 *         fence shows as a muted `:::` line; `\:::` and fences in code are text
 *   MR-6  the label shows on hover over a toggle or marker, a provenance div's source and a citation's path are linked
 *   MR-7  a div is one block: its comment is written after the closing fence, insert goes before it, and an edit
 *         holding `:::` is rendered in full rather than patched
 *   MR-8  review marks inside a span and a citation render and keep their raw text
 *   MR-9  a search match and an unanswered question inside collapsed elements are revealed by opening them
 *   MR-10 form and section tables (05b_rdv1): headed `TomSpecField | Value` or `Section | TomSpecField | Value`,
 *         compact (mdb-form-table), an editable table block without a comment button; a section cell shown once
 *         per group, the group's first row anchored at its id; another table is untouched
 *   MR-11 a records table's `Id` rows are anchored and learnt by the section references: a plain-text id links to
 *         its row; an id inside a link's text is not linked again
 *   MR-12 a `#ID` link goes to the host, and its `scrollToAnchor` reveals the row or heading with that id,
 *         unfolding its section; a fragment the host found as a section id (`anchorById`) is looked up by id only, never by slug
 *   MR-13 heading divs (`<div class="heading<N>">`, the host's transformMarkdown) and headings deeper than 10 are
 *         headings: their level kept, nested in the full ids, foldable; a section reference reaches them
 *   MR-14 rejected blocks (05b_rdv2): collapsed with an error marker (reason and label on hover), opened on click
 *         with the buttons its attributes allow; each button posts the edit blocks.js computes for it; *Errors* is a
 *         navigation kind and a search category; the hint "the document has n errors" until the reader scrolls,
 *         its click going to the first error
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

function setup(): { w: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined });
    w.eval(MARKED);
    w.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    w.eval(asset('blocks.js'));
    w.eval(asset('teamReview.js'));
    w.eval(asset('main.js'));
    w.mdbReviewTime = () => '';
    return { w, posted };
}
const send = (w: Win, msg: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data: msg })); };
const show = (w: Win, text: string, filePath = '/ws/doc.md'): void => send(w, { type: 'mdContent', content: text, filePath, relativePath: 'doc.md', crlf: false });
const $ = (w: Win, sel: string): Win[] => [...w.document.querySelectorAll(sel)];
const display = (w: Win, el: Win): string => w.getComputedStyle(el).display;
/** Whether an element and every ancestor up to the content area are displayed. */
const seen = (w: Win, el: Win): boolean => {
    for (let n = el; n && n.id !== 'contentArea'; n = n.parentElement) { if (display(w, n) === 'none') { return false; } }
    return true;
};
const div = (w: Win, kind: string, i = 0): Win => $(w, `.mdb-rd[data-kind="${kind}"]`)[i];
const span = (w: Win, kind: string, i = 0): Win => $(w, `.mdb-rs[data-kind="${kind}"]`)[i];
const body = (el: Win): Win => el.querySelector(':scope > .mdb-rd-body, :scope > .mdb-rs-body');
const setMode = (w: Win, kind: string, part: 'block' | 'span', mode: string): void => {
    w.document.getElementById('readKindBtn').click();
    const sel = w.document.querySelector(`#readKindPop select[data-read-kind="${kind}"][data-read-part="${part}"]`);
    assert.ok(sel, `the ${kind} ${part} select`);
    sel.value = mode;
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    w.document.body.click();
};

const KINDS_DOC = [
    '# Kinds',
    '',
    '::: {.provenance}',
    '_Extrapolated — see iterations/sbpa21_notes.md, a note long enough to be cut at sixty characters in the line._',
    ':::',
    '',
    '::: editorial',
    '**The provenance notes.** Every note names where it came from.',
    ':::',
    '',
    '::: aside',
    'A side remark.',
    ':::',
    '',
    '::: trace',
    '(-> C2.1, TR-07)',
    ':::',
    '',
    '::: rejected',
    'Text the import could not place.',
    ':::',
    '',
    'Rights apply to the subtree (-> C2.1), [an aside here]{.aside}, [a provenance span]{.provenance}, [an editorial span]{.editorial} (<- notes.md#X) (<~ iterations/a.md).',
    '',
    '::: refs',
    '[A](#a) [B](#b)',
    ':::',
    '',
    '::: records',
    '| Id | Given | Then |',
    '| --- | --- | --- |',
    '| R-1 | a node | it applies |',
    ':::',
].join('\n');

describe('the reading notation in the Markdown Browser', () => {
    test('MR-1: each mode of each kind', () => {
        const { w } = setup();
        show(w, KINDS_DOC);
        // Blocks: collapsed by default (the toggle line), shown on choice.
        for (const kind of ['provenance', 'editorial', 'aside', 'trace', 'rejected']) {
            const el = div(w, kind);
            assert.ok(el, kind);
            assert.equal(display(w, body(el)), 'none', `${kind}: collapsed by default`);
            const toggle = el.querySelector('.mdb-rd-toggle');
            assert.notEqual(display(w, toggle), 'none');
            assert.equal(toggle.getAttribute('aria-expanded'), 'false');
            setMode(w, kind, 'block', 'shown');
            assert.notEqual(display(w, body(el)), 'none', `${kind}: shown`);
            assert.equal(display(w, toggle), 'none');
            setMode(w, kind, 'block', 'collapsed');
            assert.equal(display(w, body(el)), 'none');
        }
        const toggle = div(w, 'provenance').querySelector('.mdb-rd-toggle').textContent;
        assert.match(toggle, /^▸ provenance — Extrapolated — see iterations\/sbpa21_notes\.md, a note long e…$/, 'kind and the first 60 characters');
        // Spans and citations: a marker by default, dimmed, shown.
        for (const kind of ['aside', 'provenance', 'editorial', 'trace']) {
            const el = span(w, kind);
            const marker = el.querySelector('.mdb-rs-marker');
            assert.equal(display(w, body(el)), 'none', `${kind}: a marker by default`);
            assert.notEqual(display(w, marker), 'none');
            assert.equal(marker.textContent, '†');
            setMode(w, kind, 'span', 'dimmed');
            assert.notEqual(display(w, body(el)), 'none', `${kind}: dimmed`);
            assert.equal(w.getComputedStyle(body(el)).opacity, '0.65');
            assert.equal(display(w, marker), 'none');
            setMode(w, kind, 'span', 'shown');
            assert.notEqual(display(w, body(el)), 'none', `${kind}: shown`);
            assert.notEqual(w.getComputedStyle(body(el)).opacity, '0.65');
        }
        assert.match(span(w, "trace").textContent, /\(-> C2\.1/, "the citation as written");
        assert.equal($(w, '.mdb-rs.mdb-citation[data-kind="provenance"]').length, 2, '(<- …) and (<~ …) are provenance');
        // Compact kinds: never collapsed, no toggle, no marker; the records table scrolls sideways.
        assert.equal(div(w, 'refs').querySelector('.mdb-rd-toggle'), null);
        assert.notEqual(display(w, body(div(w, 'refs'))), 'none');
        assert.equal(display(w, div(w, 'refs').querySelector('p')), 'inline', 'one wrapped line');
        assert.equal(w.getComputedStyle(body(div(w, 'records'))).overflowX, 'auto');
        assert.ok(div(w, 'records').querySelector('table'));
        const area = w.document.getElementById('contentArea');
        assert.ok(area.classList.contains('mdb-read-refs-compact') && area.classList.contains('mdb-read-records-compact'));
    });

    test('MR-2: opening one element, across a re-render', () => {
        const { w } = setup();
        show(w, KINDS_DOC);
        const toggle = (): Win => div(w, 'aside').querySelector('.mdb-rd-toggle');
        toggle().click();
        assert.ok(div(w, 'aside').classList.contains('mdb-open'));
        assert.notEqual(display(w, body(div(w, 'aside'))), 'none', 'opened');
        assert.notEqual(display(w, div(w, 'aside').querySelector('.mdb-rd-tag')), 'none', 'the tag that collapses it again');
        assert.equal(display(w, body(div(w, 'editorial'))), 'none', 'the others stay collapsed');
        // A marker opens in place (dimmed) and closes on a second click; Enter does the same.
        const marker = (): Win => span(w, 'trace').querySelector('.mdb-rs-marker');
        marker().click();
        assert.notEqual(display(w, body(span(w, 'trace'))), 'none');
        assert.equal(w.getComputedStyle(body(span(w, 'trace'))).opacity, '0.65');
        assert.equal(marker().getAttribute('aria-expanded'), 'true');
        marker().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(display(w, body(span(w, 'trace'))), 'none', 'closed again');
        marker().click();
        // The same file again: the choices are kept.
        show(w, `${KINDS_DOC}\n\nmore`);
        assert.ok(div(w, 'aside').classList.contains('mdb-open'), 'kept across a re-render');
        assert.ok(span(w, 'trace').classList.contains('mdb-open'));
        // The tag closes it.
        div(w, 'aside').querySelector('.mdb-rd-tag').click();
        assert.equal(display(w, body(div(w, 'aside'))), 'none');
        show(w, `${KINDS_DOC}\n\nmore\n`);
        assert.ok(!div(w, 'aside').classList.contains('mdb-open'), 'closed is kept too');
        // A mode change of a kind clears its per-element choices.
        setMode(w, 'trace', 'span', 'dimmed');
        setMode(w, 'trace', 'span', 'marker');
        assert.ok(!span(w, 'trace').classList.contains('mdb-open'));
        show(w, `${KINDS_DOC}\n\nmore`);
        assert.ok(!span(w, 'trace').classList.contains('mdb-open'), 'and from the record');
        // Another file starts from the modes.
        toggle().click();
        show(w, KINDS_DOC, '/ws/other.md');
        assert.ok(!div(w, 'aside').classList.contains('mdb-open'), 'another file resets');
    });

    test('MR-3: the all-kinds switch', () => {
        const { w } = setup();
        show(w, KINDS_DOC);
        const btn = w.document.getElementById('readAllBtn');
        btn.click();
        for (const el of $(w, '.mdb-rd, .mdb-rs')) { assert.ok(seen(w, body(el)), `${el.dataset.kind}: shown`); }
        assert.equal(w.getComputedStyle(body(span(w, 'aside'))).opacity, '1', 'spans in their fullest mode, not dimmed');
        assert.ok(btn.classList.contains('active'));
        assert.ok(btn.querySelector('.codicon-eye-closed'));
        btn.click();
        assert.equal(display(w, body(div(w, 'provenance'))), 'none', 'back to the stored modes');
        assert.equal(display(w, body(span(w, 'trace'))), 'none');
        assert.ok(btn.querySelector('.codicon-eye'));
    });

    test('MR-4: unknown kinds and the kinds popup', () => {
        const { w } = setup();
        show(w, [KINDS_DOC, '', '::: {.weird .x}', 'weird content', ':::', '', '::: {#only-an-id}', 'no kind', ':::', '', 'and [odd text]{.oddity} here'].join('\n'));
        const weird = div(w, 'weird');
        assert.ok(weird.classList.contains('mdb-rd-unknown'));
        assert.equal(weird.querySelector('.mdb-rd-toggle'), null);
        assert.ok(seen(w, body(weird)), 'an unknown kind is shown');
        assert.ok(!w.document.getElementById('contentArea').textContent.includes(':::'), 'no fence shown');
        assert.ok(!w.document.getElementById('contentArea').textContent.includes('{.'), 'no braces shown');
        assert.ok(seen(w, body(div(w, ''))), 'a div without a kind is shown');
        assert.ok(seen(w, body(span(w, 'oddity'))), 'an unknown span too');
        w.document.getElementById('readKindBtn').click();
        const pop = w.document.getElementById('readKindPop');
        assert.equal(pop.hidden, false);
        const rows = [...pop.querySelectorAll('.read-kind-row')].map((r: Win) => r.querySelector('.read-kind-name').textContent.replace(/\s+/g, ' ').trim());
        assert.deepEqual(rows.slice(0, 7), ['provenance 4', 'trace 3', 'editorial 2', 'aside 2', 'refs 1', 'records 1', 'rejected 1'], 'counted as rendered');
        assert.ok(rows.includes('weird 1') && rows.includes('oddity 1'), rows.join(', '));
        assert.match(pop.textContent, /Shown as they are/);
        assert.ok(pop.querySelector('[data-read-reset]'));
        // Reset to defaults.
        w.document.body.click();
        setMode(w, 'aside', 'block', 'shown');
        w.document.getElementById('readKindBtn').click();
        pop.querySelector('[data-read-reset]').click();
        assert.equal(display(w, body(div(w, 'aside'))), 'none', 'back to the defaults');
        // A document without the notation: the registered kinds are listed under Other kinds.
        show(w, '# Plain\n\ntext', '/ws/plain.md');
        w.document.getElementById('readKindBtn').click();
        assert.match(pop.textContent, /No marked text in this document/);
        assert.match(pop.textContent, /Other kinds/);
        assert.ok(pop.querySelector('select[data-read-kind="provenance"]'), 'set before it appears');
    });

    test('MR-5: unclosed and stray fences, literal fences', () => {
        const { w } = setup();
        show(w, ['# A', '', '::: provenance', 'an unclosed note', '', '## B', '', 'after it', '', ':::', '', '\\::: not a fence', '', '```', '::: aside', 'in code', ':::', '```', '', 'and `[x]{.aside}` in a code span'].join('\n'));
        const unclosed = div(w, 'provenance');
        assert.ok(unclosed.classList.contains('mdb-rd-unclosed'));
        assert.equal(unclosed.title, 'no closing fence');
        assert.ok(seen(w, body(unclosed)), 'shown whatever its kind\'s mode');
        assert.ok(!unclosed.textContent.includes('after it'), 'it ends at the next heading');
        const stray = $(w, '.mdb-rd-stray');
        assert.equal(stray.length, 1);
        assert.equal(stray[0].textContent, ':::');
        assert.equal(stray[0].title, 'closing fence without an opening fence');
        const text = w.document.getElementById('contentArea').textContent;
        assert.ok(text.includes('::: not a fence'), 'an escaped fence is text');
        assert.equal($(w, '.mdb-rd[data-kind="aside"]').length, 0, 'a fence in code is literal');
        assert.ok($(w, 'pre code')[0].textContent.includes('::: aside'));
        assert.equal($(w, '.mdb-rs').length, 0, 'a span in a code span is literal');
    });

    test('MR-6: label and source', () => {
        const { w } = setup();
        show(w, ['::: {.provenance label="Where it came from" source="notes/origin.md#SEC-ONE"}', 'A note.', ':::', '', 'Text [with a remark]{.aside label="A remark"} (<- notes/b.md#X) (-> C2.1).'].join('\n'));
        assert.equal(div(w, 'provenance').querySelector('.mdb-rd-toggle').title, 'Where it came from');
        assert.match(div(w, 'provenance').querySelector('.mdb-rd-toggle').textContent, /^▸ Where it came from — A note\./);
        const link = div(w, 'provenance').querySelector('.mdb-rd-source a');
        assert.equal(link.getAttribute('href'), 'notes/origin.md#SEC-ONE');
        assert.equal(span(w, 'aside').querySelector('.mdb-rs-marker').title, 'A remark');
        assert.equal($(w, '.mdb-citation[data-kind="provenance"] a')[0].getAttribute('href'), 'notes/b.md#X');
        assert.equal($(w, '.mdb-citation[data-kind="trace"] .mdb-rs-marker')[0].title, 'backed by C2.1');
        assert.equal($(w, '.mdb-citation[data-kind="provenance"] .mdb-rs-marker')[0].title, 'taken from notes/b.md#X');
    });

    test('MR-7: a div is one block — comment, insert and the full render', () => {
        const { w, posted } = setup();
        const DOC = ['Before.', '', '::: aside', 'A remark.', ':::', '', 'After.'].join('\n');
        show(w, DOC);
        w.document.getElementById('editModeBtn').click();
        const wrapper = div(w, 'aside').closest('.mdb-block');
        assert.equal(wrapper.__mdbBlock.type, 'readingDiv');
        assert.deepEqual([wrapper.__mdbBlock.startLine, wrapper.__mdbBlock.endLine], [2, 5]);
        assert.equal(div(w, 'aside').querySelectorAll('.mdb-block-actions').length, 0, 'blocks inside get no buttons of their own');
        const edits = (): Array<Record<string, unknown>> => posted.filter((m) => m.type === 'applyEdit');
        // The comment goes after the closing fence.
        wrapper.querySelector(':scope > .mdb-block-actions .mdb-comment-btn').click();
        let area = $(w, '.mdb-editor textarea')[0];
        area.value = 'Is this right?';
        $(w, '.mdb-editor-btn')[0].click();
        let edit = edits()[edits().length - 1];
        assert.equal(edit.startLine, 2);
        assert.equal(edit.endLine, 5);
        assert.match(String(edit.replacement), /^::: aside\nA remark\.\n:::\n\n> ⬆️ \*\*C-1\*\*.*Is this right\?/);
        $(w, '.mdb-editor-btn')[1].click();
        // Insert goes in before the closing fence.
        wrapper.querySelector(':scope > .mdb-block-actions .mdb-insert-btn').click();
        area = $(w, '.mdb-editor textarea')[0];
        area.value = ' More.';
        $(w, '.mdb-editor-btn')[0].click();
        edit = edits()[edits().length - 1];
        assert.equal(edit.replacement, '::: aside\nA remark. More.\n:::');
        $(w, '.mdb-editor-btn')[1].click();
        // An edit holding a fence is not patched: one fence changes where every later div ends.
        const after = $(w, '.mdb-block').find((b: Win) => b.textContent.startsWith('After.'));
        after.querySelector('.mdb-edit-btn').click();
        area = $(w, '.mdb-editor textarea')[0];
        area.value = '\n::: aside\nAfter.';
        $(w, '.mdb-editor-btn')[0].click();
        edit = edits()[edits().length - 1];
        send(w, { type: 'editResult', ok: true, editId: edit.editId });
        assert.equal($(w, '.mdb-rd[data-kind="aside"]').length, 1, 'not patched in place: the full render with the file follows');
        // A plain edit is patched in place.
        const before = $(w, '.mdb-block').find((b: Win) => b.textContent.startsWith('Before.'));
        before.querySelector('.mdb-edit-btn').click();
        area = $(w, '.mdb-editor textarea')[0];
        area.value = 'Before, changed.';
        $(w, '.mdb-editor-btn')[0].click();
        send(w, { type: 'editResult', ok: true, editId: edits()[edits().length - 1].editId });
        assert.ok(w.document.getElementById('contentArea').textContent.includes('Before, changed.'), 'patched');
    });

    test('MR-8: marks inside spans and citations', () => {
        const { w } = setup();
        show(w, 'A [remark with {++an addition++}]{.aside} and a citation (-> {++C2.1++}, TR-07).');
        const inSpan = span(w, 'aside').querySelector('.mdb-rm[data-kind="change"]');
        assert.ok(inSpan, 'the mark inside the span');
        assert.equal(inSpan.dataset.raw, '{++an addition++}');
        const inCitation = span(w, 'trace').querySelector('.mdb-rm[data-kind="change"]');
        assert.ok(inCitation, 'the mark inside the citation');
        assert.equal(inCitation.dataset.raw, '{++C2.1++}');
        // A span inside a mark renders too.
        show(w, 'A {++new [aside]{.aside}++} here.');
        assert.ok(w.document.querySelector('.mdb-rm .mdb-rs[data-kind="aside"]'));
    });

    test('MR-9: search and navigation reveal collapsed elements', async () => {
        const { w } = setup();
        show(w, ['# Doc', '', '::: provenance', 'Outer note with ::: nothing special.', '', '::: {.aside}', 'inner zebra word', ':::', ':::', '',
            'Text (-> FINDME-1).', '', '::: editorial', '> **❓ Q-1 — scope:** Is this right?', '>', '> **Answer:**', ':::'].join('\n'));
        const outer = div(w, 'provenance');
        const inner = div(w, 'aside');
        assert.ok(outer.contains(inner), 'nested');
        assert.ok(!seen(w, inner.querySelector('.mdb-rd-body p')));
        const input = w.document.getElementById('searchInput');
        input.value = 'zebra';
        input.dispatchEvent(new w.Event('input'));
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(outer.classList.contains('mdb-open') && inner.classList.contains('mdb-open'), 'every element around the match opened');
        assert.ok(seen(w, inner.querySelector('.mdb-rd-body p')));
        input.value = 'FINDME';
        input.dispatchEvent(new w.Event('input'));
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(span(w, 'trace').classList.contains('mdb-open'), 'a marker span opened');
        // The navigation arrows (unanswered questions) open the editorial note holding the question.
        assert.equal(display(w, body(div(w, 'editorial'))), 'none');
        w.document.getElementById('navNextBtn').click();
        assert.ok(div(w, 'editorial').classList.contains('mdb-open'));
        // Navigating to an unanswered question opens its answer editor, inside the opened note.
        const editor = div(w, 'editorial').querySelector('.mdb-editor textarea');
        assert.ok(editor && seen(w, editor), 'the answer editor is reachable');
    });

    test('MR-10: form and section tables', () => {
        const { w, posted } = setup();
        const DOC = [
            '# Form', '',
            '| TomSpecField | Value |', '| --- | --- |', '| DataType | uuid |', '',
            '| Section | TomSpecField | Value |', '| --- | --- | --- |',
            '| KEATT-REFE-REF | Ref | [DAENT-ENTI-ROLE](#DAENT-ENTI-ROLE) |', '| KEATT-REFE-REF | Kind | Foreign |', '| KEATT-OTHER-ONE | Ref | x |', '',
            '| A | B |', '| --- | --- |', '| 1 | 2 |',
        ].join('\n');
        show(w, DOC);
        const tables = $(w, 'table');
        assert.equal(tables.length, 3);
        assert.deepEqual(tables.map((t: Win) => t.classList.contains('mdb-form-table')), [true, true, false], 'the two form layouts, not another table');
        assert.ok(tables[1].classList.contains('mdb-section-table'));
        const rows = [...tables[1].tBodies[0].rows];
        assert.equal(rows[0].id, 'KEATT-REFE-REF', 'the group\'s first row is its anchor');
        assert.ok(rows[1].cells[0].classList.contains('mdb-form-repeat') && rows[1].id === '', 'the section cell once per group');
        assert.equal(rows[2].id, 'KEATT-OTHER-ONE');
        w.document.getElementById('editModeBtn').click();
        const wrappers = tables.map((t: Win) => t.closest('.mdb-block'));
        assert.deepEqual(wrappers.map((x: Win) => x.__mdbBlock.type), ['table', 'table', 'table'], 'ordinary table blocks');
        assert.deepEqual(wrappers.map((x: Win) => x.classList.contains('mdb-no-comment')), [true, true, false], 'no comment button on a form table');
        assert.equal(display(w, wrappers[0].querySelector('.mdb-comment-btn')), 'none');
        assert.notEqual(display(w, wrappers[2].querySelector('.mdb-comment-btn')), 'none');
        // Edited as source, saved through applyEdit.
        wrappers[0].querySelector('.mdb-edit-btn').click();
        const area = $(w, '.mdb-editor textarea')[0];
        assert.match(area.value, /\| TomSpecField \| Value \|\n\| --- \| --- \|\n\| DataType \| uuid \|/);
        area.value = area.value.replace('uuid', 'text');
        $(w, '.mdb-editor-btn')[0].click();
        const edit = posted.filter((m) => m.type === 'applyEdit').pop() as Record<string, unknown>;
        assert.match(String(edit.replacement), /\| DataType \| text \|/);
        assert.equal(edit.startLine, 1);
    });

    test('MR-11: record rows, references to them, ids inside links', () => {
        const { w } = setup();
        show(w, [
            '# Constraints', '',
            '::: records', '| Id | Mandatory |', '| --- | --- |', '| DATAA-CONS-ROLE | For role grants |', '| <a id="DATAA-CONS-USER"></a>DATAA-CONS-USER | For user grants |', ':::', '',
            'See DATAA-CONS-ROLE for the constraint, and [DATAA-CONS-USER](#DATAA-CONS-USER) linked already.',
        ].join('\n'));
        const rows = [...div(w, 'records').querySelectorAll('tbody tr')];
        assert.equal(rows[0].id, 'DATAA-CONS-ROLE', 'an Id cell anchors its row');
        assert.equal(rows[1].id, '', 'an anchor inside the cell already carries the id');
        assert.ok(w.document.getElementById('DATAA-CONS-USER'));
        assert.ok(rows.every((r: Win) => r.classList.contains('mdb-id-row') && r.dataset.fullid));
        const refs = $(w, 'a.mdb-secref');
        assert.deepEqual(refs.map((a: Win) => a.textContent), ['DATAA-CONS-ROLE'], 'the plain-text id is linked to its row');
        const linked = $(w, 'a[href="#DATAA-CONS-USER"]');
        assert.equal(linked.length, 1);
        assert.equal(linked[0].querySelector('a'), null, 'an id inside a link\'s text is not linked again');
        assert.equal(rows[0].querySelector('a.mdb-secref'), null, 'a row\'s own id is not a reference to itself');
        refs[0].click();
        assert.match(rows[0].style.backgroundColor || '', /findMatchHighlight/, 'the reference reaches the row');
    });

    test('MR-12: links by id reveal rows and headings', () => {
        const { w, posted } = setup();
        const raw = [
            '# <!--[DOC]--> Doc', '',
            '[to the row](#DATAA-CONS-ROLE)', '',
            '## <!--[SEC-ONE]--> One', '',
            '::: records', '| Id | Mandatory |', '| --- | --- |', '| DATAA-CONS-ROLE | For role grants |', ':::', '',
            '## Zz-top band', '', 'text',
        ].join('\n');
        show(w, transformMarkdown(raw));
        const row = w.document.getElementById('DATAA-CONS-ROLE');
        assert.equal(row.dataset.fullid, 'DOC.SEC-ONE.DATAA-CONS-ROLE', 'under the headings above it');
        w.document.getElementById('foldAllBtn').click();
        assert.equal(seen(w, row), false, 'folded away');
        // A #ID link goes to the host, which resolves it (the fragment-by-id step) and answers scrollToAnchor.
        $(w, 'a[href="#DATAA-CONS-ROLE"]')[0].click();
        assert.equal((posted.filter((m) => m.type === 'navigateLink').pop() as Record<string, unknown>).href, '#DATAA-CONS-ROLE');
        send(w, { type: 'scrollToAnchor', anchor: 'DATAA-CONS-ROLE', anchorById: true });
        assert.ok(seen(w, row), 'by id: unfolded and reached');
        const band = $(w, 'h2').find((h: Win) => h.textContent.includes('Zz-top band'));
        band.style.backgroundColor = '';
        send(w, { type: 'scrollToAnchor', anchor: 'zz-top-band', anchorById: true });
        assert.equal(band.style.backgroundColor, '', 'by id only: the slug is not looked for');
        send(w, { type: 'scrollToAnchor', anchor: 'zz-top-band' });
        assert.match(band.style.backgroundColor || '', /findMatchHighlight/, 'a plain anchor takes the slug');
    });

    test('MR-13: heading divs and headings deeper than 10', () => {
        const { w } = setup();
        const raw = [
            '###### <!--[DAENT-ENTI-GRANT]--> Grant', '',
            '<div class="heading7" style="font-weight:bold"><!--[RQDEP-ITEM-1]--> <a id="RQDEP-ITEM-1"></a> Requirement &amp; Dependency 1</div>', '',
            'Under seven.', '',
            '############ <!--[DEEP-TWELVE]--> Twelve', '',
            'See DAENT-ENTI-GRANT > RQDEP-ITEM-1.',
        ].join('\n');
        show(w, transformMarkdown(raw));
        const h7 = $(w, '.md-heading').find((h: Win) => h.dataset.fullid === 'DAENT-ENTI-GRANT.RQDEP-ITEM-1');
        assert.ok(h7, 'the heading div is a heading, nested under the one above');
        assert.ok(h7.classList.contains('md-h7') && h7.getAttribute('data-level') === '7');
        assert.ok(h7.textContent.includes('Requirement & Dependency 1'), 'its title as the div showed it');
        assert.ok(h7.querySelector('a#RQDEP-ITEM-1'), 'its anchor kept');
        const h12 = $(w, '.md-heading').find((h: Win) => h.getAttribute('data-level') === '12');
        assert.ok(h12 && h12.classList.contains('md-h10') && h12.classList.contains('md-hdeep'), 'deeper than 10: the deepest style, its level kept');
        assert.equal(h12.dataset.fullid, 'DAENT-ENTI-GRANT.RQDEP-ITEM-1.DEEP-TWELVE');
        const options = [...w.document.getElementById('foldLevelSelect').options].map((o: Win) => o.value);
        assert.ok(options.includes('7') && options.includes('12'), 'the fold levels');
        const ref = $(w, 'a.mdb-secref').find((a: Win) => a.dataset.secref === 'DAENT-ENTI-GRANT > RQDEP-ITEM-1');
        assert.ok(ref, 'a section reference reaches the heading div');
    });

    test('MR-14: rejected blocks — marker, buttons, navigation, search, hint', async () => {
        const { w, posted } = setup();
        const lines = ['# Doc', '', 'Owner: Alice', '', 'Platform outside the errors.', '',
            '::: {.rejected reason="malformedBlock" line="412" field="Owner" kept="SBP" label="field Owner given twice"}', 'Owner: Platform team', ':::', '',
            '::::: {.rejected reason="malformedBlock" line="420" label="unclosed refs fence"}', '\\::: {.refs}', '- [A-1](#A-1)', ':::::', '',
            '| TomSpecField | Value |', '| --- | --- |', '| Status | open |', '',
            '::: {.rejected reason="unknownField" line="430" field="Owner2"}', '| owner_2 | Platform crew |', ':::', '',
            '::: {.rejected reason="unknownSection" line="440" label="unknown section"}', 'Lost text', ':::'];
        show(w, lines.join('\n'));
        const errs = $(w, '.mdb-rd[data-kind="rejected"]');
        assert.equal(errs.length, 4);
        // Collapsed, with the marker and its reason on hover.
        const first = errs[0];
        const marker = first.querySelector(':scope > .mdb-rd-error');
        assert.ok(marker && seen(w, marker), 'the error marker is shown');
        assert.match(marker.title, /malformedBlock: field Owner given twice/);
        assert.ok(!seen(w, body(first)), 'collapsed by default');
        first.querySelector(':scope > .mdb-rd-toggle').click();
        assert.ok(seen(w, body(first)), 'opens on click');
        const labels = (el: Win): string[] => [...el.querySelectorAll('.mdb-rejected-btn')].map((b: Win) => b.textContent);
        assert.deepEqual(labels(first), ['Use this value instead', 'Remove this']);
        assert.deepEqual(labels(errs[1]), ['Close here', 'Remove the fence', 'Remove this']);
        assert.deepEqual(labels(errs[2]), ['Rename to Owner2', 'Remove this']);
        assert.deepEqual(labels(errs[3]), ['Remove this']);
        // Each button posts the edit blocks.js computes for its choice.
        const check = (el: Win, open: number, choice: string, label: string): void => {
            posted.length = 0;
            const btn = [...el.querySelectorAll('.mdb-rejected-btn')].find((b: Win) => b.textContent === label);
            btn.click();
            const edit = posted.find((m) => m.type === 'applyEdit');
            assert.ok(edit, `${label} posts an edit`);
            const want = w.mdbResolveRejected(lines, open, choice);
            assert.deepEqual([edit.startLine, edit.endLine, edit.expected, edit.replacement], [want.startLine, want.endLine, want.expected, want.replacement], label);
            send(w, { type: 'editResult', ok: false, editId: edit.editId, error: 'test' });
        };
        check(first, 6, 'use', 'Use this value instead');
        assert.match(String(posted[0].replacement), /Owner: Platform team/);
        check(errs[1], 10, 'close', 'Close here');
        check(errs[1], 10, 'unfence', 'Remove the fence');
        check(errs[2], 19, 'rename', 'Rename to Owner2');
        check(errs[3], 23, 'remove', 'Remove this');
        // Errors: a navigation kind.
        const navBox = w.document.querySelector('#navKindPop input[data-nav-kind="errors"]');
        assert.ok(navBox, 'the Errors kind');
        $(w, '#navKindPop input[data-nav-kind]').forEach((b: Win) => { b.checked = b === navBox; });
        navBox.dispatchEvent(new w.Event('change', { bubbles: true }));
        w.document.getElementById('navNextBtn').click();
        assert.ok($(w, '.mdb-nav-current')[0]?.matches('.mdb-rd[data-kind="rejected"]'), 'the arrows go to an error');
        // Errors: a search category.
        const input = w.document.getElementById('searchInput');
        input.value = 'platform';
        input.dispatchEvent(new w.Event('input'));
        await new Promise((r) => setTimeout(r, 20));
        assert.match(w.document.getElementById('searchCount').textContent, /\/5$/, 'all: the text outside and each error\'s preview and body');
        const scope = w.document.getElementById('searchScope');
        scope.value = 'errors';
        scope.dispatchEvent(new w.Event('change'));
        await new Promise((r) => setTimeout(r, 20));
        assert.match(w.document.getElementById('searchCount').textContent, /\/4$/, 'errors only: the two errors\' previews and bodies');
        scope.value = 'all';
        scope.dispatchEvent(new w.Event('change'));
        // The hint: shown while there are errors, gone on a click (which goes to the first) or a scroll.
        await new Promise((r) => setTimeout(r, 150));
        const hint = w.document.getElementById('errorHint');
        assert.ok(!hint.hidden, 'the hint is shown');
        assert.match(hint.textContent, /The document has 4 errors/);
        first.classList.remove('mdb-open');
        hint.click();
        assert.ok(hint.hidden, 'a click puts it away');
        assert.ok(first.classList.contains('mdb-open'), 'and opens the first error');
        show(w, '# Other\n\n::: {.rejected reason="x"}\nlost\n:::', '/ws/other.md');
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(!hint.hidden, 'another document with an error shows it');
        assert.match(hint.textContent, /1 error\b/);
        w.document.getElementById('contentArea').dispatchEvent(new w.Event('scroll'));
        assert.ok(!hint.hidden, 'the render\'s own scroll does not put it away');
        await new Promise((r) => setTimeout(r, 400));
        w.document.getElementById('contentArea').dispatchEvent(new w.Event('scroll'));
        assert.ok(hint.hidden, 'the reader\'s scroll puts it away');
        show(w, '# Clean\n\nNo errors.', '/ws/clean.md');
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(hint.hidden, 'no errors, no hint');
    });
});
