/**
 * Tool-impl tests for `file-mutations.ts` — the five mutation primitives
 * `tomAi_createFile`, `tomAi_editFile`, `tomAi_multiEditFile`,
 * `tomAi_deleteFile`, `tomAi_moveFile`.
 *
 * Test discipline (tool_test_coverage.md entry #2):
 *
 *   - **Typical happy-path** for each tool, wrapped in
 *     `withTiming('<toolName>:typical', …)` for audit coverage.
 *   - **All conflict cases** explicitly enumerated in the b-row:
 *     overwrite-vs-error, target exists, source missing, parent-dir
 *     auto-create, trailing newline handling, directory-vs-file,
 *     atomic vs. partial multiEdit on conflict, EXDEV (cross-fs)
 *     fallback, and the most common LLM trap (non-unique `oldText`
 *     in editFile).
 *
 * **Each test uses its own scratch temp dir** rather than sharing one.
 * Mutation tests that share state get flaky fast — one test's leftover
 * file breaks the next test's `fs.existsSync` precondition. Fixture
 * creation is cheap (a single `mkdtemp`) so isolation wins.
 *
 * EXDEV is intentionally not simulated via a separate mount — that
 * would require root and isn't portable. We instead inject the EXDEV
 * by monkey-patching `fs.renameSync` for one test and assert the
 * copy+unlink fallback path runs. Same coverage, no privilege escalation.
 */

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';
import {
    createFileImpl,
    deleteFileImpl,
    editFileImpl,
    moveFileImpl,
    multiEditFileImpl,
} from '../file-mutations.js';

// ---------------------------------------------------------------------------
// Per-test scratch workspace
// ---------------------------------------------------------------------------

let ws: string;

beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'file-mutations-'));
});

after(() => {
    // Best-effort cleanup of any leftover dirs (beforeEach creates per-test
    // dirs; we don't explicitly remove them between tests because the test
    // body may exit early). The OS reclaims tmpdir eventually anyway.
});

function write(rel: string, content: string): string {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
}

function read(rel: string): string {
    return fs.readFileSync(path.join(ws, rel), 'utf8');
}

// ===========================================================================
// createFile
// ===========================================================================

describe('createFileImpl', () => {

    test('typical call writes the file and reports byte count', async () => {
        const out = await withTiming('tomAi_createFile:typical', () =>
            createFileImpl(ws, { filePath: 'src/new.ts', content: 'export const x = 1;\n' }));
        assert.match(out, /Created file: src\/new\.ts \(20 bytes\)/);
        assert.equal(read('src/new.ts'), 'export const x = 1;\n');
    });

    test('parent directories are auto-created', async () => {
        const out = await createFileImpl(ws, { filePath: 'a/b/c/d/leaf.txt', content: 'hi' });
        assert.match(out, /Created file/);
        assert.ok(fs.existsSync(path.join(ws, 'a/b/c/d')));
    });

    test('content is written verbatim — no trailing newline added', async () => {
        await createFileImpl(ws, { filePath: 'no-nl.txt', content: 'no newline at end' });
        const buf = fs.readFileSync(path.join(ws, 'no-nl.txt'));
        assert.equal(buf.length, 'no newline at end'.length);
        assert.notEqual(buf[buf.length - 1], 0x0A);
    });

    test('errors with a clear message when the file already exists (default)', async () => {
        write('existing.ts', 'original');
        const out = await createFileImpl(ws, { filePath: 'existing.ts', content: 'new' });
        assert.match(out, /file already exists/);
        assert.match(out, /overwrite: true/);
        assert.equal(read('existing.ts'), 'original', 'file must be unchanged when overwrite is omitted');
    });

    test('overwrite: true replaces the file and reports the old + new size', async () => {
        write('existing.ts', '12345');
        const out = await createFileImpl(ws, { filePath: 'existing.ts', content: 'abcdefghij', overwrite: true });
        assert.match(out, /Overwrote file/);
        assert.match(out, /was 5 bytes, now 10 bytes/);
        assert.equal(read('existing.ts'), 'abcdefghij');
    });

    test('rejects path traversal outside the workspace', async () => {
        const out = await createFileImpl(ws, { filePath: '../../../tmp/escape.txt', content: 'x' });
        assert.match(out, /outside the workspace/);
    });

    test('missing filePath returns an instructive error', async () => {
        const out = await createFileImpl(ws, { filePath: '', content: 'x' });
        assert.match(out, /`filePath` is required/);
    });
});

