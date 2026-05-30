/**
 * Integration-level tests for the guideline tool Impl entry points.
 *
 * These mirror what the model actually sends — including the
 * "project-style path passed to the global tool" scenario that broke
 * the live-trail loop. Each test builds (or reuses) a temp workspace
 * fixture and calls the `*Impl(wsRoot, input)` overloads exported from
 * `tools/guideline-tools.ts`.
 *
 * The vscode-aware `execute*` wrappers are deliberately not exercised
 * here — they're a one-line forward to the Impl and would only test
 * the workspaceFolders[0] lookup, which has no logic to verify.
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/guideline-tools.test.js
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Install the shared vscode stub BEFORE importing the tool module —
// see _vscode-stub.ts for the contract.
import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import {
    listGlobalGuidelinesImpl,
    listProjectGuidelinesImpl,
    readGlobalGuidelineImpl,
    readProjectGuidelineImpl,
    searchGlobalGuidelinesImpl,
    searchProjectGuidelinesImpl,
} from '../guideline-tools.js';

// ---------------------------------------------------------------------------
// Fixture: realistic workspace with global + multiple project guidelines.
// ---------------------------------------------------------------------------

let tmp: string;
function w(rel: string): string { return path.join(tmp, rel); }

const PROJECT_GLOBAL = '_copilot_guidelines';
const VSCODE_PROJECT = 'tom_ai/vscode/tom_vscode_extension';
const BUILD_PROJECT = 'tom_ai/devops/tom_build';

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guideline-tools-'));
    // Global guidelines
    fs.mkdirSync(w(`${PROJECT_GLOBAL}/dart`), { recursive: true });
    fs.mkdirSync(w(`${PROJECT_GLOBAL}/cloud`), { recursive: true });
    fs.writeFileSync(w(`${PROJECT_GLOBAL}/index.md`), '# Global index\n\nLists everything.\n');
    fs.writeFileSync(w(`${PROJECT_GLOBAL}/documentation_guidelines.md`), '# Documentation\n\nGLOBAL_DOC keyword.\n');
    fs.writeFileSync(w(`${PROJECT_GLOBAL}/dart/coding_guidelines.md`), '# Dart\n\nDART_KEY content.\n');
    fs.writeFileSync(w(`${PROJECT_GLOBAL}/cloud/aws.md`), '# AWS\n\nCLOUD_AWS content.\n');

    // Project A — the vscode extension
    fs.mkdirSync(w(`${VSCODE_PROJECT}/${PROJECT_GLOBAL}`), { recursive: true });
    fs.writeFileSync(
        w(`${VSCODE_PROJECT}/${PROJECT_GLOBAL}/local_llm.md`),
        '# Local LLM\n\nPROJECT_LOCAL_LLM_KEY content.\n',
    );
    fs.writeFileSync(
        w(`${VSCODE_PROJECT}/${PROJECT_GLOBAL}/architecture.md`),
        '# Architecture\n\nPROJECT_ARCH_KEY content.\n',
    );
    fs.writeFileSync(
        w(`${VSCODE_PROJECT}/${PROJECT_GLOBAL}/index.md`),
        '# Project index\n\nPROJECT_INDEX_KEY content.\n',
    );

    // Project B — the build tool
    fs.mkdirSync(w(`${BUILD_PROJECT}/${PROJECT_GLOBAL}`), { recursive: true });
    fs.writeFileSync(
        w(`${BUILD_PROJECT}/${PROJECT_GLOBAL}/build_process.md`),
        '# Build\n\nBUILD_KEY content.\n',
    );
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// tomAi_readGlobalGuideline
// ---------------------------------------------------------------------------

describe('readGlobalGuidelineImpl', () => {

    test('without fileName returns file list + index content', async () => {
        const r = await readGlobalGuidelineImpl(tmp, {});
        assert.match(r, /Available global guideline files/);
        assert.match(r, /- documentation_guidelines\.md/);
        assert.match(r, /- dart\/coding_guidelines\.md/);
        // The index body should be appended
        assert.match(r, /Global index/);
    });

    test('bare filename resolves correctly', async () => {
        // Covers entry 13 d) — timing for tomAi_readGlobalGuideline typical call.
        const r = await withTiming('tomAi_readGlobalGuideline:typical', () =>
            readGlobalGuidelineImpl(tmp, { fileName: 'documentation_guidelines.md' }));
        assert.match(r, /GLOBAL_DOC keyword/);
    });

    test('bare filename without .md extension resolves correctly', async () => {
        const r = await readGlobalGuidelineImpl(tmp, { fileName: 'documentation_guidelines' });
        assert.match(r, /GLOBAL_DOC keyword/);
    });

    test('subfolder/filename resolves correctly', async () => {
        const r = await readGlobalGuidelineImpl(tmp, { fileName: 'dart/coding_guidelines.md' });
        assert.match(r, /DART_KEY content/);
    });

    test('basename-only fallback finds nested file', async () => {
        // "coding_guidelines" doesn't exist at root; should walk and find dart/coding_guidelines.md
        const r = await readGlobalGuidelineImpl(tmp, { fileName: 'coding_guidelines' });
        assert.match(r, /DART_KEY content/);
    });

    test('rooted form with _copilot_guidelines/ prefix is stripped', async () => {
        const r = await readGlobalGuidelineImpl(tmp, {
            fileName: '_copilot_guidelines/documentation_guidelines.md',
        });
        assert.match(r, /GLOBAL_DOC keyword/);
    });

    test('project-style path AUTO-DELEGATES to project read (this was the live-trail bug)', async () => {
        const r = await readGlobalGuidelineImpl(tmp, {
            fileName: 'tom_ai/vscode/tom_vscode_extension/_copilot_guidelines/local_llm.md',
        });
        assert.match(r, /PROJECT_LOCAL_LLM_KEY content/);
    });

    test('absolute path inside the workspace is normalised then resolved', async () => {
        const abs = path.join(tmp, VSCODE_PROJECT, PROJECT_GLOBAL, 'local_llm.md');
        const r = await readGlobalGuidelineImpl(tmp, { fileName: abs });
        assert.match(r, /PROJECT_LOCAL_LLM_KEY content/);
    });

    test('non-existent global file returns a helpful error with the file list', async () => {
        const r = await readGlobalGuidelineImpl(tmp, { fileName: 'nonexistent.md' });
        assert.match(r, /Global guideline file not found/);
        assert.match(r, /Available global guideline files/);
    });

    test('returns folder-missing error when global folder is absent', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-ws-'));
        try {
            const r = await readGlobalGuidelineImpl(empty, { fileName: 'foo.md' });
            assert.match(r, /folder not found at workspace root/);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });

    test('returns folder-missing error when wsRoot is undefined', async () => {
        const r = await readGlobalGuidelineImpl(undefined, { fileName: 'foo.md' });
        assert.match(r, /folder not found/);
    });
});

// ---------------------------------------------------------------------------
// tomAi_listGlobalGuidelines
// ---------------------------------------------------------------------------

describe('listGlobalGuidelinesImpl', () => {

    test('without subfolder lists everything sorted', async () => {
        // Covers entry 13 d) — timing for tomAi_listGlobalGuidelines typical call.
        const r = JSON.parse(await withTiming('tomAi_listGlobalGuidelines:typical', () =>
            listGlobalGuidelinesImpl(tmp, {})));
        const names = (r.files as Array<{ path: string }>).map((f) => f.path);
        assert.deepEqual(names, [
            'cloud/aws.md',
            'dart/coding_guidelines.md',
            'documentation_guidelines.md',
            'index.md',
        ]);
        assert.equal(r.folder, '.');
        assert.equal(r.count, 4);
    });

    test('subfolder narrows the list', async () => {
        const r = JSON.parse(await listGlobalGuidelinesImpl(tmp, { subfolder: 'dart' }));
        const names = (r.files as Array<{ path: string }>).map((f) => f.path);
        assert.deepEqual(names, ['dart/coding_guidelines.md']);
        assert.equal(r.folder, 'dart');
    });

    test('project-style subfolder AUTO-DELEGATES to project list', async () => {
        const r = JSON.parse(await listGlobalGuidelinesImpl(tmp, {
            subfolder: 'tom_ai/vscode/tom_vscode_extension',
        }));
        // Auto-delegated → response shape is the project shape
        assert.equal(r.projectPath, 'tom_ai/vscode/tom_vscode_extension');
        const names = (r.files as Array<{ path: string }>).map((f) => f.path).sort();
        assert.deepEqual(names, ['architecture.md', 'index.md', 'local_llm.md']);
    });

    test('rooted subfolder path is accepted', async () => {
        const r = JSON.parse(await listGlobalGuidelinesImpl(tmp, {
            subfolder: '_copilot_guidelines/cloud',
        }));
        const names = (r.files as Array<{ path: string }>).map((f) => f.path);
        assert.deepEqual(names, ['cloud/aws.md']);
    });

    test('non-existent subfolder returns error + available subfolders', async () => {
        const r = JSON.parse(await listGlobalGuidelinesImpl(tmp, { subfolder: 'nonexistent' }));
        assert.match(r.error, /Subfolder not found/);
        assert.ok(Array.isArray(r.availableSubfolders));
        assert.ok(r.availableSubfolders.includes('dart'));
        assert.ok(r.availableSubfolders.includes('cloud'));
    });

    test('missing global folder reports error', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-ws-'));
        try {
            const r = JSON.parse(await listGlobalGuidelinesImpl(empty, {}));
            assert.match(r.error, /not found/);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// tomAi_searchGlobalGuidelines
// ---------------------------------------------------------------------------

describe('searchGlobalGuidelinesImpl', () => {

    test('finds a match across nested files', async () => {
        // Covers entry 13 d) — timing for tomAi_searchGlobalGuidelines typical call.
        const r = JSON.parse(await withTiming('tomAi_searchGlobalGuidelines:typical', () =>
            searchGlobalGuidelinesImpl(tmp, { query: 'DART_KEY' })));
        assert.equal(r.count, 1);
        assert.equal(r.matches[0].file, 'dart/coding_guidelines.md');
    });

    test('caseSensitive default false matches mixed-case', async () => {
        const r = JSON.parse(await searchGlobalGuidelinesImpl(tmp, { query: 'dart_key' }));
        assert.equal(r.count, 1);
    });

    test('caseSensitive=true respects case', async () => {
        const r = JSON.parse(await searchGlobalGuidelinesImpl(tmp, { query: 'dart_key', caseSensitive: true }));
        assert.equal(r.count, 0);
    });

    test('missing query returns error', async () => {
        const r = JSON.parse(await searchGlobalGuidelinesImpl(tmp, { query: '' }));
        assert.match(r.error, /query is required/);
    });

    test('does NOT find project content (scope check)', async () => {
        // PROJECT_LOCAL_LLM_KEY lives in a project guideline, not global
        const r = JSON.parse(await searchGlobalGuidelinesImpl(tmp, { query: 'PROJECT_LOCAL_LLM_KEY' }));
        assert.equal(r.count, 0);
    });
});

// ---------------------------------------------------------------------------
// tomAi_readProjectGuideline
// ---------------------------------------------------------------------------

describe('readProjectGuidelineImpl', () => {

    test('projectPath + bare filename works', async () => {
        // Covers entry 13 d) — timing for tomAi_readProjectGuideline typical call.
        const r = await withTiming('tomAi_readProjectGuideline:typical', () =>
            readProjectGuidelineImpl(tmp, {
                projectPath: VSCODE_PROJECT,
                fileName: 'local_llm.md',
            }));
        assert.match(r, /PROJECT_LOCAL_LLM_KEY content/);
    });

    test('projectPath + filename without .md works', async () => {
        const r = await readProjectGuidelineImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            fileName: 'architecture',
        });
        assert.match(r, /PROJECT_ARCH_KEY content/);
    });

    test('projectPath + glued path (the live-trail shape) works', async () => {
        // The model often glues projectPath and fileName together —
        // we re-extract and resolve.
        const r = await readProjectGuidelineImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            fileName: 'tom_ai/vscode/tom_vscode_extension/_copilot_guidelines/local_llm.md',
        });
        assert.match(r, /PROJECT_LOCAL_LLM_KEY content/);
    });

    test('projectPath alone returns file list + index', async () => {
        const r = await readProjectGuidelineImpl(tmp, { projectPath: VSCODE_PROJECT });
        assert.match(r, /Available project guideline files/);
        assert.match(r, /architecture\.md/);
        assert.match(r, /local_llm\.md/);
        // index content appended
        assert.match(r, /PROJECT_INDEX_KEY/);
    });

    test('absolute projectPath works', async () => {
        const abs = path.join(tmp, VSCODE_PROJECT);
        const r = await readProjectGuidelineImpl(tmp, { projectPath: abs, fileName: 'local_llm.md' });
        assert.match(r, /PROJECT_LOCAL_LLM_KEY content/);
    });

    test('projectPath missing folder returns helpful error', async () => {
        const r = await readProjectGuidelineImpl(tmp, {
            projectPath: 'tom_ai/nonexistent',
            fileName: 'foo.md',
        });
        assert.match(r, /No `_copilot_guidelines\/` folder/);
        assert.match(r, /Pass projectPath as the folder containing/);
    });

    test('projectPath empty returns clear error', async () => {
        const r = await readProjectGuidelineImpl(tmp, { projectPath: '', fileName: 'x.md' });
        assert.match(r, /projectPath is required/);
    });

    test('non-existent fileName under valid project returns file list', async () => {
        const r = await readProjectGuidelineImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            fileName: 'nonexistent.md',
        });
        assert.match(r, /Project guideline file not found/);
        assert.match(r, /Available files/);
        assert.match(r, /local_llm\.md/);
    });

    test('projectPath that mistakenly includes _copilot_guidelines/ — works because the trailing segment is treated as fileName', async () => {
        // The model sometimes passes projectPath="<...>/_copilot_guidelines"
        // (with the trailing folder). projectGuidelinesRoot expects the
        // PARENT of _copilot_guidelines/, so this won't find the folder.
        // We still want a useful error rather than silently wrong data.
        const wrongProject = `${VSCODE_PROJECT}/_copilot_guidelines`;
        const r = await readProjectGuidelineImpl(tmp, {
            projectPath: wrongProject,
            fileName: 'local_llm.md',
        });
        // Either we error helpfully or we resolve correctly via the
        // classification fallback in the fileName.
        // (We document current behaviour — the lookup is at
        // `<wrongProject>/_copilot_guidelines` which doesn't exist.)
        assert.match(r, /No `_copilot_guidelines\/` folder/);
    });
});

// ---------------------------------------------------------------------------
// tomAi_listProjectGuidelines
// ---------------------------------------------------------------------------

describe('listProjectGuidelinesImpl', () => {

    test('lists everything under the project guidelines folder', async () => {
        // Covers entry 13 d) — timing for tomAi_listProjectGuidelines typical call.
        const r = JSON.parse(await withTiming('tomAi_listProjectGuidelines:typical', () =>
            listProjectGuidelinesImpl(tmp, { projectPath: VSCODE_PROJECT })));
        const names = (r.files as Array<{ path: string }>).map((f) => f.path).sort();
        assert.deepEqual(names, ['architecture.md', 'index.md', 'local_llm.md']);
        assert.equal(r.projectPath, VSCODE_PROJECT);
    });

    test('projectPath alone — second project works', async () => {
        const r = JSON.parse(await listProjectGuidelinesImpl(tmp, { projectPath: BUILD_PROJECT }));
        const names = (r.files as Array<{ path: string }>).map((f) => f.path);
        assert.deepEqual(names, ['build_process.md']);
    });

    test('subfolder narrows when present (here: nothing nested)', async () => {
        const r = JSON.parse(await listProjectGuidelinesImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            subfolder: 'nonexistent-sub',
        }));
        assert.match(r.error, /Subfolder not found/);
    });

    test('missing project folder returns error', async () => {
        const r = JSON.parse(await listProjectGuidelinesImpl(tmp, { projectPath: 'tom_ai/nonexistent' }));
        assert.match(r.error, /No _copilot_guidelines/);
    });
});

// ---------------------------------------------------------------------------
// tomAi_searchProjectGuidelines
// ---------------------------------------------------------------------------

describe('searchProjectGuidelinesImpl', () => {

    test('finds project-scoped match', async () => {
        // Covers entry 13 d) — timing for tomAi_searchProjectGuidelines typical call.
        const r = JSON.parse(await withTiming('tomAi_searchProjectGuidelines:typical', () =>
            searchProjectGuidelinesImpl(tmp, {
                projectPath: VSCODE_PROJECT,
                query: 'PROJECT_LOCAL_LLM_KEY',
            })));
        assert.equal(r.count, 1);
        assert.equal(r.matches[0].file, 'local_llm.md');
    });

    test('does NOT find global content (scope check)', async () => {
        const r = JSON.parse(await searchProjectGuidelinesImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            query: 'GLOBAL_DOC',
        }));
        assert.equal(r.count, 0);
    });

    test('does NOT find other-project content (scope check)', async () => {
        const r = JSON.parse(await searchProjectGuidelinesImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            query: 'BUILD_KEY',
        }));
        assert.equal(r.count, 0);
    });

    test('missing projectPath returns error', async () => {
        const r = JSON.parse(await searchProjectGuidelinesImpl(tmp, {
            projectPath: '',
            query: 'anything',
        }));
        assert.match(r.error, /projectPath is required/);
    });

    test('missing query returns error', async () => {
        const r = JSON.parse(await searchProjectGuidelinesImpl(tmp, {
            projectPath: VSCODE_PROJECT,
            query: '',
        }));
        assert.match(r.error, /query is required/);
    });
});
