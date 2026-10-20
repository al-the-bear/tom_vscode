#!/usr/bin/env node
/**
 * Is the bundled validate_codespecs binary built from the tom_specs_clitool
 * source as it is now?
 *
 *   node scripts/codespecs-binary-stamp.cjs     (npm run codespecs:check)
 *
 * `npm run codespecs:build` compiles bin/<platform>/validate_codespecs from
 * ai_build's tom_specs_clitool and writes, beside it,
 * validate_codespecs.build.json: a sha256 over the files the binary is built
 * from, with the clitool's git HEAD and dirty flag for the message. Nothing
 * else noticed when that source moved on: the tests and the tools then ran an
 * old checker (the stale-model failure of gate A5, in another form).
 *
 * The files: tom_specs_clitool's lib/**\/*.dart, bin/validate_codespecs.dart,
 * pubspec.yaml, pubspec.lock and pubspec_overrides.yaml, plus lib/**\/*.dart
 * and pubspec.yaml of every sibling that pubspec_overrides.yaml resolves by
 * path — the binary imports the whole package barrel, and the overrides
 * compile those siblings in. Their content is hashed, not a commit, because
 * the build compiles the working tree, uncommitted edits included.
 *
 * Like bin/, the stamp is gitignored and not packaged: it describes this
 * machine's binary.
 *
 * Exit codes (as a script): 0 fresh, 1 stale or no stamp, 2 not measured
 * (no binary, or no clitool source to compare with).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const STAMP_FORMAT = 'validate-codespecs-build';
const STAMP_FORMAT_VERSION = 1;

function aiBuildCheckout() {
    return process.env.TOM_SOM_AI_BUILD
        ? path.resolve(process.env.TOM_SOM_AI_BUILD)
        : path.resolve(EXT_ROOT, '..', '..', 'ai_build');
}

/** VS Code's platform naming for this host (getCurrentPlatform() in executableResolver.ts). */
function hostPlatform() {
    return `${process.platform}-${process.arch}`;
}

function binaryName(platform = hostPlatform()) {
    return platform.startsWith('win32') ? 'validate_codespecs.exe' : 'validate_codespecs';
}

function binaryPath(extRoot = EXT_ROOT, platform = hostPlatform()) {
    return path.join(extRoot, 'bin', platform, binaryName(platform));
}

function stampPath(extRoot = EXT_ROOT, platform = hostPlatform()) {
    return path.join(extRoot, 'bin', platform, 'validate_codespecs.build.json');
}

/** Every `*.dart` under `dir`, relative to `base`, in a stable order. */
function dartFiles(dir, base) {
    const out = [];
    if (!fs.existsSync(dir)) { return out; }
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) { walk(abs); } else if (e.isFile() && e.name.endsWith('.dart')) { out.push(path.relative(base, abs)); }
        }
    };
    walk(dir);
    return out;
}

/** The sibling folders pubspec_overrides.yaml resolves by path (relative to the clitool). */
function overridePaths(clitoolDir) {
    const file = path.join(clitoolDir, 'pubspec_overrides.yaml');
    if (!fs.existsSync(file)) { return []; }
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s+path:\s*['"]?([^'"#\s]+)['"]?/.exec(line);
        if (m) { out.push(m[1]); }
    }
    return out;
}

/**
 * The files the binary is built from, as paths relative to ai_build
 * (forward slashes), sorted. Missing optional files are left out.
 */
function feedFiles(aiBuild = aiBuildCheckout()) {
    const clitool = path.join(aiBuild, 'tom_specs_clitool');
    const files = new Set();
    const add = (abs) => { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { files.add(path.relative(aiBuild, abs)); } };
    for (const rel of dartFiles(path.join(clitool, 'lib'), aiBuild)) { files.add(rel); }
    for (const f of ['bin/validate_codespecs.dart', 'pubspec.yaml', 'pubspec.lock', 'pubspec_overrides.yaml']) { add(path.join(clitool, f)); }
    for (const rel of overridePaths(clitool)) {
        const sibling = path.resolve(clitool, rel);
        for (const f of dartFiles(path.join(sibling, 'lib'), aiBuild)) { files.add(f); }
        add(path.join(sibling, 'pubspec.yaml'));
    }
    return Array.from(files).map((f) => f.split(path.sep).join('/')).sort();
}