// ===========================================================================
// editFile
// ===========================================================================

describe('editFileImpl', () => {

    test('typical call replaces the unique occurrence', async () => {
        write('m.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
        const out = await withTiming('tomAi_editFile:typical', () =>
            editFileImpl(ws, { filePath: 'm.ts', oldText: 'const b = 2;', newText: 'const b = 42;' }));
        assert.match(out, /1 replacement\)/);
        assert.equal(read('m.ts'), 'const a = 1;\nconst b = 42;\nconst c = 3;\n');
    });

    test('non-unique `oldText` fails with an instructive error (the LLM multi-match trap)', async () => {
        write('m.ts', 'foo\nfoo\nfoo\n');
        const out = await editFileImpl(ws, { filePath: 'm.ts', oldText: 'foo', newText: 'bar' });
        assert.match(out, /matches more than once/);
        assert.match(out, /replaceAll: true/);
        // Critically: the file is untouched
        assert.equal(read('m.ts'), 'foo\nfoo\nfoo\n');
    });

    test('replaceAll: true performs the bulk rename and reports count', async () => {
        write('m.ts', 'foo bar foo baz foo\n');
        const out = await editFileImpl(ws, { filePath: 'm.ts', oldText: 'foo', newText: 'X', replaceAll: true });
        assert.match(out, /3 replacements\)/);
        assert.equal(read('m.ts'), 'X bar X baz X\n');
    });

    test('`oldText` not found surfaces a clear "not found" error', async () => {
        write('m.ts', 'hello world\n');
        const out = await editFileImpl(ws, { filePath: 'm.ts', oldText: 'absent', newText: 'replaced' });
        assert.match(out, /not found in file/);
        assert.match(out, /whitespace/);
    });

    test('missing file surfaces a clear "not found" error', async () => {
        const out = await editFileImpl(ws, { filePath: 'no-such.ts', oldText: 'a', newText: 'b' });
        assert.match(out, /File not found/);
    });

    test('rejects path traversal outside the workspace', async () => {
        const out = await editFileImpl(ws, { filePath: '../etc/host', oldText: 'a', newText: 'b' });
        assert.match(out, /outside the workspace/);
    });

    test('empty `oldText` is rejected (would match everywhere otherwise)', async () => {
        write('m.ts', 'content');
        const out = await editFileImpl(ws, { filePath: 'm.ts', oldText: '', newText: 'x' });
        assert.match(out, /oldText.*empty/);
    });
});

// ===========================================================================
// multiEditFile — atomic by default
// ===========================================================================

