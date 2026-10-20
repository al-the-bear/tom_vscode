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
 *   FD-7 both install scripts look for Dart before their first build step and put the folder on PATH; the
 *        validate_codespecs build always runs (no 'Dart not found, not bundled' branch is left)
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

    test('FD-7: the install scripts look first', () => {
        const read = (name: string): string => fs.readFileSync(path.join(EXT_ROOT, name), 'utf8');
        const sh = read('install_extension.sh');
        const ps1 = read('install_extension.ps1');
        for (const [name, text, onPath] of [
            ['install_extension.sh', sh, /export PATH="\$DART_DIR:\$PATH"/],
            ['install_extension.ps1', ps1, /\$env:Path = "\$DartDir;\$env:Path"/],
        ] as const) {
            const find = text.indexOf('node scripts/find-dart.cjs');
            assert.ok(find > 0, `${name} runs find-dart.cjs`);
            assert.ok(find < text.indexOf('scripts/build-som-packages.cjs'), `${name} looks before its first build step`);
            assert.match(text, onPath, `${name} puts the found folder on PATH`);
            assert.doesNotMatch(text, /validate_codespecs not bundled/, `${name} never packages without validate_codespecs`);
        }
        assert.match(ps1, /Invoke-Native \{ node scripts\/find-dart\.cjs \}/, 'the .ps1 calls it through Invoke-Native');
    });
});
