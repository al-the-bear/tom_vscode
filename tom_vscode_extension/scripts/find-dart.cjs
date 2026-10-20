#!/usr/bin/env node
/**
 * Find the Dart SDK for the build steps that compile Dart (validate_codespecs,
 * the tom_bs bridge from source), also when `dart` is not on PATH.
 *
 *   node scripts/find-dart.cjs        prints the folder holding `dart`, exit 0;
 *                                     names every place it looked, exit 1
 *
 * The install scripts run it first and put that folder on PATH, so a missing
 * SDK stops the install before anything is built or packaged. Before, an
 * install from a shell without Dart on PATH built and packaged everything and
 * only the VSIX check refused it — while Flutter's Dart sat in
 * ~/Desktop/development/flutter/bin all along.
 *
 * Where it looks, in this order (the first that holds a `dart` wins):
 *   1. `dart` on PATH
 *   2. $DART_SDK/bin
 *   3. $FLUTTER_ROOT/bin                 (Flutter ships its Dart there)
 *   4. the folder of `flutter` on PATH
 *   5. per-host locations: ~/Desktop/development/flutter/bin,
 *      ~/development/flutter/bin, ~/flutter/bin, /opt/homebrew/bin,
 *      /usr/local/bin, /usr/lib/dart/bin; on Windows ~\flutter\bin,
 *      ~\Desktop\development\flutter\bin, C:\src\flutter\bin,
 *      C:\tools\dart-sdk\bin, C:\tools\flutter\bin
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The file names `dart` has on this platform (Flutter's bin holds dart.bat on Windows). */
function dartNames(platform) {
    return platform === 'win32' ? ['dart.exe', 'dart.bat'] : ['dart'];
}
function flutterNames(platform) {
    return platform === 'win32' ? ['flutter.bat', 'flutter.exe'] : ['flutter'];
}

function fixedDirs(platform, home) {
    if (platform === 'win32') {
        return [
            path.win32.join(home, 'flutter', 'bin'),
            path.win32.join(home, 'Desktop', 'development', 'flutter', 'bin'),
            'C:\\src\\flutter\\bin',
            'C:\\tools\\dart-sdk\\bin',
            'C:\\tools\\flutter\\bin',
        ];
    }
    return [
        path.posix.join(home, 'Desktop', 'development', 'flutter', 'bin'),
        path.posix.join(home, 'development', 'flutter', 'bin'),
        path.posix.join(home, 'flutter', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/lib/dart/bin',
    ];
}

/**
 * Where the Dart SDK is. Everything the lookup reads is injectable for tests:
 * `env`, `platform`, `home` and `isFile(path)`.
 *
 * @returns {{ found: { dart: string, dir: string, via: string } | null, looked: Array<{ via: string, dir: string }> }}
 */
function findDart({
    env = process.env,
    platform = process.platform,
    home = os.homedir(),
    isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
} = {}) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const pathDirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    const looked = [];
    const tryDir = (dir, via) => {
        looked.push({ via, dir });
        for (const name of dartNames(platform)) {
            const dart = p.join(dir, name);
            if (isFile(dart)) { return { dart, dir, via }; }
        }
        return null;
    };
    const candidates = [];
    for (const dir of pathDirs) { candidates.push([dir, 'PATH']); }
    if (env.DART_SDK) { candidates.push([p.join(env.DART_SDK, 'bin'), 'DART_SDK']); }
    if (env.FLUTTER_ROOT) { candidates.push([p.join(env.FLUTTER_ROOT, 'bin'), 'FLUTTER_ROOT']); }
    for (const dir of pathDirs) {
        if (flutterNames(platform).some((n) => isFile(p.join(dir, n)))) { candidates.push([dir, 'flutter on PATH']); }
    }
    for (const dir of fixedDirs(platform, home)) { candidates.push([dir, 'known location']); }
    const seen = new Set();
    for (const [dir, via] of candidates) {
        if (seen.has(dir)) { continue; } // already looked at (a PATH folder that is also a known location)
        seen.add(dir);
        const hit = tryDir(dir, via);
        if (hit) { return { found: hit, looked }; }
    }
    return { found: null, looked };
}

/** The message when no Dart SDK was found: every place looked, and what to set. */
function notFoundMessage(looked) {
    const lines = ['Dart SDK not found. Looked in:'];
    const pathCount = looked.filter((l) => l.via === 'PATH').length;
    if (pathCount > 0) { lines.push(`  - the ${pathCount} folders on PATH`); }
    for (const l of looked.filter((x) => x.via !== 'PATH')) { lines.push(`  - ${l.dir} (${l.via})`); }
    lines.push('Install Dart or Flutter, or set DART_SDK (the SDK folder) or FLUTTER_ROOT (the Flutter checkout),');
    lines.push('or put the folder holding `dart` on PATH.');
    return lines.join('\n');
}

module.exports = { findDart, notFoundMessage, fixedDirs };

if (require.main === module) {
    const { found, looked } = findDart();
    if (found) {
        process.stdout.write(`${found.dir}\n`);
        if (found.via !== 'PATH') { process.stderr.write(`ℹ️  Dart SDK: ${found.dart} (${found.via})\n`); }
    } else {
        process.stderr.write(`❌ ${notFoundMessage(looked)}\n`);
        process.exitCode = 1;
    }
}