describe('multiEditFileImpl', () => {

    test('typical call applies edits across multiple files atomically', async () => {
        write('a.ts', 'export const A = 1;');
        write('b.ts', 'export const B = 2;');
        const out = await withTiming('tomAi_multiEditFile:typical', () =>
            multiEditFileImpl(ws, {
                edits: [
                    { filePath: 'a.ts', oldText: 'A = 1', newText: 'A = 100' },
                    { filePath: 'b.ts', oldText: 'B = 2', newText: 'B = 200' },
                ],
            }));
        assert.match(out, /Applied 2 file\(s\) atomically/);
        assert.equal(read('a.ts'), 'export const A = 100;');
        assert.equal(read('b.ts'), 'export const B = 200;');
    });

    test('multiple edits to the SAME file are applied sequentially', async () => {
        write('chain.ts', 'foo\nbar\nbaz\n');
        const out = await multiEditFileImpl(ws, {
            edits: [
                { filePath: 'chain.ts', oldText: 'foo', newText: 'FOO' },
                { filePath: 'chain.ts', oldText: 'bar', newText: 'BAR' },
                { filePath: 'chain.ts', oldText: 'baz', newText: 'BAZ' },
            ],
        });
        assert.match(out, /Applied 1 file\(s\) atomically/);
        assert.equal(read('chain.ts'), 'FOO\nBAR\nBAZ\n');
    });

    test('ATOMIC failure mode: one bad edit aborts EVERYTHING with a full report', async () => {
        write('a.ts', 'export const A = 1;');
        write('b.ts', 'export const B = 2;');
        // a.ts will succeed; b.ts will fail (oldText absent). Atomic mode
        // must NOT touch either file and must say so.
        const out = await multiEditFileImpl(ws, {
            edits: [
                { filePath: 'a.ts', oldText: 'A = 1', newText: 'A = 100' },
                { filePath: 'b.ts', oldText: 'NEVER_PRESENT', newText: 'x' },
            ],
        });
        assert.match(out, /Aborted/);
        assert.match(out, /no edits applied/);
        assert.match(out, /b\.ts.*not found/);
        // Critical check: a.ts is UNCHANGED despite its edit being valid.
        assert.equal(read('a.ts'), 'export const A = 1;', 'atomic mode must not partially apply');
    });

    test('bestEffort: true reverts to legacy partial-apply behaviour', async () => {
        write('a.ts', 'export const A = 1;');
        write('b.ts', 'export const B = 2;');
        const out = await multiEditFileImpl(ws, {
            edits: [
                { filePath: 'a.ts', oldText: 'A = 1', newText: 'A = 100' },
                { filePath: 'b.ts', oldText: 'NEVER_PRESENT', newText: 'x' },
            ],
            bestEffort: true,
        });
        assert.match(out, /Best-effort: 1 applied, 1 skipped/);
        assert.equal(read('a.ts'), 'export const A = 100;', 'best-effort must apply the valid edit');
        assert.equal(read('b.ts'), 'export const B = 2;');
    });

    test('empty edits array is rejected', async () => {
        const out = await multiEditFileImpl(ws, { edits: [] });
        assert.match(out, /must be a non-empty array/);
    });

    test('a non-unique `oldText` inside an edit aborts atomically (not partially)', async () => {
        write('a.ts', 'foo\nfoo\n');
        const out = await multiEditFileImpl(ws, {
            edits: [{ filePath: 'a.ts', oldText: 'foo', newText: 'X' }],
        });
        assert.match(out, /Aborted/);
        assert.match(out, /matches more than once/);
        assert.equal(read('a.ts'), 'foo\nfoo\n');
    });
});

// ===========================================================================
// deleteFile
// ===========================================================================

describe('deleteFileImpl', () => {

    test('typical call deletes a single file', async () => {
        write('to-delete.txt', 'bye');
        const out = await withTiming('tomAi_deleteFile:typical', () =>
            deleteFileImpl(ws, { path: 'to-delete.txt' }));
        assert.match(out, /Deleted: to-delete\.txt/);
        assert.ok(!fs.existsSync(path.join(ws, 'to-delete.txt')));
    });

    test('directory passed instead of file → instructive error, no delete', async () => {
        fs.mkdirSync(path.join(ws, 'is-a-dir'));
        const out = await deleteFileImpl(ws, { path: 'is-a-dir' });
        assert.match(out, /is a directory/);
        assert.match(out, /shell command in a separate step/);
        assert.ok(fs.existsSync(path.join(ws, 'is-a-dir')), 'directory must not be removed');
    });

    test('missing file surfaces a clear "not found" error', async () => {
        const out = await deleteFileImpl(ws, { path: 'no-such.txt' });
        assert.match(out, /File not found/);
    });

    test('rejects path traversal outside the workspace', async () => {
        const out = await deleteFileImpl(ws, { path: '../escape.txt' });
        assert.match(out, /outside the workspace/);
    });

    test('missing path returns an instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await deleteFileImpl(ws, {} as any);
        assert.match(out, /`path` is required/);
    });
});

// ===========================================================================
// moveFile
// ===========================================================================

