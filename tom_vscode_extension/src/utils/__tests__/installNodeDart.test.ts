/**
 * Node and the Dart SDK in the install scripts (vscimpb157; scripts/node_and_dart.sh). A shell without `node` once
 * ran the Dart lookup as `node: command not found` (exit 127), which compile_and_install.sh read as "no Dart SDK
 * found": it built and installed a VSIX without DartScript and CodeSpecs validation. The scripts run here with a
 * fake `node` (it answers `--version` and the lookup, and records every other call, which must not happen) and a
 * HOME without nvm, so no test builds anything.
 *
 *   ND-1 compile_and_install.sh without node on PATH and without nvm stops before building, naming node; no-Dart
 *        mode is never entered
 *   ND-2 tom_ensure_node loads nvm when node is missing (its default) and when it is too old
 *   ND-3 tom_find_dart: 0 prints the folder, find-dart's 1 is "no Dart SDK", anything else (127, a crash) is an error
 *   ND-4 compile_and_install.sh with a lookup that could not run (exit 127) stops with that error before the build,
 *        never TOM_NO_DART=1; install_extension.sh does the same
 *   ND-5 find-dart.cjs exits 2, not 1, when the lookup itself fails
 *   ND-6 tom_refuse_degrading_install: a build without Dart nobody asked for does not replace an installed
 *        extension with tom_bs; --no-dart / TOM_NO_DART=1, or no tom_bs installed, let it through
 *   ND-7 the .ps1 scripts check node first and tell the lookup's 1 from any other exit
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPER = path.join(EXT_ROOT, 'scripts', 'node_and_dart.sh');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'node-dart-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** The system folders the scripts' commands come from, without a node of their own. */
const SYSTEM_PATH = ['/usr/bin', '/bin'].filter((d) => !fs.existsSync(path.join(d, 'node'))).join(':');

/** A folder holding a fake `node`: `--version` prints `version`, the lookup exits `find` (printing `/fake/dart/bin` on 0), `-p` prints the platform, the build lock passes; any other call is recorded in `calls` and exits 99. */
function fakeNode(name: string, opts: { version?: string; find?: number }): { dir: string; calls: string } {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    const calls = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'node'), [
        '#!/bin/bash',
        `if [ "$1" = "--version" ]; then echo "${opts.version ?? 'v22.1.0'}"; exit 0; fi`,
        'if [ "$1" = "-p" ]; then echo "darwin-arm64"; exit 0; fi',
        // The build lock (scripts/build_lock.sh) runs before the lookup in install_extension.sh: let it through.
        'case "$1" in *build-lock.cjs) exit 0 ;; esac',
        `if [ "$1" = "scripts/find-dart.cjs" ]; then [ ${opts.find ?? 0} -eq 0 ] && echo /fake/dart/bin; exit ${opts.find ?? 0}; fi`,
        `echo "$*" >> "${calls}"`,
        'exit 99',
        '',
    ].join('\n'), { mode: 0o755 });
    return { dir, calls };
}

function bash(script: string, env: Record<string, string>, cwd = EXT_ROOT) {
    return spawnSync('/bin/bash', ['-c', script], { cwd, env: { HOME: path.join(base, 'home-without-nvm'), ...env }, encoding: 'utf8' });
}

