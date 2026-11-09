/**
 * The binaries layer (scripts/binaries-layer.cjs) and the fleet build
 * (scripts/fleet-binaries.cjs): a from-source build leaves this host's tom_bs
 * and validate_codespecs in tom_binaries/tom/<platform>/, committed and
 * pushed; a VSIX for several platforms takes theirs from there and reports
 * how current each is. Run for real against throw-away git repositories (a
 * bare remote and its clones); the fleet driver's SSH side is checked through
 * its pure helpers (no host is contacted).
 *
 *   BL-1 publish: copies tom_bs, validate_codespecs and its stamp, writes tom_bs.build.json from the stamp
 *        tom_bs prints, commits exactly those files with a message naming the build, pushes; a second
 *        publish of the same build commits nothing
 *   BL-2 a refused push leaves the commit local (exit 3); --ff fast-forwards a layer that is only behind
 *        and pushes; --ff refuses a layer with commits of its own (exit 1) and commits nothing
 *   BL-3 bundle: the listed platforms' binaries into the extension's bin/<platform>/ with their stamps,
 *        a platform without binaries named
 *   BL-4 report verdicts: no stamp, a tom_bs commit this checkout lacks, validate_codespecs fresh / stale
 *   BL-5 the bridge source hash in tom_bs's stamp: blind to `// Generated:` lines, CRLF and the versioner
 *        stamp file, moved by a real edit; a stamp whose hash matches the sources here is fresh (uncommitted
 *        edits included)
 *   FB-1 the fleet_hosts registry: entries, build flags, comments ignored, the block's end
 *   FB-2 platform names from uname, Windows paths, the remote build commands (nice on Linux; PowerShell
 *        -File -BinariesOnly with TOM_LAYER_FF on Windows), a probe without `$`
 *   FB-3 the probe answer read behind login noise; hosts not level with this one named per repo
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables and repository paths as written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
const LAYER_SCRIPT = path.join(EXT, 'scripts', 'binaries-layer.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const layer = require(LAYER_SCRIPT);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fleet = require(path.join(EXT, 'scripts', 'fleet-binaries.cjs'));

const GIT_ENV = {
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const PLATFORM = 'linux-x64';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

/** A bare remote with one commit and a clone of it as `tom_binaries`; the layer folder is its tom/. */
function makeLayer(): { root: string; remote: string; repo: string; layerDir: string; bin: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binaries-layer-'));
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
    const seed = path.join(root, 'seed');
    git(root, 'clone', '--quiet', remote, seed);
    fs.mkdirSync(path.join(seed, 'tom'));
    fs.writeFileSync(path.join(seed, 'tom', 'README'), 'layer\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'seed');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    const repo = path.join(root, 'tom_binaries');
    git(root, 'clone', '--quiet', remote, repo);
    const bin = path.join(root, 'ext_bin');
    fs.mkdirSync(path.join(bin, PLATFORM), { recursive: true });
    return { root, remote, repo, layerDir: path.join(repo, 'tom'), bin };
}

/** A fake tom_bs that prints the versioner stamp and exits, and a validate_codespecs with its stamp. */
function writeBuild(bin: string, build: number, commit = 'abcdef0'): void {
    const dir = path.join(bin, PLATFORM);
    fs.writeFileSync(path.join(dir, 'tom_bs'), `#!/bin/sh\necho "[BSTART] Version: 1.0.0+${build}.${commit} (2026-11-09T10:00:00Z) [Dart 3.13.7]"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'validate_codespecs'), `#!/bin/sh\necho ${build}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'validate_codespecs.build.json'), JSON.stringify({
        format: 'validate-codespecs-build', formatVersion: 1, platform: PLATFORM, builtAt: '2026-11-09T10:00:00.000Z',
        sourceHash: `hash${build}`, sourceFiles: 3, clitool: { head: '1234567890abcdef', dirty: false },
    }, null, 2));
}

function runLayer(env: { layerDir: string; bin: string }, ...args: string[]) {
    return spawnSync('node', [LAYER_SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, TOM_BINARIES_LAYER: env.layerDir, TOM_BINARIES_EXT_BIN: env.bin, TOM_BINARIES_HOST_PLATFORM: PLATFORM },
    });
}

