/**
 * Tests for the pure path helpers in `tools/guideline-paths.ts`.
 *
 * No vscode dependency — we build a temp workspace on disk and exercise
 * the helpers directly. Mirrors the scenarios that broke the live LLM
 * loop (model passes a full project-style path; helpers must classify
 * and resolve).
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/guideline-paths.test.js
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    GUIDELINE_FOLDER,
    classifyGuidelinePath,
    ensureMdSuffix,
    globalGuidelinesRoot,
    normaliseGuidelineInput,
    projectGuidelinesRoot,
    resolveGuidelineFile,
    searchMarkdown,
    walkMarkdown,
} from '../guideline-paths.js';

// ---------------------------------------------------------------------------
// Shared fixture: a temp workspace with both global and project guidelines.
// ---------------------------------------------------------------------------

let tmp: string;

function w(rel: string): string { return path.join(tmp, rel); }

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guideline-paths-'));
    // Global guidelines
    fs.mkdirSync(w(`${GUIDELINE_FOLDER}/dart`), { recursive: true });
    fs.mkdirSync(w(`${GUIDELINE_FOLDER}/cloud`), { recursive: true });
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/index.md`), '# Index\n\nGlobal guideline index.\n');
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/documentation_guidelines.md`), '# Documentation\n\nKEYWORD_GLOBAL line.\n');
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/dart/coding_guidelines.md`), '# Dart coding\n\nKEYWORD_DART line.\n');
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/cloud/aws.md`), '# AWS\n\nCASE-line.\n');
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/cloud/azure.md`), '# Azure\n\ncase-line.\n');
    // Hidden file should be ignored by walkMarkdown
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/.hidden.md`), '# Hidden\n');
    // Non-md file should be ignored
    fs.writeFileSync(w(`${GUIDELINE_FOLDER}/README.txt`), 'not markdown');

    // Project guidelines — mirrors the real layout the live-trail saw
    fs.mkdirSync(w(`tom_ai/vscode/tom_vscode_extension/${GUIDELINE_FOLDER}`), { recursive: true });
    fs.writeFileSync(
        w(`tom_ai/vscode/tom_vscode_extension/${GUIDELINE_FOLDER}/local_llm.md`),
        '# Local LLM\n\nKEYWORD_LOCAL_LLM line.\n',
    );
    fs.writeFileSync(
        w(`tom_ai/vscode/tom_vscode_extension/${GUIDELINE_FOLDER}/architecture.md`),
        '# Architecture\n\nKEYWORD_ARCH line.\n',
    );
    fs.writeFileSync(
        w(`tom_ai/vscode/tom_vscode_extension/${GUIDELINE_FOLDER}/index.md`),
        '# Project Index\n\nKEYWORD_PROJ_INDEX line.\n',
    );

    // A second project — to test classification against multiple project roots
    fs.mkdirSync(w(`tom_ai/devops/tom_build/${GUIDELINE_FOLDER}`), { recursive: true });
    fs.writeFileSync(
        w(`tom_ai/devops/tom_build/${GUIDELINE_FOLDER}/build_process.md`),
        '# Build\n\nKEYWORD_BUILD line.\n',
    );
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// normaliseGuidelineInput
// ---------------------------------------------------------------------------

describe('normaliseGuidelineInput', () => {
    test('returns empty for falsy input', () => {
        assert.equal(normaliseGuidelineInput(''), '');
        assert.equal(normaliseGuidelineInput('   '), '');
    });
    test('strips leading ./ and slashes', () => {
        assert.equal(normaliseGuidelineInput('./foo/bar'), 'foo/bar');
        assert.equal(normaliseGuidelineInput('/foo/bar'), 'foo/bar');
        assert.equal(normaliseGuidelineInput('////foo/bar'), 'foo/bar');
    });
    test('strips trailing slash', () => {
        assert.equal(normaliseGuidelineInput('foo/bar/'), 'foo/bar');
        assert.equal(normaliseGuidelineInput('foo///'), 'foo');
    });
    test('converts backslashes to forward', () => {
        assert.equal(normaliseGuidelineInput('foo\\bar\\baz'), 'foo/bar/baz');
    });
});

// ---------------------------------------------------------------------------
// ensureMdSuffix
// ---------------------------------------------------------------------------

describe('ensureMdSuffix', () => {
    test('appends .md when missing', () => {
        assert.equal(ensureMdSuffix('foo'), 'foo.md');
    });
    test('keeps .md when present', () => {
        assert.equal(ensureMdSuffix('foo.md'), 'foo.md');
    });
    test('does not touch empty', () => {
        assert.equal(ensureMdSuffix(''), '');
    });
});

// ---------------------------------------------------------------------------
// classifyGuidelinePath
// ---------------------------------------------------------------------------

describe('classifyGuidelinePath', () => {
    test('empty input → global with empty relPath', () => {
        assert.deepEqual(classifyGuidelinePath(''), { kind: 'global', relPath: '' });
    });

    test('bare basename → global', () => {
        assert.deepEqual(classifyGuidelinePath('coding_guidelines.md'), {
            kind: 'global', relPath: 'coding_guidelines.md',
        });
    });

    test('subfolder/basename → global', () => {
        assert.deepEqual(classifyGuidelinePath('dart/coding_guidelines.md'), {
            kind: 'global', relPath: 'dart/coding_guidelines.md',
        });
    });

    test('rooted with _copilot_guidelines/ → global (prefix stripped)', () => {
        assert.deepEqual(classifyGuidelinePath('_copilot_guidelines/coding_guidelines.md'), {
            kind: 'global', relPath: 'coding_guidelines.md',
        });
    });

    test('project-style path → project (split before/after marker)', () => {
        assert.deepEqual(
            classifyGuidelinePath('tom_ai/vscode/tom_vscode_extension/_copilot_guidelines/local_llm.md'),
            { kind: 'project', projectPath: 'tom_ai/vscode/tom_vscode_extension', relPath: 'local_llm.md' },
        );
    });

    test('project-style path with subfolder after marker → project', () => {
        assert.deepEqual(
            classifyGuidelinePath('tom_ai/devops/tom_build/_copilot_guidelines/sub/file.md'),
            { kind: 'project', projectPath: 'tom_ai/devops/tom_build', relPath: 'sub/file.md' },
        );
    });

    test('absolute path with wsRoot prefix is stripped before classification', () => {
        const absInside = '/tmp/work/tom_ai/vscode/_copilot_guidelines/foo.md';
        assert.deepEqual(
            classifyGuidelinePath(absInside, '/tmp/work'),
            { kind: 'project', projectPath: 'tom_ai/vscode', relPath: 'foo.md' },
        );
    });

    test('handles backslashes and leading ./', () => {
        assert.deepEqual(
            classifyGuidelinePath('.\\tom_ai\\vscode\\_copilot_guidelines\\foo.md'),
            { kind: 'project', projectPath: 'tom_ai/vscode', relPath: 'foo.md' },
        );
    });

    test('picks the LAST _copilot_guidelines/ segment when nested', () => {
        assert.deepEqual(
            classifyGuidelinePath('a/_copilot_guidelines/b/_copilot_guidelines/c.md'),
            { kind: 'project', projectPath: 'a/_copilot_guidelines/b', relPath: 'c.md' },
        );
    });
});

// ---------------------------------------------------------------------------
// globalGuidelinesRoot / projectGuidelinesRoot
// ---------------------------------------------------------------------------

describe('globalGuidelinesRoot', () => {
    test('resolves to absolute path when present', () => {
        assert.equal(globalGuidelinesRoot(tmp), path.join(tmp, GUIDELINE_FOLDER));
    });
    test('undefined when wsRoot is undefined', () => {
        assert.equal(globalGuidelinesRoot(undefined), undefined);
    });
    test('undefined when folder missing', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
        try { assert.equal(globalGuidelinesRoot(empty), undefined); }
        finally { fs.rmSync(empty, { recursive: true, force: true }); }
    });
});

describe('projectGuidelinesRoot', () => {
    test('resolves workspace-relative projectPath', () => {
        assert.equal(
            projectGuidelinesRoot(tmp, 'tom_ai/vscode/tom_vscode_extension'),
            path.join(tmp, 'tom_ai/vscode/tom_vscode_extension', GUIDELINE_FOLDER),
        );
    });
    test('resolves absolute projectPath', () => {
        const abs = path.join(tmp, 'tom_ai/devops/tom_build');
        assert.equal(
            projectGuidelinesRoot(tmp, abs),
            path.join(abs, GUIDELINE_FOLDER),
        );
    });
    test('undefined when project guidelines folder missing', () => {
        assert.equal(projectGuidelinesRoot(tmp, 'tom_ai/nonexistent'), undefined);
    });
    test('undefined when projectPath is empty', () => {
        assert.equal(projectGuidelinesRoot(tmp, ''), undefined);
    });
});

// ---------------------------------------------------------------------------
// walkMarkdown
// ---------------------------------------------------------------------------

describe('walkMarkdown', () => {
    test('returns relative paths sorted by their natural order', () => {
        const root = globalGuidelinesRoot(tmp)!;
        const files = walkMarkdown(root, root).map((f) => f.path).sort();
        // Should include index + documentation + 2 cloud + 1 dart = 5
        assert.deepEqual(files, [
            'cloud/aws.md',
            'cloud/azure.md',
            'dart/coding_guidelines.md',
            'documentation_guidelines.md',
            'index.md',
        ]);
    });
    test('skips hidden files', () => {
        const root = globalGuidelinesRoot(tmp)!;
        const files = walkMarkdown(root, root).map((f) => f.path);
        assert.equal(files.includes('.hidden.md'), false);
    });
    test('skips non-md files', () => {
        const root = globalGuidelinesRoot(tmp)!;
        const files = walkMarkdown(root, root).map((f) => f.path);
        assert.equal(files.includes('README.txt'), false);
    });
    test('returns empty array for missing dir', () => {
        assert.deepEqual(walkMarkdown(path.join(tmp, 'nope'), tmp), []);
    });
});

// ---------------------------------------------------------------------------
// resolveGuidelineFile
// ---------------------------------------------------------------------------

describe('resolveGuidelineFile', () => {
    const root = () => globalGuidelinesRoot(tmp)!;

    test('exact relative path (with .md)', () => {
        assert.equal(
            resolveGuidelineFile(root(), 'dart/coding_guidelines.md'),
            path.join(root(), 'dart/coding_guidelines.md'),
        );
    });
    test('exact relative path (without .md)', () => {
        assert.equal(
            resolveGuidelineFile(root(), 'documentation_guidelines'),
            path.join(root(), 'documentation_guidelines.md'),
        );
    });
    test('basename-only fallback', () => {
        // "coding_guidelines" doesn't exist at root but does in dart/
        assert.equal(
            resolveGuidelineFile(root(), 'coding_guidelines'),
            path.join(root(), 'dart/coding_guidelines.md'),
        );
    });
    test('returns undefined for missing file', () => {
        assert.equal(resolveGuidelineFile(root(), 'nonexistent.md'), undefined);
    });
    test('returns undefined for empty relPath', () => {
        assert.equal(resolveGuidelineFile(root(), ''), undefined);
    });
});

// ---------------------------------------------------------------------------
// searchMarkdown
// ---------------------------------------------------------------------------

describe('searchMarkdown', () => {
    const root = () => globalGuidelinesRoot(tmp)!;

    test('finds substring across nested files', () => {
        const matches = searchMarkdown(root(), 'KEYWORD_DART', false, 100);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].file, 'dart/coding_guidelines.md');
        assert.ok(matches[0].text.includes('KEYWORD_DART'));
    });

    test('caseSensitive=false matches both cases', () => {
        const matches = searchMarkdown(root(), 'case-line', false, 100);
        const files = matches.map((m) => m.file).sort();
        assert.deepEqual(files, ['cloud/aws.md', 'cloud/azure.md']);
    });

    test('caseSensitive=true respects case', () => {
        const matches = searchMarkdown(root(), 'case-line', true, 100);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].file, 'cloud/azure.md');
    });

    test('maxMatches caps the result', () => {
        // Both aws.md and azure.md have a case-insensitive match; limit to 1.
        const matches = searchMarkdown(root(), 'case-line', false, 1);
        assert.equal(matches.length, 1);
    });

    test('returns empty for non-matching query', () => {
        assert.deepEqual(searchMarkdown(root(), 'ZZZNOPE', false, 100), []);
    });

    test('matches escape regex metachars (literal substring search)', () => {
        // Write a file with regex metachars to ensure they are treated literally.
        const extra = path.join(root(), 'meta.md');
        fs.writeFileSync(extra, 'has (parens) and *stars*\nplain line\n');
        try {
            const matches = searchMarkdown(root(), '(parens)', false, 100);
            const ours = matches.filter((m) => m.file === 'meta.md');
            assert.equal(ours.length, 1);
            assert.ok(ours[0].text.includes('(parens)'));
        } finally {
            fs.rmSync(extra, { force: true });
        }
    });
});
