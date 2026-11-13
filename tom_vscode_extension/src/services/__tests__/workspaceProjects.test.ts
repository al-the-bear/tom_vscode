/* eslint-disable @typescript-eslint/naming-convention -- PATH and the "*" platform key are external names */
/**
 * The workspace's projects from `buildkit :projects --json`
 * (services/workspaceProjects.ts, build_tom build_cleanup8).
 *
 *   WP-1 buildkit is looked for in turn (qrfix14): bridge.executables.buildkit, bridge.binaryPath, the workspace's
 *        binaries layer, $TOM_BINARY_PATH/<platform>/, PATH — the first that has it wins; none: every place looked
 *        at (an unset TOM_BINARY_PATH named as such); ~/.tom/bin is never looked at (build_tom build_cleanup1002)
 *   WP-2 the JSON document is read after any lines printed before it; a foreign formatVersion is refused
 *   WP-3 a listing is reused for 30 s per root, `fresh` runs again, a failed listing is not kept
 *   WP-4 a binaryPath naming an unset variable (`${env:TOM_BINARY_PATH}` in a VS Code started from the Dock) is
 *        passed with a note, and buildkit is still found in the workspace's binaries layer
 *   WP-5 no buildkit, or one that cannot list: the JavaScript port lists the projects (`source: 'javascript'`) with
 *        the diagnostic `fallback` {kind, reason, searched, binary?, buildkitError?, hint}; the hint names the unset
 *        variable and launchctl, or tom_build_kit 1.18.0; a buildkit that lists: `source: 'buildkit'`
 *   WP-6 the notifier is told once per reason and window; the notice's line and details (searched, answer, hint)
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
    projectListingNoticeLine,
    projectListingNoticeMarkdown,
    projectsSourceOf,
    resetProjectListingNotices,
    resolveBuildkitBinary,
    setProjectListingNotifier,
    type BuildkitRunner,
    type ListingFallback,
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
    test('WP-1: every place in turn, the first that has it', () => {
        const ws = path.join(tmp, 'ws1');
        const configured = file('cfg/buildkit');
        const binDir = file('bindir/buildkit');
        const layer = file(`ws1/tom_binaries/tom/${platform}/buildkit`);
        const inTbp = file(`tbp1/${platform}/buildkit`);
        // A buildkit under ~/.tom/bin is not a place any more: a stale copy there is never run.
        file(`home1/.tom/bin/${platform}/buildkit`);
        const onPath = file('pathdir/buildkit');
        const env = { PATH: path.join(tmp, 'pathdir'), TOM_BINARY_PATH: path.join(tmp, 'tbp1'), HOME: path.join(tmp, 'home1') };
        const find = (config: object): string | undefined => resolveBuildkitBinary(ws, config, env, platform).binary;

        assert.equal(find({ executables: { buildkit: { '*': configured } }, binaryPath: { '*': path.dirname(binDir) } }), configured);
        assert.equal(find({ binaryPath: { '*': path.dirname(binDir) } }), binDir, 'bridge.binaryPath');
        // A configured place without the file is passed over: the next place is tried.
        assert.equal(find({ executables: { buildkit: { '*': path.join(tmp, 'gone') } }, binaryPath: { '*': path.join(tmp, 'empty-dir') } }), layer);
        fs.rmSync(layer);
        assert.equal(find({}), inTbp, '$TOM_BINARY_PATH/<platform>');
        fs.rmSync(inTbp);
        assert.equal(find({}), onPath, 'PATH, not ~/.tom/bin');

        const none = resolveBuildkitBinary(path.join(tmp, 'ws-none'), { binaryPath: { '*': path.join(tmp, 'no-layer') } }, { PATH: path.join(tmp, 'empty') }, platform);
        assert.equal(none.binary, undefined);
        assert.deepEqual(none.searched, [
            `${path.join(tmp, 'no-layer', 'buildkit')} (bridge.binaryPath)`,
            `${path.join(tmp, 'ws-none', 'tom_binaries', 'tom', platform, 'buildkit')} (the workspace's binaries layer)`,
            `${path.join('$TOM_BINARY_PATH', platform, 'buildkit')} (TOM_BINARY_PATH not set in this process)`,
            'buildkit on PATH',
        ]);
    });

    test('WP-4: a binaryPath whose variable is unset still finds buildkit in the workspace layer', () => {
        const ws = path.join(tmp, 'ws4');
        const layer = file(`ws4/tom_binaries/tom/${platform}/buildkit`);
        const unexpanded = '${env:TOM_BINARY_PATH}/' + platform + '/';
        const config = { binaryPath: { [platform]: unexpanded } };
        const r = resolveBuildkitBinary(ws, config, { PATH: '' }, platform);
        assert.equal(r.binary, layer);
        assert.equal(r.searched[0], `${path.join(unexpanded, 'buildkit')} (bridge.binaryPath: \${env:TOM_BINARY_PATH} not set in this process)`);
        // Set, the configured folder is used.
        const own = file(`tbp/${platform}/buildkit`);
        assert.equal(resolveBuildkitBinary(ws, config, { PATH: '', TOM_BINARY_PATH: path.join(tmp, 'tbp') }, platform).binary, own);
        // Unset, and no layer: none (a copy under ~/.tom/bin is not looked at).
        fs.rmSync(layer);
        file(`home4/.tom/bin/${platform}/buildkit`);
        assert.equal(resolveBuildkitBinary(ws, config, { PATH: '', HOME: path.join(tmp, 'home4') }, platform).binary, undefined);
    });

    test('WP-5: the JavaScript port when buildkit is missing or cannot list', async () => {
        const told: ListingFallback[] = [];
        setProjectListingNotifier((f) => told.push(f));
        resetProjectListingNotices();
        try {
            const project = { id: 'x', name: 'x', path: 'x', absolutePath: '/r/x', language: 'dart', type: 'dart', natures: ['dart'] };
            const jsLister = (): { projects: Array<typeof project> } => ({ projects: [project] });
            const root = path.join(tmp, 'ws5');
            const missing = await listWorkspaceProjects(root, {
                fresh: true, jsLister, env: { PATH: '' },
                config: { binaryPath: { [platform]: '${env:TOM_BINARY_PATH}/' + platform + '/' } },
            });
            assert.ok(missing.ok && missing.source === 'javascript');
            assert.deepEqual(missing.projects, [project]);
            assert.equal(missing.fallback.kind, 'notFound');
            assert.match(missing.fallback.hint, /\$\{env:TOM_BINARY_PATH\}.*launchctl setenv TOM_BINARY_PATH/);
            assert.match(projectsSourceOf(missing) ?? '', /JavaScript port/);

            const binary = file('ws5bin/buildkit');
            const config = { executables: { buildkit: { '*': binary } } };
            const failed = await listWorkspaceProjects(root, {
                fresh: true, jsLister, config,
                runner: async () => ({ exitCode: 64, stdout: '', stderr: 'Unknown command: :projects\nError: Unknown command: projects' }),
            });
            assert.ok(failed.ok && failed.source === 'javascript');
            assert.equal(failed.fallback.kind, 'failed');
            assert.equal(failed.fallback.binary, binary);
            assert.match(failed.fallback.reason, /could not list the projects: exit 64: Unknown command: :projects$/);
            assert.match(failed.fallback.buildkitError ?? '', /Error: Unknown command: projects/);
            assert.match(failed.fallback.hint, /tom_build_kit 1\.18\.0/);

            const listed = await listWorkspaceProjects(root, { fresh: true, config, runner: async () => ({ exitCode: 0, stdout: doc([project]), stderr: '' }) });
            assert.ok(listed.ok && listed.source === 'buildkit');
            assert.equal(projectsSourceOf(listed), `buildkit :projects --all --json (${binary})`);
            assert.deepEqual(told.map((f) => f.kind), ['notFound', 'failed'], 'buildkit listing: nothing told');
        } finally {
            setProjectListingNotifier(undefined);
            clearProjectListingCache();
        }
    });

    test('WP-6: told once per reason; the notice', async () => {
        const told: ListingFallback[] = [];
        setProjectListingNotifier((f) => told.push(f));
        resetProjectListingNotices();
        try {
            const opts = { fresh: true, jsLister: () => ({ projects: [] }), env: { PATH: '' }, config: { binaryPath: { '*': path.join(tmp, 'nothing6') } } };
            await listWorkspaceProjects(path.join(tmp, 'ws6'), opts);
            await listWorkspaceProjects(path.join(tmp, 'ws6'), opts);
            assert.equal(told.length, 1, 'once per reason and window');
            const f = told[0];
            assert.equal(projectListingNoticeLine(f), 'Tom AI: buildkit was not found — the project list comes from the extension\'s JavaScript port for now.');
            const md = projectListingNoticeMarkdown({ ...f, buildkitError: 'exit 64: Unknown command' }, '/ws');
            assert.match(md, /^# Project list: buildkit not available/);
            assert.ok(f.searched.every((s) => md.includes(`- \`${s}\``)), 'every place looked at');
            assert.match(md, /## What buildkit answered\n\n```text\nexit 64: Unknown command\n```/);
            assert.match(md, /## How to fix it\n\n/);
            assert.match(md, /Workspace: `\/ws`/);
        } finally {
            setProjectListingNotifier(undefined);
            clearProjectListingCache();
        }
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
        const failed = await listWorkspaceProjects(root, { config, runner, now, fresh: true, jsLister: () => { throw new Error('no listing'); } });
        assert.equal(failed.ok, false, 'buildkit and the JavaScript port both failed');
        fail = false;
        const again = await listWorkspaceProjects(root, { config, runner, now });
        assert.ok(again.ok && again.source === 'buildkit', 'the failure was not cached');
        assert.equal(runs, 5);
        clearProjectListingCache();
    });
});
