/**
 * Tool-impl tests for `diagnostics-tools.ts` — `tomAi_getErrors` and
 * `tomAi_getProblems`.
 *
 * Strategy: synthetic `DiagnosticInfo[]` arrays passed to a fake
 * `DiagnosticsSource`. The tests cover the documented filtering
 * semantics, the inverted-severity scale trap, multi-provider
 * duplication, and the truncation flag — without needing a real
 * vscode runtime.
 *
 * Coverage entry #8 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; the
 *      getErrors-vs-getProblems relationship is documented with a
 *      "prefer the structured variant" pointer.
 *   b) Ambiguities — covered:
 *        - inverted severity enum (Error=0 → Hint=3)
 *        - severity is inclusive minimum (test for each level)
 *        - workspace-wide vs single-file scope
 *        - multi-provider duplication (eslint + ts on the same line)
 *        - getErrors silent-truncation fix
 *   c) Synthetic diagnostics mix of severities + ranges + sources.
 *   d) Timing — both typical cases sub-ms via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    getErrorsImpl,
    getProblemsImpl,
    type DiagnosticInfo,
    type DiagnosticsSource,
} from '../diagnostics-tools.js';

// ---------------------------------------------------------------------------
// Synthetic fixture — a workspace with 8 diagnostics across 3 files,
// mixing severities + sources, including one line with overlapping
// ESLint + TS reports.
// ---------------------------------------------------------------------------

const FIXTURE: DiagnosticInfo[] = [
    {
        file: 'src/a.ts', absolutePath: '/ws/src/a.ts',
        severity: 'error', line: 9, character: 0, endLine: 9, endCharacter: 10,
        message: 'Cannot find name "foo".', source: 'ts', code: 2304,
    },
    {
        file: 'src/a.ts', absolutePath: '/ws/src/a.ts',
        severity: 'warning', line: 14, character: 0, endLine: 14, endCharacter: 5,
        message: 'Unused variable "bar".', source: 'eslint', code: 'no-unused-vars',
    },
    {
        // Multi-provider duplication: same line, two providers report it.
        file: 'src/a.ts', absolutePath: '/ws/src/a.ts',
        severity: 'warning', line: 14, character: 0, endLine: 14, endCharacter: 5,
        message: 'Variable "bar" is declared but never used.', source: 'ts', code: 6133,
    },
    {
        file: 'src/b.ts', absolutePath: '/ws/src/b.ts',
        severity: 'information', line: 0, character: 0, endLine: 0, endCharacter: 0,
        message: 'Consider adding a JSDoc comment.', source: 'ts',
    },
    {
        file: 'src/b.ts', absolutePath: '/ws/src/b.ts',
        severity: 'hint', line: 5, character: 12, endLine: 5, endCharacter: 18,
        message: 'Implicit return type can be inferred.', source: 'ts',
    },
    {
        file: 'src/c.ts', absolutePath: '/ws/src/c.ts',
        severity: 'error', line: 0, character: 0, endLine: 0, endCharacter: 1,
        message: 'Syntax error.', source: 'ts', code: 1005,
    },
    {
        file: 'README.md', absolutePath: '/ws/README.md',
        severity: 'warning', line: 2, character: 0, endLine: 2, endCharacter: 80,
        message: 'Line too long (80 > 79).', source: 'markdownlint',
    },
    {
        file: 'README.md', absolutePath: '/ws/README.md',
        severity: 'error', line: 7, character: 4, endLine: 7, endCharacter: 6,
        message: 'Broken link.', source: 'markdownlint', code: 'MD034',
    },
];

function makeSource(opts: { all?: DiagnosticInfo[]; perFile?: Record<string, DiagnosticInfo[]> } = {}): DiagnosticsSource {
    const all = opts.all ?? FIXTURE;
    return {
        getAll() { return all; },
        getForFile(absPath) {
            if (opts.perFile && absPath in opts.perFile) { return opts.perFile[absPath]; }
            return all.filter((d) => d.absolutePath === absPath);
        },
    };
}

const deps = (source: DiagnosticsSource = makeSource()) => ({ source, wsRoot: '/ws' });

// ===========================================================================
// getErrors — legacy text format
// ===========================================================================

describe('getErrorsImpl', () => {

    test('typical call: returns one line per error/warning, no Information/Hint', async () => {
        const out = await withTiming('tomAi_getErrors:typical', () =>
            getErrorsImpl(deps(), {}));
        const lines = out.split('\n');
        // FIXTURE has 3 errors + 3 warnings = 6 error/warning entries.
        // Information + hint are dropped.
        const realLines = lines.filter((l) => l.trim());
        assert.equal(realLines.length, 6);
        // Severity icons
        assert.ok(out.includes('❌'));
        assert.ok(out.includes('⚠️'));
        // Information and Hint must be absent
        assert.doesNotMatch(out, /JSDoc/);
        assert.doesNotMatch(out, /Implicit return type/);
        // 1-based line numbers (line 9 in fixture → "src/a.ts:10:")
        assert.match(out, /src\/a\.ts:10:/);
    });

    test('returns "No errors or warnings found." on a clean workspace', async () => {
        const out = await getErrorsImpl(deps(makeSource({ all: [] })), {});
        assert.equal(out, 'No errors or warnings found.');
    });

    test('filePath scopes to a single file', async () => {
        const out = await getErrorsImpl(deps(), { filePath: 'src/a.ts' });
        const realLines = out.split('\n').filter((l) => l.trim());
        // a.ts has 1 error + 2 warnings (the duplicate) = 3.
        assert.equal(realLines.length, 3);
        assert.match(out, /src\/a\.ts/);
        assert.doesNotMatch(out, /src\/b\.ts/);
    });

    test('absolute filePath also works', async () => {
        const out = await getErrorsImpl(deps(), { filePath: '/ws/src/c.ts' });
        const realLines = out.split('\n').filter((l) => l.trim());
        assert.equal(realLines.length, 1);
        assert.match(out, /Syntax error/);
    });

    test('SILENT-TRUNCATION FIX: cap at 100 surfaces a clear footer (not silent drop)', async () => {
        const lots: DiagnosticInfo[] = Array.from({ length: 250 }, (_, i) => ({
            file: 'src/x.ts', absolutePath: '/ws/src/x.ts',
            severity: 'error', line: i, character: 0, endLine: i, endCharacter: 1,
            message: `Issue ${i}`, source: 'ts',
        }));
        const out = await getErrorsImpl(deps(makeSource({ all: lots })), {});
        const lines = out.split('\n').filter((l) => l.trim());
        // 100 diag lines + 1 footer
        assert.equal(lines.length, 101);
        assert.match(out, /showing first 100 of 250/);
        assert.match(out, /tomAi_getProblems for the full list/);
    });
});

// ===========================================================================
// getProblems — structured JSON
// ===========================================================================

describe('getProblemsImpl', () => {

    test('typical call returns the full envelope', async () => {
        const raw = await withTiming('tomAi_getProblems:typical', () =>
            getProblemsImpl(deps(), {}));
        const r = JSON.parse(raw);
        assert.equal(r.count, 8);
        assert.equal(r.scanned, 8);
        assert.equal(r.truncated, false);
        assert.equal(r.problems.length, 8);
        // Field shape sanity check
        const first = r.problems[0];
        for (const key of ['file', 'absolutePath', 'severity', 'line', 'character', 'endLine', 'endCharacter', 'message']) {
            assert.ok(key in first, `missing key: ${key}`);
        }
    });

    test('severity: "error" returns ONLY errors (inverted-enum trap test)', async () => {
        // The inverted enum bites here: Error=0, Warning=1.
        // "Minimum severity = error" means "at LEAST as severe as error" = only errors.
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'error' }));
        assert.equal(r.count, 3, 'FIXTURE has 3 errors');
        assert.ok(r.problems.every((p: DiagnosticInfo) => p.severity === 'error'));
    });

    test('severity: "warning" returns errors + warnings', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'warning' }));
        assert.equal(r.count, 6, 'FIXTURE has 3 errors + 3 warnings');
        assert.ok(r.problems.every((p: DiagnosticInfo) => p.severity === 'error' || p.severity === 'warning'));
    });

    test('severity: "information" returns errors + warnings + info', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'information' }));
        assert.equal(r.count, 7);
        assert.ok(r.problems.every((p: DiagnosticInfo) => p.severity !== 'hint'));
    });

    test('severity: "hint" returns everything', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'hint' }));
        assert.equal(r.count, 8);
    });

    test('source filter scopes to one provider (exact match)', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { source: 'eslint' }));
        assert.equal(r.count, 1);
        assert.equal(r.problems[0].source, 'eslint');
    });

    test('source filter preserves multi-provider duplication for matching provider', async () => {
        // The fixture has two warnings on src/a.ts line 14 from eslint and ts.
        // source: 'ts' should return the ts one + every other ts diagnostic.
        const r = JSON.parse(await getProblemsImpl(deps(), { source: 'ts' }));
        const onA14 = r.problems.filter((p: DiagnosticInfo) => p.file === 'src/a.ts' && p.line === 14);
        assert.equal(onA14.length, 1);
        assert.equal(onA14[0].source, 'ts');
    });

    test('multi-provider duplication is preserved without source filter', async () => {
        // The same line 14 gets two diagnostics (one from each provider) —
        // both must appear.
        const r = JSON.parse(await getProblemsImpl(deps(), {}));
        const onA14 = r.problems.filter((p: DiagnosticInfo) => p.file === 'src/a.ts' && p.line === 14);
        assert.equal(onA14.length, 2, 'eslint + ts on the same line → 2 entries');
        const sources = onA14.map((p: DiagnosticInfo) => p.source).sort();
        assert.deepEqual(sources, ['eslint', 'ts']);
    });

    test('filePath scopes to one file', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { filePath: 'src/a.ts' }));
        assert.equal(r.count, 3);
        assert.ok(r.problems.every((p: DiagnosticInfo) => p.file === 'src/a.ts'));
    });

    test('maxResults clamps + truncated: true is set', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), { maxResults: 3 }));
        assert.equal(r.count, 3);
        assert.equal(r.truncated, true);
    });

    test('combined filters: severity + source narrow the set further', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), {
            severity: 'error',
            source: 'markdownlint',
        }));
        assert.equal(r.count, 1);
        assert.equal(r.problems[0].file, 'README.md');
        assert.equal(r.problems[0].message, 'Broken link.');
    });

    test('unknown severity name is ignored (filter does not apply)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'nonsense' as any }));
        assert.equal(r.count, 8, 'unknown severity → no filter applied');
    });

    test('"info" is accepted as an alias for "information"', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await getProblemsImpl(deps(), { severity: 'info' as any }));
        // Returns the same set as severity: information
        assert.equal(r.count, 7);
    });

    test('code field round-trips for both string + numeric codes', async () => {
        const r = JSON.parse(await getProblemsImpl(deps(), {}));
        const tsErr = r.problems.find((p: DiagnosticInfo) => p.source === 'ts' && typeof p.code === 'number');
        const eslintWarn = r.problems.find((p: DiagnosticInfo) => p.source === 'eslint');
        assert.equal(tsErr.code, 2304);
        assert.equal(eslintWarn.code, 'no-unused-vars');
    });
});
