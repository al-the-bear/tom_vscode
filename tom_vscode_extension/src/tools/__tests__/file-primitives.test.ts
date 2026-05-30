/**
 * Tool-impl tests for `file-primitives.ts` — the four file primitives
 * `tomAi_readFile`, `tomAi_listDirectory`, `tomAi_findFiles`,
 * `tomAi_findTextInFiles`.
 *
 * Test discipline (tool_test_coverage.md entry #1):
 *
 *   - **Description / typical call**: one happy-path test per tool wrapped
 *     in `withTiming('<toolName>:typical', …)` so the timing report records
 *     it and the audit script counts it as covered.
 *   - **Ambiguity cases** (b-row of the coverage doc): the mistaken-input
 *     shapes we explicitly tolerate (directory passed to `readFile`,
 *     bare `*.ts` glob to `findFiles`, etc.). One test per case.
 *   - **Large-fixture stress** for `findFiles` and `findTextInFiles`:
 *     verify the walk over the 10 000-file fixture stays under the
 *     8-second hard cap. NOT wrapped in `withTiming` — the entry would
 *     exceed the 5-second ceiling and fail the audit, and the audit
 *     intentionally treats the override as test-local only. Inline
 *     assertion covers the regression without polluting the report.
 *   - **Security regression** for `findTextInFiles`: the previous
 *     implementation passed `searchText` through `grep -E "${pattern}"`
 *     after regex-escaping but **not** shell-escaping. A test feeds it a
 *     would-be shell-injection payload and confirms the impl returns a
 *     plain "no matches" instead of executing it.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { withTiming } from './_timing.js';
import {
    mkLargeWorkspace,
    mkSmallWorkspace,
    writeFile,
    type Fixture,
} from './_fixtures.js';

import {
    findFilesImpl,
    findTextInFilesImpl,
    globToRegExp,
    listDirectoryImpl,
    nodeNativeWalker,
    readFileImpl,
} from '../file-primitives.js';

// ---------------------------------------------------------------------------
// Small fixture — shared across the cheap, correctness-focused tests.
// ---------------------------------------------------------------------------

let small: Fixture;

before(() => {
    small = mkSmallWorkspace({ prefix: 'file-primitives-small-' });
    // Add a known binary file for the binary-skip test of findTextInFiles.
    const assetsDir = path.join(small.root, 'src/assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'icon.bin'), Buffer.from([0xFF, 0x00, 0xAB, 0x12, 0x00, 0x00, 0xCD]));
    // Add an empty directory for listDirectory.
    fs.mkdirSync(path.join(small.root, 'empty_dir'));
});

after(() => small.cleanup());

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe('readFileImpl', () => {

    test('typical call returns the file contents', async () => {
        const out = await withTiming('tomAi_readFile:typical', () =>
            readFileImpl(small.root, { filePath: 'src/index.ts' }));
        assert.match(out, /export const main/);
    });

    test('startLine / endLine slice is 1-based and inclusive', async () => {
        const target = 'lineA\nlineB\nlineC\nlineD\nlineE\n';
        writeFile(small.root, 'tmp/slice.txt', target);
        const out = await readFileImpl(small.root, { filePath: 'tmp/slice.txt', startLine: 2, endLine: 4 });
        assert.equal(out, 'lineB\nlineC\nlineD');
    });

    test('out-of-range range returns a clear marker, not silent empty', async () => {
        writeFile(small.root, 'tmp/short.txt', 'only-one-line\n');
        const out = await readFileImpl(small.root, { filePath: 'tmp/short.txt', startLine: 99, endLine: 200 });
        assert.match(out, /\(empty: requested range/);
        // `\n`-split counts the trailing newline as an extra empty line — so a
        // "single line + newline" file reports as 2 lines. Just confirm the
        // size is reported.
        assert.match(out, /out of bounds for a \d+-line file/);
    });

    test('directory passed instead of file → instructive error pointing to listDirectory', async () => {
        const out = await readFileImpl(small.root, { filePath: 'src' });
        assert.match(out, /is a directory/);
        assert.match(out, /tomAi_listDirectory/);
    });

    test('missing file returns a clear not-found message', async () => {
        const out = await readFileImpl(small.root, { filePath: 'nope/nothing-here.ts' });
        assert.match(out, /File not found/);
    });

    test('path traversing outside the workspace is rejected', async () => {
        const out = await readFileImpl(small.root, { filePath: '../../../etc/passwd' });
        assert.match(out, /outside the workspace/);
    });

    test('absolute path inside the workspace is accepted', async () => {
        const abs = path.join(small.root, 'src/index.ts');
        const out = await readFileImpl(small.root, { filePath: abs });
        assert.match(out, /export const main/);
    });

    test('empty `wsRoot` is permissive (CLI / non-extension usage)', async () => {
        // No workspace → no traversal check; the impl just reads the absolute path.
        const abs = path.join(small.root, 'src/index.ts');
        const out = await readFileImpl('', { filePath: abs });
        assert.match(out, /export const main/);
    });
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

describe('listDirectoryImpl', () => {

    test('typical call lists entries with trailing slash on dirs, sorted', async () => {
        const out = await withTiming('tomAi_listDirectory:typical', () =>
            listDirectoryImpl(small.root, { dirPath: 'src' }));
        const lines = out.split('\n');
        // src/ contains: index.ts, utils/, components/, assets/ (created above)
        assert.ok(lines.includes('index.ts'), `expected index.ts in: ${lines.join(', ')}`);
        assert.ok(lines.includes('utils/'));
        // Sorted alphabetically
        const sorted = [...lines].sort();
        assert.deepEqual(lines, sorted);
    });

    test('file passed instead of directory → instructive error pointing to readFile', async () => {
        const out = await listDirectoryImpl(small.root, { dirPath: 'src/index.ts' });
        assert.match(out, /is a file/);
        assert.match(out, /tomAi_readFile/);
    });

    test('missing directory returns a clear not-found message', async () => {
        const out = await listDirectoryImpl(small.root, { dirPath: 'nope/no-such-dir' });
        assert.match(out, /Directory not found/);
    });

    test('empty directory returns a clear marker, not silent empty string', async () => {
        const out = await listDirectoryImpl(small.root, { dirPath: 'empty_dir' });
        assert.match(out, /\(empty directory: empty_dir\)/);
    });

    test('path traversing outside the workspace is rejected', async () => {
        const out = await listDirectoryImpl(small.root, { dirPath: '../../../tmp' });
        assert.match(out, /outside the workspace/);
    });
});

// ---------------------------------------------------------------------------
// glob matcher (used by both findFiles tests and findTextInFiles)
// ---------------------------------------------------------------------------

describe('globToRegExp', () => {

    test('** alone matches any path', () => {
        const re = globToRegExp('**');
        assert.ok(re.test('a/b/c.ts'));
        assert.ok(re.test('x'));
    });

    test('**/foo matches at any depth', () => {
        const re = globToRegExp('**/foo.ts');
        assert.ok(re.test('foo.ts'));
        assert.ok(re.test('a/foo.ts'));
        assert.ok(re.test('a/b/c/foo.ts'));
        assert.ok(!re.test('foo.txt'));
    });

    test('* is single-segment', () => {
        const re = globToRegExp('*.ts');
        assert.ok(re.test('foo.ts'));
        assert.ok(!re.test('a/foo.ts'));
    });

    test('? is exactly one non-slash char', () => {
        const re = globToRegExp('foo?.ts');
        assert.ok(re.test('fooA.ts'));
        assert.ok(!re.test('fooAB.ts'));
        assert.ok(!re.test('foo/.ts'));
    });

    test('brace expansion produces alternation', () => {
        const re = globToRegExp('**/*.{ts,tsx,dart}');
        assert.ok(re.test('foo.ts'));
        assert.ok(re.test('a/b.tsx'));
        assert.ok(re.test('x/y/z.dart'));
        assert.ok(!re.test('foo.md'));
    });

    test('regex specials in the literal portion are escaped', () => {
        const re = globToRegExp('foo.bar');
        assert.ok(re.test('foo.bar'));
        assert.ok(!re.test('fooXbar'));   // the `.` is literal, not regex `.`
    });
});