describe('moveFileImpl', () => {

    test('typical call renames a file', async () => {
        write('old-name.ts', 'hello');
        const out = await withTiming('tomAi_moveFile:typical', () =>
            moveFileImpl(ws, { from: 'old-name.ts', to: 'new-name.ts' }));
        assert.match(out, /Moved: old-name\.ts → new-name\.ts/);
        assert.ok(!fs.existsSync(path.join(ws, 'old-name.ts')));
        assert.equal(read('new-name.ts'), 'hello');
    });

    test('parent directories of `to` are auto-created', async () => {
        write('flat.ts', 'x');
        const out = await moveFileImpl(ws, { from: 'flat.ts', to: 'deep/nested/structure/leaf.ts' });
        assert.match(out, /Moved/);
        assert.equal(read('deep/nested/structure/leaf.ts'), 'x');
    });

    test('errors when destination exists (default) and leaves both files alone', async () => {
        write('src.ts', 'source');
        write('dst.ts', 'destination');
        const out = await moveFileImpl(ws, { from: 'src.ts', to: 'dst.ts' });
        assert.match(out, /destination already exists/);
        assert.match(out, /overwrite: true/);
        assert.equal(read('src.ts'), 'source', 'source must be unchanged');
        assert.equal(read('dst.ts'), 'destination', 'destination must be unchanged');
    });

    test('overwrite: true replaces the destination', async () => {
        write('src.ts', 'source');
        write('dst.ts', 'destination');
        const out = await moveFileImpl(ws, { from: 'src.ts', to: 'dst.ts', overwrite: true });
        assert.match(out, /Moved/);
        assert.ok(!fs.existsSync(path.join(ws, 'src.ts')));
        assert.equal(read('dst.ts'), 'source');
    });

    test('errors when from === to (same resolved path)', async () => {
        write('same.ts', 'x');
        const out = await moveFileImpl(ws, { from: 'same.ts', to: 'same.ts' });
        assert.match(out, /resolve to the same path/);
        assert.equal(read('same.ts'), 'x');
    });

    test('missing source surfaces a clear error', async () => {
        const out = await moveFileImpl(ws, { from: 'no-such.ts', to: 'dst.ts' });
        assert.match(out, /source not found/);
    });

    test('rejects path traversal on either end', async () => {
        write('src.ts', 'x');
        const out1 = await moveFileImpl(ws, { from: '../escape.ts', to: 'dst.ts' });
        const out2 = await moveFileImpl(ws, { from: 'src.ts', to: '../escape.ts' });
        assert.match(out1, /must be inside the workspace/);
        assert.match(out2, /must be inside the workspace/);
    });

    test('EXDEV (cross-filesystem) falls back to copy + unlink', async () => {
        // Force EXDEV on the FIRST renameSync call so we exercise the
        // fallback without needing a real cross-fs mount. The impl
        // resolves `fs.renameSync` via the shared CJS exports object —
        // mutating it through `require('fs')` is the only reassign route
        // that works in Node 20+ where `* as fs` is a frozen namespace.
        write('src.ts', 'crosses fs boundary');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const realFs = require('fs') as { renameSync: typeof fs.renameSync };
        const original = realFs.renameSync;
        let exdevTripped = false;
        realFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
            if (!exdevTripped) {
                exdevTripped = true;
                const err: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted');
                err.code = 'EXDEV';
                throw err;
            }
            return original(from, to);
        }) as typeof fs.renameSync;

        try {
            const out = await moveFileImpl(ws, { from: 'src.ts', to: 'moved.ts' });
            assert.match(out, /Moved/);
            assert.ok(exdevTripped, 'EXDEV branch should have fired');
            assert.ok(!fs.existsSync(path.join(ws, 'src.ts')), 'source must be removed after copy+unlink');
            assert.equal(read('moved.ts'), 'crosses fs boundary');
        } finally {
            realFs.renameSync = original;
        }
    });

    test('missing from/to returns an instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await moveFileImpl(ws, { from: 'a' } as any);
        assert.match(out, /both `from` and `to` are required/);
    });
});
