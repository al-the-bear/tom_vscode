/**
 * The workspace walks that panels ask for while a window opens
 * (src/utils/projectDetector.ts, promptScopes.ts, ttlPromiseCache.ts): they run
 * asynchronously, once for every caller, and skip scratch and build output.
 *
 *   SS-1 the asynchronous scan finds the same projects, in the same order, as
 *        the synchronous one; a detected project is not descended into
 *   SS-2 `ztmp/`, `target/` and the other ignored folders are not walked: a
 *        project inside them is not found
 *   SS-3 detector rules are answered from the directory listing, symlinked
 *        files included (a linked pubspec.yaml is a file); a rule with a path
 *        (`lib/src`) is still checked on disk
 *   SS-4 the detector config is read once per scan, not once per directory
 *   SS-5 scanWorkspaceProjectsCached: concurrent callers share one walk; within
 *        the TTL a finished walk is reused; `fresh` walks again
 *   SS-6 TtlPromiseCache: a failed load is forgotten; after the TTL the next
 *        caller loads again
 *   SS-8 the shipped tom_workspace detector marks the directory holding
 *        buildkit_master.yaml (with _ai/ and _copilot_guidelines/); the retired
 *        tom_workspace.yaml / tom.code-workspace mark nothing
 *   SS-7 promptScopes: every `prompt/` folder (not descending into one, ztmp
 *        skipped) as scan scopes, each detected project's `prompt/` as a project
 *        scope; the walk is shared within the TTL
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({});

import {
    clearProjectScanCache,
    detectProjectAttributes,
    listingOf,
    scanWorkspaceProjectsByDetectors,
    scanWorkspaceProjectsByDetectorsAsync,
    scanWorkspaceProjectsCached,
} from '../projectDetector.js';
import { clearPromptScopeCache, projectPromptScopes, scanPromptScopes } from '../promptScopes.js';
import { TtlPromiseCache } from '../ttlPromiseCache.js';

const DART_PUBSPEC = 'name: pkg\nversion: 1.0.0\n';

function write(root: string, rel: string, content = ''): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** A workspace with Dart packages, scratch copies and build output. */
function makeWorkspace(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-scans-')));
    for (const pkg of ['packages/alpha', 'packages/beta', 'tools/gamma']) {
        write(root, `${pkg}/pubspec.yaml`, DART_PUBSPEC);
        fs.mkdirSync(path.join(root, pkg, 'lib', 'src'), { recursive: true });
    }
    // Inside a detected project: not descended into.
    write(root, 'packages/alpha/example/pubspec.yaml', DART_PUBSPEC);
    fs.mkdirSync(path.join(root, 'packages/alpha/example/lib/src'), { recursive: true });
    // Scratch and build output: never walked.
    for (const skipped of ['ztmp/copy', 'rust/target/debug/copy', 'node_modules/x', 'build/y', '.hidden/z', 'zom_fixture/w']) {
        write(root, `${skipped}/pubspec.yaml`, DART_PUBSPEC);
        fs.mkdirSync(path.join(root, skipped, 'lib', 'src'), { recursive: true });
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
        clearProjectScanCache();
        clearPromptScopeCache();
    });

    test('SS-1: async and sync scans agree; detected projects are not descended into', async () => {
        const sync = scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
        const asyncResult = await scanWorkspaceProjectsByDetectorsAsync({ traverseWholeWorkspace: true });
        assert.deepEqual(asyncResult, sync);
        assert.deepEqual(sync.map((p) => p.relativePath), ['packages/alpha', 'packages/beta', 'tools/gamma']);
        assert.ok(sync[0].attributes.types?.length, 'the detector attributes are reported');
    });

    test('SS-2: ztmp, target and the other ignored folders are not walked', async () => {
        const found = (await scanWorkspaceProjectsByDetectorsAsync({ traverseWholeWorkspace: true })).map((p) => p.relativePath);
        for (const skipped of ['ztmp', 'target', 'node_modules', 'build', '.hidden', 'zom_fixture']) {
            assert.ok(!found.some((rel) => rel.split('/').includes(skipped)), `${skipped} is not walked: ${found.join(', ')}`);
        }
    });

    test('SS-3: rules answered from the listing, symlinks followed, nested paths checked on disk', () => {
        const pkg = path.join(root, 'linked');
        fs.mkdirSync(path.join(pkg, 'lib', 'src'), { recursive: true });
        fs.symlinkSync(path.join(root, 'packages/alpha/pubspec.yaml'), path.join(pkg, 'pubspec.yaml'));
        const listing = listingOf(fs.readdirSync(pkg, { withFileTypes: true }));
        assert.equal(listing.get('pubspec.yaml'), 'link');
        const withListing = detectProjectAttributes(pkg, undefined, listing);
        assert.ok(withListing.detectorNames.includes('dart_package'), `linked pubspec is a file: ${withListing.detectorNames}`);
        assert.deepEqual(withListing, detectProjectAttributes(pkg), 'the same as without a listing');

        fs.rmSync(path.join(pkg, 'lib', 'src'), { recursive: true });
        const noSrc = detectProjectAttributes(pkg, undefined, listingOf(fs.readdirSync(pkg, { withFileTypes: true })));
        assert.ok(!noSrc.detectorNames.includes('dart_package'), '`lib/src` is checked on disk');
    });

    test('SS-4: the detector config is read once per scan', () => {
        // The module object itself: a namespace import only has getters.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const realFs: typeof import('fs') = require('fs');
        const original = realFs.readFileSync;
        let configReads = 0;
        realFs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
            if (String(file).endsWith('project_types.json') || String(file).endsWith('project_detection.json')) {
                configReads++;
            }
            return (original as (...a: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.readFileSync;
        try {
            scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
        } finally {
            realFs.readFileSync = original;
        }
        assert.equal(configReads, 1, 'the built-in config once (the workspace override does not exist here)');
    });

    test('SS-5: concurrent callers share one walk; reused within the TTL; fresh walks again', async () => {
        const original = fs.promises.readdir;
        let rootReads = 0;
        fs.promises.readdir = (async (dir: fs.PathLike, ...rest: unknown[]) => {
            if (String(dir) === root) { rootReads++; }
            return (original as (...a: unknown[]) => Promise<unknown>)(dir, ...rest);
        }) as typeof fs.promises.readdir;
        try {
            const [a, b] = await Promise.all([
                scanWorkspaceProjectsCached({ traverseWholeWorkspace: true }),
                scanWorkspaceProjectsCached({ traverseWholeWorkspace: true }),
            ]);
            assert.equal(a, b, 'the same result object');
            assert.equal(rootReads, 1, 'one walk for both');
            await scanWorkspaceProjectsCached({ traverseWholeWorkspace: true });
            assert.equal(rootReads, 1, 'reused after it finished');
            await scanWorkspaceProjectsCached({ traverseWholeWorkspace: true }, true);
            assert.equal(rootReads, 2, 'fresh walks again');
            await scanWorkspaceProjectsCached({ maxDepth: 2 });
            assert.equal(rootReads, 3, 'other options are another walk');
        } finally {
            fs.promises.readdir = original;
        }
    });

    test('SS-7: prompt scopes from the shared walks', async () => {
        const scan = await scanPromptScopes(root);
        assert.deepEqual(scan.map((s) => path.relative(root, s.dir)), ['docs/prompt', 'packages/beta/prompt']);
        assert.equal(scan[0].id, encodeURIComponent(path.join(root, 'docs/prompt')));
        assert.equal(scan[0].label, 'docs/prompt');

        const projects = await projectPromptScopes(root);
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

describe('tom_workspace detector', () => {
    test('SS-8: buildkit_master.yaml marks the workspace; the retired markers do not', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ss8-'));
        try {
            fs.mkdirSync(path.join(ws, '_ai'));
            fs.mkdirSync(path.join(ws, '_copilot_guidelines'));
            fs.writeFileSync(path.join(ws, 'tom_workspace.yaml'), '');
            fs.writeFileSync(path.join(ws, 'tom.code-workspace'), '{}');
            assert.ok(!detectProjectAttributes(ws).detectorNames.includes('tom_workspace'),
                'the retired markers alone are no workspace');
            fs.writeFileSync(path.join(ws, 'buildkit_master.yaml'), '');
            assert.ok(detectProjectAttributes(ws).detectorNames.includes('tom_workspace'));
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});
