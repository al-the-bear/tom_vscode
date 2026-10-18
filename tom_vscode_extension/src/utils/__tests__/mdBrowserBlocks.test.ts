/**
 * The Markdown Browser's source mapping (media/markdownBrowser/blocks.js),
 * loaded into a vm sandbox and fed marked's real lexer output.
 *
 *   MB-1  blocks carry their file line ranges, trailing blank lines excluded
 *   MB-2  a dropped link definition does not shift the lines after it
 *   MB-3  only paragraphs, lists, quotes, tables and code are editable
 *   MB-4  CRLF text maps to the same lines
 *   MB-5  answer markers: every one outside fenced code, with the column after the marker
 *   MB-6  inserting an answer: one space before and after, the rest of the line kept
 *   MB-7  folding: a folded heading hides its section, deeper headings included; its own state is kept
 *   MB-8  folding: the folded headings an element sits under, for revealing it
 *   MB-9  indent depths: a heading at its level - 1, its content one step deeper
 *   MB-10 html blocks that open an element (e.g. <details>) are grouped with everything up to its close
 *   MB-11 section references `OUTER > INNER`: found in text, uppercase ids only
 *   MB-12 a section reference resolves to the heading whose full id holds its ids in order
 *   MB-13 plain-text .md paths: relative, nested, bare names; not URLs, not mid-word
 *   MB-14 which links point at a Markdown document
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { marked } from 'marked';

interface Block { index: number; type: string; startLine: number; endLine: number; editable: boolean }
interface BlocksApi {
    mdbBlocks(text: string, tokens: unknown[]): Block[];
    mdbAnswerMarkers(text: string): Array<{ line: number; column: number }>;
    mdbInsertAnswer(lineText: string, column: number, answer: string): string;
    mdbFoldHidden(entries: Array<{ level: number | null; folded?: boolean }>): boolean[];
    mdbFoldAncestors(entries: Array<{ level: number | null; folded?: boolean }>, index: number): number[];
    mdbIndentDepths(entries: Array<{ level: number | null }>): number[];
    mdbGroups(tokens: unknown[]): Array<[number, number]>;
    mdbSectionRefs(text: string): Array<{ start: number; end: number; ids: string[] }>;
    mdbResolveSectionRef(ids: string[], fullIds: string[]): number;
    mdbMdPaths(text: string): Array<{ start: number; end: number; path: string }>;
    mdbIsMdLink(href: string): boolean;
}

function load(): BlocksApi {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'media', 'markdownBrowser', 'blocks.js'), 'utf-8');
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
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

    test('MB-6: inserting an answer', () => {
        assert.equal(api.mdbInsertAnswer('**Answer:**', 11, 'Yes, do it.'), '**Answer:** Yes, do it. ');
        assert.equal(api.mdbInsertAnswer('**Answer:**   (fill in)', 11, ' no '), '**Answer:** no (fill in)');
        assert.equal(api.mdbInsertAnswer('- **Answer:** old', 13, 'new'), '- **Answer:** new old');
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
        assert.deepEqual(plain(api.mdbSectionRefs('a > b, Stkg > TOENV, STKG alone, x STKG > ')), [], 'lower case, single ids and dangling > are no references');
        assert.deepEqual(plain(api.mdbSectionRefs('RFDOC-DOCU-LST > RFDOC-DOCU-PROJECT-IDEA')).map((r) => r.ids), [['RFDOC-DOCU-LST', 'RFDOC-DOCU-PROJECT-IDEA']]);
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
});