describe('binaries layer', () => {
    test('BL-1: publish copies, stamps, commits those files and pushes', () => {
        const t = makeLayer();
        writeBuild(t.bin, 41);
        fs.writeFileSync(path.join(t.layerDir, 'unrelated.txt'), 'not ours\n');
        const r = runLayer(t, 'publish');
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const dir = path.join(t.layerDir, PLATFORM);
        for (const f of ['tom_bs', 'validate_codespecs', 'validate_codespecs.build.json', 'tom_bs.build.json']) {
            assert.ok(fs.existsSync(path.join(dir, f)), f);
        }
        assert.ok((fs.statSync(path.join(dir, 'tom_bs')).mode & 0o111) !== 0, 'tom_bs executable');
        const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'tom_bs.build.json'), 'utf8'));
        assert.equal(stamp.format, 'tom-bs-build');
        assert.equal(stamp.platform, PLATFORM);
        assert.equal(stamp.version, '1.0.0');
        assert.equal(stamp.build, 41);
        assert.equal(stamp.commit, 'abcdef0');
        assert.equal(stamp.builtOn, os.hostname());
        assert.equal(stamp.builtAt, '2026-11-09T10:00:00.000Z', 'the versioner time, not the publish time');
        assert.ok(stamp.publishedAt);
        const files = git(t.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
        assert.deepEqual(files, ['tom_bs', 'tom_bs.build.json', 'validate_codespecs', 'validate_codespecs.build.json'].map((f) => `tom/${PLATFORM}/${f}`).sort());
        assert.match(git(t.repo, 'log', '-1', '--format=%s'), new RegExp(`^tom_bs 1\\.0\\.0\\+41 \\(abcdef0\\), validate_codespecs \\(clitool 12345678\\) for ${PLATFORM}, built on `));
        assert.equal(git(t.remote, 'rev-parse', 'main'), git(t.repo, 'rev-parse', 'HEAD'), 'pushed');
        assert.match(git(t.repo, 'status', '--porcelain'), /\?\? tom\/unrelated\.txt/, 'other files left alone');
        const head = git(t.repo, 'rev-parse', 'HEAD');
        const again = runLayer(t, 'publish');
        assert.equal(again.status, 0);
        assert.match(again.stdout, /already holds this build for linux-x64/, 'the same build keeps its stamp');
        assert.equal(git(t.repo, 'rev-parse', 'HEAD'), head);
    });

    test('BL-2: refused push, --ff on a behind layer, --ff on a layer with own commits', () => {
        const t = makeLayer();
        // Another host pushes first: this clone is behind.
        const other = path.join(t.root, 'other');
        git(t.root, 'clone', '--quiet', t.remote, other);
        fs.writeFileSync(path.join(other, 'tom', 'other.txt'), 'x\n');
        git(other, 'add', '.');
        git(other, 'commit', '--quiet', '-m', 'other host');
        git(other, 'push', '--quiet', 'origin', 'HEAD:main');

        writeBuild(t.bin, 42);
        const refused = runLayer(t, 'publish');
        assert.equal(refused.status, 3, refused.stdout + refused.stderr);
        assert.match(refused.stderr, /commit stays local: the push was refused/);
        assert.match(git(t.repo, 'log', '-1', '--format=%s'), /^tom_bs 1\.0\.0\+42/, 'committed locally');

        // A layer with commits of its own: --ff refuses and adds none.
        const head = git(t.repo, 'rev-parse', 'HEAD');
        writeBuild(t.bin, 43);
        const own = runLayer(t, 'publish', '--ff');
        assert.equal(own.status, 1);
        assert.match(own.stderr, /has 1 commit\(s\) not on origin\/main: reconcile first/);
        assert.equal(git(t.repo, 'rev-parse', 'HEAD'), head);

        // Only behind: --ff fast-forwards, then commits on top and pushes.
        const fresh = path.join(t.root, 'fresh');
        git(t.root, 'clone', '--quiet', t.remote, fresh);
        fs.writeFileSync(path.join(other, 'tom', 'other2.txt'), 'y\n');
        git(other, 'add', '.');
        git(other, 'commit', '--quiet', '-m', 'other host again');
        git(other, 'push', '--quiet', 'origin', 'HEAD:main');
        const ff = runLayer({ layerDir: path.join(fresh, 'tom'), bin: t.bin }, 'publish', '--ff');
        assert.equal(ff.status, 0, ff.stdout + ff.stderr);
        assert.match(ff.stdout, /fast-forwarded by 1 commit/);
        assert.equal(git(t.remote, 'rev-parse', 'main'), git(fresh, 'rev-parse', 'HEAD'));
        assert.equal(git(fresh, 'log', '-2', '--format=%s').split('\n')[1], 'other host again');
    });

    test('BL-3: bundle copies the binaries, not the stamps', () => {
        const t = makeLayer();
        const dir = path.join(t.layerDir, 'win32-x64');
        fs.mkdirSync(dir, { recursive: true });
        for (const f of ['tom_bs.exe', 'validate_codespecs.exe', 'tom_bs.build.json', 'validate_codespecs.build.json']) {
            fs.writeFileSync(path.join(dir, f), f);
        }
        const r = runLayer(t, 'bundle', '--platforms', 'win32-x64,darwin-x64');
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(fs.readdirSync(path.join(t.bin, 'win32-x64')).sort(), ['tom_bs.build.json', 'tom_bs.exe', 'validate_codespecs.build.json', 'validate_codespecs.exe'], 'the stamps too (.vscodeignore keeps them out of the VSIX)');
        assert.match(fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf8'), /^bin\/\*\/\*\.build\.json$/m);
        assert.match(r.stdout, /darwin-x64: no tom_bs or validate_codespecs in the binaries layer/);
        assert.match(r.stdout, /Bundled 2 binaries from the binaries layer/);
        assert.deepEqual(layer.DEFAULT_PLATFORMS, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
    });

    test('BL-4: report verdicts', () => {
        const t = makeLayer();
        const dir = path.join(t.layerDir, PLATFORM);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'tom_bs'), 'x');
        fs.writeFileSync(path.join(dir, 'validate_codespecs'), 'x');
        let d = layer.describePlatform(PLATFORM, { layer: t.layerDir, currentHash: 'h1' });
        assert.equal(d.tomBs.state, 'unknown');
        assert.match(d.tomBs.text, /no build stamp/);
        assert.equal(d.validateCodespecs.state, 'unknown');
        fs.writeFileSync(path.join(dir, 'tom_bs.build.json'), JSON.stringify({ version: '1.0.0', build: 7, commit: '0000000', builtAt: '2026-11-09T10:00:00.000Z', builtOn: 'h' }));
        fs.writeFileSync(path.join(dir, 'validate_codespecs.build.json'), JSON.stringify({ sourceHash: 'h1', builtAt: '2026-11-09T10:00:00.000Z' }));
        d = layer.describePlatform(PLATFORM, { layer: t.layerDir, currentHash: 'h1' });
        assert.equal(d.tomBs.state, 'unknown', 'a commit this checkout does not have');
        assert.match(d.tomBs.text, /^tom_bs 1\.0\.0\+7 \(0000000, built 2026-11-09 10:00 on h\)/);
        assert.equal(d.validateCodespecs.state, 'fresh');
        d = layer.describePlatform(PLATFORM, { layer: t.layerDir, currentHash: 'h2' });
        assert.equal(d.validateCodespecs.state, 'stale');
        assert.match(d.validateCodespecs.text, /older than the sources/);
        assert.deepEqual(layer.describePlatform('darwin-x64', { layer: t.layerDir, currentHash: 'h1' }), { platform: 'darwin-x64', tomBs: null, validateCodespecs: null });
    });
});

