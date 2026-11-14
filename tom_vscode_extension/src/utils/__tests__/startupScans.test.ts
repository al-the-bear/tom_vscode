/**
 * The workspace walks that panels ask for while a window opens
 * (src/utils/promptScopes.ts, ttlPromiseCache.ts): they run asynchronously,
 * once for every caller, and skip scratch and build output. The projects come
 * from buildkit's listing (services/workspaceProjects.ts, vscimpb84; the
 * detector walk is retired).
 *
 *   SS-6 TtlPromiseCache: a failed load is forgotten; after the TTL the next
 *        caller loads again
 *   SS-7 promptScopes: every `prompt/` folder (not descending into one, ztmp
 *        skipped) as scan scopes, each listed project's `prompt/` as a project
 *        scope; the walk is shared within the TTL
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({});

import { clearPromptScopeCache, projectPromptScopes, scanPromptScopes } from '../promptScopes.js';
import { TtlPromiseCache } from '../ttlPromiseCache.js';

function write(root: string, rel: string, content = ''): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** A workspace with prompt folders, scratch copies among them. */
function makeWorkspace(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-scans-')));
    for (const pkg of ['packages/alpha', 'packages/beta', 'tools/gamma']) {
        fs.mkdirSync(path.join(root, pkg), { recursive: true });
    }
    // prompt/ folders: one per project, one nested in a prompt folder, one in ztmp.
    write(root, 'packages/beta/prompt/a.prompt.md', '# a');
    write(root, 'docs/prompt/b.prompt.md', '# b');
    write(root, 'docs/prompt/inner/prompt/c.prompt.md', '# c');
    write(root, 'ztmp/prompt/d.prompt.md', '# d');
    return root;
}

describe('workspace scans at start-up', () => {
    let root: string;
    beforeEach(() => {
        root = makeWorkspace();
        vscodeStub.setWorkspaceFolders([root]);
        clearPromptScopeCache();
    });

    test('SS-7: prompt scopes from the shared walks', async () => {
        const scan = await scanPromptScopes(root);
        assert.deepEqual(scan.map((s) => path.relative(root, s.dir)), ['docs/prompt', 'packages/beta/prompt']);
        assert.equal(scan[0].id, encodeURIComponent(path.join(root, 'docs/prompt')));
        assert.equal(scan[0].label, 'docs/prompt');

        const listed = ['packages/alpha', 'packages/beta', 'tools/gamma'].map((rel) => ({ name: path.basename(rel), absolutePath: path.join(root, rel) }));
        const asked: Array<[string, boolean]> = [];
        const projects = await projectPromptScopes(root, false, async (ws, fresh) => { asked.push([ws, fresh]); return listed; });
        assert.deepEqual(asked, [[root, false]], 'the listing of this workspace');
        assert.deepEqual(projects.map((s) => s.label), ['alpha', 'beta', 'gamma']);
        assert.equal(projects[1].dir, path.join(root, 'packages/beta/prompt'));
        assert.equal(projects[1].id, encodeURIComponent(path.join(root, 'packages/beta')));

        write(root, 'later/prompt/e.prompt.md', '# e');
        assert.equal((await scanPromptScopes(root)).length, 2, 'reused within the TTL');
        assert.equal((await scanPromptScopes(root, true)).length, 3, 'fresh walks again');
    });
});

describe('TtlPromiseCache', () => {
    test('SS-6: a failed load is forgotten; the TTL counts from the end of the load', async () => {
        let clock = 0;
        const cache = new TtlPromiseCache<number>(1000, () => clock);
        let loads = 0;
        await assert.rejects(cache.get('k', async () => { loads++; throw new Error('boom'); }));
        assert.equal(await cache.get('k', async () => ++loads), 2, 'the failure was not kept');
        clock = 999;
        assert.equal(await cache.get('k', async () => ++loads), 2, 'within the TTL');
        clock = 1000;
        assert.equal(await cache.get('k', async () => ++loads), 3, 'after the TTL');
    });
});
