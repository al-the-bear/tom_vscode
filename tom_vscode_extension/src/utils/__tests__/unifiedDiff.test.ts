/**
 * unifiedDiff — the dry-run diff the spec document store returns (UD-*).
 *
 *   UD-1  identical texts give an empty diff
 *   UD-2  a one-line change gives one hunk with context and the right header
 *   UD-3  an insertion and a deletion are each reported with correct ranges
 *   UD-4  two changes far apart give two hunks; close ones merge into one
 *   UD-5  a change at the very start and at the very end
 *   UD-6  a large file with one change stays fast (common prefix/suffix trimmed)
 *   UD-7  a 300 000-line file changed all over (and a block moved) is diffed within seconds without an
 *         allocation that grows with the product of the lengths; the diff applied to the old text gives
 *         the new one
 *   UD-8  a large changed middle with no line unique on both sides is shown removed, then added
 *   UD-9  random edits of small texts: the diff applied to the old text gives the new one
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { LCS_CELLS, unifiedDiff } from '../unifiedDiff.js';

/** `before` with `diff` applied, hunk by hunk; throws when a context or removed line does not match. */
function applyDiff(before: string, diff: string): string {
    const old = before === '' ? [] : before.replace(/\n$/, '').split('\n');
    const out: string[] = [];
    let at = 0;
    for (const hunk of diff.split(/^(?=@@ )/m).slice(1)) {
        const [header, ...body] = hunk.replace(/\n$/, '').split('\n');
        const m = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(header);
        assert.ok(m, header);
        const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
        while (at < start) { out.push(old[at++]); }
        for (const line of body) {
            const text = line.slice(1);
            if (line[0] === '+') { out.push(text); continue; }
            assert.equal(old[at], text, `line ${at + 1} of the old text`);
            if (line[0] === ' ') { out.push(text); }
            at++;
        }
    }
    while (at < old.length) { out.push(old[at++]); }
    return out.length ? `${out.join('\n')}\n` : '';
}

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

    test('UD-7: a 300 000-line file changed all over', () => {
        const before = lines(300_000);
        const a = before.split('\n');
        // Every 997th line changed, a block of 2000 lines moved from the start to the end.
        const changed = a.map((l, i) => (i % 997 === 500 ? `${l} (edited)` : l));
        const moved = [...changed.slice(0, 1000), ...changed.slice(3000, -1), ...changed.slice(1000, 3000), ''];
        const after = moved.join('\n');
        const started = Date.now();
        const diff = unifiedDiff(before, after, 'f');
        assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
        assert.equal(applyDiff(before, diff), after);
        assert.ok(diff.length < before.length / 4, 'the diff names the changes, not the whole file');
    });

    test('UD-8: no anchor in a large middle', () => {
        const side = Math.ceil(Math.sqrt(LCS_CELLS)) + 10;
        const before = lines(side, () => 'same');
        const after = lines(side, () => 'other');
        const diff = unifiedDiff(before, after, 'f');
        assert.equal(applyDiff(before, diff), after);
        const body = diff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
        assert.equal(body.length, 2 * side);
        assert.ok(body.slice(0, side).every((l) => l === '-same') && body.slice(side).every((l) => l === '+other'), 'removed, then added');
    });

    test('UD-9: random edits apply back', () => {
        let seed = 7;
        const random = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        for (let round = 0; round < 300; round++) {
            const a = Array.from({ length: random(30) }, () => `l${random(8)}`);
            const b = [...a];
            for (let k = random(6); k > 0; k--) {
                const at = random(b.length + 1);
                if (random(2) === 0 && b.length > 0) { b.splice(at, 1); } else { b.splice(at, 0, `n${random(8)}`); }
            }
            const before = a.length ? `${a.join('\n')}\n` : '';
            const after = b.length ? `${b.join('\n')}\n` : '';
            assert.equal(applyDiff(before, unifiedDiff(before, after, 'f')), after, JSON.stringify({ a, b }));
        }
    });
});