describe('node and the Dart SDK in the install scripts', () => {
    test('ND-1: without node and nvm, compile_and_install.sh stops before building', () => {
        const r = spawnSync('/bin/bash', [path.join(EXT_ROOT, 'compile_and_install.sh')], {
            cwd: EXT_ROOT, encoding: 'utf8', env: { PATH: SYSTEM_PATH, HOME: path.join(base, 'home-without-nvm') },
        });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /❌ node not found: Node\.js >= 20 is needed on PATH/);
        assert.doesNotMatch(r.stdout + r.stderr, /No-Dart|no Dart SDK found|BUILT WITHOUT/i, 'never no-Dart mode');
        assert.equal(fs.existsSync(path.join(EXT_ROOT, '.build.lock')) && fs.readFileSync(path.join(EXT_ROOT, '.build.lock'), 'utf8').includes('compile_and_install'), false, 'nothing started');
    });

    test('ND-2: tom_ensure_node loads nvm', () => {
        const good = fakeNode('nvm-node', { version: 'v22.4.0' });
        const old = fakeNode('old-node', { version: 'v18.0.0' });
        const home = path.join(base, 'home-with-nvm');
        fs.mkdirSync(path.join(home, '.nvm'), { recursive: true });
        // A fake nvm: `use` puts the good node first on PATH.
        fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), `nvm() { case "$1" in use) export PATH="${good.dir}:$PATH" ;; list) echo "v20.0.0" ;; esac; }\n`);
        const missing = bash(`source "${HELPER}"; tom_ensure_node && command -v node`, { PATH: SYSTEM_PATH, HOME: home });
        assert.equal(missing.status, 0, missing.stdout + missing.stderr);
        assert.match(missing.stdout, /node is not on PATH: loading nvm/);
        assert.match(missing.stdout, new RegExp(`${good.dir}/node`));
        const tooOld = bash(`source "${HELPER}"; tom_ensure_node`, { PATH: `${old.dir}:${SYSTEM_PATH}`, HOME: home });
        assert.equal(tooOld.status, 0, tooOld.stdout);
        assert.match(tooOld.stdout, /Node\.js 18 is below the required 20: loading nvm/);
        const ok = bash(`source "${HELPER}"; tom_ensure_node`, { PATH: `${good.dir}:${SYSTEM_PATH}` });
        assert.equal(ok.status, 0);
        assert.match(ok.stdout, /✅ Node\.js v22\.4\.0/);
        const oldNoNvm = bash(`source "${HELPER}"; tom_ensure_node`, { PATH: `${old.dir}:${SYSTEM_PATH}` });
        assert.equal(oldNoNvm.status, 1);
        assert.match(oldNoNvm.stdout, /Node\.js 18 is below the required 20/);
    });

    test('ND-3: tom_find_dart tells "no Dart SDK" from a lookup that could not run', () => {
        const run = (find: number) => bash(`set -e; source "${HELPER}"; if out="$(tom_find_dart .)"; then echo "found:$out"; else echo "status:$?"; fi`,
            { PATH: `${fakeNode(`find-${find}`, { find }).dir}:${SYSTEM_PATH}` });
        assert.match(run(0).stdout, /found:\/fake\/dart\/bin/);
        assert.match(run(1).stdout, /status:1/);
        for (const code of [2, 127, 255]) {
            const r = run(code);
            assert.match(r.stdout, /status:2/, `exit ${code}`);
            assert.match(r.stderr, new RegExp(`The Dart SDK lookup could not run \\(node scripts/find-dart\\.cjs exited ${code}\\)`));
        }
    });

    test('ND-4: a lookup that could not run stops the install, never no-Dart mode', () => {
        const fake = fakeNode('find-127', { find: 127 });
        for (const script of ['compile_and_install.sh', 'install_extension.sh']) {
            fs.rmSync(fake.calls, { force: true });
            const r = spawnSync('/bin/bash', [path.join(EXT_ROOT, script)], {
                cwd: EXT_ROOT, encoding: 'utf8', env: { PATH: `${fake.dir}:${SYSTEM_PATH}`, HOME: path.join(base, 'home-without-nvm') },
            });
            assert.notEqual(r.status, 0, `${script}: ${r.stdout}`);
            assert.match(r.stderr, /The Dart SDK lookup could not run \(node scripts\/find-dart\.cjs exited 127\)/, script);
            assert.doesNotMatch(r.stdout + r.stderr, /No Dart SDK found|BUILT WITHOUT A DART SDK/i, `${script}: not no-Dart mode`);
            assert.equal(fs.existsSync(fake.calls), false, `${script}: nothing after the lookup ran (${fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8') : ''})`);
        }
    });

    test('ND-5: find-dart.cjs exits 2 when the lookup fails', () => {
        // A preload makes reading the environment throw: the lookup fails, which is no "not found" (1).
        const broken = path.join(base, 'broken-env.cjs');
        fs.writeFileSync(broken, "Object.defineProperty(process, 'env', { get() { throw new Error('the lookup broke'); } });\n");
        const r = spawnSync(process.execPath, ['-r', broken, path.join(EXT_ROOT, 'scripts', 'find-dart.cjs')], { env: { PATH: '/nonexistent', HOME: '/nonexistent-home' }, encoding: 'utf8' });
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /❌ The Dart SDK lookup failed: Error: the lookup broke/);
    });

    test('ND-6: a build without Dart does not replace an installed extension with tom_bs', () => {
        const fake = fakeNode('guard', {});
        const exts = path.join(base, 'extensions');
        const installed = path.join(exts, 'peter-nicolai-alexis-kyaw.tom-ai-extension-0.1.0', 'bin', 'darwin-arm64');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(path.join(installed, 'tom_bs'), '');
        const guard = (env: Record<string, string>) => bash(`source "${HELPER}"; tom_refuse_degrading_install; echo "rc:$?"`,
            { PATH: `${fake.dir}:${SYSTEM_PATH}`, TOM_EXTENSIONS_DIR: exts, ...env });
        const refused = guard({ TOM_NO_DART: '1', TOM_NO_DART_REASON: 'no Dart SDK found' });
        assert.match(refused.stdout, /❌ Not installing: no Dart SDK was found, and the installed extension carries tom_bs/);
        assert.match(refused.stdout, /pass --no-dart to install a build without Dart on purpose/);
        assert.match(refused.stdout, /rc:1/);
        assert.match(guard({ TOM_NO_DART: '1', TOM_NO_DART_REASON: '--no-dart given' }).stdout, /^rc:0$/m, '--no-dart: on purpose');
        assert.match(guard({ TOM_NO_DART: '1', TOM_NO_DART_REASON: 'TOM_NO_DART=1' }).stdout, /^rc:0$/m, 'TOM_NO_DART=1: on purpose');
        assert.match(guard({}).stdout, /^rc:0$/m, 'with Dart');
        fs.rmSync(path.join(installed, 'tom_bs'));
        assert.match(guard({ TOM_NO_DART: '1', TOM_NO_DART_REASON: 'no Dart SDK found' }).stdout, /^rc:0$/m, 'no tom_bs installed: nothing lost');
        const sh = fs.readFileSync(path.join(EXT_ROOT, 'install_extension.sh'), 'utf8');
        assert.ok(sh.indexOf('tom_refuse_degrading_install || exit 1') < sh.indexOf('# From source: the bridge is compiled'), 'checked before anything is built');
    });

    test('ND-7: the .ps1 scripts', () => {
        const cai = fs.readFileSync(path.join(EXT_ROOT, 'compile_and_install.ps1'), 'utf8');
        assert.ok(cai.indexOf("if (-not (Get-Command node -ErrorAction SilentlyContinue))") < cai.indexOf('node scripts/find-dart.cjs'), 'node is checked before the lookup');
        assert.match(cai, /node not found: Node\.js >= 20 is needed on PATH/);
        assert.match(cai, /if \(\$DartLookup -eq 1\) \{\s+\$env:TOM_NO_DART = '1'[\s\S]*?\} elseif \(\$DartLookup -ne 0\) \{\s+Write-Host "The Dart SDK lookup could not run[^\n]+\n\s+exit 1/);
        const ie = fs.readFileSync(path.join(EXT_ROOT, 'install_extension.ps1'), 'utf8');
        assert.match(ie, /if \(\$DartLookup -ne 0 -and \$DartLookup -ne 1\) \{\s+Write-Host "The Dart SDK lookup could not run[^\n]+\n\s+exit 1/);
    });
});
