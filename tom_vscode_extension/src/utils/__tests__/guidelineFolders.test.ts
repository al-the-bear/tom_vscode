/**
 * The guidelines in two levels, under both folder names (02_wslayout-6):
 *
 *   GF-1 two levels: a workspace file of the same path wins, the others come from the root
 *   GF-2 root only; workspace only; root == workspace folder is one level
 *   GF-3 each folder name at each level; both names in one folder: the new one wins
 *   GF-4 the levels' indexes: index_root.md / index_workspace.md, else index.md, root first
 *   GF-5 project guidelines under each name, not layered
 *   GF-6 resolving: exact path first, else by name (the workspace's first), and says so
 *   GF-7 the guideline tools on two levels: list, read, search, the found-by-name hook
 *   GF-8 pattern prompts are found under each name, the workspace folder's first
 *   GF-9 the container shape: root al_the_bear/_agent_guidelines, container _copilot_guidelines
 *   GF-10 a rule heading's name: workspace guidelines, root guidelines, root documents, in that order
 *   GF-11 the `§` reference: by number, by title, the brackets, a section that is not there
 *   GF-12 the read tool by a rule heading's name, in a workspace folder's window and in the root window
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    extractSection,
    filesNamed,
    listRootDocuments,
    splitSectionRef,
    guidelineLevels,
    guidelineLevelGroups,
    levelIndexes,
    listLevelFiles,
    listProjectFiles,
    projectGuidelineDirs,
    resolveInFiles,
} from '../guidelineFolders.js';
import { listGlobalGuidelinesImpl, readGlobalGuidelineImpl, searchGlobalGuidelinesImpl, readProjectGuidelineImpl } from '../../tools/guideline-tools.js';
import { patternPromptDirs } from '../../tools/pattern-prompts-tools.js';

function tmp(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guidelines-')));
}
function put(file: string, text = '# x\n'): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** al_the_bear-like root with a container workspace folder below it. */
function twoLevels(): { root: string; ws: string } {
    const root = tmp();
    const ws = path.join(root, 'container');
    put(path.join(root, '_agent_guidelines', 'index_root.md'), '# Root index\n');
    put(path.join(root, '_agent_guidelines', 'shared.md'), 'root shared\n');
    put(path.join(root, '_agent_guidelines', 'only_root.md'), 'root only\n');
    put(path.join(root, '_agent_guidelines', 'dart', 'coding.md'), 'root dart coding\n');
    put(path.join(ws, '_copilot_guidelines', 'index.md'), '# Container index\n');
    put(path.join(ws, '_copilot_guidelines', 'shared.md'), 'workspace shared\n');
    put(path.join(ws, '_copilot_guidelines', 'only_ws.md'), 'workspace only\n');
    return { root, ws };
}
const dirsOf = (root: string, ws: string) => [path.join(root, '_agent_guidelines'), path.join(ws, '_agent_guidelines')];