describe('bridge source hash', () => {
    test('BL-5: what moves the hash, and the verdict it gives', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hash-'));
        const bridge = path.join(root, 'tom_vscode_bridge');
        fs.mkdirSync(path.join(bridge, 'lib', 'src'), { recursive: true });
        fs.mkdirSync(path.join(bridge, 'bin'));
        fs.writeFileSync(path.join(bridge, 'pubspec.yaml'), 'name: b\n');
        fs.writeFileSync(path.join(bridge, 'bin', 'tom_bs.dart'), 'void main() {}\n');
        fs.writeFileSync(path.join(bridge, 'lib', 'a.b.dart'), '// Generated: 2026-11-09\nclass A {}\n');
        fs.writeFileSync(path.join(bridge, 'lib', 'src', 'version.versioner.dart'), 'const v = 1;\n');
        const h0 = layer.bridgeSourceHash(bridge);
        fs.writeFileSync(path.join(bridge, 'lib', 'a.b.dart'), '// Generated: 2026-11-10\r\nclass A {}\r\n');
        fs.writeFileSync(path.join(bridge, 'lib', 'src', 'version.versioner.dart'), 'const v = 2;\n');
        assert.equal(layer.bridgeSourceHash(bridge), h0, 'stamps and line endings do not count');
        fs.writeFileSync(path.join(bridge, 'lib', 'a.b.dart'), 'class A { int x = 1; }\n');
        assert.notEqual(layer.bridgeSourceHash(bridge), h0, 'a real edit does');

        const t = makeLayer();
        const dir = path.join(t.layerDir, PLATFORM);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'tom_bs'), 'x');
        fs.writeFileSync(path.join(dir, 'tom_bs.build.json'), JSON.stringify({ version: '1.0.0', build: 8, commit: '0000000', builtAt: '2026-11-09T10:00:00.000Z', builtOn: 'h', bridgeSourceHash: h0 }));
        assert.equal(layer.describePlatform(PLATFORM, { layer: t.layerDir, currentBridgeHash: h0 }).tomBs.state, 'fresh');
        assert.equal(layer.describePlatform(PLATFORM, { layer: t.layerDir, currentBridgeHash: 'other' }).tomBs.state, 'unknown', 'else the commit decides (not in this checkout here)');
    });
});

