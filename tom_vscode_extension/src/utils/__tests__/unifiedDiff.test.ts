/**
 * unifiedDiff — the dry-run diff the spec document store returns (UD-*).
 *
 *   UD-1  identical texts give an empty diff
 *   UD-2  a one-line change gives one hunk with context and the right header
 *   UD-3  an insertion and a deletion are each reported with correct ranges
 *   UD-4  two changes far apart give two hunks; close ones merge into one
 *   UD-5  a change at the very start and at the very end
 *   UD-6  a large file with one change stays fast (common prefix/suffix trimmed)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { unifiedDiff } from '../unifiedDiff.js';

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string =>
    Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('unifiedDiff', () => {
    test('UD-1: identical texts give an empty diff', () => {
        assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'f'), '');
    });

    test('UD-2: one changed line, one hunk with three lines of context', () => {
        const before = lines(10);
        const after = before.replace('line 5\n', 'line FIVE\n');
        assert.equal(unifiedDiff(before, after, 'doc.yaml'), [
            '--- a/doc.yaml',
            '+++ b/doc.yaml',
            '@@ -2,7 +2,7 @@',
            ' line 2',
            ' line 3',
            ' line 4',
            '-line 5',
            '+line FIVE',
            ' line 6',
            ' line 7',
            ' line 8',
            '',
        ].join('\n'));
    });

    test('UD-3: insertion and deletion ranges', () => {
        const before = lines(5);
        const inserted = before.replace('line 3\n', 'line 3\nnew\n');
        assert.match(unifiedDiff(before, inserted, 'f'), /@@ -1,5 \+1,6 @@\n line 1\n line 2\n line 3\n\+new\n line 4\n line 5\n/);
        const deleted = before.replace('line 3\n', '');
        assert.match(unifiedDiff(before, deleted, 'f'), /@@ -1,5 \+1,4 @@\n line 1\n line 2\n-line 3\n line 4\n line 5\n/);
    });

    test('UD-4: distant changes give two hunks, near ones one', () => {
        const before = lines(40);
        const far = before.replace('line 5\n', 'X\n').replace('line 35\n', 'Y\n');
        assert.equal((unifiedDiff(before, far, 'f').match(/^@@/gm) ?? []).length, 2);
        const near = before.replace('line 5\n', 'X\n').replace('line 9\n', 'Y\n');
        assert.equal((unifiedDiff(before, near, 'f').match(/^@@/gm) ?? []).length, 1);
    });

    test('UD-5: changes at the start and at the end', () => {
        const before = lines(5);
        assert.match(unifiedDiff(before, before.replace('line 1\n', 'first\n'), 'f'), /@@ -1,4 \+1,4 @@\n-line 1\n\+first\n/);
        assert.match(unifiedDiff(before, before.replace('line 5\n', 'last\n'), 'f'), /@@ -2,4 \+2,4 @@\n line 2\n line 3\n line 4\n-line 5\n\+last\n$/);
    });

    test('UD-6: a large file with one change is fast', () => {
        const before = lines(20000);
        const after = before.replace('line 10000\n', 'changed\n');
        const started = Date.now();
        const diff = unifiedDiff(before, after, 'f');
        assert.ok(Date.now() - started < 500, 'diff of a 20000-line file took too long');
        assert.match(diff, /-line 10000\n\+changed\n/);
    });
});