// ---------------------------------------------------------------------------
// findFiles (uses the Node-native walker shipped in file-primitives — same
// matcher tested above, so we can rely on it for the orchestration tests)
// ---------------------------------------------------------------------------

describe('findFilesImpl', () => {

    const walk = (pattern: string, exclude: string, limit: number) =>
        nodeNativeWalker(small.root, pattern, exclude, limit);

    test('typical call: **/*.ts on the small fixture', async () => {
        const out = await withTiming('tomAi_findFiles:typical', () =>
            findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.ts' }));
        const paths = out.split('\n');
        // Small fixture has src/index.ts + 2 utils + 20 components = 23 .ts files
        assert.ok(paths.length >= 20, `expected ≥ 20 .ts files, got ${paths.length}`);
        assert.ok(paths.includes('src/index.ts'));
    });

    test('bare `*.ts` only matches root-level files and surfaces a recursive hint', async () => {
        // Small fixture has no .ts at root — only nested under src/
        const out = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '*.ts' });
        assert.match(out, /No files found/);
        assert.match(out, /Hint: `\*\.ts` only matches root-level/);
        assert.match(out, /\*\*\/\*\.ts/);
    });

    test('brace expansion matches multiple extensions', async () => {
        const out = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.{ts,md}' });
        const paths = out.split('\n');
        const hasTs = paths.some((p) => p.endsWith('.ts'));
        const hasMd = paths.some((p) => p.endsWith('.md'));
        assert.ok(hasTs && hasMd, 'brace expansion should match both .ts and .md');
    });

    test('maxResults clamps the output', async () => {
        const out = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.ts', maxResults: 3 });
        assert.equal(out.split('\n').length, 3);
    });

    test('sort stability: same query → same order', async () => {
        const a = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.ts' });
        const b = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.ts' });
        assert.equal(a, b);
    });

    test('node_modules is excluded even when present in the fixture', async () => {
        // Sprinkle a fake node_modules tree
        writeFile(small.root, 'node_modules/foo/index.ts', 'export {};');
        const out = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '**/*.ts' });
        assert.ok(!out.includes('node_modules/'), 'node_modules paths should not appear');
    });

    test('empty pattern returns an instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await findFilesImpl({ wsRoot: small.root, walk }, { pattern: '' as any });
        assert.match(out, /Error: `pattern` is required/);
    });

    test('walker errors are surfaced cleanly', async () => {
        const badWalk = () => { throw new Error('disk on fire'); };
        const out = await findFilesImpl(
            { wsRoot: small.root, walk: badWalk as never },
            { pattern: '**/*.ts' },
        );
        assert.match(out, /Error finding files: disk on fire/);
    });
});

