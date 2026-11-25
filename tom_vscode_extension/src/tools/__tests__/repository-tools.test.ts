/**
 * tomAi_listRepositories (src/tools/repository-tools.ts) on a sandbox root with its own repos.yaml.
 *
 *   LR-1 every entry of `repos:` with path, name, url, kind, branch / pin, cloned and workspaceFolder; an upstream
 *        has a pin and no branch; `links:` and `unmanaged:` are no repositories; `root` and `file` are answered
 *   LR-2 `kind` keeps one kind; `under` keeps a repository and those below it, whole segments only, a trailing `/`
 *        or leading `./` ignored; both together; an unknown kind is refused
 *   LR-3 `includeProjects`: the ids of the listing's projects inside each repository, a nested repository's
 *        projects not also its parent's, projects outside every repository dropped; a failed listing answers
 *        `projectsError`, the repositories still listed; without it no `projects` field
 *   LR-4 without repos.yaml `{ok: false, error}` naming the file looked for; no root; a file that does not parse;
 *        an entry without path, url or kind is skipped and reported
 *   LR-5 the tool: read-only (on the MCP read-only floor), registered, selectable, categorised, documented
 *   LR-6 an entry's `description:` is answered (absent when the entry has none)
 *   LR-7 tomAi_getWorkspaceInfo `include: ["repos"]`: the root (path `.`, url, branch, description, cloned) and every
 *        entry with path, kind, branch / pin, url, description and cloned; `repos: null` without repos.yaml or
 *        without a root, `{file, error}` for a file that does not parse; documented in the tool description and
 *        doc/llm_tools.md
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({ workspaceFolders: [process.cwd()] });

import { withTiming } from './_timing.js';
import {
    LIST_REPOSITORIES_TOOL_DEF, deepestContaining, isAtOrUnder, listRepositoriesImpl, normalizeUnder, workspaceRepos,
    type RepositorySource,
} from '../repository-tools.js';
import { GET_WORKSPACE_INFO_TOOL, getWorkspaceInfoImpl, WORKSPACE_INFO_PARTS } from '../editor-context-tools.js';
import type { ProjectListing } from '../../services/workspaceProjects.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'list-repositories-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const REPOS_YAML = [
    'version: 1',
    'root: {url: git@github.com:me/root.git, branch: main, description: "The fleet root."}',
    'repos:',
    '  - {path: ws/agent, url: git@github.com:me/agent.git, kind: code, branch: main}',
    '  - {path: ws/agent/tom_ai/core, url: git@github.com:me/core.git, kind: code, branch: main}',
    '  - {path: ws/agent/tom_ai/xternal/dcli, url: git@github.com:me/dcli.git, kind: fork, branch: tom/10-fixes, description: "Our fork of dcli: the shell library."}',
    '  - {path: ws/agent/tom_ai/corelib, url: git@github.com:me/corelib.git, kind: code, branch: dev}',
    '  - {path: _ai, url: git@github.com:me/state.git, kind: ai, branch: main}',
    '  - {path: samples/cJSON, url: https://github.com/DaveGamble/cJSON.git, kind: upstream, pin: a29814f285cc531c00223743ad3c55cd38c0dc56, hosts: []}',
    'links:',
    '  - {path: ws/agent/_ai, target: ../../_ai}',
    'unmanaged:',
    '  - {path: ws/agent/ztmp/clone, notes: a test clone}',
    '',
].join('\n');

const PROJECTS: ProjectListing = {
    ok: true, source: 'buildkit', binary: '/bin/buildkit', root: path.join(ROOT, 'ws/agent'),
    projects: [
        { id: 'agent_tool', path: 'agent_tool', absolutePath: path.join(ROOT, 'ws/agent/agent_tool') },
        { id: 'tom_core_kernel', path: 'tom_ai/core/tom_core_kernel', absolutePath: path.join(ROOT, 'ws/agent/tom_ai/core/tom_core_kernel') },
        { id: 'tom_core_flutter', path: 'tom_ai/core/tom_core_flutter', absolutePath: path.join(ROOT, 'ws/agent/tom_ai/core/tom_core_flutter') },
        { id: 'corelib_pkg', path: 'tom_ai/corelib/pkg', absolutePath: path.join(ROOT, 'ws/agent/tom_ai/corelib/pkg') },
        { id: 'elsewhere', path: '../../../elsewhere', absolutePath: path.join(path.dirname(ROOT), 'elsewhere') },
    ] as never,
};

function source(over: Partial<RepositorySource> = {}): RepositorySource {
    return {
        root: () => ROOT,
        readText: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
        isDirectory: (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } },
        workspaceFolders: () => ['ws/agent', 'samples'],
        readProjects: async () => PROJECTS,
        ...over,
    };
}

async function run(input: Record<string, unknown>, src = source(), label = 'typical'): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return JSON.parse(await withTiming(`tomAi_listRepositories:${label}`, () => listRepositoriesImpl(src, input)));
}

fs.writeFileSync(path.join(ROOT, 'repos.yaml'), REPOS_YAML);
for (const dir of ['ws/agent/tom_ai/core', 'ws/agent/tom_ai/xternal/dcli', '_ai']) { fs.mkdirSync(path.join(ROOT, dir), { recursive: true }); }

describe('tomAi_listRepositories', () => {
    test('LR-1: every repository with its fields', async () => {
        const r = await run({});
        assert.equal(r.ok, true);
        assert.equal(r.root, ROOT);
        assert.equal(r.file, path.join(ROOT, 'repos.yaml'));
        assert.equal(r.count, 6, 'the repos entries only: no links, no unmanaged clones');
        assert.deepEqual(r.repositories.map((e: { path: string }) => e.path), [
            'ws/agent', 'ws/agent/tom_ai/core', 'ws/agent/tom_ai/xternal/dcli', 'ws/agent/tom_ai/corelib', '_ai', 'samples/cJSON',
        ]);
        assert.deepEqual(r.repositories[2], {
            path: 'ws/agent/tom_ai/xternal/dcli', name: 'dcli', url: 'git@github.com:me/dcli.git', kind: 'fork',
            branch: 'tom/10-fixes', description: 'Our fork of dcli: the shell library.', cloned: true, workspaceFolder: 'ws/agent',
        });
        assert.deepEqual(r.repositories[5], {
            path: 'samples/cJSON', name: 'cJSON', url: 'https://github.com/DaveGamble/cJSON.git', kind: 'upstream',
            pin: 'a29814f285cc531c00223743ad3c55cd38c0dc56', cloned: false, workspaceFolder: 'samples',
        }, 'an upstream: pinned, no branch; not cloned here');
        assert.equal(r.repositories[0].workspaceFolder, 'ws/agent', 'a repository that is a workspace folder is in it');
        assert.equal('workspaceFolder' in r.repositories[4], false, '_ai is in no workspace folder');
        assert.deepEqual(r.repositories.map((e: { cloned: boolean }) => e.cloned), [true, true, true, false, true, false]);
        assert.equal('projects' in r.repositories[0], false, 'no projects unless asked');
    });

    test('LR-2: the kind and under filters', async () => {
        assert.deepEqual((await run({ kind: 'code' }, undefined, 'kind')).repositories.map((e: { name: string }) => e.name), ['agent', 'core', 'corelib']);
        assert.equal((await run({ kind: 'upstream' })).count, 1);
        assert.equal((await run({ kind: 'binaries' })).count, 0);
        const under = await run({ under: 'ws/agent/tom_ai/core' }, undefined, 'under');
        assert.deepEqual(under.repositories.map((e: { path: string }) => e.path), ['ws/agent/tom_ai/core'], 'whole segments: not corelib');
        assert.equal(under.under, 'ws/agent/tom_ai/core');
        assert.deepEqual((await run({ under: './ws/agent/tom_ai/' })).repositories.map((e: { name: string }) => e.name), ['core', 'dcli', 'corelib']);
        assert.equal((await run({ under: 'ws' })).count, 4);
        assert.deepEqual((await run({ under: 'ws/agent', kind: 'fork' })).repositories.map((e: { name: string }) => e.name), ['dcli']);
        const bad = await run({ kind: 'mirror' });
        assert.equal(bad.ok, false);
        assert.match(bad.error, /unknown kind "mirror"; one of code, fork, ai, binaries, upstream/);
        assert.equal(normalizeUnder(' ./a/b/ '), 'a/b');
        assert.equal(isAtOrUnder('a/bc', 'a/b'), false);
        assert.equal(isAtOrUnder('a/b/c', 'a/b'), true);
        assert.equal(deepestContaining('ws/agent/x', ['ws', 'ws/agent', 'other']), 'ws/agent');
        assert.equal(deepestContaining('top', ['ws']), undefined);
    });

    test('LR-3: the projects inside each repository', async () => {
        const r = await run({ includeProjects: true }, undefined, 'projects');
        const byPath = Object.fromEntries(r.repositories.map((e: { path: string; projects: string[] }) => [e.path, e.projects]));
        assert.deepEqual(byPath, {
            'ws/agent': ['agent_tool'],
            'ws/agent/tom_ai/core': ['tom_core_flutter', 'tom_core_kernel'],
            'ws/agent/tom_ai/xternal/dcli': [],
            'ws/agent/tom_ai/corelib': ['corelib_pkg'],
            '_ai': [],
            'samples/cJSON': [],
        }, 'a nested repository\'s projects are its own; one outside every repository is dropped');
        const filtered = await run({ includeProjects: true, under: 'ws/agent', kind: 'code' });
        assert.deepEqual(filtered.repositories[0].projects, ['agent_tool'], 'the filtered-out repositories still keep their projects');
        const failed = await run({ includeProjects: true }, source({ readProjects: async () => ({ ok: false, error: 'buildkit failed' }) }));
        assert.equal(failed.ok, true);
        assert.equal(failed.projectsError, 'buildkit failed');
        assert.equal(failed.count, 6);
    });

    test('LR-4: no repos.yaml, no root, a broken file, a broken entry', async () => {
        const missing = await run({}, source({ root: () => path.join(ROOT, 'nowhere') }), 'missing');
        assert.equal(missing.ok, false);
        assert.equal(missing.file, path.join(ROOT, 'nowhere', 'repos.yaml'));
        assert.match(missing.error, /no repos\.yaml at the Tom root: .*nowhere[/\\]repos\.yaml/);
        const noRoot = await run({}, source({ root: () => undefined }));
        assert.equal(noRoot.ok, false);
        assert.match(noRoot.error, /no workspace folder is open/);
        const broken = await run({}, source({ readText: () => 'repos: [unclosed' }));
        assert.equal(broken.ok, false);
        assert.match(broken.error, /repos\.yaml does not parse/);
        const noList = await run({}, source({ readText: () => 'version: 1\n' }));
        assert.match(noList.error, /no `repos:` list/);
        const partial = await run({}, source({ readText: () => 'repos:\n  - {path: a, url: u, kind: code}\n  - {path: b, kind: code}\n' }));
        assert.equal(partial.count, 1);
        assert.deepEqual(partial.skipped, ['repos[1]: needs path, url and kind']);
    });

    test('LR-5: the tool is registered, read-only, selectable, categorised and documented', async () => {
        const { ALL_SHARED_TOOLS, READ_ONLY_TOOLS } = await import('../tool-executors.js');
        const { AVAILABLE_LLM_TOOLS } = await import('../../utils/constants.js');
        const { CATEGORY_MAP } = await import('../../utils/toolCategories.js');
        assert.equal(LIST_REPOSITORIES_TOOL_DEF.readOnly, true);
        assert.ok(ALL_SHARED_TOOLS.some((t) => t.name === 'tomAi_listRepositories'), 'registered');
        assert.ok(READ_ONLY_TOOLS.some((t) => t.name === 'tomAi_listRepositories'), 'on the read-only floor');
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_listRepositories'), 'selectable');
        assert.ok((CATEGORY_MAP['Quests'] ?? []).includes('tomAi_listRepositories'), 'categorised beside tomAi_listProjects');
        const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'doc', 'llm_tools.md'), 'utf8');
        assert.match(doc, /\| `tomAi_listRepositories` \|/, 'in the tool table');
        assert.match(doc, /### `tomAi_listRepositories`/, 'its own section');
    });

    test('LR-6: the description', async () => {
        const r = await run({ kind: 'fork' });
        assert.equal(r.repositories[0].description, 'Our fork of dcli: the shell library.');
        assert.equal('description' in (await run({ kind: 'ai' })).repositories[0], false, 'absent when the entry has none');
        assert.match(LIST_REPOSITORIES_TOOL_DEF.description, /description\?/);
    });

    test('LR-7: tomAi_getWorkspaceInfo include repos', async () => {
        const snapshot = async () => ({ workspaceName: 'w', workspaceFile: null, workspaceFolders: [], questId: 'q', projects: [], projectsSource: null, git: null }) as never;
        const extras = (src: RepositorySource) => ({ layout: () => null, workspaceFolders: () => null, quests: () => [], repos: () => workspaceRepos(src) });
        const info = async (src: RepositorySource, include = ['repos']) => JSON.parse(await getWorkspaceInfoImpl({ source: { snapshot }, extras: extras(src) }, { include, includeGit: false }));
        assert.ok((WORKSPACE_INFO_PARTS as readonly string[]).includes('repos'));
        const r = (await info(source())).repos;
        assert.equal(r.file, path.join(ROOT, 'repos.yaml'));
        assert.deepEqual(r.root, { path: '.', url: 'git@github.com:me/root.git', branch: 'main', description: 'The fleet root.', cloned: true, absolutePath: ROOT });
        assert.equal(r.count, 6);
        assert.deepEqual(r.repositories[2], {
            path: 'ws/agent/tom_ai/xternal/dcli', name: 'dcli', url: 'git@github.com:me/dcli.git', kind: 'fork',
            branch: 'tom/10-fixes', description: 'Our fork of dcli: the shell library.', cloned: true, workspaceFolder: 'ws/agent',
        });
        assert.deepEqual([r.repositories[5].pin, r.repositories[5].cloned, 'branch' in r.repositories[5]], ['a29814f285cc531c00223743ad3c55cd38c0dc56', false, false]);
        assert.equal('repos' in (await info(source(), [])), false, 'only on request');
        assert.equal((await info(source({ root: () => path.join(ROOT, 'nowhere') }))).repos, null, 'no repos.yaml: null');
        assert.equal((await info(source({ root: () => undefined }))).repos, null, 'no root: null');
        const broken = (await info(source({ readText: () => 'repos: [unclosed' }))).repos;
        assert.equal(broken.file, path.join(ROOT, 'repos.yaml'));
        assert.match(broken.error, /does not parse/);
        // Documented.
        assert.match(GET_WORKSPACE_INFO_TOOL.description, /`repos` \(the root\\?'s `repos\.yaml`/);
        const schema = GET_WORKSPACE_INFO_TOOL.inputSchema as { properties: { include: { items: { enum: string[] } } } };
        assert.ok(schema.properties.include.items.enum.includes('repos'));
        const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'doc', 'llm_tools.md'), 'utf8');
        assert.match(doc, /`include: \["repos"\]`/, 'doc/llm_tools.md names the part');
    });
});
