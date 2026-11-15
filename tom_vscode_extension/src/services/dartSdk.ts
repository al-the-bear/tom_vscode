/**
 * The Dart SDK this window knows, at run time (vscimpb114): the bundled,
 * compiled `irspecs` has no SDK of its own, and its Dart + Tom mapper formats
 * with the SDK's `dart format` (tom_specs irfmt1: a Dart SDK is a prerequisite
 * of the dart-tom mapper). It finds `dart` from `TOM_DART`, else PATH — and
 * the extension host's PATH often lacks the SDK a login shell has (Flutter's
 * Dart in ~/Desktop/development/flutter/bin), so the extension looks it up and
 * hands it over as `TOM_DART`.
 *
 * Where it looks, in this order (the first `dart` found wins):
 *   1. `TOM_DART` (the `dart` executable, or an SDK folder holding bin/dart)
 *   2. the Dart extension's settings: `dart.sdkPath`, then `dart.flutterSdkPath`
 *      (an SDK folder; bin/dart)
 *   3. what scripts/find-dart.cjs looks at for the build steps: `dart` on PATH,
 *      $DART_SDK/bin, $FLUTTER_ROOT/bin, the folder of `flutter` on PATH, the
 *      per-host locations (`fixedDirs`)
 *
 * TOM_FIND_DART_DISABLE=1 finds nothing, as in find-dart.cjs.
 *
 * vscode-free; the settings are read by the caller (dartSdkSettings).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The Dart extension's SDK settings (`dart.sdkPath`, `dart.flutterSdkPath`). */
export interface DartSdkSettings {
    sdkPath?: unknown;
    flutterSdkPath?: unknown;
}

export interface DartSdkFound {
    /** The `dart` executable. */
    dart: string;
    /** Where it was found: `TOM_DART`, `dart.sdkPath`, `dart.flutterSdkPath`, `PATH`, `DART_SDK`, `FLUTTER_ROOT`, `flutter on PATH`, `known location`. */
    via: string;
}

export interface FindDartSdkOptions {
    env?: NodeJS.ProcessEnv;
    settings?: DartSdkSettings;
    platform?: NodeJS.Platform;
    home?: string;
    isFile?: (p: string) => boolean;
}

function dartNames(platform: NodeJS.Platform): string[] {
    return platform === 'win32' ? ['dart.exe', 'dart.bat'] : ['dart'];
}

function flutterNames(platform: NodeJS.Platform): string[] {
    return platform === 'win32' ? ['flutter.bat', 'flutter.exe'] : ['flutter'];
}

/** The per-host locations scripts/find-dart.cjs looks at (kept the same; a test compares them). */
export function knownDartDirs(platform: NodeJS.Platform, home: string): string[] {
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

const defaultIsFile = (p: string): boolean => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** The Dart SDK this host has, or undefined. */
export function findDartSdk(opts: FindDartSdkOptions = {}): DartSdkFound | undefined {
    const env = opts.env ?? process.env;
    // The install scripts' switch for the "no Dart SDK" route (scripts/find-dart.cjs) holds here too.
    if (env.TOM_FIND_DART_DISABLE === '1') { return undefined; }
    const platform = opts.platform ?? process.platform;
    const home = opts.home ?? os.homedir();
    const isFile = opts.isFile ?? defaultIsFile;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const names = dartNames(platform);
    const inDir = (dir: string): string | undefined => names.map((n) => p.join(dir, n)).find(isFile);
    /** A `dart` executable, or an SDK folder holding bin/dart. */
    const fromSdk = (value: unknown): string | undefined => {
        const v = typeof value === 'string' ? value.trim() : Array.isArray(value) && typeof value[0] === 'string' ? value[0].trim() : '';
        if (!v) { return undefined; }
        const expanded = v.startsWith('~') ? p.join(home, v.slice(1)) : v;
        return isFile(expanded) && names.includes(p.basename(expanded).toLowerCase()) ? expanded : inDir(p.join(expanded, 'bin'));
    };
    const tomDart = fromSdk(env.TOM_DART);
    if (tomDart) { return { dart: tomDart, via: 'TOM_DART' }; }
    for (const key of ['sdkPath', 'flutterSdkPath'] as const) {
        const hit = fromSdk(opts.settings?.[key]);
        if (hit) { return { dart: hit, via: `dart.${key}` }; }
    }
    const pathDirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    const candidates: Array<[string, string]> = pathDirs.map((d) => [d, 'PATH']);
    if (env.DART_SDK) { candidates.push([p.join(env.DART_SDK, 'bin'), 'DART_SDK']); }
    if (env.FLUTTER_ROOT) { candidates.push([p.join(env.FLUTTER_ROOT, 'bin'), 'FLUTTER_ROOT']); }
    for (const dir of pathDirs) {
        if (flutterNames(platform).some((n) => isFile(p.join(dir, n)))) { candidates.push([dir, 'flutter on PATH']); }
    }
    for (const dir of knownDartDirs(platform, home)) { candidates.push([dir, 'known location']); }
    const seen = new Set<string>();
    for (const [dir, via] of candidates) {
        if (seen.has(dir)) { continue; }
        seen.add(dir);
        const dart = inDir(dir);
        if (dart) { return { dart, via }; }
    }
    return undefined;
}

/** The Dart extension's SDK settings of this window ({} outside VS Code). */
export function dartSdkSettings(): DartSdkSettings {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const cfg = vscode.workspace.getConfiguration('dart');
        return { sdkPath: cfg.get('sdkPath'), flutterSdkPath: cfg.get('flutterSdkPath') };
    } catch {
        return {};
    }
}

/** The SDK this window knows: the Dart extension's settings, the environment, the host's usual places. */
export function liveDartSdk(env: NodeJS.ProcessEnv = process.env): DartSdkFound | undefined {
    return findDartSdk({ env, settings: dartSdkSettings() });
}