/** sha256 over each feed file's path and content: what the binary is built from, now. */
function sourceHash(aiBuild = aiBuildCheckout()) {
    const files = feedFiles(aiBuild);
    const hash = crypto.createHash('sha256');
    for (const rel of files) {
        hash.update(rel).update('\0').update(fs.readFileSync(path.join(aiBuild, rel))).update('\0');
    }
    return { hash: hash.digest('hex'), files: files.length };
}

/** The clitool's HEAD and whether its source is dirty; nulls outside a git checkout. */
function gitInfo(aiBuild = aiBuildCheckout()) {
    const cwd = path.join(aiBuild, 'tom_specs_clitool');
    try {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd, encoding: 'utf8' }).trim() !== '';
        return { head, dirty };
    } catch {
        return { head: null, dirty: null };
    }
}

/** Write the stamp for the binary just built. */
function writeStamp({ extRoot = EXT_ROOT, aiBuild = aiBuildCheckout(), platform = hostPlatform(), now = new Date() } = {}) {
    const { hash, files } = sourceHash(aiBuild);
    const stamp = {
        format: STAMP_FORMAT,
        formatVersion: STAMP_FORMAT_VERSION,
        platform,
        builtAt: now.toISOString(),
        sourceHash: hash,
        sourceFiles: files,
        clitool: gitInfo(aiBuild),
    };
    fs.writeFileSync(stampPath(extRoot, platform), `${JSON.stringify(stamp, null, 2)}\n`);
    return stamp;
}

/**
 * Whether the binary is built from the source as it is now:
 * `fresh`, `stale` (the source changed since), `noStamp` (built before stamps,
 * or by hand), `noBinary`, `noSource` (no clitool to compare with) — each with
 * a message naming what to do.
 */
function checkFreshness({ extRoot = EXT_ROOT, aiBuild = aiBuildCheckout(), platform = hostPlatform() } = {}) {
    const fix = 'Run `npm run codespecs:build` (a Dart SDK on PATH is needed).';
    if (!fs.existsSync(binaryPath(extRoot, platform))) {
        return { state: 'noBinary', message: `No validate_codespecs binary for ${platform}. ${fix}` };
    }
    if (!fs.existsSync(path.join(aiBuild, 'tom_specs_clitool', 'bin', 'validate_codespecs.dart'))) {
        return { state: 'noSource', message: `No tom_specs_clitool source at ${aiBuild}: freshness not measured.` };
    }
    const file = stampPath(extRoot, platform);
    if (!fs.existsSync(file)) {
        return { state: 'noStamp', message: `The validate_codespecs binary has no build stamp, so its source is unknown. ${fix}` };
    }
    const stamp = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = sourceHash(aiBuild);
    if (stamp.sourceHash === current.hash) {
        return { state: 'fresh', stamp, current, message: `validate_codespecs is built from the current source (${stamp.builtAt}).` };
    }
    const built = stamp.clitool && stamp.clitool.head ? ` (clitool ${String(stamp.clitool.head).slice(0, 8)}${stamp.clitool.dirty ? ', dirty' : ''})` : '';
    const now = gitInfo(aiBuild);
    const nowAt = now.head ? ` (now ${now.head.slice(0, 8)}${now.dirty ? ', dirty' : ''})` : '';
    return {
        state: 'stale',
        stamp,
        current,
        message: `validate_codespecs was built ${stamp.builtAt}${built}; tom_specs_clitool or a path-resolved sibling changed since${nowAt}. ${fix}`,
    };
}

module.exports = {
    STAMP_FORMAT, STAMP_FORMAT_VERSION,
    aiBuildCheckout, hostPlatform, binaryName, binaryPath, stampPath,
    feedFiles, sourceHash, gitInfo, writeStamp, checkFreshness,
};

if (require.main === module) {
    const r = checkFreshness();
    console.log(`${r.state === 'fresh' ? '✔' : r.state === 'noSource' ? 'ℹ' : '✖'} ${r.message}`);
    process.exitCode = r.state === 'fresh' ? 0 : (r.state === 'noSource' || r.state === 'noBinary') ? 2 : 1;
}
