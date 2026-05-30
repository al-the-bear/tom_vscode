/**
 * Tool-impl tests for `quest-introspection-tools.ts` — the 4 quest /
 * project introspection tools (coverage entry #23):
 *
 *   - tomAi_getActiveQuest
 *   - tomAi_listQuests
 *   - tomAi_listProjects
 *   - tomAi_listDocuments
 *
 * Strategy: a real on-disk fixture under `os.tmpdir()` holding the
 * coverage doc's required shape — **2 quests + 3 projects** plus a
 * realistic spread of category folders (prompts, answers, notes,
 * roles, guidelines) so `listDocuments` can be exercised against each
 * one. Real `fs` walks keep the test honest about path-traversal +
 * "recursive returns every file" semantics; the only fake is a
 * single-line `getActiveQuestId()` so different active-quest scenarios
 * can be swapped without rewriting the workspace file.
 *
 * Coverage entry #23 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; discovery
 *      mechanism (workspace-file basename, _ai/quests/* walk,
 *      tom_master.yaml) is spelled out; what counts as a "project"
 *      (one YAML array entry) is spelled out.
 *   b) Ambiguities — covered explicitly:
 *        - quest id format: free-form, whatever the folder is named
 *        - project path format: workspace-relative, verbatim from YAML
 *        - listDocuments returns ALL files (not only .md)
 *        - listDocuments subPath traversal hole CLOSED
 *        - getActiveQuest returns `active: null` vs `rawId` so the
 *          model can diagnose "workspace open but quest folder missing"
 *   c) Fixture: 2 quests (`alpha`, `beta`) + 3 projects (`tom_basics`,
 *      `tom_core_kernel`, `vscode-extension`).
 *   d) Timing — sub-ms per call (no network).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';
import {
    getActiveQuestImpl,
    listQuestsImpl,
    listProjectsImpl,
    listDocumentsImpl,
    type QuestSource,
    type ProjectSource,
    type DocumentSource,
    type DocumentCategory,
    type ProjectInfo,
} from '../quest-introspection-tools.js';

// ===========================================================================
// On-disk fixture — 2 quests + 3 projects + 5 category folders
// ===========================================================================

let tmp: string;
function w(rel: string): string { return path.join(tmp, rel); }
function write(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(w(rel)), { recursive: true });
    fs.writeFileSync(w(rel), content);
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-introspection-'));

    // -- Quests --------------------------------------------------------------
    // alpha — has overview, 1 todo file
    write('_ai/quests/alpha/overview.alpha.md', '# Alpha\n');
    write('_ai/quests/alpha/todos.alpha.todo.yaml', 'todos: []\n');
    // beta — NO overview, 2 todo files
    write('_ai/quests/beta/notes.md', 'random notes\n');
    write('_ai/quests/beta/todos.beta.todo.yaml', 'todos: []\n');
    write('_ai/quests/beta/extra.beta.todo.yaml', 'todos: []\n');

    // -- Projects (tom_master.yaml) ------------------------------------------
    const masterYaml = [
        'projects:',
        '  - id: tom_basics',
        '    name: Tom Basics',
        '    path: tom_ai/basics/tom_basics',
        '    type: dart-package',
        '  - id: tom_core_kernel',
        '    name: Tom Core Kernel',
        '    path: tom_ai/core/tom_core_kernel',
        '    type: dart-package',
        '  - id: vscode-extension',
        '    name: VS Code Extension',
        '    path: tom_ai/vscode/tom_vscode_extension',
        '    type: typescript',
        '',
    ].join('\n');
    write('.tom_metadata/tom_master.yaml', masterYaml);

    // -- Document categories -------------------------------------------------
    // prompts (recursive)
    write('_ai/prompt/start.md', '# start\n');
    write('_ai/prompt/templates/quest.md', '# template\n');
    write('_ai/prompt/.hidden.md', 'should be skipped\n');
    // answers
    write('_ai/answers/copilot/2026/jan/answer1.md', 'a1\n');
    // notes
    write('_ai/notes/note1.md', 'n1\n');
    write('_ai/notes/note2.md', 'n2\n');
    // roles
    write('_ai/roles/architect.md', 'role\n');
    // guidelines
    write('_copilot_guidelines/dart/coding.md', 'guideline\n');
    write('_copilot_guidelines/index.md', 'index\n');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ===========================================================================
// Source factories backed by the on-disk fixture
// ===========================================================================

function questSourceFor(activeId: string): QuestSource {
    return {
        getActiveQuestId: () => activeId,
        questFolderExists: (id) => fs.existsSync(w(`_ai/quests/${id}`)),
        listQuestIds: () => {
            const dir = w('_ai/quests');
            if (!fs.existsSync(dir)) { return []; }
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter((d) => d.isDirectory()).map((d) => d.name).sort();
        },
        hasOverviewFile: (id) => fs.existsSync(w(`_ai/quests/${id}/overview.${id}.md`)),
        listTodoFiles: (id) => {
            const dir = w(`_ai/quests/${id}`);
            if (!fs.existsSync(dir)) { return []; }
            return fs.readdirSync(dir).filter((f) => f.endsWith('.todo.yaml')).sort();
        },
        questFolderRelative: (id) => `_ai/quests/${id}`,
    };
}

const projectSource: ProjectSource = {
    readProjects(): { found: boolean; masterPath: string; projects: ProjectInfo[] } {
        const masterPath = w('.tom_metadata/tom_master.yaml');
        if (!fs.existsSync(masterPath)) { return { found: false, masterPath, projects: [] }; }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yaml = require('yaml');
        const doc = yaml.parse(fs.readFileSync(masterPath, 'utf8')) as { projects?: unknown[] };
        const projects: ProjectInfo[] = [];
        if (doc?.projects && Array.isArray(doc.projects)) {
            for (const raw of doc.projects) {
                const p = raw as { id?: string; name?: string; path?: string; type?: string };
                projects.push({
                    id: p.id || p.name || '',
                    name: p.name || p.id || '',
                    path: p.path || '',
                    type: p.type || undefined,
                });
            }
        }
        return { found: true, masterPath, projects };
    },
};

const documentSource: DocumentSource = {
    resolveCategoryFolder(category: DocumentCategory) {
        const map: Record<DocumentCategory, string> = {
            prompts:    '_ai/prompt',
            answers:    '_ai/answers/copilot',
            notes:      '_ai/notes',
            roles:      '_ai/roles',
            guidelines: '_copilot_guidelines',
        };
        return { absolute: w(map[category]), relative: map[category] };
    },
    listFilesRecursive(absoluteFolder: string) {
        if (!fs.existsSync(absoluteFolder)) { return { exists: false, files: [] }; }
        const out: string[] = [];
        function walk(dir: string, prefix: string): void {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name.startsWith('.')) { continue; }
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.isDirectory()) { walk(path.join(dir, e.name), rel); }
                else { out.push(rel); }
            }
        }
        walk(absoluteFolder, '');
        return { exists: true, files: out.sort() };
    },
};

// ===========================================================================
// `tomAi_getActiveQuest`
// ===========================================================================

describe('getActiveQuestImpl', () => {

    test('typical: existing quest → active = quest id, source = workspace_file', async () => {
        const raw = await withTiming('tomAi_getActiveQuest:typical', () =>
            getActiveQuestImpl(questSourceFor('alpha'), {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.active, 'alpha');
        assert.equal(r.rawId, 'alpha');
        assert.equal(r.questFolderExists, true);
        assert.equal(r.questFolder, '_ai/quests/alpha');
        assert.equal(r.source, 'workspace_file');
    });

    test('"default" filename → active: null, rawId: "default"', async () => {
        const r = JSON.parse(await getActiveQuestImpl(questSourceFor('default'), {}));
        assert.equal(r.active, null);
        assert.equal(r.rawId, 'default');
        assert.equal(r.questFolderExists, false);
        assert.equal(r.questFolder, null);
    });

    test('workspace open but quest folder missing → active: null, questFolderExists: false', async () => {
        // distinguishable from the "default" case via rawId
        const r = JSON.parse(await getActiveQuestImpl(questSourceFor('ghost_quest'), {}));
        assert.equal(r.active, null);
        assert.equal(r.rawId, 'ghost_quest');
        assert.equal(r.questFolderExists, false);
        assert.equal(r.questFolder, '_ai/quests/ghost_quest');
    });
});

// ===========================================================================
// `tomAi_listQuests`
// ===========================================================================

describe('listQuestsImpl', () => {

    test('typical: no enrichment returns plain id list (alphabetical)', async () => {
        const raw = await withTiming('tomAi_listQuests:typical', () =>
            listQuestsImpl(questSourceFor('alpha'), {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.discoveredFrom, '_ai/quests/*');
        assert.equal(r.count, 2);
        assert.deepEqual(r.quests, ['alpha', 'beta']);
    });

    test('includeOverview: each entry → {id, overviewFile, todoFileCount}', async () => {
        const r = JSON.parse(await listQuestsImpl(questSourceFor('alpha'), { includeOverview: true }));
        assert.equal(r.count, 2);
        assert.deepEqual(r.quests, [
            { id: 'alpha', overviewFile: 'overview.alpha.md', todoFileCount: 1 },
            { id: 'beta',  overviewFile: null,                todoFileCount: 2 },
        ]);
    });

    test('empty workspace → count: 0, quests: []', async () => {
        const empty: QuestSource = {
            ...questSourceFor('default'),
            listQuestIds: () => [],
        };
        const r = JSON.parse(await listQuestsImpl(empty, {}));
        assert.equal(r.count, 0);
        assert.deepEqual(r.quests, []);
    });
});

// ===========================================================================
// `tomAi_listProjects`
// ===========================================================================

describe('listProjectsImpl', () => {

    test('typical: reads all 3 projects from tom_master.yaml', async () => {
        const raw = await withTiming('tomAi_listProjects:typical', () =>
            listProjectsImpl(projectSource, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.discoveredFrom, '.tom_metadata/tom_master.yaml');
        assert.equal(r.count, 3);
        assert.deepEqual(
            r.projects.map((p: ProjectInfo) => p.id).sort(),
            ['tom_basics', 'tom_core_kernel', 'vscode-extension'],
        );
        // Path format preserved verbatim from YAML (workspace-relative).
        const basics = r.projects.find((p: ProjectInfo) => p.id === 'tom_basics');
        assert.equal(basics.path, 'tom_ai/basics/tom_basics');
        assert.equal(basics.name, 'Tom Basics');
        assert.equal(basics.type, 'dart-package');
    });

    test('tom_master.yaml missing → ok: false with diagnostic envelope', async () => {
        const missing: ProjectSource = {
            readProjects: () => ({ found: false, masterPath: '/nope/tom_master.yaml', projects: [] }),
        };
        const r = JSON.parse(await listProjectsImpl(missing, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /tom_master.yaml not found/);
        assert.equal(r.masterPath, '/nope/tom_master.yaml');
        assert.deepEqual(r.projects, []);
    });

    test('id/name fallback: only `name` present → id falls back to name', async () => {
        const partial: ProjectSource = {
            readProjects: () => ({
                found: true,
                masterPath: '/x/tom_master.yaml',
                projects: [{ id: 'nameonly', name: 'nameonly', path: 'p', type: undefined }],
            }),
        };
        const r = JSON.parse(await listProjectsImpl(partial, {}));
        assert.equal(r.projects[0].id, 'nameonly');
        assert.equal(r.projects[0].name, 'nameonly');
    });
});

// ===========================================================================
// `tomAi_listDocuments`
// ===========================================================================

describe('listDocumentsImpl', () => {

    test('typical: guidelines category returns all .md files (recursive, alphabetical)', async () => {
        const raw = await withTiming('tomAi_listDocuments:typical', () =>
            listDocumentsImpl(documentSource, { category: 'guidelines' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.category, 'guidelines');
        assert.equal(r.categoryFolder, '_copilot_guidelines');
        assert.equal(r.exists, true);
        assert.deepEqual(r.files, ['dart/coding.md', 'index.md']);
    });

    test('each of the 5 categories resolves to the correct workspace-relative folder', async () => {
        const expectations: Record<DocumentCategory, string> = {
            prompts:    '_ai/prompt',
            answers:    '_ai/answers/copilot',
            notes:      '_ai/notes',
            roles:      '_ai/roles',
            guidelines: '_copilot_guidelines',
        };
        for (const cat of Object.keys(expectations) as DocumentCategory[]) {
            const r = JSON.parse(await listDocumentsImpl(documentSource, { category: cat }));
            assert.equal(r.categoryFolder, expectations[cat], `category ${cat}`);
            assert.equal(r.exists, true, `category ${cat} folder should exist in fixture`);
        }
    });

    test('hidden files are skipped (`.hidden.md` not in result)', async () => {
        const r = JSON.parse(await listDocumentsImpl(documentSource, { category: 'prompts' }));
        // Fixture wrote start.md + templates/quest.md + .hidden.md
        assert.deepEqual(r.files, ['start.md', 'templates/quest.md']);
    });

    test('recursive walk: nested folders surface as posix paths', async () => {
        const r = JSON.parse(await listDocumentsImpl(documentSource, { category: 'answers' }));
        assert.deepEqual(r.files, ['2026/jan/answer1.md']);
    });

    test('subPath narrows the walk (no traversal)', async () => {
        const r = JSON.parse(await listDocumentsImpl(documentSource, {
            category: 'prompts', subPath: 'templates',
        }));
        assert.equal(r.resolvedFolder, '_ai/prompt/templates');
        assert.deepEqual(r.files, ['quest.md']);
    });

    test('subPath traversal REJECTED: "../" → ok: false', async () => {
        const r = JSON.parse(await listDocumentsImpl(documentSource, {
            category: 'prompts', subPath: '../answers',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /traversal rejected/);
        assert.equal(r.subPath, '../answers');
    });

    test('subPath absolute path REJECTED', async () => {
        const r = JSON.parse(await listDocumentsImpl(documentSource, {
            category: 'prompts', subPath: '/etc',
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /traversal rejected/);
    });

    test('missing category folder → ok: true with exists: false', async () => {
        const noFolder: DocumentSource = {
            resolveCategoryFolder: () => ({ absolute: '/nope', relative: '_ai/notes' }),
            listFilesRecursive: () => ({ exists: false, files: [] }),
        };
        const r = JSON.parse(await listDocumentsImpl(noFolder, { category: 'notes' }));
        assert.equal(r.ok, true);
        assert.equal(r.exists, false);
        assert.equal(r.fileCount, 0);
        assert.deepEqual(r.files, []);
    });

    test('workspace not open → ok: false', async () => {
        const closed: DocumentSource = {
            resolveCategoryFolder: () => undefined,
            listFilesRecursive: () => ({ exists: false, files: [] }),
        };
        const r = JSON.parse(await listDocumentsImpl(closed, { category: 'notes' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Workspace not open/);
    });
});