describe('guideline levels', () => {
    test('GF-1: two levels, the workspace file wins', () => {
        const { root, ws } = twoLevels();
        const levels = guidelineLevels(dirsOf(root, ws));
        assert.deepEqual(levels.map((l) => l.level), ['root', 'workspace']);
        const files = listLevelFiles(levels);
        const byPath = Object.fromEntries(files.map((f) => [f.path, f.level]));
        assert.equal(byPath['shared.md'], 'workspace');
        assert.equal(byPath['only_root.md'], 'root');
        assert.equal(byPath['only_ws.md'], 'workspace');
        assert.equal(byPath['dart/coding.md'], 'root');
        assert.equal(files.filter((f) => f.path === 'shared.md').length, 1, 'each path once');
    });

    test('GF-2: root only, workspace only, one level', () => {
        const root = tmp();
        const ws = path.join(root, 'ws');
        put(path.join(root, '_agent_guidelines', 'a.md'));
        fs.mkdirSync(ws, { recursive: true });
        assert.deepEqual(guidelineLevels(dirsOf(root, ws)).map((l) => l.level), ['root']);
        const ws2 = tmp();
        const root2 = tmp();
        put(path.join(ws2, '_copilot_guidelines', 'b.md'));
        assert.deepEqual(guidelineLevels(dirsOf(root2, ws2)).map((l) => l.level), ['workspace']);
        const same = tmp();
        put(path.join(same, '_agent_guidelines', 'c.md'));
        assert.deepEqual(guidelineLevels([path.join(same, '_agent_guidelines')]).map((l) => l.level), ['root']);
        assert.deepEqual(guidelineLevels([path.join(same, '_agent_guidelines'), path.join(same, '_agent_guidelines')]).length, 1, 'the same folders once');
    });

    test('GF-3: both names; in one folder the new one wins', () => {
        const ws = tmp();
        put(path.join(ws, '_agent_guidelines', 'both.md'), 'new\n');
        put(path.join(ws, '_copilot_guidelines', 'both.md'), 'old\n');
        put(path.join(ws, '_copilot_guidelines', 'old_only.md'), 'old only\n');
        const levels = guidelineLevels([path.join(ws, '_agent_guidelines')]);
        assert.deepEqual(levels[0].dirs.map((d) => path.basename(d)), ['_agent_guidelines', '_copilot_guidelines']);
        const files = listLevelFiles(levels);
        assert.equal(fs.readFileSync(files.find((f) => f.path === 'both.md')!.abs, 'utf8'), 'new\n');
        assert.ok(files.some((f) => f.path === 'old_only.md'), 'the old folder is read too');
        assert.deepEqual(guidelineLevelGroups(levels).map((g) => g.id), ['global', 'level:root:1']);
    });

    test('GF-4: the indexes', () => {
        const { root, ws } = twoLevels();
        const ix = levelIndexes(guidelineLevels(dirsOf(root, ws)));
        assert.deepEqual(ix.map((i) => [i.level, path.basename(i.file), i.content]), [
            ['root', 'index_root.md', '# Root index\n'],
            ['workspace', 'index.md', '# Container index\n'],
        ]);
        put(path.join(ws, '_copilot_guidelines', 'index_workspace.md'), '# WS index\n');
        assert.equal(path.basename(levelIndexes(guidelineLevels(dirsOf(root, ws)))[1].file), 'index_workspace.md');
    });

    test('GF-5: project guidelines under each name', () => {
        const p = tmp();
        assert.deepEqual(projectGuidelineDirs(p), []);
        put(path.join(p, '_copilot_guidelines', 'x.md'), 'old\n');
        assert.deepEqual(projectGuidelineDirs(p).map((d) => path.basename(d)), ['_copilot_guidelines']);
        put(path.join(p, '_agent_guidelines', 'x.md'), 'new\n');
        const files = listProjectFiles(projectGuidelineDirs(p));
        assert.equal(files.length, 1);
        assert.equal(files[0].level, 'project');
        assert.equal(fs.readFileSync(files[0].abs, 'utf8'), 'new\n');
    });

    test('GF-6: resolving', () => {
        const { root, ws } = twoLevels();
        const files = listLevelFiles(guidelineLevels(dirsOf(root, ws)));
        assert.equal(resolveInFiles(files, 'dart/coding')!.byName, false);
        const byName = resolveInFiles(files, 'cloud/coding.md')!;
        assert.equal(byName.byName, true);
        assert.equal(byName.file.path, 'dart/coding.md');
        assert.equal(resolveInFiles(files, 'nowhere.md'), undefined);
    });

    test('GF-7: the guideline tools on two levels', async () => {
        const { root, ws } = twoLevels();
        const told: Array<[string, string]> = [];
        const scope = { wsRoot: ws, levels: guidelineLevels(dirsOf(root, ws)), onFoundByName: (r: string, f: string) => { told.push([r, f]); } };
        const list = JSON.parse(await listGlobalGuidelinesImpl(scope, {}));
        assert.deepEqual(list.files.map((f: { path: string; level: string }) => `${f.path}:${f.level}`).sort(),
            ['dart/coding.md:root', 'index.md:workspace', 'index_root.md:root', 'only_root.md:root', 'only_ws.md:workspace', 'shared.md:workspace']);
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: 'shared' }), 'workspace shared\n');
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: '_agent_guidelines/only_root.md' }), 'root only\n');
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: path.join(root, '_agent_guidelines', 'only_root.md') }), 'root only\n');
        assert.equal(told.length, 0);
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: 'old/place/coding.md' }), 'root dart coding\n');
        assert.deepEqual(told, [['old/place/coding.md', '../_agent_guidelines/dart/coding.md']], 'the user is told');
        const listing = await readGlobalGuidelineImpl(scope, {});
        assert.match(listing, /index_root\.md \(root\):\n\n# Root index/);
        assert.match(listing, /index\.md \(workspace\):\n\n# Container index/);
        const search = JSON.parse(await searchGlobalGuidelinesImpl(scope, { query: 'shared' }));
        assert.deepEqual(search.matches.map((m: { file: string; level: string }) => `${m.file}:${m.level}`), ['shared.md:workspace'], 'the shadowed root file is not searched');
        put(path.join(ws, 'pkg', '_agent_guidelines', 'p.md'), 'pkg new\n');
        assert.equal(await readProjectGuidelineImpl(scope, { projectPath: 'pkg', fileName: 'p.md' }), 'pkg new\n');
    });

    test('GF-8: pattern prompts under each name, the workspace folder first', () => {
        const { root, ws } = twoLevels();
        put(path.join(root, '_agent_guidelines', 'pattern_prompts', 'commit.md'));
        put(path.join(ws, '_copilot_guidelines', 'pattern_prompts', 'build.md'));
        const dirs = patternPromptDirs(ws, guidelineLevels(dirsOf(root, ws))).map((d) => d.relativePath);
        assert.deepEqual(dirs, ['_copilot_guidelines/pattern_prompts', '../_agent_guidelines/pattern_prompts', '_copilot_tomai/pattern_prompts']);
    });

    test('GF-9: the container shape', () => {
        const atb = tmp();
        const container = path.join(atb, 'inhouse', 'second_wind', 'enterprise_flutter', 'tom_agent_container');
        put(path.join(atb, '_agent_guidelines', 'index.md'), '# root\n');
        put(path.join(atb, '_agent_guidelines', 'quest_todos.md'));
        put(path.join(container, '_copilot_guidelines', 'index.md'), '# container\n');
        put(path.join(container, '_copilot_guidelines', 'parallel_work.md'));
        const levels = guidelineLevels(dirsOf(atb, container));
        assert.deepEqual(levels.map((l) => [l.level, l.dirs.map((d) => path.relative(atb, d))]), [
            ['root', ['_agent_guidelines']],
            ['workspace', [path.join('inhouse', 'second_wind', 'enterprise_flutter', 'tom_agent_container', '_copilot_guidelines')]],
        ]);
        const paths = listLevelFiles(levels).map((f) => `${f.path}:${f.level}`);
        assert.deepEqual(paths, ['index.md:workspace', 'parallel_work.md:workspace', 'quest_todos.md:root']);
        assert.deepEqual(guidelineLevelGroups(levels).map((g) => [g.id, g.label]), [['global', 'Workspace'], ['level:root:0', 'Root']]);
    });

    test('GF-10: a rule heading\'s name on every level, in order', () => {
        const { root, ws } = twoLevels();
        put(path.join(root, 'repo_skills_userguide.md'), '# Skills\n');
        put(path.join(root, 'only_root.md'), 'root document of a guideline\'s name\n');
        put(path.join(root, 'notes', 'deep.md'), 'not a root document\n');
        put(path.join(ws, '_copilot_guidelines', 'nested', 'only_root.md'), 'workspace nested\n');
        const levels = guidelineLevels(dirsOf(root, ws));
        const docs = listRootDocuments(root);
        assert.deepEqual(docs.map((d) => `${d.path}:${d.level}`), ['only_root.md:rootDocument', 'repo_skills_userguide.md:rootDocument'], 'top-level files only');
        const at = (name: string) => filesNamed(levels, docs, name).map((f) => `${f.path}:${f.level}`);
        assert.deepEqual(at('repo_skills_userguide.md'), ['repo_skills_userguide.md:rootDocument'], 'a root document');
        assert.deepEqual(at('only_ws'), ['only_ws.md:workspace'], 'the workspace guidelines, .md added');
        assert.deepEqual(at('coding.md'), ['dart/coding.md:root'], 'the root guidelines, nested');
        assert.deepEqual(at('only_root.md'), ['nested/only_root.md:workspace', 'only_root.md:root', 'only_root.md:rootDocument'], 'workspace, root, root document; the first wins');
        assert.deepEqual(at('shared.md'), ['shared.md:workspace'], 'the root file of the same path is overridden, no duplicate');
        assert.deepEqual(at('deep.md'), [], 'root subfolders are no root documents');
        assert.deepEqual(filesNamed(guidelineLevels([path.join(root, '_agent_guidelines')]), docs, 'only_root.md').map((f) => f.level), ['root', 'rootDocument'], 'root == workspace folder: one level');
    });

    test('GF-11: the § reference', () => {
        assert.deepEqual(splitSectionRef('repo_skills_userguide.md § 5'), { name: 'repo_skills_userguide.md', section: '5' });
        assert.deepEqual(splitSectionRef('[quest_todos.md § Chat Todo List]'), { name: 'quest_todos.md', section: 'Chat Todo List' });
        assert.deepEqual(splitSectionRef('a.md §3.1'), { name: 'a.md', section: '3.1' });
        assert.deepEqual(splitSectionRef('a.md'), { name: 'a.md' });
        const md = '# Title\n\n## 1. One\none\n\n## 5. Fleet\nfleet\n\n### 5.1 Detail\ndetail\n\n```\n## 6. not a heading\n```\n\n## 6. Generated files\ngen\n\n## Chat Todo List\nchat\n';
        assert.equal(extractSection(md, '5')?.text, '## 5. Fleet\nfleet\n\n### 5.1 Detail\ndetail\n\n```\n## 6. not a heading\n```\n', 'to the next heading of its level: subsections and fenced code included');
        assert.equal(extractSection(md, '5.1')?.heading, '5.1 Detail');
        assert.equal(extractSection(md, '6')?.text, '## 6. Generated files\ngen\n', 'a # line in fenced code is no heading');
        assert.equal(extractSection(md, 'chat todo list')?.text, '## Chat Todo List\nchat\n', 'by title, any case');
        assert.equal(extractSection(md, 'Generated files')?.heading, '6. Generated files', 'by title without its number');
        assert.equal(extractSection(md, 'Gen')?.heading, '6. Generated files', 'the one heading starting with it');
        assert.equal(extractSection(md, '9'), undefined);
    });

    test('GF-12: the read tool by a rule heading\'s name, in both windows', async () => {
        const { root, ws } = twoLevels();
        put(path.join(root, 'repo_skills_userguide.md'), '# Skills\n\n## 4. Per machine\nfour\n\n## 5. Driving the fleet\nfive\n');
        put(path.join(root, 'only_root.md'), 'root document\n');
        const told: string[] = [];
        const wsWindow = { wsRoot: ws, root, levels: guidelineLevels(dirsOf(root, ws)), onFoundByName: (r: string) => { told.push(r); } };
        assert.equal(await readGlobalGuidelineImpl(wsWindow, { fileName: 'repo_skills_userguide.md' }), '# Skills\n\n## 4. Per machine\nfour\n\n## 5. Driving the fleet\nfive\n', 'a root document');
        const section = await readGlobalGuidelineImpl(wsWindow, { fileName: '[repo_skills_userguide.md § 5]' });
        assert.match(section, /^Read \.\.\/repo_skills_userguide\.md \(rootDocument\), § 5: "5\. Driving the fleet"\./);
        assert.ok(section.endsWith('---\n\n## 5. Driving the fleet\nfive\n'), section);
        const missing = await readGlobalGuidelineImpl(wsWindow, { fileName: 'repo_skills_userguide.md § 9' });
        assert.match(missing, /has no section § 9; the whole file follows\. Its headings:\n {2}- 4\. Per machine\n {2}- 5\. Driving the fleet/);
        assert.equal(await readGlobalGuidelineImpl(wsWindow, { fileName: 'only_ws' }), 'workspace only\n', 'the workspace folder\'s guidelines');
        assert.equal(await readGlobalGuidelineImpl(wsWindow, { fileName: 'coding.md' }), 'root dart coding\n', 'the root\'s guidelines, nested');
        const dup = await readGlobalGuidelineImpl(wsWindow, { fileName: 'only_root.md' });
        assert.match(dup, /^Read \.\.\/_agent_guidelines\/only_root\.md \(root\)\.\nThe name is also in: \.\.\/only_root\.md \(rootDocument\)/);
        assert.ok(dup.endsWith('---\n\nroot only\n'));
        assert.deepEqual(told, [], 'a bare name found on a level is no path to correct');
        const list = JSON.parse(await listGlobalGuidelinesImpl(wsWindow, {}));
        assert.ok(list.files.some((f: { path: string; level: string }) => f.path === 'repo_skills_userguide.md' && f.level === 'rootDocument'));
        const search = JSON.parse(await searchGlobalGuidelinesImpl(wsWindow, { query: 'Driving the fleet' }));
        assert.deepEqual(search.matches.map((m: { file: string; level: string }) => `${m.file}:${m.level}`), ['repo_skills_userguide.md:rootDocument']);
        // The root window: the root is the workspace folder, one level.
        const rootWindow = { wsRoot: root, root, levels: guidelineLevels([path.join(root, '_agent_guidelines')]) };
        assert.equal(await readGlobalGuidelineImpl(rootWindow, { fileName: 'only_root' }), 'Read _agent_guidelines/only_root.md (root).\nThe name is also in: only_root.md (rootDocument) (file names are meant to be unique across the levels).\n\n---\n\nroot only\n');
        assert.match(await readGlobalGuidelineImpl(rootWindow, { fileName: 'repo_skills_userguide.md § Per machine' }), /---\n\n## 4\. Per machine\nfour\n$/);
        assert.match(await readGlobalGuidelineImpl(rootWindow, { fileName: 'only_ws.md' }), /^Global guideline file not found/, 'the container\'s guidelines are not the root window\'s');
    });
});
