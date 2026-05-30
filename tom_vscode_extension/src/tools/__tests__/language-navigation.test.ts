/**
 * Tool-impl tests for `language-navigation.ts` — `tomAi_findSymbol`,
 * `tomAi_gotoDefinition`, `tomAi_findReferences`.
 *
 * Strategy: the impls take a narrow `LanguageNavigator` dep that
 * returns `SymbolInfo[]` / `LocationInfo[]` (vscode-free); tests
 * pass synthetic results. The 1-based ↔ 0-based conversion at the
 * impl boundary is one of the explicit things being tested, since
 * the entry #1 / #6 / #9 refactors made 1-based the convention
 * everywhere else and this entry brings nav into line.
 *
 * Coverage entry #10 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file (fuzzy match,
 *      1-based positions, overload surfacing, includeDeclaration
 *      semantics, kind filter all spelled out).
 *   b) Ambiguities — covered:
 *        - overloads (gotoDefinition with count > 1 → `note`)
 *        - workspace-wide vs file-scoped (findSymbol is fuzzy + workspace;
 *          documented in the description)
 *        - includeDeclaration: false drops the cursor-position location
 *        - missing file → instructive error
 *        - bad cursor position (line/character missing) → error
 *   c) Tests with fake LanguageNavigator returning known SymbolInfo /
 *      LocationInfo arrays. Both the conversion at the impl boundary
 *      and the response shape are pinned.
 *   d) Timing — all three typical cases sub-ms via `withTiming`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    findReferencesImpl,
    findSymbolImpl,
    gotoDefinitionImpl,
    type LanguageNavigator,
    type LocationInfo,
    type SymbolInfo,
} from '../language-navigation.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures (vscode-native 0-based positions)
// ---------------------------------------------------------------------------

const SAMPLE_SYMBOLS: SymbolInfo[] = [
    { name: 'MyClass', kind: 'Class', containerName: 'src/foo.ts', file: 'src/foo.ts', absolutePath: '/ws/src/foo.ts', line: 9, character: 0 },
    { name: 'myMethod', kind: 'Method', containerName: 'MyClass', file: 'src/foo.ts', absolutePath: '/ws/src/foo.ts', line: 22, character: 4 },
    { name: 'utilFn', kind: 'Function', file: 'src/util.ts', absolutePath: '/ws/src/util.ts', line: 4, character: 0 },
    { name: 'OtherClass', kind: 'Class', file: 'src/other.ts', absolutePath: '/ws/src/other.ts', line: 0, character: 0 },
    { name: 'mockEnum', kind: 'Enum', file: 'src/types.ts', absolutePath: '/ws/src/types.ts', line: 14, character: 0 },
];

const SAMPLE_LOCATIONS: LocationInfo[] = [
    { file: 'src/foo.ts', absolutePath: '/ws/src/foo.ts', startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 7 },
    { file: 'src/foo.ts', absolutePath: '/ws/src/foo.ts', startLine: 30, startCharacter: 12, endLine: 30, endCharacter: 19 },
    { file: 'src/other.ts', absolutePath: '/ws/src/other.ts', startLine: 5, startCharacter: 8, endLine: 5, endCharacter: 15 },
];

// ---------------------------------------------------------------------------
// Fake LanguageNavigator
// ---------------------------------------------------------------------------

interface NavCall {
    method: 'findSymbol' | 'gotoDefinition' | 'findReferences' | 'resolveFile';
    args: unknown[];
}

function makeNav(opts: {
    symbols?: SymbolInfo[];
    definitions?: LocationInfo[];
    references?: LocationInfo[];
    findError?: Error;
    gotoError?: Error;
    refsError?: Error;
    existingFiles?: Set<string>;
} = {}): LanguageNavigator & { calls: NavCall[] } {
    const calls: NavCall[] = [];
    const existing = opts.existingFiles ?? new Set(['/ws/src/foo.ts']);
    return {
        calls,
        resolveFile(filePath) {
            calls.push({ method: 'resolveFile', args: [filePath] });
            // Match the production behaviour: absolute paths pass through;
            // relative paths get joined to /ws (the test workspace root).
            const abs = filePath.startsWith('/') ? filePath : `/ws/${filePath}`;
            return existing.has(abs) ? abs : null;
        },
        async findSymbol(query) {
            calls.push({ method: 'findSymbol', args: [query] });
            if (opts.findError) { throw opts.findError; }
            return opts.symbols ?? SAMPLE_SYMBOLS;
        },
        async gotoDefinition(absPath, line, character) {
            calls.push({ method: 'gotoDefinition', args: [absPath, line, character] });
            if (opts.gotoError) { throw opts.gotoError; }
            return opts.definitions ?? [SAMPLE_LOCATIONS[0]];
        },
        async findReferences(absPath, line, character) {
            calls.push({ method: 'findReferences', args: [absPath, line, character] });
            if (opts.refsError) { throw opts.refsError; }
            return opts.references ?? SAMPLE_LOCATIONS;
        },
    };
}

// ===========================================================================
// findSymbol
// ===========================================================================

describe('findSymbolImpl', () => {

    test('typical call returns the symbol list with totalMatched + 1-based positions', async () => {
        const nav = makeNav();
        const raw = await withTiming('tomAi_findSymbol:typical', () =>
            findSymbolImpl(nav, { query: 'My' }));
        const r = JSON.parse(raw);
        assert.equal(r.query, 'My');
        assert.equal(r.count, 5);
        assert.equal(r.totalMatched, 5);
        assert.equal(r.truncated, false);
        // 1-based conversion: SAMPLE_SYMBOLS[0].line = 9 → 10
        assert.equal(r.symbols[0].line, 10);
        assert.equal(r.symbols[0].character, 1);
        assert.equal(r.symbols[0].kind, 'Class');
    });

    test('kind filter narrows the result (case-insensitive substring)', async () => {
        const nav = makeNav();
        const r = JSON.parse(await findSymbolImpl(nav, { query: 'X', kind: 'class' }));
        assert.equal(r.totalMatched, 2);
        assert.ok(r.symbols.every((s: SymbolInfo) => s.kind === 'Class'));
    });

    test('maxResults clamps + truncated flag fires', async () => {
        const nav = makeNav();
        const r = JSON.parse(await findSymbolImpl(nav, { query: 'X', maxResults: 2 }));
        assert.equal(r.count, 2);
        assert.equal(r.totalMatched, 5);
        assert.equal(r.truncated, true);
    });

    test('missing query → instructive error, no nav call', async () => {
        const nav = makeNav();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await findSymbolImpl(nav, { query: '' as any }));
        assert.match(r.error, /`query` is required/);
        assert.equal(nav.calls.length, 0);
    });

    test('nav error wrapped as error JSON', async () => {
        const nav = makeNav({ findError: new Error('LSP offline') });
        const r = JSON.parse(await findSymbolImpl(nav, { query: 'X' }));
        assert.match(r.error, /Symbol search failed: LSP offline/);
    });

    test('empty symbol list → count 0, totalMatched 0', async () => {
        const nav = makeNav({ symbols: [] });
        const r = JSON.parse(await findSymbolImpl(nav, { query: 'X' }));
        assert.equal(r.count, 0);
        assert.equal(r.totalMatched, 0);
    });
});

// ===========================================================================
// gotoDefinition
// ===========================================================================

describe('gotoDefinitionImpl', () => {

    test('typical call returns one definition with 1-based positions', async () => {
        const nav = makeNav();
        const raw = await withTiming('tomAi_gotoDefinition:typical', () =>
            gotoDefinitionImpl(nav, { filePath: 'src/foo.ts', line: 10, character: 5 }));
        const r = JSON.parse(raw);
        assert.equal(r.count, 1);
        // 0-based 9 → 1-based 10
        assert.equal(r.definitions[0].startLine, 10);
        assert.equal(r.definitions[0].startCharacter, 1);
        assert.equal(r.definitions[0].endLine, 10);
        assert.equal(r.definitions[0].endCharacter, 8);
        // And the dep got called with 0-based (1-based input - 1)
        const gotoCall = nav.calls.find((c) => c.method === 'gotoDefinition');
        assert.deepEqual(gotoCall!.args, ['/ws/src/foo.ts', 9, 4]);
    });

    test('multiple definitions → `note` field flags overloads/ambiguity', async () => {
        const nav = makeNav({ definitions: SAMPLE_LOCATIONS });
        const r = JSON.parse(await gotoDefinitionImpl(nav, { filePath: 'src/foo.ts', line: 10, character: 1 }));
        assert.equal(r.count, 3);
        assert.match(r.note, /3 definitions found/);
        assert.match(r.note, /overloads/);
    });

    test('zero definitions → instructive `note` (not silent empty)', async () => {
        const nav = makeNav({ definitions: [] });
        const r = JSON.parse(await gotoDefinitionImpl(nav, { filePath: 'src/foo.ts', line: 10, character: 1 }));
        assert.equal(r.count, 0);
        assert.match(r.note, /No definition found/);
    });

    test('missing file → not-found error, no nav call', async () => {
        const nav = makeNav({ existingFiles: new Set() });
        const r = JSON.parse(await gotoDefinitionImpl(nav, { filePath: 'no/such.ts', line: 1, character: 1 }));
        assert.match(r.error, /File not found/);
        const gotoCall = nav.calls.find((c) => c.method === 'gotoDefinition');
        assert.equal(gotoCall, undefined);
    });

    test('missing line/character → error', async () => {
        const nav = makeNav();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await gotoDefinitionImpl(nav, { filePath: 'src/foo.ts' } as any));
        assert.match(r.error, /`line` and `character` are required/);
    });

    test('nav error wrapped as error JSON', async () => {
        const nav = makeNav({ gotoError: new Error('LSP timed out') });
        const r = JSON.parse(await gotoDefinitionImpl(nav, { filePath: 'src/foo.ts', line: 1, character: 1 }));
        assert.match(r.error, /Goto definition failed: LSP timed out/);
    });
});

// ===========================================================================
// findReferences
// ===========================================================================

describe('findReferencesImpl', () => {

    test('typical call returns references with 1-based positions + totalMatched', async () => {
        const nav = makeNav();
        const raw = await withTiming('tomAi_findReferences:typical', () =>
            findReferencesImpl(nav, { filePath: 'src/foo.ts', line: 10, character: 1 }));
        const r = JSON.parse(raw);
        assert.equal(r.count, 3);
        assert.equal(r.totalMatched, 3);
        assert.equal(r.includeDeclaration, true);
        // 1-based check
        assert.equal(r.references[0].startLine, 10);
        assert.equal(r.references[0].startCharacter, 1);
    });

    test('includeDeclaration: false drops the location overlapping the cursor', async () => {
        const nav = makeNav();
        // Cursor at 1-based (10, 1) = 0-based (9, 0). SAMPLE_LOCATIONS[0]
        // spans line 9 cols 0-7 → contains the cursor → must be dropped.
        const r = JSON.parse(await findReferencesImpl(nav, {
            filePath: 'src/foo.ts',
            line: 10, character: 1,
            includeDeclaration: false,
        }));
        assert.equal(r.includeDeclaration, false);
        assert.equal(r.count, 2);
        // The two surviving refs must NOT include the foo.ts:9 one.
        assert.ok(r.references.every((l: LocationInfo) => !(l.startLine === 10 && l.startCharacter === 1)));
    });

    test('includeDeclaration: false on a position outside any range leaves everything', async () => {
        const nav = makeNav();
        // Position far from any of the SAMPLE_LOCATIONS — the filter has nothing to drop.
        const r = JSON.parse(await findReferencesImpl(nav, {
            filePath: 'src/foo.ts',
            line: 999, character: 999,
            includeDeclaration: false,
        }));
        assert.equal(r.count, 3);
    });

    test('maxResults clamps + truncated flag', async () => {
        const nav = makeNav();
        const r = JSON.parse(await findReferencesImpl(nav, {
            filePath: 'src/foo.ts', line: 10, character: 1, maxResults: 1,
        }));
        assert.equal(r.count, 1);
        assert.equal(r.totalMatched, 3);
        assert.equal(r.truncated, true);
    });

    test('missing file → not-found error', async () => {
        const nav = makeNav({ existingFiles: new Set() });
        const r = JSON.parse(await findReferencesImpl(nav, { filePath: 'gone.ts', line: 1, character: 1 }));
        assert.match(r.error, /File not found/);
    });

    test('nav error wrapped as error JSON', async () => {
        const nav = makeNav({ refsError: new Error('refs unavailable') });
        const r = JSON.parse(await findReferencesImpl(nav, { filePath: 'src/foo.ts', line: 1, character: 1 }));
        assert.match(r.error, /Find references failed: refs unavailable/);
    });

    test('empty references → count: 0, totalMatched: 0', async () => {
        const nav = makeNav({ references: [] });
        const r = JSON.parse(await findReferencesImpl(nav, { filePath: 'src/foo.ts', line: 1, character: 1 }));
        assert.equal(r.count, 0);
        assert.equal(r.totalMatched, 0);
    });
});
