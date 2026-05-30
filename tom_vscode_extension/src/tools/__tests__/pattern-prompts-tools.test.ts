/**
 * Tool-impl tests for `pattern-prompts-tools.ts` — coverage entry #28.
 *
 *   - tomAi_listPatternPrompts
 *   - tomAi_readPatternPrompt
 *
 * Strategy: an on-disk fixture under `os.tmpdir()` containing both
 * `_copilot_guidelines/pattern_prompts/` AND
 * `_copilot_tomai/pattern_prompts/` so the precedence rule (guidelines
 * masks tomai for same-name prompts) is exercised end-to-end. A
 * `PatternPromptStore` wired to the fixture root drives both impls.
 *
 * Coverage entry #28 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: fallback chain,
 *      first-match-wins, naming convention (`.md` basename →
 *      invocation), accepted name forms (bare / `!`-prefixed /
 *      `.md`-suffixed).
 *   b) Ambiguities closed:
 *        - bare name vs full filename — all three forms tested + the
 *          impl strips them to the same lookup
 *        - **path traversal** through `name: "../escape"` rejected
 *          BEFORE filesystem access (was a real hole — same trap as
 *          guidelines)
 *        - first-match-wins documented + tested with conflict
 *        - missing pattern_prompts folder distinguished from "folder
 *          present but prompt missing"
 *   c) On-disk fixture under `_copilot_guidelines/pattern_prompts/`
 *      AND `_copilot_tomai/pattern_prompts/` per the c-row's ask.
 *   d) Timing — sub-ms per call (small fixture).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';

// `pattern-prompts-tools.ts` imports `vscode` at module top to build
// the live bridge — install the shared stub first.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    listPatternPromptsImpl,
    readPatternPromptImpl,
    type PatternPromptStore,
    type PatternPromptFile,
} from '../pattern-prompts-tools.js';

// ===========================================================================
// On-disk fixture
// ===========================================================================

let tmp: string;
function w(rel: string): string { return path.join(tmp, rel); }
function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(w(rel)), { recursive: true });
    fs.writeFileSync(w(rel), content);
}

const GUIDELINES_DIR = '_copilot_guidelines/pattern_prompts';
const TOMAI_DIR      = '_copilot_tomai/pattern_prompts';

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-prompts-'));

    // _copilot_guidelines/pattern_prompts/
    //   continue.md  — also exists in tomai (guidelines should win)
    //   start.md     — only in guidelines
    //   nested/skip.md — nested file (should be ignored — listFiles is single-level)
    write(`${GUIDELINES_DIR}/continue.md`, '# Continue (guidelines)\n');
    write(`${GUIDELINES_DIR}/start.md`,    '# Start\n');
    write(`${GUIDELINES_DIR}/nested/skip.md`, 'should not be listed\n');
    // Non-md file should be filtered out
    write(`${GUIDELINES_DIR}/notes.txt`, 'not a prompt\n');

    // _copilot_tomai/pattern_prompts/
    //   continue.md  — masked by the guidelines version
    //   commit.md    — only in tomai (fallback)
    write(`${TOMAI_DIR}/continue.md`, '# Continue (tomai)\n');
    write(`${TOMAI_DIR}/commit.md`,   '# Commit\n');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ===========================================================================
// Store backed by the on-disk fixture
// ===========================================================================

function makeStore(): PatternPromptStore {
    return {
        promptDirs() {
            const out: Array<{ absolutePath: string; relativePath: string }> = [];
            for (const sub of [GUIDELINES_DIR, TOMAI_DIR]) {
                const abs = w(sub);
                if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                    out.push({ absolutePath: abs, relativePath: sub });
                }
            }
            return out;
        },
        listFiles(absoluteFolder) {
            const out: PatternPromptFile[] = [];
            for (const e of fs.readdirSync(absoluteFolder, { withFileTypes: true })) {
                if (!e.isFile() || !e.name.endsWith('.md')) { continue; }
                const abs = path.join(absoluteFolder, e.name);
                out.push({
                    absolutePath: abs,
                    relativePath: path.relative(tmp, abs),
                    size: fs.statSync(abs).size,
                });
            }
            return out;
        },
        readFile(absolutePath) {
            if (!fs.existsSync(absolutePath)) { return null; }
            return fs.readFileSync(absolutePath, 'utf8');
        },
    };
}

// ===========================================================================
// `tomAi_listPatternPrompts`
// ===========================================================================

describe('listPatternPromptsImpl', () => {

    test('typical: lists every .md in alphabetical order across both dirs', async () => {
        const store = makeStore();
        const raw = await withTiming('tomAi_listPatternPrompts:typical', () =>
            listPatternPromptsImpl(store, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        // 3 unique: commit (tomai), continue (guidelines wins), start (guidelines)
        assert.equal(r.count, 3);
        assert.deepEqual(r.prompts.map((p: { name: string }) => p.name), ['commit', 'continue', 'start']);
        // Invocation prefix on every entry
        for (const p of r.prompts) { assert.equal(p.invocation, `!${p.name}`); }
        // First-match-wins: continue.md should come from guidelines, not tomai
        const cont = r.prompts.find((p: { name: string }) => p.name === 'continue');
        assert.match(cont.source, /_copilot_guidelines\/pattern_prompts\/continue\.md$/);
    });

    test('non-md files filtered out (notes.txt not listed)', async () => {
        const store = makeStore();
        const r = JSON.parse(await listPatternPromptsImpl(store, {}));
        assert.equal(r.prompts.some((p: { name: string }) => p.name === 'notes'), false);
    });

    test('nested .md files NOT listed (single-level dir scan)', async () => {
        const store = makeStore();
        const r = JSON.parse(await listPatternPromptsImpl(store, {}));
        assert.equal(r.prompts.some((p: { name: string }) => p.name === 'skip'), false);
    });

    test('searchedDirs reports both fallback paths in lookup order', async () => {
        const store = makeStore();
        const r = JSON.parse(await listPatternPromptsImpl(store, {}));
        assert.deepEqual(r.searchedDirs, [GUIDELINES_DIR, TOMAI_DIR]);
    });

    test('size + source surfaced per prompt', async () => {
        const store = makeStore();
        const r = JSON.parse(await listPatternPromptsImpl(store, {}));
        const commit = r.prompts.find((p: { name: string }) => p.name === 'commit');
        assert.ok(commit.size > 0);
        assert.match(commit.source, /commit\.md$/);
    });

    test('no folders found → ok:false with `searched` hint', async () => {
        const empty: PatternPromptStore = {
            promptDirs: () => [],
            listFiles: () => [],
            readFile: () => null,
        };
        const r = JSON.parse(await listPatternPromptsImpl(empty, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /No pattern_prompts folder found/);
        assert.deepEqual(r.searched, [
            '_copilot_guidelines/pattern_prompts',
            '_copilot_tomai/pattern_prompts',
        ]);
    });

    test('store throws on listFiles → ok:false with reason', async () => {
        const broken: PatternPromptStore = {
            promptDirs: () => [{ absolutePath: '/x', relativePath: 'x' }],
            listFiles: () => { throw new Error('EACCES'); },
            readFile: () => null,
        };
        const r = JSON.parse(await listPatternPromptsImpl(broken, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /listPatternPrompts failed: EACCES/);
    });
});

// ===========================================================================
// `tomAi_readPatternPrompt`
// ===========================================================================

describe('readPatternPromptImpl', () => {

    test('typical: bare name reads from guidelines dir', async () => {
        const store = makeStore();
        const raw = await withTiming('tomAi_readPatternPrompt:typical', () =>
            readPatternPromptImpl(store, { name: 'continue' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.name, 'continue');
        assert.equal(r.invocation, '!continue');
        assert.match(r.source, /_copilot_guidelines\/pattern_prompts\/continue\.md$/);
        assert.match(r.content, /Continue \(guidelines\)/);
    });

    test('`!continue` form accepted (strips the bang)', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '!continue' }));
        assert.equal(r.ok, true);
        assert.equal(r.name, 'continue');
    });

    test('`continue.md` form accepted (strips the suffix)', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: 'continue.md' }));
        assert.equal(r.ok, true);
        assert.equal(r.name, 'continue');
    });

    test('`!continue.md` (both) accepted', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '!continue.md' }));
        assert.equal(r.ok, true);
        assert.equal(r.name, 'continue');
    });

    test('fallback: prompt only in tomai dir resolves via the fallback chain', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: 'commit' }));
        assert.equal(r.ok, true);
        assert.match(r.source, /_copilot_tomai\/pattern_prompts\/commit\.md$/);
        assert.match(r.content, /Commit/);
    });

    test('PATH TRAVERSAL: name with ".." rejected BEFORE filesystem access', async () => {
        const store = makeStore();
        // Sanity: this string would have escaped the dir before the fix.
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '../../etc/passwd' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /bare prompt name/);
        assert.equal(r.received, '../../etc/passwd');
    });

    test('PATH TRAVERSAL: forward slash rejected', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: 'sub/x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /bare prompt name/);
    });

    test('PATH TRAVERSAL: backslash rejected', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: 'sub\\x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /bare prompt name/);
    });

    test('PATH TRAVERSAL: bare ".." rejected', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '..' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /bare prompt name/);
    });

    test('not-found: returns ok:false with `searchedDirs` hint', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: 'nonexistent' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Pattern prompt not found: "nonexistent"/);
        assert.match(r.hint, /listPatternPrompts/);
        assert.deepEqual(r.searchedDirs, [GUIDELINES_DIR, TOMAI_DIR]);
    });

    test('empty name rejected', async () => {
        const store = makeStore();
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`name` is required/);
    });

    test('name that normalises to "" rejected', async () => {
        const store = makeStore();
        // "!" alone -> strips to "" -> empty after normalisation
        const r = JSON.parse(await readPatternPromptImpl(store, { name: '!' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /resolves to an empty string|bare prompt name/);
    });

    test('no folders found → ok:false (distinct from "found-but-not-here")', async () => {
        const empty: PatternPromptStore = {
            promptDirs: () => [],
            listFiles: () => [],
            readFile: () => null,
        };
        const r = JSON.parse(await readPatternPromptImpl(empty, { name: 'continue' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /No pattern_prompts folder found/);
    });

    test('store.readFile throws → ok:false with reason', async () => {
        const broken: PatternPromptStore = {
            promptDirs: () => [{ absolutePath: '/x', relativePath: 'x' }],
            listFiles: () => [],
            readFile: () => { throw new Error('EACCES'); },
        };
        const r = JSON.parse(await readPatternPromptImpl(broken, { name: 'continue' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /readPatternPrompt failed: EACCES/);
    });
});
