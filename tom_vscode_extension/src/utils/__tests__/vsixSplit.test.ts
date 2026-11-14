/**
 * One VSIX per platform (scripts/vsix-split.cjs, vscimpb103): the multi-platform create scripts pack
 * `tom-ai-extension-<platform>.vsix` with `vsce package --target`, each with only its platform's bin/ folder.
 *
 *   VS-1 the platforms bin/ holds, in packing order (only VS Code targets); the file names and back
 *   VS-2 the per-platform ignore file: the package's .vscodeignore, the other platforms' bin/, the scratch
 *   VS-3 packing (vsce stubbed): one `vsce package --target <p> --ignoreFile … -o tom-ai-extension-<p>.vsix` per
 *        platform, each checked with `check-vsix-contents --target <p>`; a failed pack or check is reported
 *   VS-4 with the real vsce (when one is cached on this machine): a fake extension with three platforms gives
 *        three VSIX, each holding only its own bin/<platform>/ and naming its target platform
 *   VS-5 check-vsix-contents --target: another platform's bin/ fails, the report names the VSIX's platform
 *   VS-6 the scripts: the three multi-platform create scripts (sh and ps1) set TOM_SPLIT_PLATFORMS and publish
 *        every per-platform VSIX; create_vsix.* do not; install_extension.* pack per platform only with
 *        package-only (the refusal run for real in bash); .vscodeignore leaves the scratch out
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as written */
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const split = require(path.join(EXT, 'scripts', 'vsix-split.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const contents = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs'));
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb103_split-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');

/** A fake extension folder with bin/ for the given platforms. */
function fakeExt(name: string, platforms: string[]): string {
    const dir = path.join(SANDBOX, name);
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'fake', publisher: 't', version: '0.0.1', engines: { vscode: '^1.80.0' },
        repository: { type: 'git', url: 'https://github.com/al-the-bear/tom_vscode.git', directory: 'tom_vscode_extension' },
    }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# fake\n');
    fs.writeFileSync(path.join(dir, '.vscodeignore'), 'src/**\n');
    fs.writeFileSync(path.join(dir, 'out', 'x.js'), 'x\n');
    for (const p of platforms) {
        fs.mkdirSync(path.join(dir, 'bin', p), { recursive: true });
        fs.writeFileSync(path.join(dir, 'bin', p, p.startsWith('win32') ? 'tom_bs.exe' : 'tom_bs'), p);
    }
    return dir;
}

/** A vsce cached by npx on this machine, or undefined. */
function cachedVsce(): string | undefined {
    const root = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(root)) { return undefined; }
    for (const d of fs.readdirSync(root)) {
        const bin = path.join(root, d, 'node_modules', '@vscode', 'vsce', 'vsce');
        if (fs.existsSync(bin)) { return bin; }
    }
    return undefined;
}