describe('fleet build', () => {
    test('FB-1: the fleet_hosts registry', () => {
        const text = [
            '# Repo structure', '', '```yaml', 'fleet_hosts:',
            '  - id: mbp', '    ssh: alexiskyaw@10.8.0.7', '    root: /Users/x/al_the_bear', '    shell: bash', '    ai: true', '    build: true      # macOS builder',
            '  - id: bomber', '    ssh: alexis@10.8.0.9', '    root: /srv/repos/al_the_bear', '    shell: bash', '    build: false     # reconcile-only',
            '  - id: legiondary01', '    ssh: alexi@10.8.0.6', '    root: /c/Code/al_the_bear', '    shell: gitbash', '    build: true',
            '```', 'after: ignored',
        ].join('\n');
        const hosts = fleet.parseRegistry(text);
        assert.deepEqual(hosts.map((h: { id: string }) => h.id), ['mbp', 'bomber', 'legiondary01']);
        assert.deepEqual(hosts.filter((h: { build: boolean }) => h.build).map((h: { id: string }) => h.id), ['mbp', 'legiondary01']);
        assert.equal(hosts[0].ssh, 'alexiskyaw@10.8.0.7');
        assert.equal(hosts[2].shell, 'gitbash');
        assert.deepEqual(fleet.FLEET_PLATFORMS, ['darwin-arm64', 'linux-x64', 'win32-x64']);
    });

    test('FB-2: platforms, paths and the remote commands', () => {
        assert.equal(fleet.platformFromUname('Darwin', 'arm64'), 'darwin-arm64');
        assert.equal(fleet.platformFromUname('Linux', 'x86_64'), 'linux-x64');
        assert.equal(fleet.platformFromUname('MINGW64_NT-10.0-26100', 'x86_64'), 'win32-x64');
        assert.equal(fleet.platformFromUname('SunOS', 'sparc'), null);
        assert.equal(fleet.windowsPath('/c/Code/al_the_bear'), 'C:\\Code\\al_the_bear');
        const rel = 'inhouse/ws';
        const linux = fleet.remoteBuild({ shell: 'bash', root: '/srv/repos/al_the_bear' }, rel);
        assert.equal(linux, "bash -lc 'cd /srv/repos/al_the_bear/inhouse/ws/tom_ai/vscode/tom_vscode_extension && TOM_LAYER_FF=1 nice -n 10 ./compile_and_install.sh --binaries-only'");
        const win = fleet.remoteBuild({ shell: 'gitbash', root: '/c/Code/al_the_bear' }, rel);
        assert.equal(win, "$env:TOM_LAYER_FF='1'; powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Code\\al_the_bear\\inhouse\\ws\\tom_ai\\vscode\\tom_vscode_extension\\compile_and_install.ps1\" -BinariesOnly; exit $LASTEXITCODE");
        const probe = fleet.probeScript('/c/Code/al_the_bear/inhouse/ws');
        assert.ok(!probe.includes('$'), 'PowerShell would expand $ in the Git Bash wrap');
        assert.match(fleet.remoteBash({ shell: 'gitbash' }, probe), /^& "C:\\Program Files\\Git\\bin\\bash\.exe" -lc "cd \/c\/Code/);
        assert.match(fleet.remoteBash({ shell: 'bash' }, probe), /^bash -lc 'cd /);
    });

    test('FB-3: the probe answer and the level check', () => {
        const answer = ['Welcome to the host', 'Linux', 'x86_64', 'aaa1111', 'bbb2222', 'none', 'dart', 'node', ''].join('\r\n');
        const p = fleet.parseProbe(answer);
        assert.deepEqual(p, { platform: 'linux-x64', heads: { 'tom_ai/vscode': 'aaa1111', 'tom_ai/d4rt': 'bbb2222', 'tom_ai/ai_build': 'none' }, dart: true, node: true });
        assert.equal(fleet.parseProbe('Linux\nx86_64\n'), null);
        const here = { heads: { 'tom_ai/vscode': 'aaa1111', 'tom_ai/d4rt': 'ccc3333', 'tom_ai/ai_build': 'ddd4444' } };
        assert.deepEqual(fleet.levelDiffs(p, here), ['tom_ai/d4rt (bbb2222, here ccc3333)', 'tom_ai/ai_build (none, here ddd4444)']);
        assert.deepEqual(fleet.levelDiffs(here, here), []);
    });
});
