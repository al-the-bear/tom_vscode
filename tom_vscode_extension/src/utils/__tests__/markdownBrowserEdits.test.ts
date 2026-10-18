/**
 * The Markdown Browser's file edit: replace a line range, guarded by the text
 * the browser saw there.
 *
 *   ME-1  replaces the range, keeps the rest byte for byte
 *   ME-2  appending at the end of a block (replacement = old text + insertion)
 *   ME-3  CRLF files keep CRLF, the expected text compares without the CR
 *   ME-4  a file that changed underneath is refused, nothing written
 *   ME-5  a range outside the file is refused
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyMdLineEdit } from '../markdownBrowserEdits.js';

const FILE = 'a\nb\nc\n\nd\n';

describe('applyMdLineEdit', () => {
    test('ME-1: replaces the range', () => {
        assert.deepEqual(applyMdLineEdit(FILE, { startLine: 1, endLine: 3, expected: 'b\nc', replacement: 'B\nC\nC2' }),
            { ok: true, text: 'a\nB\nC\nC2\n\nd\n' });
    });

    test('ME-2: appending to a block', () => {
        assert.deepEqual(applyMdLineEdit(FILE, { startLine: 4, endLine: 5, expected: 'd', replacement: 'd and more\n\nnew para' }),
            { ok: true, text: 'a\nb\nc\n\nd and more\n\nnew para\n' });
    });

    test('ME-3: CRLF', () => {
        const crlf = 'a\r\nb\r\nc\r\n';
        assert.deepEqual(applyMdLineEdit(crlf, { startLine: 1, endLine: 2, expected: 'b', replacement: 'x\ny' }),
            { ok: true, text: 'a\r\nx\r\ny\r\nc\r\n' });
    });

    test('ME-4: changed underneath', () => {
        const r = applyMdLineEdit(FILE, { startLine: 1, endLine: 2, expected: 'old b', replacement: 'x' });
        assert.equal(r.ok, false);
        assert.match(!r.ok ? r.reason : '', /changed/);
    });

    test('ME-5: out of range', () => {
        assert.equal(applyMdLineEdit(FILE, { startLine: 4, endLine: 99, expected: 'd', replacement: 'x' }).ok, false);
        assert.equal(applyMdLineEdit(FILE, { startLine: -1, endLine: 1, expected: 'a', replacement: 'x' }).ok, false);
        assert.equal(applyMdLineEdit(FILE, { startLine: 2, endLine: 1, expected: '', replacement: 'x' }).ok, false);
    });
});
