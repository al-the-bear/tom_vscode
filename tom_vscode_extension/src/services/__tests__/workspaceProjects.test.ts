/* eslint-disable @typescript-eslint/naming-convention -- PATH and the "*" platform key are external names */
/**
 * The workspace's projects from `buildkit :projects --json`
 * (services/workspaceProjects.ts, build_tom build_cleanup8).
 *
 *   WP-1 buildkit is found configured first, then in the binaries layer, then on PATH; none: the places looked at
 *   WP-2 the JSON document is read after any lines printed before it; a foreign formatVersion is refused
 *   WP-3 a listing is reused for 30 s per root, `fresh` runs again, a failed listing is not kept
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    CACHE_MS,
    clearProjectListingCache,
    listWorkspaceProjects,
    parseProjectsJson,
    resolveBuildkitBinary,
    type BuildkitRunner,
} from '../workspaceProjects.js';
import { getCurrentPlatform } from '../../utils/executableResolver.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsprojects-'));
const platform = getCurrentPlatform();

function file(rel: string): string {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
    return abs;
}

const doc = (projects: unknown[]) => JSON.stringify({ formatVersion: 1, tool: 'buildkit', root: '/ws', count: projects.length, projects });

describe('workspaceProjects', () => {
    test('WP-1: configured, then the binaries layer, then PATH', () => {
        const ws = path.join(tmp, 'ws1');
        const configured = file('cfg/buildkit');
        const layer = file(`ws1/tom_binaries/tom/${platform}/buildkit`);
        const onPath = file('pathdir/buildkit');
        const env = { PATH: path.join(tmp, 'pathdir') };

        assert.equal(resolveBuildkitBinary(ws, { executables: { buildkit: { '*': configured } } }, env, platform).binary, configured);
        assert.equal(resolveBuildkitBinary(ws, {}, env, platform).binary, layer);
        fs.rmSync(layer);
        assert.equal(resolveBuildkitBinary(ws, {}, env, platform).binary, onPath);
        // A configured file that does not exist is passed over.
        assert.equal(resolveBuildkitBinary(ws, { executables: { buildkit: { '*': path.join(tmp, 'gone') } } }, env, platform).binary, onPath);

        const none = resolveBuildkitBinary(path.join(tmp, 'ws-none'), { binaryPath: { '*': path.join(tmp, 'no-layer') } }, { PATH: path.join(tmp, 'empty') }, platform);
        assert.equal(none.binary, undefined);
        assert.deepEqual(none.searched, [path.join(tmp, 'no-layer', 'buildkit'), 'buildkit on PATH']);
    });

    test('WP-2: the document after other lines; a foreign formatVersion is refused', () => {
        const parsed = parseProjectsJson('Environment warnings:\n  - x\n' + doc([
            { id: 'A', name: 'a', path: 'p/a', absolutePath: '/ws/p/a', language: 'go', type: 'go', natures: ['go', 'git'] },
        ]));
        assert.equal(parsed.root, '/ws');
        assert.deepEqual(parsed.projects, [
            { id: 'A', name: 'a', path: 'p/a', absolutePath: '/ws/p/a', language: 'go', type: 'go', natures: ['go', 'git'] },
        ]);
        assert.throws(() => parseProjectsJson(JSON.stringify({ formatVersion: 7, projects: [] })), /formatVersion 7 is not 1/);
        assert.throws(() => parseProjectsJson('no listing'), /no JSON document/);
    });

    test('WP-3: reused for 30 s per root; fresh runs again; a failure is not kept', async () => {
        clearProjectListingCache();
        const binary = file('cache/buildkit');
        const config = { executables: { buildkit: { '*': binary } } };
        let runs = 0;
        let fail = false;
        const runner: BuildkitRunner = async () => {
            runs++;
            return fail ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: doc([]), stderr: '' };
        };
        let clock = 1_000_000;
        const now = () => clock;
        const root = path.join(tmp, 'cache-root');

        await listWorkspaceProjects(root, { config, runner, now });
        await listWorkspaceProjects(root, { config, runner, now });
        assert.equal(runs, 1, 'the second call reuses the listing');
        clock += CACHE_MS;
        await listWorkspaceProjects(root, { config, runner, now });
        assert.equal(runs, 2, 'expired after CACHE_MS');
        await listWorkspaceProjects(root, { config, runner, now, fresh: true });
        assert.equal(runs, 3, 'fresh runs again');

        fail = true;
        const failed = await listWorkspaceProjects(root, { config, runner, now, fresh: true });
        assert.equal(failed.ok, false);
        fail = false;
        const again = await listWorkspaceProjects(root, { config, runner, now });
        assert.equal(again.ok, true, 'the failure was not cached');
        assert.equal(runs, 5);
        clearProjectListingCache();
    });
});
