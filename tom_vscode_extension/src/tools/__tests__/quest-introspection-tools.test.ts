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
 * smallest shape that tells the tools apart — **2 quests + 3 projects** plus a
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
 *      `buildkit :projects --json`) is spelled out; what counts as a
 *      "project" (a folder a buildkit project command visits) is spelled out.
 *   b) Ambiguities — covered explicitly:
 *        - quest id format: free-form, whatever the folder is named
 *        - project path format: workspace-relative with `/`, as buildkit reports it
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
import { listWorkspaceProjects, type BuildkitRunner } from '../../services/workspaceProjects.js';

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

/** What `buildkit :projects --json` prints for the fixture (tom_build_base's ListedProject.toJson()). */
const PROJECTS_DOC = {
    formatVersion: 1,
    tool: 'buildkit',
    root: '/ws',
    count: 3,
    projects: [
        { id: 'TBA', name: 'Tom Basics', path: 'tom_ai/basics/tom_basics', absolutePath: '/ws/tom_ai/basics/tom_basics', language: 'dart', type: 'dart_package', natures: ['dart_package', 'buildkit'], version: '1.0.0', description: 'Basics.' },
        { id: 'tom_core_kernel', name: 'tom_core_kernel', path: 'tom_ai/core/tom_core_kernel', absolutePath: '/ws/tom_ai/core/tom_core_kernel', language: 'dart', type: 'dart_package', natures: ['dart_package'] },
        { id: 'tom-ai', name: 'tom-ai', path: 'tom_ai/vscode/tom_vscode_extension', absolutePath: '/ws/tom_ai/vscode/tom_vscode_extension', language: 'typescript', type: 'typescript', natures: ['vscode_extension', 'typescript'] },
    ],
};

/** The live source over a fake buildkit run (a configured binary that exists). */
function projectSourceFor(run: BuildkitRunner): ProjectSource {
    const binary = w('fake-bin/buildkit');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '');
    return {
        readProjects: () => listWorkspaceProjects(w('.'), {
            fresh: true,
            config: { executables: { buildkit: { '*': binary } } }, // eslint-disable-line @typescript-eslint/naming-convention -- the '*' platform key
            runner: run,
        }),
    };
}

const projectSource = projectSourceFor(async () => ({
    exitCode: 0,
    stdout: JSON.stringify(PROJECTS_DOC, null, 2) + '\n',
    stderr: 'Skipping - buildkit_skip.yaml found: x\n',
}));

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

    test('typical: the projects of buildkit\'s listing, with identity and natures', async () => {
        const raw = await withTiming('tomAi_listProjects:typical', () =>
            listProjectsImpl(projectSource, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.discoveredFrom, 'buildkit :projects --all --json');
        assert.equal(r.binary, w('fake-bin/buildkit'));
        assert.equal(r.count, 3);
        assert.deepEqual(
            r.projects.map((p: ProjectInfo) => p.id).sort(),
            ['TBA', 'tom-ai', 'tom_core_kernel'],
        );
        const basics = r.projects.find((p: ProjectInfo) => p.id === 'TBA');
        assert.equal(basics.path, 'tom_ai/basics/tom_basics');
        assert.equal(basics.name, 'Tom Basics');
        assert.equal(basics.type, 'dart_package');
        assert.deepEqual(basics.natures, ['dart_package', 'buildkit']);
        assert.equal(basics.version, '1.0.0');
        const kernel = r.projects.find((p: ProjectInfo) => p.id === 'tom_core_kernel');
        assert.equal('version' in kernel, false, 'absent fields stay absent');
    });

    test('the command run: -R <root> :projects --all --json in the workspace root', async () => {
        const calls: Array<{ args: string[]; cwd: string }> = [];
        const src = projectSourceFor(async (_b, args, cwd) => {
            calls.push({ args, cwd });
            return { exitCode: 0, stdout: JSON.stringify(PROJECTS_DOC), stderr: '' };
        });
        await listProjectsImpl(src, {});
        assert.deepEqual(calls, [{ args: ['-R', w('.'), ':projects', '--all', '--json'], cwd: w('.') }]);
    });

    test('no buildkit → ok: false naming where it looked', async () => {
        const src: ProjectSource = {
            readProjects: () => listWorkspaceProjects(w('nowhere'), {
                fresh: true,
                config: { binaryPath: { '*': w('no-layer') } }, // eslint-disable-line @typescript-eslint/naming-convention -- the '*' platform key
                env: { PATH: w('no-path') }, // eslint-disable-line @typescript-eslint/naming-convention -- PATH
            }),
        };
        const r = JSON.parse(await listProjectsImpl(src, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /buildkit not found/);
        assert.ok(r.searched.some((s: string) => s.startsWith(w('no-layer'))));
        assert.deepEqual(r.projects, []);
    });

    test('a failing or foreign listing → ok: false with buildkit\'s message', async () => {
        const failing = projectSourceFor(async () => ({ exitCode: 2, stdout: '', stderr: 'Error: boom' }));
        const r1 = JSON.parse(await listProjectsImpl(failing, {}));
        assert.equal(r1.ok, false);
        assert.match(r1.error, /exited with 2: Error: boom/);
        const newer = projectSourceFor(async () => ({ exitCode: 0, stdout: JSON.stringify({ ...PROJECTS_DOC, formatVersion: 2 }), stderr: '' }));
        const r2 = JSON.parse(await listProjectsImpl(newer, {}));
        assert.equal(r2.ok, false);
        assert.match(r2.error, /formatVersion 2 is not 1/);
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
