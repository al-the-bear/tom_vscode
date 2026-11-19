/**
 * The Markdown Browser's source mapping (media/markdownBrowser/blocks.js),
 * loaded into a vm sandbox and fed marked's real lexer output.
 *
 *   MB-1  blocks carry their file line ranges, trailing blank lines excluded
 *   MB-2  a dropped link definition does not shift the lines after it
 *   MB-3  only paragraphs, lists, quotes, tables and code are editable
 *   MB-4  CRLF text maps to the same lines
 *   MB-5  answer markers: every one outside fenced code, with the column after the marker
 *   MB-6  an answer's extent: the rest of its line and, in a blockquote, the following `>` lines up to a
 *         bare `>`, a blank line or a line without `>`; outside a quote the rest of the paragraph;
 *         writing one back keeps the quote prefix on every line
 *   MB-7  folding: a folded heading hides its section, deeper headings included; its own state is kept
 *   MB-8  folding: the folded headings an element sits under, for revealing it
 *   MB-8b the +/- groups (vscimpb100): a heading's level within its parent section, other levels and other parents apart
 *   MB-9  indent depths: a heading at its level - 1, its content one step deeper
 *   MB-10 html blocks that open an element (e.g. <details>) are grouped with everything up to its close
 *   MB-11 section references `OUTER > INNER`: found in text, uppercase ids only
 *   MB-12 a section reference resolves to the heading whose full id holds its ids in order
 *   MB-13 plain-text .md paths: relative, nested, bare names; not URLs, not mid-word
 *   MB-14 which links point at a Markdown document
 *   MB-16 comment blocks: recognised by the upward arrow, their extent and text without `>`, the next id
 *         (the runtime's when higher), form-field ranges; the
 *         next id, written back with `> ` (missing id and author added, empty = no comment)
 *   MB-17 inline review marks (CriticMarkup, tom_specs annot1 §5): addition, deletion, substitution,
 *         highlight with its comment, comment alone; only at the start; unclosed is no mark
 *   MB-15 splitting a large document for lexing: only before headings outside code and html,
 *         the parts join back to the text, and lexing the parts gives the tokens of the whole
 *   MB-18 questions: the question an `**Answer:**` belongs to — its id, its options `(a)`, `(b)` … with
 *         continuation lines, and the recommended one: the bold option, else the one whose text says
 *         "recommended", else the letter of a `*Recommendation:*` line; in a block of several questions,
 *         each answer finds its own; the answer an option writes
 *   MB-21 questions of a SOM document (vscannot4): the options and the recommended letter the host read with
 *         the runtime replace the browser's own reading for a question the host knows (`source: 'runtime'`),
 *         the header line still found in the text; a question the host does not know, or no reading at all,
 *         is read by the browser (`source: 'browser'`)
 *   MB-22 the count shown for search and navigation (vscimpa13): `current/total`, `–/total` before the
 *         first step, `0/0` when nothing matches
 *   MB-19 navigating from a position (after a save or a decision): next is the first target at or after
 *         it, previous the last one before it, wrapping around; targets without a position are passed over
 *   MB-20 revealing a target: its context (the question) at the top of the view, unless that would push
 *         the part that must stay visible (the answer editor) out at the bottom
 *   MB-23 the reading notation's opening fence: braces or a bare kind word, up to three spaces of indent, the
 *         first class as the kind, `#id` and `key="value"` kept; a closing fence, four spaces and `\:::` are none;
 *         the registered kinds and their default modes, an unknown kind always shown
 *   MB-24 the closing fence: nesting, a fence inside fenced code, a heading stop (ATX or styled div), unclosed at
 *         the end; the block extension's `start` looks only up to the paragraph's end
 *   MB-25 spans and citation shapes: nesting, code spans, `]\{.` is none, no blank line inside, a class needed;
 *         `(-> ids)` trace, `(<- …)` / `(<~ …)` provenance, balanced parentheses only; the per-element key
 *   MB-26 a div is one block from its opening to its closing fence, editable, its content lexed inside it; a
 *         stray closing fence is a block of its own
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { marked, Marked } from 'marked';

interface Block { index: number; type: string; startLine: number; endLine: number; editable: boolean }
interface BlocksApi {
    mdbBlocks(text: string, tokens: unknown[]): Block[];
    mdbAnswerMarkers(text: string): Array<{ line: number; column: number }>;
    mdbAnswerAt(lines: string[], line: number, column: number): { text: string; endLine: number };
    mdbWriteAnswer(lines: string[], line: number, column: number, answer: string): string;
    mdbFoldHidden(entries: Array<{ level: number | null; folded?: boolean }>): boolean[];
    mdbFoldAncestors(entries: Array<{ level: number | null; folded?: boolean }>, index: number): number[];
    mdbFoldLevelGroups(entries: Array<{ level: number | null; folded?: boolean }>): Array<{ members: number[]; parent: number } | null>;
    mdbIndentDepths(entries: Array<{ level: number | null }>): number[];
    mdbGroups(tokens: unknown[]): Array<[number, number]>;
    mdbSectionRefs(text: string): Array<{ start: number; end: number; ids: string[] }>;
    mdbResolveSectionRef(ids: string[], fullIds: string[]): number;
    mdbMdPaths(text: string): Array<{ start: number; end: number; path: string }>;
    mdbIsMdLink(href: string): boolean;
    mdbSplitForLexing(text: string, target: number): Array<{ startLine: number; text: string }>;
    mdbIsCommentLine(line: string): boolean;
    mdbCommentAt(lines: string[], line: number): { startLine: number; endLine: number; text: string } | null;
    mdbNextCommentId(text: string, runtimeNext?: number): string;
    mdbInRanges(ranges: Array<[number, number]>, line: number): boolean;
    mdbWriteComment(text: string, nextId: string, author?: string): string;
    mdbNavPick(keys: Array<{ line: number; ord: number } | null>, anchor: { line: number; ord: number }, delta: number): number;
    mdbRevealDelta(contextTop: number, keepBottom: number, viewHeight: number, pad: number): number;
    mdbQuestionAt(lines: string[], answerLine: number, fromRuntime?: Record<string, { options: Array<{ letter: string; text: string; bold: boolean }>; recommended: string | null }> | null): { id: string; line: number; options: Array<{ letter: string; text: string; bold: boolean }>; recommended: string | null; source: string } | null;
    mdbOptionAnswer(letter: string): string;
    mdbCountLabel(index: number, total: number): string;
    mdbCriticMark(src: string): { raw: string; kind: string; text: string; oldText?: string; newText?: string; comment?: string } | null;
    mdbEditInlineComment(source: string, raw: string, occurrence: number, comment: string): { text: string } | { error: string };
    mdbChangeQuote(text: string): { kind: string; oldText: string; newText: string; outcome: string | null; comment: string } | null;
    mdbChangeWithComment(src: string): { mark: { raw: string }; token: string; comment: { raw: string; text: string } | null; raw: string } | null;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- blocks.js's global
    MDB_READING_KINDS: Record<string, { block: string[]; span: string[]; title: string }>;
    mdbReadingFence(line: string): { colons: number; kind: string; classes: string[]; id: string; attrs: Record<string, string> } | null;
    mdbReadingDivEnd(lines: string[], open: number): { close: number; stop: number; unclosed: boolean };
    mdbReadingDivToken(src: string, lexer: unknown): Record<string, unknown> | undefined;
    mdbReadingBlockStart(src: string): number | undefined;
    mdbReadingSpan(src: string): { raw: string; text: string; kind: string; classes: string[]; id: string; attrs: Record<string, string> } | null;
    mdbCitation(src: string): { raw: string; arrow: string; content: string; kind: string } | null;
    mdbReadingKey(kind: string, text: string, seen: Record<string, number>): string;
    mdbReadingMode(modes: Record<string, { block?: string; span?: string }> | null, kind: string, span: boolean): string;
}

function load(): BlocksApi {
    const media = join(__dirname, '..', '..', '..', 'media');
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    // The question parser is shared with the host (media/shared/mdQuestions.js); the browser loads it first.
    vm.runInContext(readFileSync(join(media, 'shared', 'mdQuestions.js'), 'utf-8'), sandbox);
    vm.runInContext(readFileSync(join(media, 'markdownBrowser', 'blocks.js'), 'utf-8'), sandbox);
    return sandbox as unknown as BlocksApi;
}
const api = load();
/** Plain host-realm copies, so deepEqual compares values, not realms. */
const blocks = (text: string): Block[] => JSON.parse(JSON.stringify(api.mdbBlocks(text, marked.lexer(text))));
const lineOf = (text: string, b: Block): string => text.split('\n').slice(b.startLine, b.endLine).join('\n');