/** A stored zip with empty files (central directory only matters). */
function zip(names: string[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const n of names) {
        const name = Buffer.from(n, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

describe('one VSIX per platform', () => {
    test('VS-1: platforms and names', () => {
        const dir = fakeExt('p1', ['win32-x64', 'linux-x64', 'darwin-arm64']);
        fs.mkdirSync(path.join(dir, 'bin', 'not-a-platform'));
        assert.deepEqual(split.platformsInBin(path.join(dir, 'bin')), ['darwin-arm64', 'linux-x64', 'win32-x64']);
        assert.deepEqual(split.platformsInBin(path.join(dir, 'none')), []);
        assert.equal(split.vsixName('linux-x64'), 'tom-ai-extension-linux-x64.vsix');
        assert.equal(split.platformOfVsix('/a/tom-ai-extension-win32-x64.vsix'), 'win32-x64');
        assert.equal(split.platformOfVsix('tom-ai-extension.vsix'), null);
        assert.equal(split.platformOfVsix('tom-ai-extension-0.1.0.vsix'), null);
    });

    test('VS-2: the ignore file', () => {
        const text = split.ignoreText('src/**\n**/*.ts\n', 'linux-x64', ['darwin-arm64', 'linux-x64', 'win32-x64']);
        const lines = text.split('\n');
        assert.ok(lines.includes('src/**') && lines.includes('**/*.ts'), 'the package\'s own rules');
        assert.ok(lines.includes('bin/darwin-arm64/**') && lines.includes('bin/win32-x64/**'));
        assert.ok(!lines.includes('bin/linux-x64/**'), 'its own platform stays');
        assert.ok(lines.includes('out/vsix-split/**') && lines.includes('*.vsix'));
    });

    test('VS-3: packing (vsce stubbed)', () => {
        const dir = fakeExt('p3', ['darwin-arm64', 'linux-x64', 'win32-x64']);
        const calls: string[][] = [];
        const results = split.packageAll({
            vsce: ['npx', '--yes', '@vscode/vsce'], extRoot: dir, log: () => undefined,
            run: (cmd: string, args: string[]) => {
                calls.push([cmd, ...args]);
                if (args.includes('package')) {
                    const out = args[args.indexOf('-o') + 1];
                    if (args.includes('win32-x64')) { return 1; }
                    fs.writeFileSync(out, 'vsix');
                    return 0;
                }
                return args.includes('linux-x64') ? 1 : 0;
            },
        });
        assert.deepEqual(results.map((r: { platform: string; ok: boolean; error?: string }) => [r.platform, r.ok, r.error]), [
            ['darwin-arm64', true, undefined], ['linux-x64', false, 'check-vsix-contents failed'], ['win32-x64', false, 'vsce package failed'],
        ]);
        const packs = calls.filter((c) => c.includes('package'));
        assert.equal(packs.length, 3);
        for (const [i, p] of ['darwin-arm64', 'linux-x64', 'win32-x64'].entries()) {
            const c = packs[i];
            assert.deepEqual(c.slice(0, 4), ['npx', '--yes', '@vscode/vsce', 'package']);
            assert.equal(c[c.indexOf('--target') + 1], p);
            assert.equal(c[c.indexOf('-o') + 1], path.join(dir, `tom-ai-extension-${p}.vsix`));
            assert.ok(c.includes('--skip-license') && c.includes('--baseContentUrl') && c.includes('--baseImagesUrl'));
            const ignore = fs.readFileSync(c[c.indexOf('--ignoreFile') + 1], 'utf8');
            assert.ok(!ignore.includes(`bin/${p}/**`) && ignore.includes('src/**'), ignore);
        }
        const checks = calls.filter((c) => c.some((a) => a.endsWith('check-vsix-contents.cjs')));
        assert.deepEqual(checks.map((c) => c.slice(-2)), [['--target', 'darwin-arm64'], ['--target', 'linux-x64']], 'a VSIX that was not packed is not checked');
    });

    const vsce = cachedVsce();
    test('VS-4: with the real vsce', { skip: vsce ? false : 'no vsce cached by npx here' }, () => {
        const dir = fakeExt('p4', ['darwin-arm64', 'linux-x64', 'win32-x64']);
        const results = split.packageAll({
            vsce: [process.execPath, vsce], extRoot: dir, log: () => undefined,
            run: (cmd: string, args: string[], o: Record<string, unknown>) => {
                if (args.some((a) => a.endsWith('check-vsix-contents.cjs'))) { return 0; } // a fake extension lacks the required entries
                const r = spawnSync(cmd, args, { ...o, encoding: 'utf8' });
                return r.status ?? 1;
            },
        });
        assert.ok(results.every((r: { ok: boolean }) => r.ok), JSON.stringify(results));
        for (const p of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
            const file = path.join(dir, `tom-ai-extension-${p}.vsix`);
            const buf = fs.readFileSync(file);
            const names = contents.readCentralDirectory(buf).map((e: { name: string }) => e.name);
            assert.deepEqual(names.filter((n: string) => n.includes('/bin/')), [`extension/bin/${p}/${p.startsWith('win32') ? 'tom_bs.exe' : 'tom_bs'}`]);
            assert.ok(names.includes('extension/out/x.js'));
            assert.ok(!names.some((n: string) => n.includes('vsix-split')), 'the scratch stays out');
            assert.ok(buf.includes(Buffer.from(`TargetPlatform="${p}"`)) || unzipManifest(file).includes(`TargetPlatform="${p}"`), `${p}: its target`);
        }
    });

    test('VS-5: check-vsix-contents --target', () => {
        const script = path.join(EXT, 'scripts', 'check-vsix-contents.cjs');
        const run = (name: string, names: string[], target: string) => {
            const file = path.join(SANDBOX, name);
            fs.writeFileSync(file, zip([...contents.REQUIRED, ...names]));
            return spawnSync(process.execPath, [script, file, '--target', target], { encoding: 'utf8' });
        };
        const mixed = run('mixed.vsix', ['extension/bin/darwin-arm64/tom_bs', 'extension/bin/linux-x64/tom_bs'], 'darwin-arm64');
        assert.equal(mixed.status, 1);
        assert.match(mixed.stderr, /another platform's binaries in the darwin-arm64 VSIX: 1 entries, e\.g\. extension\/bin\/linux-x64\/tom_bs/);
        const own = run('own.vsix', ['extension/bin/win32-x64/tom_bs.exe', 'extension/bin/win32-x64/buildkit.exe'], 'win32-x64');
        assert.equal(own.status, 0, own.stderr);
        assert.match(own.stdout, /binaries for win32-x64 only/);
        assert.match(own.stdout, /win32-x64 \(this VSIX's platform\): tom_bs ✔/);
        assert.match(own.stdout, /win32-x64 \(this VSIX's platform\): buildkit ✔/);
        assert.doesNotMatch(own.stdout, /this host/, 'only its own platform is reported');
        assert.deepEqual(contents.otherPlatformEntries(new Set(['extension/bin/a-b/x', 'extension/bin/c-d/y', 'extension/out/z']), 'a-b'), ['extension/bin/c-d/y']);
    });

    test('VS-6: the scripts', () => {
        for (const name of ['create_currentbinaries_vsix', 'create_fleetcompiled_vsix', 'create_layerbinaries_vsix']) {
            const sh = read(`${name}.sh`);
            assert.ok(sh.indexOf('export TOM_SPLIT_PLATFORMS=1') > 0 && sh.indexOf('export TOM_SPLIT_PLATFORMS=1') < sh.indexOf('"$SCRIPT_DIR/install_extension.sh"'), `${name}.sh splits`);
            assert.match(sh, /tom_release_publish "\$SCRIPT_DIR" "\$\(tom_platform_vsixes "\$SCRIPT_DIR"\)"/, `${name}.sh publishes every VSIX`);
            assert.match(sh, /tom-ai-extension-<platform>\.vsix/);
            const ps = read(`${name}.ps1`);
            assert.ok(ps.indexOf("$env:TOM_SPLIT_PLATFORMS = '1'") > 0 && ps.indexOf("$env:TOM_SPLIT_PLATFORMS = '1'") < ps.indexOf("install_extension.ps1')"), `${name}.ps1 splits`);
            assert.match(ps, /'TOM_SPLIT_PLATFORMS'\)/, `${name}.ps1 clears it`);
            assert.match(ps, /Publish-TomRelease \$ScriptDir "\$\(\(Get-TomPlatformVsixes \$ScriptDir\) -join "`n"\)"/, `${name}.ps1 publishes every VSIX`);
        }
        for (const name of ['create_vsix.sh', 'create_vsix.ps1', 'compile_and_install.sh', 'compile_and_install.ps1']) {
            assert.doesNotMatch(read(name), /TOM_SPLIT_PLATFORMS/, `${name}: one VSIX for this host`);
        }
        const sh = read('install_extension.sh');
        assert.match(sh, /if \[ "\$\{TOM_SPLIT_PLATFORMS:-0\}" = "1" \]; then[\s\S]*node scripts\/vsix-split\.cjs package --vsce "\$VSCE_CMD"[\s\S]*exit 0\nfi\n\n# Package as VSIX/);
        const ps = read('install_extension.ps1');
        assert.match(ps, /if \(\$SplitPlatformsMode\) \{[\s\S]*Invoke-Native \{ node scripts\/vsix-split\.cjs package --vsce vsce \}/);
        assert.match(ps, /\$SplitPlatformsMode -and -not \$PackageOnlyMode/);
        // Without --package-only: refused at once (no build).
        const r = spawnSync('bash', [path.join(EXT, 'install_extension.sh')], { encoding: 'utf8', env: { ...process.env, TOM_SPLIT_PLATFORMS: '1', TOM_PACKAGE_ONLY: '' } });
        assert.equal(r.status, 1);
        assert.match(r.stdout, /One VSIX per platform \(TOM_SPLIT_PLATFORMS=1\) is packaging only/);
        // The summary helpers name every VSIX.
        const summary = read('scripts/install_summary.sh');
        assert.match(summary, /tom_platform_vsixes\(\) \{\n\s+\( cd "\$1" && node scripts\/vsix-split\.cjs list \)/);
        assert.match(summary, /node scripts\/check-vsix-contents\.cjs "\$vsix" --target "\$platform"/);
        assert.match(read('scripts/install_summary.ps1'), /node scripts\/check-vsix-contents\.cjs \$vsix --target \$platform/);
        const ignore = read('.vscodeignore').split('\n');
        assert.ok(ignore.includes('out/vsix-split/**') && ignore.includes('out/vsix-release/**'));
    });
});

/** The extension.vsixmanifest of a VSIX (it is deflated): read with `unzip -p` where there is one. */
function unzipManifest(file: string): string {
    const r = spawnSync('unzip', ['-p', file, 'extension.vsixmanifest'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : '';
}
