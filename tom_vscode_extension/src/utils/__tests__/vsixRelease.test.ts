/**
 * The VSIX as the GitHub Release of tom_binaries (scripts/vsix-release.cjs, vscimpb70): every create_*_vsix script
 * checks the tom_vscode checkout at its start and publishes at its end. `gh` is a stub here (its calls recorded);
 * git runs for real against throw-away repositories (a bare remote and its clones).
 *
 *   VR-1 precheck: a clean, pushed checkout answers `ok <commit>`; uncommitted changes (named), unpushed commits
 *        (counted) and a branch without upstream answer `skip <why>`
 *   VR-2 publish: the first time `gh release create` with the asset tom-ai-extension.vsix and the notes, after that
 *        `gh release upload --clobber` and `gh release edit` with the notes; the README is committed (that file
 *        only) and pushed in the tom_binaries checkout; without a checkout it goes through the GitHub API
 *   VR-3 skipped, the VSIX left local, with a warning and nothing uploaded: --no-release, a dirty / unpushed
 *        checkout (the precheck's reason), HEAD moved during the build, no `gh` (how to install it), no login
 *        that may push (gh auth login)
 *   VR-4 the README: the link, the install command, commit, date, size, the script, the platforms whose binaries
 *        it carries with their build stamps, the platforms without them named; none at all said so
 *   VR-5 the scripts: each of the five create scripts (sh and ps1) checks at its start (before anything is built),
 *        publishes at its end and takes --no-release / -NoRelease; the nodart wrappers name themselves
 *   VR-6 one VSIX per platform (vscimpb103): each tom-ai-extension-<platform>.vsix its own asset (one upload),
 *        the README a download per platform with its binaries and build tools, the single tom-ai-extension.vsix
 *        kept and listed; a single publish lists the per-platform assets; files that are not one per platform
 *        are refused; the command line takes --vsix more than once
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as written */
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require(path.join(EXT, 'scripts', 'vsix-release.cjs'));
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb70_release-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
/** The real runner, with the test's committer identity. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require('child_process');
function realRun(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...GIT_ENV } });
    return { status: r.status, stdout: (r.stdout || '').replace(/\s+$/, ''), stderr: (r.stderr || '').trim() };
}

let n = 0;
/** A bare remote and a clone of it with one pushed commit. */
function repoPair(): { remote: string; clone: string } {
    const root = path.join(SANDBOX, `r${++n}`);
    fs.mkdirSync(root, { recursive: true });
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
    const clone = path.join(root, 'clone');
    git(root, 'clone', '--quiet', remote, clone);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'seed');
    git(clone, 'push', '--quiet', '-u', 'origin', 'HEAD:main');
    return { remote, clone };
}

/** A gh stub: the calls it gets, and whether the release exists yet. */
function ghStub(opts: { installed?: boolean; canPush?: boolean; exists?: boolean; assets?: Array<{ name: string; size: number; updatedAt: string }> } = {}) {
    const calls: string[][] = [];
    let exists = opts.exists === true;
    const run = (cmd: string, args: string[], o: Record<string, unknown> = {}) => {
        if (cmd !== 'gh') { return realRun(cmd, args, o); }
        calls.push(args);
        if (opts.installed === false) { return { status: null, stdout: '', stderr: 'spawn gh ENOENT' }; }
        if (args[0] === '--version') { return { status: 0, stdout: 'gh version 2.0.0', stderr: '' }; }
        if (args[0] === 'api' && args[1] === `repos/${release.REPO}`) { return { status: 0, stdout: opts.canPush === false ? 'false' : 'true', stderr: '' }; }
        if (args[0] === 'release' && args[1] === 'view') { return exists ? { status: 0, stdout: JSON.stringify({ assets: opts.assets ?? [] }), stderr: '' } : { status: 1, stdout: '', stderr: 'release not found' }; }
        if (args[0] === 'release' && args[1] === 'create') { exists = true; }
        if (args[0] === 'api' && args.includes('PUT')) { return { status: 0, stdout: '{}', stderr: '' }; }
        if (args[0] === 'api') { return { status: 1, stdout: '', stderr: 'Not Found' }; }
        return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, run };
}

