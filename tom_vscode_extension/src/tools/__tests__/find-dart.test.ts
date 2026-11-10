/**
 * Finding the Dart SDK for the install (scripts/find-dart.cjs, vscimpa12):
 * the lookup order, over injected environments and file systems.
 *
 *   FD-1 `dart` on PATH wins
 *   FD-2 then DART_SDK/bin, then FLUTTER_ROOT/bin, then the folder of `flutter` on PATH
 *   FD-3 then the per-host locations — Flutter's Dart in ~/Desktop/development/flutter/bin found without PATH
 *   FD-4 Windows: dart.exe / dart.bat, `;`-separated Path, the Windows locations
 *   FD-5 nothing found: every place looked is reported, and the message names DART_SDK and FLUTTER_ROOT
 *   FD-6 the script as the install scripts run it: prints the folder (exit 0) or stops with the message (exit 1)
 *   FD-7 both install scripts look for Dart before their first build step and put the folder on PATH; without
 *        one (or with --no-dart / -NoDart / TOM_NO_DART=1) they go on in no-Dart mode: the lookup is skipped or its
 *        failure tolerated, and the Dart steps (bridge-lock preflight, from-source bridge build, validate_codespecs)
 *        are skipped; the wrappers settle the mode before calling them and print the closing warning
 *   FD-8 TOM_FIND_DART_DISABLE=1 finds nothing, wherever Dart is, and says why
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names (PATH, DART_SDK, …) are data here */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(EXT_ROOT, 'scripts', 'find-dart.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findDart, notFoundMessage } = require(SCRIPT) as {
    findDart(o: { env: Record<string, string>; platform: string; home: string; isFile(p: string): boolean }): {
        found: { dart: string; dir: string; via: string } | null; looked: Array<{ via: string; dir: string }>;
    };
    notFoundMessage(looked: Array<{ via: string; dir: string }>): string;
};

const files = (...paths: string[]): ((p: string) => boolean) => (p) => paths.includes(p);
const HOME = '/Users/me';

