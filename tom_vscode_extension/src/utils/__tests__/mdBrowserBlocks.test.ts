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
});