/** A VSIX-like file (its content is not read when `platforms` is given). */
function vsixFile(): string {
    const file = path.join(SANDBOX, `t${++n}.vsix`);
    fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024));
    return file;
}
const PLATFORMS = [
    { platform: 'darwin-arm64', carried: ['tom_bs', 'tomspecs'], stamps: { tom_bs: '2026-11-11T17:23:07Z from 4113c17' } },
    { platform: 'linux-x64', carried: [], stamps: {} },
];

describe('the VSIX as a release', () => {
    test('VR-1: precheck', () => {
        const { clone } = repoPair();
        const ok = release.precheck({ repoDir: clone, run: realRun });
        assert.deepEqual(ok, { ok: true, commit: git(clone, 'rev-parse', 'HEAD') });
        assert.equal(release.precheckLine(ok), `ok ${ok.commit}`);
        fs.writeFileSync(path.join(clone, 'a.txt'), 'changed\n');
        fs.writeFileSync(path.join(clone, 'new.txt'), 'new\n');
        const dirty = release.precheck({ repoDir: clone, run: realRun });
        assert.equal(dirty.ok, false);
        assert.match(dirty.reason, /^2 uncommitted change\(s\) in tom_vscode: a\.txt, new\.txt$/);
        git(clone, 'add', '.');
        git(clone, 'commit', '--quiet', '-m', 'local');
        const unpushed = release.precheck({ repoDir: clone, run: realRun });
        assert.match(unpushed.reason, /1 unpushed commit\(s\) in tom_vscode \(not on origin\/main\): push them first/);
        git(clone, 'checkout', '--quiet', '-b', 'topic');
        assert.match(release.precheck({ repoDir: clone, run: realRun }).reason, /no upstream: push it first/);
        assert.deepEqual(release.parsePrecheck('skip because'), { ok: false, reason: 'because' });
        assert.equal(release.parsePrecheck('').ok, false);
    });

    test('VR-2: create, then upload; the README', () => {
        const tom = repoPair();
        const bins = repoPair();
        const commit = git(tom.clone, 'rev-parse', 'HEAD');
        const stub = ghStub();
        const logs: string[] = [];
        const deps = { run: stub.run, gh: 'gh', repoDir: tom.clone, binariesRepo: bins.clone, workDir: path.join(SANDBOX, 'work'), platforms: PLATFORMS, log: (l: string) => logs.push(l) };
        const first = release.publish({ vsix: vsixFile(), script: 'create_vsix.sh', precheck: `ok ${commit}` }, deps);
        assert.equal(first.updated, true, logs.join('\n'));
        assert.equal(first.created, true);
        const create = stub.calls.find((c) => c[0] === 'release' && c[1] === 'create')!;
        assert.deepEqual([create[2], path.basename(create[3]), create.slice(-2)], ['vscode-extension-latest', 'tom-ai-extension.vsix', ['-R', 'al-the-bear/tom_binaries']]);
        assert.ok(create.includes('--notes-file'));
        assert.match(logs.join('\n'), /🚀 Release created: https:\/\/github\.com\/al-the-bear\/tom_binaries\/releases\/download\/vscode-extension-latest\/tom-ai-extension\.vsix/);
        // The README: that file only, committed and pushed.
        const readme = git(bins.remote, 'show', 'main:vscode_extension/vsix/README.md');
        assert.match(readme, /Built from \| tom_vscode `[0-9a-f]{40}`/);
        assert.deepEqual(git(bins.remote, 'show', '--name-only', '--format=', 'main').split('\n'), ['vscode_extension/vsix/README.md']);
        // The second time: upload --clobber and the notes edited.
        stub.calls.length = 0;
        const second = release.publish({ vsix: vsixFile(), script: 'create_vsix.sh', precheck: `ok ${commit}` }, deps);
        assert.equal(second.created, false);
        assert.deepEqual(stub.calls.filter((c) => c[0] === 'release').map((c) => c.slice(0, 2).join(' ')), ['release view', 'release upload', 'release edit']);
        assert.ok(stub.calls.find((c) => c[1] === 'upload')!.includes('--clobber'));
        // No checkout: through the API.
        stub.calls.length = 0;
        const api = release.publish({ vsix: vsixFile(), script: 'create_vsix.sh', precheck: `ok ${commit}` }, { ...deps, binariesRepo: path.join(SANDBOX, 'none') });
        assert.equal(api.updated, true);
        const put = stub.calls.find((c) => c[0] === 'api' && c.includes('PUT'))!;
        assert.ok(put.includes(`repos/al-the-bear/tom_binaries/contents/vscode_extension/vsix/README.md`));
        const content = put.find((a) => a.startsWith('content='))!.slice('content='.length);
        assert.match(Buffer.from(content, 'base64').toString('utf8'), /# Tom AI VS Code extension — the latest VSIX/);
    });

    test('VR-3: skipped, the VSIX left local', () => {
        const tom = repoPair();
        const commit = git(tom.clone, 'rev-parse', 'HEAD');
        const attempt = (opts: Record<string, unknown>, stubOpts: Record<string, boolean> = {}) => {
            const stub = ghStub(stubOpts);
            const logs: string[] = [];
            const vsix = vsixFile();
            const r = release.publish({ vsix, script: 'create_vsix.sh', precheck: `ok ${commit}`, ...opts }, { run: stub.run, gh: 'gh', repoDir: tom.clone, binariesRepo: path.join(SANDBOX, 'none'), workDir: path.join(SANDBOX, 'w'), platforms: PLATFORMS, log: (l: string) => logs.push(l) });
            assert.equal(r.updated, false);
            assert.ok(!stub.calls.some((c) => c[0] === 'release' && ['create', 'upload'].includes(c[1])), 'nothing uploaded');
            assert.ok(fs.existsSync(vsix), 'the VSIX stays');
            const text = logs.join('\n');
            assert.match(text, /The release was not updated:/);
            assert.match(text, /The VSIX stays local: /);
            return text;
        };
        assert.match(attempt({ noRelease: true }), /--no-release given/);
        assert.match(attempt({ precheck: 'skip 2 uncommitted change(s) in tom_vscode: a.txt, b.txt' }), /2 uncommitted change\(s\) in tom_vscode: a\.txt, b\.txt[\s\S]*Commit and push tom_vscode/);
        assert.match(attempt({ precheck: 'skip 1 unpushed commit(s) in tom_vscode (not on origin/main): push them first' }), /1 unpushed commit/);
        assert.match(attempt({ precheck: 'ok 0000000000000000000000000000000000000000' }), /tom_vscode moved from 000000000000 to [0-9a-f]{12} while the VSIX was built/);
        assert.match(attempt({}, { installed: false }), /the GitHub CLI \(gh\) is not installed[\s\S]*https:\/\/cli\.github\.com[\s\S]*gh auth login/);
        assert.match(attempt({}, { canPush: false }), /gh has no login that may push to al-the-bear\/tom_binaries[\s\S]*Run `gh auth login`/);
    });

    test('VR-4: the README', () => {
        const text = release.readmeText({ commit: 'c'.repeat(40), date: '2026-11-11T17:30:00.000Z', size: 95.9 * 1024 * 1024, script: 'create_currentbinaries_vsix.sh', platforms: PLATFORMS });
        assert.match(text, /Download: <https:\/\/github\.com\/al-the-bear\/tom_binaries\/releases\/download\/vscode-extension-latest\/tom-ai-extension\.vsix>/);
        assert.match(text, /code --install-extension tom-ai-extension\.vsix/);
        assert.match(text, /\| Built from \| tom_vscode `c{40}` \|\n\| Built at \| 2026-11-11T17:30:00\.000Z \|\n\| Size \| 95\.9 MiB \|\n\| Packed by \| `create_currentbinaries_vsix\.sh` \|/);
        assert.match(text, /\| darwin-arm64 \| tom_bs, tomspecs \| tom_bs: 2026-11-11T17:23:07Z from 4113c17; tomspecs: no stamp \|/);
        assert.match(text, /On linux-x64, win32-x64 the extension runs without DartScript and CodeSpecs validation/);
        const none = release.readmeText({ commit: 'c', date: 'd', size: 1, script: 'create_vsix_nodart.sh', platforms: [{ platform: 'darwin-arm64', carried: [], stamps: {} }] });
        assert.match(none, /None: DartScript and CodeSpecs validation are not available on any platform/);
    });

    test('VR-5: the scripts', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');
        for (const name of ['create_vsix', 'create_currentbinaries_vsix', 'create_fleetcompiled_vsix', 'create_layerbinaries_vsix']) {
            const sh = read(`${name}.sh`);
            assert.match(sh, /--no-release\) NO_RELEASE=1/, `${name}.sh takes --no-release`);
            const pre = sh.indexOf('RELEASE_PRECHECK="$(tom_release_precheck "$SCRIPT_DIR" "$NO_RELEASE")"');
            assert.ok(pre > 0, `${name}.sh checks at its start`);
            assert.ok(pre < sh.indexOf('"$SCRIPT_DIR/install_extension.sh"'), `${name}.sh: before the build`);
            const pub = sh.indexOf('tom_release_publish "$SCRIPT_DIR"');
            assert.ok(pub > sh.indexOf('"$SCRIPT_DIR/install_extension.sh"') && pub < sh.lastIndexOf('Finished at'), `${name}.sh publishes at its end`);
            const ps = read(`${name}.ps1`);
            assert.match(ps, /\[switch\]\$NoRelease/, `${name}.ps1 takes -NoRelease`);
            assert.match(ps, /'--no-release'\) \{ \$NoRelease = \$true \}/, `${name}.ps1 takes --no-release`);
            const pp = ps.indexOf('$ReleasePrecheck = Get-TomReleasePrecheck $ScriptDir $NoRelease');
            assert.ok(pp > 0 && pp < ps.indexOf("install_extension.ps1')"), `${name}.ps1 checks before the build`);
            assert.ok(ps.indexOf('Publish-TomRelease $ScriptDir') > ps.indexOf("install_extension.ps1')"), `${name}.ps1 publishes at its end`);
        }
        assert.ok(read('create_currentbinaries_vsix.sh').indexOf('tom_release_precheck') < read('create_currentbinaries_vsix.sh').indexOf('compile_and_install.sh" --binaries-only'), 'before this host\'s binaries are built');
        assert.match(read('create_vsix_nodart.sh'), /export TOM_RELEASE_SCRIPT="create_vsix_nodart\.sh"\nexec "\$SCRIPT_DIR\/create_vsix\.sh" --no-dart "\$\{PASS\[@\]\}"/);
        assert.match(read('create_vsix_nodart.ps1'), /\$env:TOM_RELEASE_SCRIPT = 'create_vsix_nodart\.ps1'[\s\S]*create_vsix\.ps1'\) -NoDart -NoRelease:\$NoRelease/);
        assert.match(read('scripts/install_summary.sh'), /tom_release_publish\(\) \{[\s\S]*node scripts\/vsix-release\.cjs "\$\{args\[@\]\}" \) \|\| true/, 'the step never fails the script');
    });

    test('VR-6: one VSIX per platform', () => {
        const tom = repoPair();
        const bins = repoPair();
        const commit = git(tom.clone, 'rev-parse', 'HEAD');
        const dir = path.join(SANDBOX, 'split');
        fs.mkdirSync(dir, { recursive: true });
        const files = ['darwin-arm64', 'linux-x64', 'win32-x64'].map((p, i) => {
            const f = path.join(dir, `tom-ai-extension-${p}.vsix`);
            fs.writeFileSync(f, Buffer.alloc((i + 1) * 1024 * 1024));
            return f;
        });
        const single = { name: 'tom-ai-extension.vsix', size: 80 * 1024 * 1024, updatedAt: '2026-11-10T09:00:00Z' };
        const stub = ghStub({ exists: true, assets: [single, { name: 'tom-ai-extension-linux-x64.vsix', size: 1, updatedAt: 'old' }] });
        const logs: string[] = [];
        const platformsOf = (_file: string, platform: string) => [platform === 'linux-x64'
            ? { platform, carried: [], stamps: {}, tools: [] }
            : { platform, carried: ['tom_bs', 'tomspecs'], stamps: { tom_bs: '2026-11-14T10:00:00Z from abc' }, tools: ['buildkit', 'testkit'] }];
        const deps = { run: stub.run, gh: 'gh', repoDir: tom.clone, binariesRepo: bins.clone, workDir: path.join(SANDBOX, 'work6'), platforms: platformsOf, log: (l: string) => logs.push(l) };
        const r = release.publish({ vsix: files, script: 'create_layerbinaries_vsix.sh', precheck: `ok ${commit}` }, deps);
        assert.equal(r.updated, true, logs.join('\n'));
        assert.deepEqual(r.assets, ['tom-ai-extension-darwin-arm64.vsix', 'tom-ai-extension-linux-x64.vsix', 'tom-ai-extension-win32-x64.vsix']);
        const upload = stub.calls.filter((c) => c[0] === 'release' && c[1] === 'upload');
        assert.equal(upload.length, 1, 'one upload for all of them');
        assert.deepEqual(upload[0].slice(3, 6).map((f) => path.basename(f)), r.assets);
        assert.ok(upload[0].includes('--clobber'));
        assert.ok(!stub.calls.some((c) => c.includes('delete-asset')), 'the single asset is kept');
        assert.match(logs.join('\n'), /🚀 Release updated: https:\/\/github\.com\/al-the-bear\/tom_binaries\/releases\/download\/vscode-extension-latest\/tom-ai-extension-darwin-arm64\.vsix, .*linux-x64\.vsix, .*win32-x64\.vsix/);
        const readme = git(bins.remote, 'show', 'main:vscode_extension/vsix/README.md');
        assert.match(readme, /One VSIX per platform: take the one for the machine it is installed on/);
        assert.match(readme, /\| darwin-arm64 \| \[`tom-ai-extension-darwin-arm64\.vsix`\]\(https:\/\/github\.com\/al-the-bear\/tom_binaries\/releases\/download\/vscode-extension-latest\/tom-ai-extension-darwin-arm64\.vsix\) \| 1\.0 MiB \| tom_bs \(2026-11-14T10:00:00Z from abc\), tomspecs \| buildkit, testkit \|/);
        assert.match(readme, /\| linux-x64 \| .* \| 2\.0 MiB \| none \(no DartScript, no CodeSpecs validation\) \| none \|/);
        assert.match(readme, /\| win32-x64 \| \[`tom-ai-extension-win32-x64\.vsix`\]/);
        assert.match(readme, /code --install-extension tom-ai-extension-<platform>\.vsix/);
        assert.match(readme, /## Also in the release\n\n- \[`tom-ai-extension\.vsix`\]\(https:[^)]*\/tom-ai-extension\.vsix\) \(80\.0 MiB, updated 2026-11-10T09:00:00Z\): the single-platform build of `create_vsix`/);
        assert.doesNotMatch(readme, /Also in the release[\s\S]*tom-ai-extension-linux-x64\.vsix\]\([^)]*\) \(0\.0 MiB/, 'the replaced asset is not listed twice');

        // A single publish lists the per-platform assets.
        const stub2 = ghStub({ exists: true, assets: [{ name: 'tom-ai-extension-win32-x64.vsix', size: 2 * 1024 * 1024, updatedAt: '2026-11-14T11:00:00Z' }] });
        const one = release.publish({ vsix: vsixFile(), script: 'create_vsix.sh', precheck: `ok ${commit}` }, { ...deps, run: stub2.run, platforms: PLATFORMS });
        assert.equal(one.updated, true);
        assert.deepEqual(one.assets, ['tom-ai-extension.vsix']);
        assert.match(one.text, /## Also in the release\n\nThe per-platform VSIX of the last multi-platform build \(each installs only on its platform\):\n\n- \[`tom-ai-extension-win32-x64\.vsix`\]/);

        // Not one per platform: refused, nothing uploaded.
        const stub3 = ghStub({ exists: true });
        const twice = release.publish({ vsix: [files[0], vsixFile()], script: 's', precheck: `ok ${commit}` }, { ...deps, run: stub3.run });
        assert.equal(twice.updated, false);
        assert.match(twice.reason, /not one VSIX per platform/);
        assert.ok(!stub3.calls.some((c) => c[1] === 'upload' || c[1] === 'create'));

        // The command line: --vsix more than once.
        const cli = spawnSync(process.execPath, [path.join(EXT, 'scripts', 'vsix-release.cjs'), 'publish', '--vsix', files[0], '--vsix', files[1], '--script', 's', '--precheck', 'ok x', '--no-release'], { encoding: 'utf8' });
        assert.match(cli.stdout, /The VSIX stays local: .*tom-ai-extension-darwin-arm64\.vsix, .*tom-ai-extension-linux-x64\.vsix/);
    });
});