describe('finding the Dart SDK', () => {
    test('FD-1: dart on PATH wins', () => {
        const r = findDart({ env: { PATH: '/usr/bin:/opt/dart/bin', DART_SDK: '/sdk' }, platform: 'darwin', home: HOME,
            isFile: files('/opt/dart/bin/dart', '/sdk/bin/dart') });
        assert.deepEqual(r.found, { dart: '/opt/dart/bin/dart', dir: '/opt/dart/bin', via: 'PATH' });
    });

    test('FD-2: DART_SDK, FLUTTER_ROOT, flutter on PATH', () => {
        const base = { platform: 'darwin', home: HOME };
        const sdk = findDart({ ...base, env: { PATH: '/usr/bin', DART_SDK: '/sdk', FLUTTER_ROOT: '/fl' }, isFile: files('/sdk/bin/dart', '/fl/bin/dart') });
        assert.deepEqual([sdk.found?.dir, sdk.found?.via], ['/sdk/bin', 'DART_SDK']);
        const fl = findDart({ ...base, env: { PATH: '/usr/bin', FLUTTER_ROOT: '/fl' }, isFile: files('/fl/bin/dart') });
        assert.deepEqual([fl.found?.dir, fl.found?.via], ['/fl/bin', 'FLUTTER_ROOT']);
        // flutter's folder on PATH holds dart too — found by the PATH pass already.
        const onPath = findDart({ ...base, env: { PATH: '/x/flutter/bin' }, isFile: files('/x/flutter/bin/flutter', '/x/flutter/bin/dart') });
        assert.deepEqual([onPath.found?.dir, onPath.found?.via], ['/x/flutter/bin', 'PATH']);
    });

    test('FD-3: the per-host locations', () => {
        const r = findDart({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin', home: HOME,
            isFile: files(`${HOME}/Desktop/development/flutter/bin/dart`, '/opt/homebrew/bin/dart') });
        assert.deepEqual(r.found, { dart: `${HOME}/Desktop/development/flutter/bin/dart`, dir: `${HOME}/Desktop/development/flutter/bin`, via: 'known location' });
        const brew = findDart({ env: { PATH: '/usr/bin' }, platform: 'darwin', home: HOME, isFile: files('/opt/homebrew/bin/dart') });
        assert.equal(brew.found?.dir, '/opt/homebrew/bin');
    });

    test('FD-4: Windows', () => {
        const home = 'C:\\Users\\alexi';
        const bat = findDart({ env: { Path: 'C:\\Windows;C:\\Windows\\System32' }, platform: 'win32', home,
            isFile: files('C:\\Users\\alexi\\flutter\\bin\\dart.bat') });
        assert.deepEqual(bat.found, { dart: 'C:\\Users\\alexi\\flutter\\bin\\dart.bat', dir: 'C:\\Users\\alexi\\flutter\\bin', via: 'known location' });
        const exe = findDart({ env: { Path: 'C:\\Windows;C:\\dart\\bin' }, platform: 'win32', home, isFile: files('C:\\dart\\bin\\dart.exe') });
        assert.deepEqual([exe.found?.dir, exe.found?.via], ['C:\\dart\\bin', 'PATH']);
        const sdk = findDart({ env: { Path: '', DART_SDK: 'C:\\tools\\dart-sdk' }, platform: 'win32', home, isFile: files('C:\\tools\\dart-sdk\\bin\\dart.exe') });
        assert.equal(sdk.found?.via, 'DART_SDK');
    });

    test('FD-5: nothing found', () => {
        const r = findDart({ env: { PATH: '/usr/bin:/bin', DART_SDK: '/sdk' }, platform: 'linux', home: '/home/me', isFile: () => false });
        assert.equal(r.found, null);
        const vias = r.looked.map((l) => l.via);
        assert.deepEqual([...new Set(vias)], ['PATH', 'DART_SDK', 'known location']);
        assert.ok(r.looked.some((l) => l.dir === '/home/me/Desktop/development/flutter/bin'));
        const message = notFoundMessage(r.looked);
        assert.match(message, /the 2 folders on PATH/);
        assert.match(message, /\/sdk\/bin \(DART_SDK\)/);
        assert.match(message, /\/usr\/lib\/dart\/bin \(known location\)/);
        assert.match(message, /DART_SDK/);
        assert.match(message, /FLUTTER_ROOT/);
    });

    test('FD-6: the script', () => {
        const none = spawnSync(process.execPath, [SCRIPT], { env: { PATH: '/nonexistent', HOME: '/nonexistent-home' }, encoding: 'utf8' });
        assert.equal(none.status, 1);
        assert.equal(none.stdout, '');
        assert.match(none.stderr, /Dart SDK not found/);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-dart-'));
        fs.mkdirSync(path.join(dir, 'bin'));
        for (const name of ['dart', 'dart.exe', 'dart.bat']) { fs.writeFileSync(path.join(dir, 'bin', name), ''); }
        const found = spawnSync(process.execPath, [SCRIPT], { env: { PATH: '/nonexistent', HOME: '/nonexistent-home', DART_SDK: dir }, encoding: 'utf8' });
        assert.equal(found.status, 0, found.stderr);
        assert.equal(found.stdout.trim(), path.join(dir, 'bin'));
        assert.match(found.stderr, /DART_SDK/);
    });

    test('FD-7: the install scripts look first, and go on without Dart', () => {
        const read = (name: string): string => fs.readFileSync(path.join(EXT_ROOT, name), 'utf8');
        const sh = read('install_extension.sh');
        const ps1 = read('install_extension.ps1');
        for (const [name, text, onPath, noDartOn, gated] of [
            ['install_extension.sh', sh, /export PATH="\$DART_DIR:\$PATH"/, /--no-dart\) export TOM_NO_DART=1/,
                /if \[ "\$NO_DART" = "1" \]; then\s+echo "📦 No Dart: validate_codespecs and spec_checks are not built[^"]*"\s+else\s+\( cd "\$SCRIPT_DIR" && node scripts\/build-validate-codespecs\.cjs \)/],
            ['install_extension.ps1', ps1, /\$env:Path = "\$DartDir;\$env:Path"/, /if \(\$Arg -eq '--no-dart'\) \{ \$NoDart = \$true \}/,
                /if \(\$NoDartMode\) \{\s+Write-Host "No Dart: validate_codespecs and spec_checks are not built[^"]*"\s+\} else \{\s+Push-Location \$ExtensionDir\s+Invoke-Native \{ node scripts\/build-validate-codespecs\.cjs \}/],
        ] as const) {
            const find = text.indexOf('node scripts/find-dart.cjs');
            assert.ok(find > 0, `${name} runs find-dart.cjs`);
            assert.ok(find < text.indexOf('scripts/build-som-packages.cjs'), `${name} looks before its first build step`);
            assert.match(text, onPath, `${name} puts the found folder on PATH`);
            assert.match(text, noDartOn, `${name} takes --no-dart`);
            assert.match(text, gated, `${name} skips the validate_codespecs build without Dart`);
            assert.match(text, /no Dart SDK found/, `${name} goes on when no Dart SDK is found`);
            assert.doesNotMatch(text, /DART_DIR="\$\(node scripts\/find-dart\.cjs\)" \|\| exit 1/, `${name} does not stop without Dart`);
        }
        // The bridge-lock preflight (--fix) and the from-source bridge build are skipped without Dart.
        assert.match(sh, /if \[ "\$FROM_SOURCE" = "1" \] && \[ "\$NO_DART" != "1" \]; then\s+echo "🔎 Checking the bridge's tom_\* resolutions\.\.\."/);
        assert.match(sh, /if \[ "\$FROM_SOURCE" = "1" \] && \[ "\$NO_DART" = "1" \]; then[\s\S]{0,300}No Dart: no tom_bs is built/);
        assert.match(ps1, /if \(\$FromSource -and -not \$NoDartMode\) \{\s+Write-Host "Checking the bridge's tom_\* resolutions\.\.\."/);
        assert.match(ps1, /if \(\$FromSource -and \$NoDartMode\) \{[\s\S]{0,300}No Dart: no tom_bs is built/);
        assert.match(ps1, /Invoke-Native \{ node scripts\/find-dart\.cjs \}/, 'the .ps1 calls it through Invoke-Native');
        // The wrappers settle the mode, then own the closing lines: VSIX path, warning, Finished, warning.
        for (const [name, closing, call] of [
            ['compile_and_install.sh', /tom_print_vsix_path "\$SCRIPT_DIR"\n\[ "\$\{TOM_NO_DART:-0\}" = "1" \] && tom_print_no_dart_warning [^\n]+\necho "🕒 Finished at [^\n]+\n\[ "\$\{TOM_NO_DART:-0\}" = "1" \] && tom_print_no_dart_warning/, '"$SCRIPT_DIR/install_extension.sh"'],
            ['compile_and_install.ps1', /Write-TomVsixPath \$ScriptDir\nif \(\$NoDartMode\) \{ Write-TomNoDartWarning [^\n]+\nWrite-Host "🕒 Finished at [^\n]+\nif \(\$NoDartMode\) \{ Write-TomNoDartWarning/, "& (Join-Path $ScriptDir 'install_extension.ps1')"],
        ] as const) {
            const text = read(name);
            assert.match(text, /--no-dart/, `${name} takes --no-dart`);
            assert.ok(text.indexOf('node scripts/find-dart.cjs') > 0, `${name} looks for Dart itself`);
            assert.ok(text.indexOf('node scripts/find-dart.cjs') < text.indexOf(call), `${name} settles the mode before the base runs`);
            assert.match(text, closing, `${name} closes with the VSIX path and the warning around the Finished line`);
        }
    });

    test('FD-8: TOM_FIND_DART_DISABLE=1', () => {
        const r = findDart({ env: { PATH: '/opt/dart/bin', TOM_FIND_DART_DISABLE: '1' }, platform: 'darwin', home: HOME,
            isFile: files('/opt/dart/bin/dart') });
        assert.equal(r.found, null);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-dart-'));
        fs.writeFileSync(path.join(dir, 'dart'), '');
        const run = spawnSync(process.execPath, [SCRIPT], { env: { PATH: dir, HOME: '/nonexistent-home', TOM_FIND_DART_DISABLE: '1' }, encoding: 'utf8' });
        assert.equal(run.status, 1);
        assert.equal(run.stdout, '');
        assert.match(run.stderr, /lookup disabled \(TOM_FIND_DART_DISABLE=1\)/);
    });
});