const DOC = [
    '# Title',          // 0
    '',                 // 1
    'Para one',         // 2
    'line two',         // 3
    '',                 // 4
    '- a',              // 5
    '- b',              // 6
    '',                 // 7
    '[x]: http://y',    // 8  (link definition: no token)
    '',                 // 9
    '```js',            // 10
    '**Answer:** in code',
    '```',              // 12
    '',                 // 13
    '| a | b |',        // 14
    '|---|---|',
    '| 1 | 2 |',        // 16
    '',                 // 17
    '> quote',          // 18
    '',                 // 19
    'last para',        // 20
].join('\n');

describe('Markdown Browser source mapping', () => {
    test('MB-1: line ranges', () => {
        const b = blocks(DOC);
        assert.deepEqual(b.map((x) => [x.type, x.startLine, x.endLine]), [
            ['heading', 0, 1], ['paragraph', 2, 4], ['list', 5, 7], ['code', 10, 13], ['table', 14, 17],
            ['blockquote', 18, 19], ['paragraph', 20, 21],
        ]);
        assert.equal(lineOf(DOC, b[1]), 'Para one\nline two');
        assert.equal(lineOf(DOC, b[4]), '| a | b |\n|---|---|\n| 1 | 2 |');
    });

    test('MB-2: a link definition does not shift what follows', () => {
        const b = blocks(DOC);
        assert.equal(lineOf(DOC, b[3]), '```js\n**Answer:** in code\n```');
        assert.equal(lineOf(DOC, b[6]), 'last para');
    });

    test('MB-3: editable types', () => {
        assert.deepEqual(blocks(DOC).filter((x) => x.editable).map((x) => x.type),
            ['paragraph', 'list', 'code', 'table', 'blockquote', 'paragraph']);
    });

    test('MB-4: CRLF text', () => {
        const crlf = DOC.split('\n').join('\r\n');
        assert.deepEqual(blocks(crlf).map((x) => [x.startLine, x.endLine]), blocks(DOC).map((x) => [x.startLine, x.endLine]));
    });

    test('MB-5: answer markers outside code', () => {
        const text = 'Q1?\n**Answer:**\n\n```\n**Answer:** no\n```\nA **Answer:** x and **Answer:** y';
        assert.deepEqual(JSON.parse(JSON.stringify(api.mdbAnswerMarkers(text))), [
            { line: 1, column: 11 }, { line: 6, column: 13 }, { line: 6, column: 31 },
        ]);
    });

    test('MB-6: an answer, read and written', () => {
        const at = (lines: string[], line: number, column: number): { text: string; endLine: number } =>
            JSON.parse(JSON.stringify(api.mdbAnswerAt(lines, line, column)));
        const quote = ['> Q?', '>', '> **Answer:** (b) long', '> more text', '>', '> next'];
        assert.deepEqual(at(quote, 2, 13), { text: '(b) long\nmore text', endLine: 4 });
        assert.deepEqual(at(['> **Answer:** (c) ', '', 'x'], 0, 13), { text: '(c)', endLine: 1 }, 'trailing space dropped');
        assert.deepEqual(at(['> **Answer:**'], 0, 13), { text: '', endLine: 1 });
        assert.deepEqual(at(['> **Answer:** a', 'not quoted'], 0, 13), { text: 'a', endLine: 1 }, 'a line without > ends it');
        assert.deepEqual(at(['> **Answer:** a', '> **Answer:** b'], 0, 13), { text: 'a', endLine: 1 }, 'the next marker ends it');
        assert.deepEqual(at(['**Answer:** x', 'y', '', 'z'], 0, 11), { text: 'x\ny', endLine: 2 }, 'outside a quote: to the end of the paragraph');
        assert.deepEqual(at(['**Answer:** x', '- item'], 0, 11), { text: 'x', endLine: 1 }, 'a list starts after it');
        assert.deepEqual(at(['A **Answer:** x and **Answer:** y'], 0, 13), { text: 'x and', endLine: 1 }, 'up to a second marker on the line');

        assert.equal(api.mdbWriteAnswer(quote, 2, 13, '(c)\nbecause\n\nreasons '), '> **Answer:** (c)\n> because\n> reasons',
            'every line in the quote; blank lines would end the answer, so they are dropped');
        assert.equal(api.mdbWriteAnswer(quote, 2, 13, ''), '> **Answer:**', 'empty clears it');
        assert.equal(api.mdbWriteAnswer(['**Answer:**'], 0, 11, ' Yes, go ahead. '), '**Answer:** Yes, go ahead.');
        assert.equal(api.mdbWriteAnswer(['A **Answer:** x and **Answer:** y'], 0, 13, 'new\ntext'), 'A **Answer:** new text **Answer:** y',
            'a marker followed by another on its line takes one line');
    });

    // # A (0) / text (1) / ## B (2) / text (3) / ### C (4) / text (5) / ## D (6) / text (7) / # E (8) / text (9)
    const outline = (folded: number[]): Array<{ level: number | null; folded: boolean }> =>
        [1, null, 2, null, 3, null, 2, null, 1, null].map((level, i) => ({ level, folded: folded.includes(i) }));
    const hidden = (folded: number[]): number[] =>
        Array.from(api.mdbFoldHidden(outline(folded))).flatMap((h, i) => (h ? [i] : []));

    test('MB-7: folding hides a section and keeps the inner headings\' own state', () => {
        assert.deepEqual(hidden([]), []);
        assert.deepEqual(hidden([2]), [3, 4, 5], '## B hides its text and ### C with its text, not ## D');
        assert.deepEqual(hidden([4]), [5]);
        assert.deepEqual(hidden([0]), [1, 2, 3, 4, 5, 6, 7], '# A hides everything up to # E');
        assert.deepEqual(hidden([0, 4]), [1, 2, 3, 4, 5, 6, 7]);
        assert.deepEqual(hidden([4]), [5], 'unfolding # A again shows ### C still folded — its own flag');
        assert.deepEqual(hidden([8]), [9]);
    });

    test('MB-8: the folded headings above an element', () => {
        assert.deepEqual(Array.from(api.mdbFoldAncestors(outline([0, 4]), 5)), [0, 4]);
        assert.deepEqual(Array.from(api.mdbFoldAncestors(outline([2]), 7)), [], '## D is not under ## B');
        assert.deepEqual(Array.from(api.mdbFoldAncestors(outline([2]), 4)), [2], 'a heading under a folded one');
    });

    test('MB-8b: the sections a heading\'s +/- act on', () => {
        // # A (0), ## B (2), ### C (4), ## D (6), # E (8), each followed by text; then # F's own ## G.
        const entries = [...outline([]), { level: 2, folded: false }, { level: 1, folded: false }, { level: 2, folded: false }];
        const groups = api.mdbFoldLevelGroups(entries);
        const g = (i: number) => (groups[i] ? { members: Array.from(groups[i]!.members), parent: groups[i]!.parent } : null);
        assert.equal(groups[1], null, 'text is no heading');
        assert.deepEqual(g(2), { members: [2, 6], parent: 0 }, '## B and ## D under # A');
        assert.equal(groups[2], groups[6], 'one group, shared');
        assert.deepEqual(g(4), { members: [4], parent: 2 }, '### C alone under ## B');
        assert.deepEqual(g(0), { members: [0, 8, 11], parent: -1 }, 'the top level: the document');
        assert.deepEqual(g(10), { members: [10], parent: 8 }, '## under # E is not ## B\'s group');
        assert.deepEqual(g(12), { members: [12], parent: 11 }, 'another parent, another group');
    });

    test('MB-9: indent depths', () => {
        // text before any heading (0), # A (0), text (1), ### C skipping a level (2), text (3), ## D (1), text (2)
        const entries = [null, 1, null, 3, null, 2, null].map((level) => ({ level }));
        assert.deepEqual(Array.from(api.mdbIndentDepths(entries)), [0, 0, 1, 2, 3, 1, 2]);
    });

    test('MB-10: html groups', () => {
        const groups = (text: string): string[] => {
            const tokens = marked.lexer(text) as Array<{ type: string; raw: string }>;
            return Array.from(api.mdbGroups(tokens), ([a, b]) => tokens.slice(a, b + 1).filter((x) => x.type !== 'space').map((x) => x.type).join('+')).filter(Boolean);
        };
        assert.deepEqual(
            groups('Intro\n\n<details><summary>R</summary>\n\n```\nx\n```\n\n</details>\n\nAfter'),
            ['paragraph', 'html+code+html', 'paragraph'],
            'the <details> block and its content are one group',
        );
        assert.deepEqual(groups('<!-- comment -->\n\nText'), ['html', 'paragraph'], 'a comment opens nothing');
        assert.deepEqual(groups('<div>\n\n<details><summary>a</summary>\n\ninner\n\n</details>\n\n</div>\n\nout'),
            ['html+html+paragraph+html+html', 'paragraph'], 'nested elements close together');
        assert.deepEqual(groups('<br>\n\n<img src="x"/>\n\nText'), ['html', 'html', 'paragraph'], 'void and self-closing tags open nothing');
        assert.deepEqual(groups('<details>\n\nnever closed\n\nmore'), ['html+paragraph+paragraph'], 'unclosed runs to the end');
    });

    const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

    test('MB-11: section references', () => {
        assert.deepEqual(plain(api.mdbSectionRefs('in STKG > TOENV and SYDSC>UCE > X-1.')), [
            { start: 3, end: 15, ids: ['STKG', 'TOENV'] },
            { start: 20, end: 35, ids: ['SYDSC', 'UCE', 'X-1'] },
        ]);
        assert.deepEqual(plain(api.mdbSectionRefs('a > b, Stkg > TOENV, STKG alone, x STKG > ')).map((r) => r.ids), [['TOENV']],
            'lower case, a single id of four letters or fewer and dangling > are no references; TOENV is a single id of five letters');
        assert.deepEqual(plain(api.mdbSectionRefs('RFDOC-DOCU-LST > RFDOC-DOCU-PROJECT-IDEA')).map((r) => r.ids), [['RFDOC-DOCU-LST', 'RFDOC-DOCU-PROJECT-IDEA']]);
    });

    test('MB-11b: a single id of more than four letters', () => {
        const refs = (s: string): string[][] => plain(api.mdbSectionRefs(s)).map((r) => r.ids);
        assert.deepEqual(refs('see PLTPLN and ASMRE-ASMP-PERSONA-ARCHETYPES.'), [['PLTPLN'], ['ASMRE-ASMP-PERSONA-ARCHETYPES']]);
        assert.deepEqual(plain(api.mdbSectionRefs('see PLTPLN.')), [{ start: 4, end: 10, ids: ['PLTPLN'] }]);
        assert.deepEqual(refs('STKG, ACE-1, HTTP, TODO and X-1-2 are four letters or fewer'), [], 'letters counted, digits and dashes not');
        assert.deepEqual(refs('ACE-CRIT-1 has seven letters'), [['ACE-CRIT-1']]);
        assert.deepEqual(refs('PLTPLNx, xPLTPLN, Pltpln, pre-PLTPLN, PLTPLN-x'), [], 'only a whole all-uppercase word');
        assert.deepEqual(refs('STKG > TOENV then PLTPLN'), [['STKG', 'TOENV'], ['PLTPLN']], 'a chain is one reference, the single id another');
    });

    test('MB-12: resolving a section reference', () => {
        const ids = ['SBP.A.ACE-CRIT-1', 'SBP.B.X.ACE-CRIT-1', 'SBP.STKG.TOENV'];
        assert.equal(api.mdbResolveSectionRef(['B', 'ACE-CRIT-1'], ids), 1, 'the outer id picks among repeated inner ids');
        assert.equal(api.mdbResolveSectionRef(['STKG', 'TOENV'], ids), 2);
        assert.equal(api.mdbResolveSectionRef(['SBP', 'X', 'ACE-CRIT-1'], ids), 1, 'outer ids need not be the direct parent');
        assert.equal(api.mdbResolveSectionRef(['Q', 'ACE-CRIT-1'], ids), 0, 'an unknown outer id falls back to the first with that id');
        assert.equal(api.mdbResolveSectionRef(['STKG', 'NONE'], ids), -1);
        assert.equal(api.mdbResolveSectionRef(['TOENV', 'STKG'], ids), -1, 'order matters');
    });

    test('MB-13: plain-text .md paths', () => {
        const paths = (s: string): string[] => plain(api.mdbMdPaths(s)).map((m) => m.path);
        assert.deepEqual(paths('_Extrapolated — see iterations/sbpa06_notes.md._'), ['iterations/sbpa06_notes.md']);
        assert.deepEqual(paths('see ../x/y.md, clarifications.sbp.md and _ai/quests/q/overview.q.md;'), ['../x/y.md', 'clarifications.sbp.md', '_ai/quests/q/overview.q.md']);
        assert.deepEqual(paths('https://host/a.md and readme.mdx and x.md5 and a.md/b'), [], 'URLs, other extensions and directories');
        const m = plain(api.mdbMdPaths('see ./a.md'))[0];
        assert.deepEqual([m.start, m.end], [4, 10]);
    });

    test('MB-14: Markdown links', () => {
        assert.equal(api.mdbIsMdLink('a/b.md'), true);
        assert.equal(api.mdbIsMdLink('../B.MD#sec'), true);
        assert.equal(api.mdbIsMdLink('#local'), false);
        assert.equal(api.mdbIsMdLink('https://x.org/a.md'), false);
        assert.equal(api.mdbIsMdLink('a/b.ts'), false);
    });

    test('MB-15: splitting for lexing', () => {
        const doc = [
            '# A', '', 'para a', '',            // 0-3
            '```', '# not a heading', '```', '', // 4-7
            '## B', '', '<details>', '', '# inside details', '', '</details>', '', // 8-15
            '## C', '', '- item', '  more', '', // 16-20
            '### D', 'text right after',          // 21-22
        ].join('\n');
        const parts = plain(api.mdbSplitForLexing(doc, 1));
        assert.deepEqual(parts.map((p) => p.startLine), [0, 8, 16, 21], 'never inside the fence or the open <details>');
        assert.equal(parts.map((p) => p.text).join('\n'), doc, 'the parts are the text');
        parts.forEach((p) => assert.equal(p.text.split('\n')[0], doc.split('\n')[p.startLine]));
        assert.deepEqual(plain(api.mdbSplitForLexing(doc, 1e9)).map((p) => p.startLine), [0], 'below the target: one part');
        const kinds = (text: string): string[] => marked.lexer(text).filter((x) => x.type !== 'space').map((x) => x.type + ':' + x.raw.trim());
        assert.deepEqual(parts.flatMap((p) => kinds(p.text)), kinds(doc), 'the same tokens as lexing the whole');
    });

    test('MB-16: comment blocks', () => {
        assert.equal(api.mdbIsCommentLine('> ⬆️ **C-12** (Alexis): text'), true);
        assert.equal(api.mdbIsCommentLine('>⬆ plain arrow, no variation selector'), true);
        assert.equal(api.mdbIsCommentLine('> **❓ BQ-1 — topic:** question'), false);
        assert.equal(api.mdbIsCommentLine('⬆️ not quoted'), false);

        const lines = ['Para', '', '> ⬆️ **C-2** (Alexis): first', '> second', '>', '> third', '', 'next'];
        assert.deepEqual(plain(api.mdbCommentAt(lines, 2)), { startLine: 2, endLine: 6, text: '⬆️ **C-2** (Alexis): first\nsecond\n\nthird' });
        assert.equal(api.mdbCommentAt(lines, 0), null);

        assert.equal(api.mdbNextCommentId('no comments'), 'C-1');
        assert.equal(api.mdbNextCommentId('> ⬆️ **C-2** a\n\n> ⬆ **C-11** b\n\n**C-40** is not a comment id'), 'C-12');
        assert.equal(api.mdbNextCommentId('> ⬆️ **C-2** a', 9), 'C-9', 'the runtime\'s next id wins when it is higher (annot2)');
        assert.equal(api.mdbNextCommentId('> ⬆️ **C-12** a', 9), 'C-13', 'a comment only the browser sees still counts');
        assert.equal(api.mdbNextCommentId('no comments', undefined), 'C-1');
        assert.equal(api.mdbInRanges([[4, 7], [10, 12]], 4), true);
        assert.equal(api.mdbInRanges([[4, 7], [10, 12]], 7), false, 'the end is exclusive');
        assert.equal(api.mdbInRanges([], 4), false);

        const write = (text: string): string => api.mdbWriteComment(text, 'C-7');
        assert.equal(write('⬆️ **C-7** looks wrong\n\nsee below\n'), '> ⬆️ **C-7** looks wrong\n>\n> see below', 'every line under `> `, a blank one as `>`');
        assert.equal(write('⬆️ **C-3** (Alexis): keep the id'), '> ⬆️ **C-3** (Alexis): keep the id');
        assert.equal(write('⬆️ (Alexis): no id yet'), '> ⬆️ **C-7** (Alexis): no id yet', 'a missing id is added after the arrow');
        assert.equal(write('just text'), '> ⬆️ **C-7** just text', 'a missing arrow too');
        assert.equal(write(''), '');
        assert.equal(write('  \n '), '');
        assert.equal(write('⬆️ **C-7** '), '', 'the arrow and id alone are no comment');
        assert.equal(write('⬆️ **C-7** (Alexis):'), '');
        const byMe = (text: string): string => api.mdbWriteComment(text, 'C-7', 'Alexis');
        assert.equal(byMe('⬆️ **C-7** looks wrong'), '> ⬆️ **C-7** (Alexis): looks wrong', 'the author is added when none is named');
        assert.equal(byMe('⬆️ **C-7**: colon already'), '> ⬆️ **C-7** (Alexis): colon already');
        assert.equal(byMe('⬆️ (Bob): his comment'), '> ⬆️ **C-7** (Bob): his comment', 'another author is kept');
        assert.equal(byMe('⬆️ **C-7** (Alexis): '), '', 'header only: still no comment');
    });
    test('MB-17: inline review marks', () => {
        const mark = (src: string): unknown => JSON.parse(JSON.stringify(api.mdbCriticMark(src)));
        assert.deepEqual(mark('{++ new words ++} tail'), { raw: '{++ new words ++}', kind: 'addition', text: 'new words' });
        assert.deepEqual(mark('{-- gone --}'), { raw: '{-- gone --}', kind: 'deletion', text: 'gone' });
        assert.deepEqual(mark('{~~ old ~> new ~~}.'), { raw: '{~~ old ~> new ~~}', kind: 'substitution', text: 'new', oldText: 'old', newText: 'new' });
        assert.deepEqual(mark('{== the text ==}{>> why? <<} more'),
            { raw: '{== the text ==}{>> why? <<}', kind: 'highlight', text: 'the text', comment: 'why?' });
        assert.deepEqual(mark('{== only marked ==}'), { raw: '{== only marked ==}', kind: 'highlight', text: 'only marked' });
        assert.deepEqual(mark('{>> a remark <<}'), { raw: '{>> a remark <<}', kind: 'comment', text: 'a remark' });
        assert.deepEqual(mark('{++ across\nlines ++}'), { raw: '{++ across\nlines ++}', kind: 'addition', text: 'across\nlines' });
        assert.equal(mark('text {++ x ++}'), null, 'only at the start of the source');
        assert.equal(mark('{++ never closed'), null);
        assert.equal(mark('{-- --}'), null, 'an empty mark is no mark');
        assert.equal(mark('{plain}'), null);
    });
    test('MB-17b: editing an inline comment', () => {
        const edit = (source: string, raw: string, occurrence: number, comment: string): unknown =>
            JSON.parse(JSON.stringify(api.mdbEditInlineComment(source, raw, occurrence, comment)));
        const src = 'One {>> first <<} and {>> first <<} and {==marked==}{>>why<<} and {== bare ==} end.';
        assert.deepEqual(edit(src, '{>> first <<}', 1, 'second'),
            { text: 'One {>> first <<} and {>> second <<} and {==marked==}{>>why<<} and {== bare ==} end.' }, 'the n-th occurrence, spacing kept');
        assert.deepEqual(edit(src, '{==marked==}{>>why<<}', 0, ' because '),
            { text: 'One {>> first <<} and {>> first <<} and {==marked==}{>>because<<} and {== bare ==} end.' });
        assert.deepEqual(edit(src, '{== bare ==}', 0, 'added'),
            { text: 'One {>> first <<} and {>> first <<} and {==marked==}{>>why<<} and {== bare ==}{>> added <<} end.' }, 'a highlight gets a comment');
        assert.deepEqual(edit(src, '{>> first <<}', 0, ''),
            { text: 'One  and {>> first <<} and {==marked==}{>>why<<} and {== bare ==} end.' }, 'empty: the comment goes');
        assert.deepEqual(edit(src, '{==marked==}{>>why<<}', 0, '  '),
            { text: 'One {>> first <<} and {>> first <<} and {==marked==} and {== bare ==} end.' }, 'empty: the highlight stays');
        assert.match((edit(src, '{>> first <<}', 0, 'a <<} b') as { error: string }).error, /cannot contain/);
        assert.match((edit(src, '{>> first <<}', 2, 'x') as { error: string }).error, /no longer where it was/);
        assert.match((edit(src, '{++ add ++}', 0, 'x') as { error: string }).error, /Not an inline comment/);
    });
    test('MB-17c: change comments (SOM §11.9.3)', () => {
        const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
        assert.deepEqual(json(api.mdbCriticMark('{>> [~~ 30 ~> 15 ~~] why shorter? <<} rest')), {
            raw: '{>> [~~ 30 ~> 15 ~~] why shorter? <<}', kind: 'comment', text: 'why shorter?',
            quote: { kind: 'substitution', oldText: '30', newText: '15', outcome: null },
        });
        assert.deepEqual(json(api.mdbChangeQuote('[++ on shared devices ++ | accepted ] needed?')),
            { kind: 'addition', oldText: '', newText: 'on shared devices', outcome: 'accepted', comment: 'needed?' });
        assert.deepEqual(json(api.mdbChangeQuote(' [-- old --]\tgone?')), { kind: 'deletion', oldText: 'old', newText: '', outcome: null, comment: 'gone?' });
        for (const plain of ['[see FR-3] x', 'no quote', '[~~ no arrow ~~] x', '[++ never closed']) {
            assert.equal(api.mdbChangeQuote(plain), null, plain);
        }
        assert.equal((json(api.mdbCriticMark('{>> [see FR-3] note <<}')) as { text: string }).text, '[see FR-3] note', 'a plain comment keeps its text');

        // A change with its own comment, its attribution token between; anything else is not attached.
        const attached = api.mdbChangeWithComment('{~~ 30 ~> 15 ~~}{@bob}{>> [~~ 30 ~> 15 ~~] why? <<} minutes');
        assert.deepEqual(json(attached && { token: attached.token, comment: attached.comment?.raw, raw: attached.raw }),
            { token: '{@bob}', comment: '{>> [~~ 30 ~> 15 ~~] why? <<}', raw: '{~~ 30 ~> 15 ~~}{@bob}{>> [~~ 30 ~> 15 ~~] why? <<}' });
        for (const loose of ['{~~ 30 ~> 15 ~~} {>> [~~ 30 ~> 15 ~~] why? <<}', '{~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 20 ~~] why? <<}',
            '{~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~ | accepted] why? <<}', '{~~ 30 ~> 15 ~~}{>> plain <<}']) {
            const parsed = api.mdbChangeWithComment(loose);
            assert.equal(parsed?.comment, null, loose);
            assert.equal(parsed?.raw, '{~~ 30 ~> 15 ~~}');
        }
        assert.equal(api.mdbChangeWithComment('{>> note <<}'), null, 'not a change');
    });
    test('MB-18: questions and their options', () => {
        const lines = [
            '> **❓ Open questions on these fields**',                                     // 0
            '>',                                                                           // 1
            '> **❓ BQ-07 — overallComplexity:** are the complexity and the',              // 2
            '> influence rated?',                                                          // 3
            '> - (a) both unrated',                                                        // 4
            '> - (b) both rated: the complexity "Very high"; the influence of the owner',  // 5
            '>   critical',                                                                // 6
            '> - (c) only the complexity rated',                                           // 7
            '>',                                                                           // 8
            '> *Recommendation:* (c) — the complexity informs the sizing.',               // 9
            '>',                                                                           // 10
            '> **Answer:**',                                                               // 11
            '>',                                                                           // 12
            '> **BQ-08 — author:** who is named?',                                         // 13
            '> - (a) the owner',                                                           // 14
            '> - **(b)** the owner and the agents',                                        // 15
            '> **Answer:** (a)',                                                           // 16
            '>',                                                                           // 17
            '> **❓ BQ-09 — scope:** which scope?',                                        // 18
            '> - (a) narrow',                                                              // 19
            '> - (b) wide (recommended)',                                                  // 20
            '> **Answer:**',                                                               // 21
            '',                                                                            // 22
            '> **❓ BQ-10 — free:** anything else?',                                       // 23
            '> **Answer:**',                                                               // 24
        ];
        const q7 = api.mdbQuestionAt(lines, 11)!;
        assert.equal(q7.id, 'BQ-07');
        assert.equal(q7.line, 2);
        assert.deepEqual(Array.from(q7.options, (o) => o.letter), ['a', 'b', 'c']);
        assert.equal(q7.options[1].text, 'both rated: the complexity "Very high"; the influence of the owner critical', 'continuation lines join');
        assert.equal(q7.recommended, 'c', 'from the Recommendation line');
        const q8 = api.mdbQuestionAt(lines, 16)!;
        assert.deepEqual([q8.id, q8.line, q8.recommended], ['BQ-08', 13, 'b'], 'a field question; the bold option');
        assert.equal(q8.options[1].bold, true);
        assert.equal(q8.options[1].text, 'the owner and the agents');
        assert.deepEqual([api.mdbQuestionAt(lines, 21)!.id, api.mdbQuestionAt(lines, 21)!.recommended], ['BQ-09', 'b'], '"recommended" in the text');
        const q10 = api.mdbQuestionAt(lines, 24)!;
        assert.deepEqual([q10.id, q10.options.length, q10.recommended], ['BQ-10', 0, null]);
        assert.equal(api.mdbQuestionAt(['plain', '**Answer:**'], 1), null, 'no question above');
        assert.equal(api.mdbOptionAnswer('c'), '(c)');
    });

    test('MB-21: questions read by the runtime', () => {
        const lines = [
            '> **❓ BQ-01 — scope:** which scope?',   // 0
            '> - (a) narrow',                        // 1
            '> - (b) wide',                          // 2
            '> **Answer:**',                         // 3
            '',                                      // 4
            '> **❓ BQ-02 — size:** how large?',     // 5
            '> - **(a)** small',                     // 6
            '> **Answer:**',                         // 7
        ];
        const runtime = Object.fromEntries([
            ['BQ-01', { options: [{ letter: 'a', text: 'narrow', bold: false }, { letter: 'b', text: 'wide, as the runtime reads it', bold: true }], recommended: 'b' }],
        ]);
        const known = api.mdbQuestionAt(lines, 3, runtime)!;
        assert.deepEqual([known.id, known.line, known.source, known.recommended], ['BQ-01', 0, 'runtime', 'b']);
        assert.equal(known.options[1].text, 'wide, as the runtime reads it');
        const own = api.mdbQuestionAt(lines, 3)!;
        assert.deepEqual([own.source, own.recommended], ['browser', null], 'without the host\'s reading: the browser\'s');
        const unknown = api.mdbQuestionAt(lines, 7, runtime)!;
        assert.deepEqual([unknown.id, unknown.source, unknown.recommended], ['BQ-02', 'browser', 'a'], 'a question the host does not know');
        assert.equal(api.mdbQuestionAt(['plain', '**Answer:**'], 1, runtime), null);
    });

    test('MB-22: the count label', () => {
        assert.equal(api.mdbCountLabel(146, 356), '147/356');
        assert.equal(api.mdbCountLabel(-1, 356), '–/356', 'before the first step');
        assert.equal(api.mdbCountLabel(-1, 0), '0/0');
        assert.equal(api.mdbCountLabel(0, 0), '0/0');
    });

    test('MB-19: navigating from a position', () => {
        const keys = [{ line: 3, ord: 0 }, { line: 8, ord: 0 }, { line: 8, ord: 1 }, null, { line: 20, ord: 0 }];
        assert.equal(api.mdbNavPick(keys, { line: 8, ord: 1 }, 1), 2, 'at the position: the mark that took the decided one\'s place');
        assert.equal(api.mdbNavPick(keys, { line: 9, ord: 0 }, 1), 4, 'after the saved answer: the next one');
        assert.equal(api.mdbNavPick(keys, { line: 21, ord: 0 }, 1), 0, 'wraps to the first');
        assert.equal(api.mdbNavPick(keys, { line: 8, ord: 1 }, -1), 1, 'previous: the last one before');
        assert.equal(api.mdbNavPick(keys, { line: 3, ord: 0 }, -1), 4, 'wraps to the last');
        assert.equal(api.mdbNavPick([], { line: 0, ord: 0 }, 1), -1);
    });

    test('MB-20: revealing a target with its context', () => {
        assert.equal(api.mdbRevealDelta(500, 700, 400, 8), 492, 'the question at the top, the editor below it in view');
        assert.equal(api.mdbRevealDelta(500, 1100, 400, 8), 708, 'a long question: the editor at the bottom of the view');
        assert.equal(api.mdbRevealDelta(-300, 50, 400, 8), -308, 'upwards too');
    });

    test('MB-23: the opening fence and the kinds', () => {
        const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
        assert.deepEqual(plain(api.mdbReadingFence('::: {.provenance .extra #p1 label="Where it came from" source=notes.md}')),
            { colons: 3, kind: 'provenance', classes: ['provenance', 'extra'], id: 'p1', attrs: { label: 'Where it came from', source: 'notes.md' } });
        assert.equal(api.mdbReadingFence('   :::: aside')?.kind, 'aside', 'a bare kind word, up to three spaces, more colons');
        assert.equal(api.mdbReadingFence('::: {#x}')?.kind, '', 'no class: a div without a kind');
        assert.equal(api.mdbReadingFence(':::'), null, 'a closing fence opens nothing');
        assert.equal(api.mdbReadingFence('    ::: aside'), null, 'four spaces are an indented code block');
        assert.equal(api.mdbReadingFence('\\::: aside'), null, 'an escaped fence is text');
        assert.equal(api.mdbReadingFence(':: aside'), null);
        assert.deepEqual(Object.keys(api.MDB_READING_KINDS), ['provenance', 'trace', 'editorial', 'aside', 'refs', 'records', 'rejected']);
        const mode = (kind: string, span: boolean, modes: Record<string, { block?: string; span?: string }> | null = null): string => api.mdbReadingMode(modes, kind, span);
        assert.deepEqual(['provenance', 'editorial', 'aside'].map((k) => [mode(k, false), mode(k, true)]), [['collapsed', 'marker'], ['collapsed', 'marker'], ['collapsed', 'marker']]);
        assert.equal(mode('trace', true), 'marker');
        assert.deepEqual([mode('refs', false), mode('records', false)], ['compact', 'compact']);
        assert.equal(mode('mystery', false), 'shown', 'an unknown kind is shown');
        assert.equal(mode('aside', true, { aside: { span: 'dimmed' } }), 'dimmed', 'the reader\'s choice');
        assert.equal(mode('aside', true, { aside: { span: 'hidden' } }), 'marker', 'no hidden mode: an unknown choice falls back');
        assert.equal(mode('refs', false, { refs: { block: 'collapsed' } }), 'compact', 'content is never collapsed');
    });

    test('MB-24: the closing fence', () => {
        const end = (lines: string[]): unknown => JSON.parse(JSON.stringify(api.mdbReadingDivEnd(lines, 0)));
        assert.deepEqual(end(['::: aside', 'a', ':::', 'b']), { close: 2, stop: 3, unclosed: false });
        assert.deepEqual(end([':::: {.provenance}', 'a', '::: trace', 'b', ':::', 'c', '::::']), { close: 6, stop: 7, unclosed: false }, 'a nested div closes first');
        assert.deepEqual(end(['::: aside', '```', ':::', '```', ':::']), { close: 4, stop: 5, unclosed: false }, 'a fence inside code is literal');
        assert.deepEqual(end(['::: aside', '~~~~', ':::', '~~~', ':::', '~~~~', ':::']), { close: 6, stop: 7, unclosed: false }, 'a shorter fence does not close the code');
        assert.deepEqual(end(['::: aside', 'a', '', '## Next', ':::']), { close: -1, stop: 3, unclosed: true }, 'a heading stops it');
        assert.deepEqual(end(['::: aside', 'a', '<div class="heading7" id="X"><!--[X]--> Deep</div>']), { close: -1, stop: 2, unclosed: true }, 'a styled-div heading too');
        assert.deepEqual(end(['::: aside', 'a']), { close: -1, stop: 2, unclosed: true }, 'unclosed at the end');
        // `start`: the newline before a fence line, looked for only up to the paragraph's end.
        assert.equal(api.mdbReadingBlockStart('ext\nmore\n::: aside\n'), 'ext\nmore'.length);
        assert.equal(api.mdbReadingBlockStart('ext\n\n::: aside\n'), undefined, 'not past the blank line');
        assert.equal(api.mdbReadingBlockStart('ext and more'), undefined);
    });

    test('MB-25: spans, citations and keys', () => {
        const span = (src: string): unknown => { const m = api.mdbReadingSpan(src); return m ? JSON.parse(JSON.stringify(m)) : null; };
        assert.deepEqual(span('[an aside]{.aside} rest'), { raw: '[an aside]{.aside}', text: 'an aside', kind: 'aside', classes: ['aside'], id: '', attrs: {} });
        assert.equal((span('[a [b]{.trace} c]{.provenance label="L"}') as { text: string; attrs: { label: string } }).text, 'a [b]{.trace} c', 'nesting');
        assert.equal((span('[code `]{.x}` in it]{.aside}') as { text: string }).text, 'code `]{.x}` in it', 'a code span is skipped');
        assert.equal((span('[a \\] b]{.aside}') as { text: string }).text, 'a \\] b', 'an escaped bracket is skipped');
        assert.equal(span('[a]\\{.aside}'), null, '`]\\{.` is no span');
        assert.equal(span('[a](http://x)'), null, 'a link is no span');
        assert.equal(span('[a]{#only-id}'), null, 'a span needs a class');
        assert.equal(span('[a\n\nb]{.aside}'), null, 'no blank line inside');
        assert.equal((span('[a\nb]{.aside}') as { text: string }).text, 'a\nb', 'it may wrap a line');
        const cite = (src: string): unknown => { const m = api.mdbCitation(src); return m ? JSON.parse(JSON.stringify(m)) : null; };
        assert.deepEqual(cite('(-> C2.1, TR-07) and'), { raw: '(-> C2.1, TR-07)', arrow: '->', content: 'C2.1, TR-07', kind: 'trace' });
        assert.equal((cite('(<- tom_uam.sbp.tomspecs.md#FRE-REQU-LST)') as { kind: string }).kind, 'provenance');
        assert.equal((cite('(<~ iterations/sbpa21_notes.md)') as { arrow: string }).arrow, '<~');
        assert.equal((cite('(-> f(x) and g)') as { content: string }).content, 'f(x) and g', 'balanced parentheses');
        assert.equal(cite('(-> f(x)'), null, 'unbalanced');
        assert.equal(cite('(->C2.1)'), null, 'one space after the arrow');
        assert.equal(cite('(C2.1)'), null, 'a plain parenthesis is no shape');
        const seen: Record<string, number> = {};
        assert.equal(api.mdbReadingKey('trace', '(-> C2.1)', seen), 'trace|(-> C2.1)#1');
        assert.equal(api.mdbReadingKey('trace', '(-> C2.1)', seen), 'trace|(-> C2.1)#2', 'its occurrence');
        assert.equal(api.mdbReadingKey('aside', `${'x'.repeat(100)}\n  y`, {}), `aside|${'x'.repeat(80)}#1`, 'the first 80 characters');
    });

    test('MB-26: a div is one editable block', () => {
        const m = new Marked();
        m.use({ extensions: [{
            name: 'readingDiv', level: 'block',
            start: (src: string) => api.mdbReadingBlockStart(src),
            tokenizer(this: { lexer: unknown }, src: string) { return api.mdbReadingDivToken(src, this.lexer) as never; },
            renderer: () => '',
        }] });
        const text = ['Before', '', '::: {.provenance}', 'note *one*', '', '- a list', ':::', '', ':::', '', 'After', 'still after'].join('\n');
        const tokens = m.lexer(text);
        const b = JSON.parse(JSON.stringify(api.mdbBlocks(text, tokens))) as Block[];
        assert.deepEqual(b.map((x) => [x.type, x.startLine, x.endLine, x.editable]), [
            ['paragraph', 0, 1, true], ['readingDiv', 2, 7, true], ['readingDiv', 8, 9, true], ['paragraph', 10, 12, true],
        ]);
        const div = tokens.find((t: { type: string }) => t.type === 'readingDiv') as unknown as { kind: string; tokens: Array<{ type: string }>; unclosed: boolean; stray: boolean };
        assert.equal(div.kind, 'provenance');
        assert.deepEqual(JSON.parse(JSON.stringify(div.tokens.filter((t) => t.type !== 'space').map((t) => t.type))), ['paragraph', 'list'], 'its content lexed inside it');
        assert.equal(div.unclosed, false);
        assert.equal((tokens.filter((t: { type: string }) => t.type === 'readingDiv')[1] as unknown as { stray: boolean }).stray, true, 'a stray closing fence');
        // A fence line ends the paragraph before it (the start), and an escaped one is text.
        const cut = m.lexer('text\n::: aside\nnote\n:::\n');
        assert.deepEqual(cut.filter((t: { type: string }) => t.type !== 'space').map((t: { type: string }) => t.type), ['paragraph', 'readingDiv']);
        assert.deepEqual(m.lexer('\\::: aside\n').filter((t: { type: string }) => t.type !== 'space').map((t: { type: string }) => t.type), ['paragraph']);
    });
});