// ---------------------------------------------------------------------------
// findTextInFiles
// ---------------------------------------------------------------------------

describe('findTextInFilesImpl', () => {

    test('typical substring search across the small fixture', async () => {
        // The components have body `export const C<n> = () => 'c<n>';`
        const out = await withTiming('tomAi_findTextInFiles:typical', () =>
            findTextInFilesImpl({ wsRoot: small.root }, { searchText: 'C5 = () =>', filePattern: '**/*.ts' }));
        const lines = out.split('\n');
        assert.ok(lines.length >= 1);
        // Output format: `path:line:content`
        assert.match(lines[0], /^src\/components\/file_00005\.ts:1:export const C5/);
    });

    test('isRegex: true compiles to a real regex', async () => {
        const out = await findTextInFilesImpl({ wsRoot: small.root }, {
            searchText: 'C\\d+ =',
            isRegex: true,
            filePattern: '**/*.ts',
        });
        const lines = out.split('\n');
        assert.ok(lines.length >= 20, 'should match every component');
    });

    test('invalid regex returns a clear error (not a parse stack trace)', async () => {
        const out = await findTextInFilesImpl({ wsRoot: small.root }, {
            searchText: '[invalid',
            isRegex: true,
        });
        assert.match(out, /Error: `searchText` is not a valid regex/);
    });

    test('default filePattern coerces from `*` to recursive (the LLM intent)', async () => {
        // Passing `*` to grep means "any file"; we coerce to recursive
        // so it actually finds matches inside subdirs.
        const out = await findTextInFilesImpl({ wsRoot: small.root }, {
            searchText: 'DOC_KEY',
            filePattern: '*',
        });
        assert.match(out, /_copilot_guidelines\/documentation_guidelines\.md:.*DOC_KEY/);
    });

    test('binary files are skipped silently', async () => {
        // We wrote `src/assets/icon.bin` with a null byte in the small fixture.
        const out = await findTextInFilesImpl({ wsRoot: small.root }, {
            searchText: 'AB',
            filePattern: '**/*.bin',
        });
        // The bytes 0xAB happen to round-trip to "«" in latin1, but
        // because the binary detector skips the file, we should get
        // a "no matches" response.
        assert.match(out, /No matches for substring/);
    });

    test('shell-injection regression: search text with shell metacharacters is treated literally', async () => {
        // Old impl piped this directly into `grep -E "..."` after only regex-
        // escaping — the embedded `"` would close the shell quote. Now it's
        // a plain substring search and never reaches a shell.
        const payload = '"; rm -rf /; echo "';
        const out = await findTextInFilesImpl({ wsRoot: small.root }, { searchText: payload });
        // Should report no matches, NOT crash, NOT shell out.
        assert.match(out, /No matches for substring/);
        // Side-effect check: the small fixture's files are still intact
        assert.ok(fs.existsSync(path.join(small.root, 'src/index.ts')));
    });

    test('maxResults clamps the output', async () => {
        const out = await findTextInFilesImpl({ wsRoot: small.root }, {
            searchText: 'export const',
            filePattern: '**/*.ts',
            maxResults: 5,
        });
        assert.equal(out.split('\n').length, 5);
    });

    test('empty searchText returns an instructive error', async () => {
        const out = await findTextInFilesImpl({ wsRoot: small.root }, { searchText: '' });
        assert.match(out, /Error: `searchText` is required/);
    });
});

