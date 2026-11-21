/**
 * Looking for a linked file by its name (src/utils/linkFileSearch.ts), the MD Browser's fallback
 * when a link's file is not where the link says.
 *
 *   LFS-1 the scopes come in order (document folder, quest, workspace guidelines, root guidelines,
 *         workspace), missing folders and repeated folders left out
 *   LFS-2 the search stops at the first scope with a match: a file in the document's folder (or
 *         below it) wins over one in the quest folder and the workspace
 *   LFS-3 several matches in a scope are all returned, nearer folders first
 *   LFS-4 a link that names folders keeps the files whose path ends with them
 *   LFS-5 skipped folders (node_modules, .git, build …) are not searched; nothing found is an empty,
 *         complete result
 *   LFS-6 a symbolic link to a folder is followed once, and a link loop ends
 *   LFS-7 a time budget used up stops the search and says so
 *   LFS-8 linkSearchName drops `.`, `..` and the folders before the name
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findLinkedFile, linkSearchName, linkSearchScopes, preferFolderMatches } from '../linkFileSearch.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-file-search-')));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const WS = path.join(ROOT, 'ws');
const put = (rel: string, text = '# x\n'): string => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
};

const DOC = put('ws/docs/area/doc.md');
const QUEST = path.join(WS, '_ai', 'quests', 'q1');
const WS_GUIDE = path.join(WS, '_agent_guidelines');
const ROOT_GUIDE = path.join(ROOT, '_agent_guidelines');
put('ws/_ai/quests/q1/overview.q1.md');
put('ws/_agent_guidelines/index_workspace.md');
put('_agent_guidelines/index_root.md');

const scopes = () => linkSearchScopes({
    currentFilePath: DOC,
    questDir: QUEST,
    workspaceGuidelineDirs: [WS_GUIDE],
    rootGuidelineDirs: [ROOT_GUIDE],
    workspaceRoot: WS,
});

describe('linkFileSearch', () => {
    test('LFS-1: scopes in order, missing and repeated folders left out', () => {
        assert.deepEqual(scopes().map((s) => [s.kind, s.dir]), [
            ['document', path.dirname(DOC)],
            ['quest', QUEST],
            ['workspaceGuidelines', WS_GUIDE],
            ['rootGuidelines', ROOT_GUIDE],
            ['workspace', WS],
        ]);
        const fewer = linkSearchScopes({ currentFilePath: path.join(WS, 'top.md'), questDir: path.join(WS, 'nope'), workspaceRoot: WS });
        assert.deepEqual(fewer.map((s) => s.kind), ['document'], 'the workspace folder is the document folder already; a missing quest folder is left out');
    });

    test('LFS-2: the first scope with a match wins', async () => {
        const near = put('ws/docs/area/sub/target.md');
        put('ws/_ai/quests/q1/target.md');
        put('ws/elsewhere/target.md');
        const r = await findLinkedFile('target.md', scopes());
        assert.equal(r.scope?.kind, 'document');
        assert.deepEqual(r.files, [near]);
        const q = await findLinkedFile('overview.q1.md', scopes());
        assert.equal(q.scope?.kind, 'quest');
        const g = await findLinkedFile('index_root.md', scopes());
        assert.equal(g.scope?.kind, 'rootGuidelines');
        const w = await findLinkedFile('index_workspace.md', scopes());
        assert.equal(w.scope?.kind, 'workspaceGuidelines');
    });

    test('LFS-3: several matches in a scope, nearer first', async () => {
        const deep = put('ws/pkg/a/b/twice.md');
        const shallow = put('ws/pkg/z/twice.md');
        const r = await findLinkedFile('twice.md', scopes());
        assert.equal(r.scope?.kind, 'workspace');
        assert.deepEqual(r.files, [shallow, deep]);
    });

    test('LFS-4: folders in the link narrow the matches', async () => {
        const wanted = put('ws/pkg/dart/unit_tests.md');
        put('ws/pkg/other/unit_tests.md');
        const r = await findLinkedFile('../../dart/unit_tests.md', scopes());
        assert.deepEqual(r.files, [wanted]);
        const loose = await findLinkedFile('nomatch/unit_tests.md', scopes());
        assert.equal(loose.files.length, 2, 'no file ends with the folders: every file of the name');
        assert.deepEqual(preferFolderMatches(['/a/x/f.md', '/b/y/f.md'], ['y']), ['/b/y/f.md']);
    });

    test('LFS-5: skipped folders are not searched; nothing found is complete', async () => {
        put('ws/node_modules/pkg/hidden.md');
        put('ws/sub/build/hidden.md');
        put('ws/.git/hidden.md');
        const r = await findLinkedFile('hidden.md', scopes());
        assert.deepEqual(r, { files: [], incomplete: false });
    });

    test('LFS-6: folder links are followed once, loops end', async () => {
        const target = put('outside/linked/via_link.md');
        fs.symlinkSync(path.join(ROOT, 'outside'), path.join(WS, 'link_to_outside'), 'dir');
        fs.symlinkSync(WS, path.join(WS, 'pkg', 'loop'), 'dir');
        const r = await findLinkedFile('via_link.md', scopes());
        assert.deepEqual(r.files, [path.join(WS, 'link_to_outside', 'linked', 'via_link.md')]);
        assert.ok(fs.existsSync(target));
    });

    test('LFS-7: a used-up budget stops the search and says so', async () => {
        const r = await findLinkedFile('nowhere.md', scopes(), { timeBudgetMs: -1 });
        assert.deepEqual(r, { files: [], incomplete: true });
        const c = await findLinkedFile('nowhere.md', scopes(), { isCancelled: () => true });
        assert.equal(c.incomplete, true);
    });

    test('LFS-8: linkSearchName', () => {
        assert.deepEqual(linkSearchName('../../dart/unit_tests.md'), { name: 'unit_tests.md', folders: ['dart'] });
        assert.deepEqual(linkSearchName('./x.md'), { name: 'x.md', folders: [] });
        assert.deepEqual(linkSearchName('/abs/dir/y.md'), { name: 'y.md', folders: ['abs', 'dir'] });
        assert.deepEqual(linkSearchName(''), { name: '', folders: [] });
    });
});
