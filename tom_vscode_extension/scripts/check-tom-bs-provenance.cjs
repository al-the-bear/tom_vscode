#!/usr/bin/env node
/**
 * Which bridge source was the prebuilt tom_bs built from, and is it older
 * than the committed bridge sources?
 *
 *   node scripts/check-tom-bs-provenance.cjs [--binary <path>]
 *
 * The prebuilt-binaries install bundles tom_bs from tom_binaries, built
 * whenever somebody last ran `buildkit :compiler`. check-bridge-fresh.cjs says
 * whether the committed bridges match the scripting API; it says nothing about
 * a binary built before the last regeneration (the 09fbfd7 case: the committed
 * bridges gained streamQuery & co. after the binary was built).
 *
 * tom_bs prints its versioner stamp when it starts —
 * `[BSTART] Version: 1.0.0+38.42e69c0 (2026-10-02T17:21:39Z) [Dart 3.12.2]` —
 * and exits when stdin is closed, so the stamp is read by starting it with an
 * empty stdin. Its commit is then compared with the bridge sources now: the
 * files under tom_vscode_bridge/lib and /bin and its pubspec.yaml whose content
 * differs from that commit, ignoring the versioner stamp and the generators'
 * `// Generated:` lines (which every rebuild rewrites). Changed files mean the
 * binary may be older than the sources; the install warns (it goes on; a fresh
 * binary comes from compile_and_install).
 *
 * Exit codes: 0 fresh, 1 older than the sources, 2 not measured (no binary,
 * no stamp, a commit this checkout does not have).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(EXT_ROOT, '..');                          // tom_ai/vscode
const BRIDGE = 'tom_vscode_bridge';
/** The bridge sources a binary is built from, as git pathspecs relative to the repo. */
const FEED = [`${BRIDGE}/lib`, `${BRIDGE}/bin`, `${BRIDGE}/pubspec.yaml`, `:(exclude)${BRIDGE}/lib/src/version.versioner.dart`];
const GENERATED_LINE = '^// Generated: ';

const STAMP = /\[BSTART\] Version: (\S+?)\+(\d+)\.([0-9a-f]{7,40}) \(([^)]+)\)(?: \[Dart ([^\]]+)\])?/;

/** The versioner stamp in tom_bs's start-up output, or null. */
function parseBridgeStamp(output) {
    const m = STAMP.exec(output || '');
    if (!m) { return null; }
    return { version: m[1], build: Number(m[2]), commit: m[3], buildTime: m[4], dart: m[5] || null };
}

/**
 * The verdict, without IO: `stamp` from parseBridgeStamp; `changedFiles` the
 * bridge files whose content differs from the stamp's commit, or null when
 * that commit is not in this checkout.
 */
function judgeProvenance({ stamp, changedFiles }) {
    if (!stamp) {
        return { state: 'unknown', message: 'tom_bs printed no build stamp: which bridge source it was built from is unknown.' };
    }
    const built = `tom_bs ${stamp.version}+${stamp.build} was built from ${stamp.commit} (${stamp.buildTime})`;
    if (changedFiles === null) {
        return { state: 'unknown', stamp, message: `${built}; that commit is not in this checkout, so it cannot be compared.` };
    }
    if (changedFiles.length === 0) {
        return { state: 'fresh', stamp, message: `${built}; the bridge sources are the same now.` };
    }
    const shown = changedFiles.slice(0, 5).map((f) => f.replace(`${BRIDGE}/`, '')).join(', ');
    const more = changedFiles.length > 5 ? ` and ${changedFiles.length - 5} more` : '';
    return {
        state: 'stale',
        stamp,
        changedFiles,
        message: `${built}; the bridge sources changed since (${shown}${more}), so it may lack them. compile_and_install rebuilds it.`,
    };
}

/** Start the binary with an empty stdin and read its start-up output (it exits when stdin closes). */
function readStamp(binary, timeoutMs = 20000) {
    const r = spawnSync(binary, [], { input: '', encoding: 'utf8', timeout: timeoutMs });
    return parseBridgeStamp(`${r.stdout || ''}\n${r.stderr || ''}`);
}

/** The bridge files whose content differs from `commit` (stamp lines ignored); null when the commit is unknown. */
function changedSince(commit, repo = REPO) {
    try {
        execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repo, stdio: 'ignore' });
    } catch {
        return null;
    }
    // --numstat honours -I (--name-only does not): a file whose only change is
    // a `// Generated:` line counts 0 / 0 and is no change.
    const out = execFileSync('git', ['diff', '--numstat', `-I${GENERATED_LINE}`, commit, '--', ...FEED], { cwd: repo, encoding: 'utf8' });
    return out.split('\n').map((l) => l.split('\t')).filter((c) => c.length === 3 && (c[0] !== '0' || c[1] !== '0')).map((c) => c[2]);
}

function hostPlatform() {
    return `${process.platform}-${process.arch}`;
}

/** The host's prebuilt tom_bs: the one bundled into bin/, else the one in tom_binaries. */
function defaultBinary() {
    const name = process.platform === 'win32' ? 'tom_bs.exe' : 'tom_bs';
    const bundled = path.join(EXT_ROOT, 'bin', hostPlatform(), name);
    if (fs.existsSync(bundled)) { return bundled; }
    return path.resolve(REPO, '..', '..', 'tom_binaries', 'tom', hostPlatform(), name);
}

module.exports = { parseBridgeStamp, judgeProvenance, readStamp, changedSince, FEED };

if (require.main === module) {
    const i = process.argv.indexOf('--binary');
    const binary = i > 0 ? process.argv[i + 1] : defaultBinary();
    let verdict;
    if (!fs.existsSync(binary)) {
        verdict = { state: 'unknown', message: `No tom_bs at ${binary}.` };
    } else {
        const stamp = readStamp(binary);
        verdict = judgeProvenance({ stamp, changedFiles: stamp ? changedSince(stamp.commit) : [] });
    }
    console.log(`${verdict.state === 'fresh' ? '✔' : verdict.state === 'stale' ? '⚠️ ' : 'ℹ'} ${verdict.message}`);
    process.exitCode = verdict.state === 'fresh' ? 0 : verdict.state === 'stale' ? 1 : 2;
}
