/**
 * mergeYamlLayout — a fresh encoding written with the original file's layout
 * wherever the values did not change (YL-*).
 *
 *   YL-1  identical texts: the encoding as it is
 *   YL-2  key order: the original's, at every level; a changed value inside keeps its place
 *   YL-3  scalar style: a value that reads the same (plain or `|2-`, `6` or a `|2-` block holding 6, a one-line
 *         `a: b` the SOM TypeScript runtime writes plain) keeps the original's text; a changed one takes the
 *         encoding's text
 *   YL-4  keys only the encoding has go after their predecessor in the encoding's order (first when none);
 *         keys only the original has are dropped
 *   YL-5  leading comments (the file header) and blank lines stay with their entries
 *   YL-6  a mapping becoming a value or a value becoming a mapping takes the encoding's text
 *   YL-7  not a block mapping at the top (a sequence, a scalar): the encoding as it is; a sequence inside is
 *         one value
 *   YL-8  with the encoding of the document before the edit: a mapping the edit reordered (a list item
 *         moved) takes the encoding's order, its values' text kept; the others keep the original's order
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeYamlLayout } from '../yamlLayoutMerge.js';

const y = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('mergeYamlLayout', () => {
    test('YL-1: identical texts', () => {
        const text = y('a: 1', 'b:', '  c: x');
        assert.equal(mergeYamlLayout(text, text), text);
    });

    test('YL-2: the original key order', () => {
        const original = y('doc:', '  status: Draft', '  date: 2026-11-09', '  inner:', '    z: 1', '    a: 2');
        const encoded = y('doc:', '  date: 2026-11-09', '  inner:', '    a: 3', '    z: 1', '  status: Draft');
        assert.equal(mergeYamlLayout(original, encoded),
            y('doc:', '  status: Draft', '  date: 2026-11-09', '  inner:', '    z: 1', '    a: 3'));
    });

    test('YL-3: a value that reads the same keeps its text', () => {
        const original = y(
            'f:',
            '  severity: high',
            '  count: |2-',
            '    6',
            '  item: |2-',
            '    Confirming would take the tenant beyond its quota: the confirmation is refused.',
            '  code: |2-',
            '    `userName` → username',
            '  text: |2-',
            '    old text',
        );
        const encoded = y(
            'f:',
            '  severity: |2-',
            '    high',
            '  count: 6',
            '  item: Confirming would take the tenant beyond its quota: the confirmation is refused.',
            '  code: `userName` → username',
            '  text: |2-',
            '    new text',
        );
        assert.equal(mergeYamlLayout(original, encoded), y(
            'f:',
            '  severity: high',
            '  count: |2-',
            '    6',
            '  item: |2-',
            '    Confirming would take the tenant beyond its quota: the confirmation is refused.',
            '  code: |2-',
            '    `userName` → username',
            '  text: |2-',
            '    new text',
        ));
    });

    test('YL-4: added and removed keys', () => {
        const original = y('m:', '  b: 1', '  gone: 2', '  d: 3');
        const encoded = y('m:', '  first: 0', '  d: 3', '  b: 1', '  c: new');
        // `first` has no common key before it: first. `c` follows `b` in the encoding.
        assert.equal(mergeYamlLayout(original, encoded), y('m:', '  first: 0', '  b: 1', '  c: new', '  d: 3'));
    });

    test('YL-5: comments and blank lines', () => {
        const original = y('# header line 1', '# header line 2', 'version: 2', 'doc:', '  a: |2-', '    one', '', '    two', '', '  # about b', '  b: x');
        const encoded = y('# header line 1', 'version: 2', 'doc:', '  b: y', '  a: |2-', '    one', '', '    two');
        assert.equal(mergeYamlLayout(original, encoded),
            y('# header line 1', '# header line 2', 'version: 2', 'doc:', '  a: |2-', '    one', '', '    two', '', '  # about b', '  b: y'));
    });

    test('YL-6: a mapping and a value trading places', () => {
        const original = y('a:', '  x: 1', 'b: plain', 'c: 3');
        const encoded = y('a: {}', 'b:', '  y: 2', 'c: 3');
        assert.equal(mergeYamlLayout(original, encoded), encoded);
    });

    test('YL-8: an edit that reorders', () => {
        // The file: form fields in its own order (b before a), list items 1, 2, 3 as blocks.
        const original = y('form:', '  b: x', '  a: y', 'list:', '  I-1: |2-', '    one', '  I-2: |2-', '    two', '  I-3: |2-', '    three');
        // This encoder: a before b, items plain; the edit moved I-3 first.
        const before = y('form:', '  a: y', '  b: x', 'list:', '  I-1: one', '  I-2: two', '  I-3: three');
        const encoded = y('form:', '  a: y', '  b: x', 'list:', '  I-3: three', '  I-1: one', '  I-2: two');
        assert.equal(mergeYamlLayout(original, encoded, before),
            y('form:', '  b: x', '  a: y', 'list:', '  I-3: |2-', '    three', '  I-1: |2-', '    one', '  I-2: |2-', '    two'));
        assert.equal(mergeYamlLayout(original, encoded).indexOf('I-3'), original.indexOf('I-3'), 'without it: the original order');
    });

    test('YL-7: not a block mapping', () => {
        assert.equal(mergeYamlLayout(y('- a', '- b'), y('- b', '- a')), y('- b', '- a'));
        assert.equal(mergeYamlLayout('just text\n', 'other text\n'), 'other text\n');
        const original = y('list:', '  - one', '  - two', 'k: v');
        const encoded = y('k: v', 'list:', '  - one', '  - three');
        assert.equal(mergeYamlLayout(original, encoded), y('list:', '  - one', '  - three', 'k: v'), 'the sequence is one changed value');
        const same = y('k: v', 'list:', '  -   one', '  -   two');
        assert.equal(mergeYamlLayout(original, same), original, 'the same sequence keeps its text');
    });
});
