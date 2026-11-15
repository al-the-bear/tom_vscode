/**
 * The Dart SDK the window knows (vscimpb114; services/dartSdk.ts), which tomAi_specCodeSpecsMap hands the dart-tom
 * mapper of the bundled irspecs as TOM_DART.
 *
 *   DS-1 the order: TOM_DART (the executable, or an SDK folder holding bin/dart) > the Dart extension's dart.sdkPath
 *        > dart.flutterSdkPath > `dart` on PATH > $DART_SDK/bin > $FLUTTER_ROOT/bin > the folder of `flutter` on PATH
 *        > the known locations; a TOM_DART that is no SDK falls through; `~` expanded; Windows' dart.exe / dart.bat
 *   DS-2 TOM_FIND_DART_DISABLE=1 finds nothing; nothing anywhere finds nothing
 *   DS-3 the known locations are those of scripts/find-dart.cjs (the build steps), on both platforms
 *   DS-4 the binaries check reports it (dartBinariesStatus.dartSdk, the summary's `dartSdk`)
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findDartSdk, knownDartDirs } from '../dartSdk.js';
import { dartBinariesStatus, summarizeDartBinaries } from '../dartBinariesStatus.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** A lookup over a set of files that exist. */
function lookup(files: string[], env: NodeJS.ProcessEnv, settings?: Record<string, unknown>, platform: NodeJS.Platform = 'darwin') {
    const set = new Set(files);
    return findDartSdk({ env, settings, platform, home: platform === 'win32' ? 'C:\\Users\\u' : '/home/u', isFile: (p) => set.has(p) });
}

describe('the Dart SDK the window knows', () => {
    test('DS-1: the order', () => {
        const all = ['/t/dart', '/sdk/bin/dart', '/fl/bin/dart', '/p/dart', '/ds/bin/dart', '/fr/bin/dart', '/fp/dart', '/fp/flutter', '/home/u/flutter/bin/dart'];
        const env = { TOM_DART: '/t/dart', PATH: '/p:/fp', DART_SDK: '/ds', FLUTTER_ROOT: '/fr' };
        const settings = { sdkPath: '/sdk', flutterSdkPath: '/fl' };
        assert.deepEqual(lookup(all, env, settings), { dart: '/t/dart', via: 'TOM_DART' });
        assert.deepEqual(lookup(all, { ...env, TOM_DART: '/sdk' }, settings), { dart: '/sdk/bin/dart', via: 'TOM_DART' }, 'an SDK folder');
        assert.deepEqual(lookup(all, { ...env, TOM_DART: '/nothing' }, settings), { dart: '/sdk/bin/dart', via: 'dart.sdkPath' }, 'no SDK there: falls through');
        assert.deepEqual(lookup(all, { ...env, TOM_DART: '' }, { flutterSdkPath: '/fl' }), { dart: '/fl/bin/dart', via: 'dart.flutterSdkPath' });
        assert.deepEqual(lookup(all, { PATH: '/p:/fp', DART_SDK: '/ds', FLUTTER_ROOT: '/fr' }), { dart: '/p/dart', via: 'PATH' });
        assert.deepEqual(lookup(all.filter((f) => f !== '/p/dart' && f !== '/fp/dart'), { PATH: '/p', DART_SDK: '/ds', FLUTTER_ROOT: '/fr' }), { dart: '/ds/bin/dart', via: 'DART_SDK' });
        assert.deepEqual(lookup(['/fr/bin/dart'], { PATH: '', FLUTTER_ROOT: '/fr' }), { dart: '/fr/bin/dart', via: 'FLUTTER_ROOT' });
        assert.deepEqual(lookup(['/home/u/flutter/bin/dart'], { PATH: '/usr/bin' }), { dart: '/home/u/flutter/bin/dart', via: 'known location' });
        assert.deepEqual(lookup(['/home/u/sdk/bin/dart'], { PATH: '' }, { sdkPath: '~/sdk' }), { dart: '/home/u/sdk/bin/dart', via: 'dart.sdkPath' }, '~ expanded');
        assert.deepEqual(lookup(['C:\\dart\\bin\\dart.bat'], { PATH: '' }, { sdkPath: 'C:\\dart' }, 'win32'), { dart: 'C:\\dart\\bin\\dart.bat', via: 'dart.sdkPath' });
    });

    test('DS-2: disabled, or nothing anywhere', () => {
        assert.equal(lookup(['/p/dart'], { PATH: '/p', TOM_FIND_DART_DISABLE: '1' }), undefined);
        assert.equal(lookup([], { PATH: '/p' }), undefined);
    });

    test('DS-3: the known locations are find-dart.cjs\'s', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { fixedDirs } = require(path.join(EXT_ROOT, 'scripts', 'find-dart.cjs')) as { fixedDirs(p: string, h: string): string[] };
        for (const [platform, home] of [['darwin', '/home/u'], ['linux', '/home/u'], ['win32', 'C:\\Users\\u']] as const) {
            assert.deepEqual(knownDartDirs(platform, home), fixedDirs(platform, home), platform);
        }
    });

    test('DS-4: the binaries check reports it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-sdk-'));
        try {
            fs.mkdirSync(path.join(dir, 'bin'));
            fs.writeFileSync(path.join(dir, 'bin', process.platform === 'win32' ? 'dart.exe' : 'dart'), '');
            const status = dartBinariesStatus(EXT_ROOT, { dartSdkSettings: {} }, { PATH: '', TOM_DART: dir });
            assert.deepEqual(status.dartSdk, { dart: path.join(dir, 'bin', process.platform === 'win32' ? 'dart.exe' : 'dart'), via: 'TOM_DART' });
            assert.equal(summarizeDartBinaries(status).dartSdk, status.dartSdk?.dart);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