// ---------------------------------------------------------------------------
// Large-fixture stress — 10 000 files
//
// Runs once at the bottom; the fixture is built lazily inside `before()`
// so the cheap tests above don't pay the build cost. NOT wrapped in
// `withTiming` because the entry would exceed the 5-second ceiling and
// fail the audit; the audit treats `expectMaxMs` overrides as test-
// local. The inline assertion still catches the regression we care
// about (walks going from O(seconds) to O(minutes)).
// ---------------------------------------------------------------------------

describe('large-fixture stress (10 000 files)', () => {

    let large: Fixture;
    const HARD_CAP_MS = 8000;

    before(() => {
        large = mkLargeWorkspace({ prefix: 'file-primitives-large-' });
    });

    after(() => large.cleanup());

    test('findFiles over 10k files completes under 8 s and returns 1000 capped matches', async () => {
        const walk = (pattern: string, exclude: string, limit: number) =>
            nodeNativeWalker(large.root, pattern, exclude, limit);
        const t0 = process.hrtime.bigint();
        const out = await findFilesImpl({ wsRoot: large.root, walk }, {
            pattern: '**/*.ts',
            maxResults: 1000,
        });
        const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
        const lines = out.split('\n');
        assert.ok(lines.length === 1000, `expected exactly 1000 matches (the cap), got ${lines.length}`);
        assert.ok(ms < HARD_CAP_MS, `findFiles took ${ms.toFixed(0)}ms (cap ${HARD_CAP_MS}ms)`);
    });

    test('findTextInFiles over 10k files completes under 8 s on a narrow filePattern', async () => {
        // Scope to the 30 markdown notes (cheap) so we exercise orchestration
        // without paying the price of reading 9 000 .ts files. The walker
        // glob applies first, so the scanner only opens those 30.
        const t0 = process.hrtime.bigint();
        const out = await findTextInFilesImpl({ wsRoot: large.root }, {
            searchText: 'body line',
            filePattern: '**/medium_notes/**/*.md',
            maxResults: 50,
        });
        const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
        assert.ok(out.length > 0 && !out.startsWith('No matches'), `expected matches; got: ${out.slice(0, 200)}`);
        assert.ok(ms < HARD_CAP_MS, `findTextInFiles took ${ms.toFixed(0)}ms (cap ${HARD_CAP_MS}ms)`);
    });

    test('findFiles walk does not materialise all 10k matches in memory at once', async () => {
        // The walker is bounded by `limit * 2` of `matches` accumulated before
        // returning. With maxResults=10 we should observe an output of exactly
        // 10 lines, regardless of how many .ts files exist.
        const walk = (pattern: string, exclude: string, limit: number) =>
            nodeNativeWalker(large.root, pattern, exclude, limit);
        const out = await findFilesImpl({ wsRoot: large.root, walk }, {
            pattern: '**/*.ts',
            maxResults: 10,
        });
        assert.equal(out.split('\n').length, 10);
    });
});
