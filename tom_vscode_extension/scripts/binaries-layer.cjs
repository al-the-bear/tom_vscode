#!/usr/bin/env node
/**
 * The extension's Dart-built binaries in the binaries layer (tom_binaries).
 *
 *   node scripts/binaries-layer.cjs publish [--ff] [--no-push]
 *   node scripts/binaries-layer.cjs bundle [--platforms a,b,...]
 *   node scripts/binaries-layer.cjs tools [--platforms a,b,...]
 *   node scripts/binaries-layer.cjs report [--platforms a,b,...]
 *   node scripts/binaries-layer.cjs unpushed
 *   node scripts/binaries-layer.cjs sync
 *
 * The extension carries three binaries per platform, built with the Dart SDK:
 * tom_bs (the DartScript bridge) and tom_specs_clitool's validate_codespecs
 * (CodeSpecs validation) and spec_checks (the TomSpecs process checks) — the
 * clitool binaries of codespecs-binary-stamp.cjs (CLITOOL_BINARIES). A Dart binary can only be built on its own platform, so a VSIX
 * for several platforms takes the others' from the layer,
 * `tom_binaries/tom/<platform>/`, where every host that builds them leaves
 * its own.
 *
 * publish — after a from-source build (install_extension.* with
 *   TOM_BRIDGE_FROM_SOURCE=1, so compile_and_install.*, create_vsix* and the
 *   binaries-only build): copy this host's bin/<platform>/tom_bs[.exe] and
 *   each clitool binary with its <name>.build.json into the layer,
 *   write tom_bs.build.json (the versioner stamp tom_bs prints on start, with
 *   the build time and host), commit exactly those files and push. A push the
 *   remote refuses (the layer is behind it) leaves the commit local, says so
 *   and exits 3: the install goes on, and nothing pulls the layer on its own.
 *   --ff (the fleet build, create_fleetcompiled_vsix.*): first fast-forward
 *   the layer to its remote — only when it has no commits of its own — so the
 *   hosts' commits follow each other; any failure is then fatal (exit 1).
 *   --no-push commits only.
 * bundle — copy each platform's tom_bs and clitool binaries from the layer
 *   into the extension's bin/<platform>/ for packaging, with their build
 *   stamps (.vscodeignore keeps the stamps out of the VSIX; in the checkout
 *   they say what the binaries were built from — `npm run codespecs:check`,
 *   the CV-8 test). Default platforms: the ones the binaries are built for
 *   (DEFAULT_PLATFORMS: darwin-arm64, linux-x64, win32-x64) that the layer has.
 * tools — copy the tom build tools the VSIX bundles as the last fallback
 *   (BUILD_TOOLS: buildkit, d4rtgen, reflectiongenerator, testkit;
 *   src/services/buildTools.ts) from the layer into bin/<platform>/, each with
 *   a `<name>.bundle.json` stamp: the file, its size and sha256, and the layer
 *   commit that last changed it (.vscodeignore keeps the stamps out of the
 *   VSIX). They are built by their own repositories (tom_build_kit,
 *   tom_d4rt_generator, tom_reflection_generator, tom_test_kit), not here, so
 *   every VSIX — from source or from the layer — takes them from the layer.
 *   Default platforms: DEFAULT_PLATFORMS. A tool or a platform the layer does
 *   not have, or no layer at all, is named and passed: the VSIX goes without
 *   it (exit 0).
 * report — per platform: each binary's build stamp and whether it is older
 *   than the sources here (tom_bs: the bridge files changed since the commit
 *   it was built from, check-tom-bs-provenance.cjs; a clitool binary: the
 *   source hash of its stamp against the clitool source now,
 *   codespecs-binary-stamp.cjs).
 *
 * unpushed — the closing lines of an install: when the layer holds commits its
 *   remote does not (refused pushes pile up there, one per install, and the
 *   refusal itself scrolls past mid-build), say how many, how far the remote
 *   is ahead, and to push them with /tom_push_binaries. It fetches to count,
 *   and never merges, rebases or pushes: bringing the layer level is the
 *   user's step. Silent when the layer is level or absent; always exit 0.
 *
 * sync — before packaging from the layer (install_extension.* with
 *   TOM_LAYER_BINARIES=1, so every create_*binaries_vsix script): bring the
 *   layer level with its remote, so the VSIX packs the binaries every host
 *   published. Behind: fast-forwarded. This host's binaries commits not on the
 *   remote: pushed. Both (the remote moved meanwhile): rebased onto it (each
 *   host's commit touches only its own platform's files), then pushed; a
 *   rebase that does not go through is aborted and the layer packaged as it
 *   is, with a warning. No layer, no repository or no upstream: nothing to do.
 *   Always exit 0: the VSIX can still be packed from the local layer.
 *
 * TOM_BINARIES_LAYER overrides the layer folder (default
 * <workspace>/tom_binaries/tom), TOM_BINARIES_EXT_BIN the extension's bin/
 * folder and TOM_BINARIES_HOST_PLATFORM the host platform (tests).
 *
 * Exit codes: 0 done, 1 a step failed, 2 bad usage, 3 published but not pushed.
 */
'use strict';
/* eslint-disable @typescript-eslint/naming-convention -- exported constants and environment variables keep their names */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const provenance = require('./check-tom-bs-provenance.cjs');
const codespecsStamp = require('./codespecs-binary-stamp.cjs');

const EXT_ROOT = path.resolve(__dirname, '..');
/** The platforms the binaries are built for and a VSIX carries them for: the fleet's build platforms (macOS ARM, Linux x64, Windows x64; fleet-binaries.cjs builds them). */
const DEFAULT_PLATFORMS = ['darwin-arm64', 'linux-x64', 'win32-x64'];
const CLITOOL_BINARIES = codespecsStamp.CLITOOL_BINARIES;
const BINARIES = ['tom_bs', ...CLITOOL_BINARIES];
const TOM_BS_STAMP = 'tom_bs.build.json';
/** The tom build tools a VSIX bundles from the layer as the last fallback (src/services/buildTools.ts BUILD_TOOLS). */
const BUILD_TOOLS = ['buildkit', 'd4rtgen', 'reflectiongenerator', 'testkit'];
/** A bundled build tool's stamp file. */
function toolStampName(name) { return `${name}.bundle.json`; }
const CLITOOL_STAMPS = CLITOOL_BINARIES.map((name) => codespecsStamp.stampName(name));

function layerDir() {
    return process.env.TOM_BINARIES_LAYER
        ? path.resolve(process.env.TOM_BINARIES_LAYER)
        : path.resolve(EXT_ROOT, '..', '..', '..', 'tom_binaries', 'tom');
}

function extBinDir() {
    return process.env.TOM_BINARIES_EXT_BIN ? path.resolve(process.env.TOM_BINARIES_EXT_BIN) : path.join(EXT_ROOT, 'bin');
}

function hostPlatform() {
    return process.env.TOM_BINARIES_HOST_PLATFORM || `${process.platform}-${process.arch}`;
}

function exe(platform, name) {
    return platform.startsWith('win32') ? `${name}.exe` : name;
}

function git(args, cwd, opts = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

const BRIDGE_DIR = path.resolve(EXT_ROOT, '..', 'tom_vscode_bridge');

/**
 * sha256 over the bridge sources tom_bs is compiled from, as they are in the
 * working tree: lib/ and bin/ *.dart and pubspec.yaml, without the versioner
 * stamp file and the generators' `// Generated:` lines (each build rewrites
 * them), line endings normalised (a Windows checkout has CRLF). The same
 * content gives the same hash on every host.
 */
function bridgeSourceHash(bridgeDir = BRIDGE_DIR) {
    const files = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) { return; }
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { walk(abs); } else if (e.name.endsWith('.dart')) { files.push(abs); }
        }
    };
    walk(path.join(bridgeDir, 'lib'));
    walk(path.join(bridgeDir, 'bin'));
    files.push(path.join(bridgeDir, 'pubspec.yaml'));
    const hash = crypto.createHash('sha256');
    for (const abs of files) {
        const rel = path.relative(bridgeDir, abs).split(path.sep).join('/');
        if (rel === 'lib/src/version.versioner.dart' || !fs.existsSync(abs)) { continue; }
        const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('// Generated: ')).join('\n');
        hash.update(rel).update('\0').update(text).update('\0');
    }
    return hash.digest('hex');
}

/**
 * tom_bs's build stamp as written beside it: the versioner stamp, the bridge
 * source hash, when it was built and for which platform. No host name: the
 * layer is a public repository.
 */
function tomBsStamp(binary, platform, now = new Date()) {
    const stamp = provenance.readStamp(binary);
    return {
        format: 'tom-bs-build',
        formatVersion: 1,
        platform,
        // The versioner's time is when this build ran; publishing can come later.
        builtAt: stamp && stamp.buildTime ? new Date(stamp.buildTime).toISOString() : now.toISOString(),
        publishedAt: now.toISOString(),
        version: stamp ? stamp.version : null,
        build: stamp ? stamp.build : null,
        commit: stamp ? stamp.commit : null,
        versionerTime: stamp ? stamp.buildTime : null,
        dart: stamp ? stamp.dart : null,
        bridgeSourceHash: fs.existsSync(BRIDGE_DIR) ? bridgeSourceHash() : null,
    };
}

/** Fast-forward the layer's branch to its remote; refused when it has commits of its own. */
function fastForward(repo) {
    git(['fetch', '--quiet', 'origin'], repo);
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo);
    const ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`], repo));
    if (ahead > 0) {
        throw new Error(`the binaries layer has ${ahead} commit(s) not on ${upstream}: reconcile first (nothing is merged here)`);
    }
    const behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`], repo));
    if (behind > 0) {
        git(['merge', '--ff-only', '--quiet', upstream], repo);
        console.log(`  ↻ binaries layer fast-forwarded by ${behind} commit(s) to ${upstream}`);
    }
}

function publish({ ff = false, push = true } = {}) {
    const platform = hostPlatform();
    const srcDir = path.join(extBinDir(), platform);
    const dstDir = path.join(layerDir(), platform);
    const present = [exe(platform, 'tom_bs'), ...CLITOOL_BINARIES.map((b) => exe(platform, b)), ...CLITOOL_STAMPS]
        .filter((f) => fs.existsSync(path.join(srcDir, f)));
    if (!present.some((f) => !f.endsWith('.json'))) {
        console.log(`ℹ No binaries in bin/${platform}/ to put into the binaries layer.`);
        return 0;
    }
    if (!fs.existsSync(path.dirname(dstDir))) {
        console.error(`❌ No binaries layer at ${path.dirname(dstDir)} (check out tom_binaries beside tom_ai).`);
        return 1;
    }
    let repo;
    try {
        repo = git(['rev-parse', '--show-toplevel'], path.dirname(dstDir));
        if (ff) { fastForward(repo); }
    } catch (e) {
        console.error(`❌ Binaries layer: ${e.message.split('\n')[0]}`);
        return 1;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    // An unchanged tom_bs keeps its stamp: rewriting it (new build time) would
    // commit a change that is none.
    const tomBsName = exe(platform, 'tom_bs');
    const sameTomBs = present.includes(tomBsName)
        && fs.existsSync(path.join(dstDir, tomBsName)) && fs.existsSync(path.join(dstDir, TOM_BS_STAMP))
        && Boolean((readJson(path.join(dstDir, TOM_BS_STAMP)) || {}).bridgeSourceHash)
        && fs.readFileSync(path.join(srcDir, tomBsName)).equals(fs.readFileSync(path.join(dstDir, tomBsName)));
    const written = [];
    for (const f of present) {
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
        if (!f.endsWith('.json') && !platform.startsWith('win32')) { fs.chmodSync(path.join(dstDir, f), 0o755); }
        written.push(f);
    }
    let tomBs = null;
    if (present.includes(tomBsName)) {
        if (sameTomBs) {
            tomBs = readJson(path.join(dstDir, TOM_BS_STAMP));
        } else {
            tomBs = tomBsStamp(path.join(dstDir, tomBsName), platform);
            fs.writeFileSync(path.join(dstDir, TOM_BS_STAMP), `${JSON.stringify(tomBs, null, 2)}\n`);
        }
        written.push(TOM_BS_STAMP);
    }
    // Against the real folder: git names the repository by its real path (a
    // symlinked parent would otherwise put the files "outside" it).
    const realDst = fs.realpathSync(dstDir);
    const rel = written.map((f) => path.relative(repo, path.join(realDst, f)).split(path.sep).join('/'));
    try {
        git(['add', '--', ...rel], repo);
        const changed = spawnSync('git', ['diff', '--cached', '--quiet', '--', ...rel], { cwd: repo }).status !== 0;
        if (!changed) {
            console.log(`✔ The binaries layer already holds this build for ${platform}.`);
            return 0;
        }
        const parts = [];
        if (tomBs) { parts.push(`tom_bs ${tomBs.version ?? '?'}+${tomBs.build ?? '?'}${tomBs.commit ? ` (${tomBs.commit})` : ''}`); }
        for (const name of CLITOOL_BINARIES) {
            if (!present.includes(exe(platform, name))) { continue; }
            const cs = readJson(path.join(dstDir, codespecsStamp.stampName(name)));
            const head = cs && cs.clitool && cs.clitool.head ? ` (clitool ${String(cs.clitool.head).slice(0, 8)}${cs.clitool.dirty ? ', dirty' : ''})` : '';
            parts.push(`${name}${head}`);
        }
        const message = `${parts.join(', ')} for ${platform}`;
        git(['commit', '--quiet', '-m', message, '--', ...rel], repo);
        console.log(`✔ Binaries layer: committed ${message}`);
    } catch (e) {
        console.error(`❌ Committing the binaries layer failed: ${(e.stderr || e.message).toString().trim()}`);
        return 1;
    }
    if (!push) { return 0; }
    try {
        git(['push', '--quiet', 'origin', 'HEAD'], repo);
        console.log('✔ Binaries layer pushed.');
        return 0;
    } catch (e) {
        const why = (e.stderr || e.message).toString().trim().split('\n').slice(-1)[0];
        if (ff) {
            console.error(`❌ Pushing the binaries layer failed: ${why}`);
            return 1;
        }
        console.warn(`⚠️  The binaries layer commit stays local: the push was refused (${why}). Push it after the next reconcile (/tom_push_binaries).`);
        return 3;
    }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function platformsArg(argv) {
    const i = argv.indexOf('--platforms');
    if (i < 0) { return null; }
    return String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function bundle(platforms) {
    const layer = layerDir();
    const list = platforms || DEFAULT_PLATFORMS;
    let count = 0;
    for (const platform of list) {
        const srcDir = path.join(layer, platform);
        const found = BINARIES.map((b) => exe(platform, b)).filter((f) => fs.existsSync(path.join(srcDir, f)));
        if (found.length === 0) {
            console.log(`  ⚠️  ${platform}: none of ${BINARIES.join(', ')} in the binaries layer`);
            continue;
        }
        const dstDir = path.join(extBinDir(), platform);
        fs.mkdirSync(dstDir, { recursive: true });
        for (const f of found) {
            fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
            if (!platform.startsWith('win32')) { fs.chmodSync(path.join(dstDir, f), 0o755); }
            count++;
        }
        for (const stamp of [TOM_BS_STAMP, ...CLITOOL_STAMPS]) {
            if (fs.existsSync(path.join(srcDir, stamp))) { fs.copyFileSync(path.join(srcDir, stamp), path.join(dstDir, stamp)); }
        }
        const missing = BINARIES.map((b) => exe(platform, b)).filter((f) => !found.includes(f));
        console.log(`  ✔ ${platform}: ${found.join(', ')}${missing.length ? ` (no ${missing.join(', ')})` : ''}`);
    }
    console.log(`  Bundled ${count} binaries from the binaries layer`);
    return 0;
}

/** One platform's binaries in the layer: their stamps and freshness against the sources here. */
function describePlatform(platform, { layer = layerDir(), aiBuild = codespecsStamp.aiBuildCheckout(), currentHashes = {}, currentBridgeHash } = {}) {
    const dir = path.join(layer, platform);
    const out = { platform, tomBs: null, clitool: Object.fromEntries(CLITOOL_BINARIES.map((name) => [name, null])) };
    if (fs.existsSync(path.join(dir, exe(platform, 'tom_bs')))) {
        const s = readJson(path.join(dir, TOM_BS_STAMP));
        if (!s || !s.commit) {
            const mtime = fs.statSync(path.join(dir, exe(platform, 'tom_bs'))).mtime.toISOString();
            out.tomBs = { state: 'unknown', text: `tom_bs: no build stamp (file from ${mtime.slice(0, 10)}): its source is unknown` };
        } else if (s.bridgeSourceHash && currentBridgeHash && s.bridgeSourceHash === currentBridgeHash) {
            // Built from exactly the bridge sources here, uncommitted edits included.
            out.tomBs = { state: 'fresh', text: `tom_bs ${s.version}+${s.build} (${s.commit}, built ${s.builtAt.slice(0, 16).replace('T', ' ')}): ${label('fresh')}` };
        } else {
            const changed = provenance.changedSince(s.commit);
            const verdict = provenance.judgeProvenance({
                stamp: { version: s.version, build: s.build, commit: s.commit, buildTime: s.builtAt, dart: s.dart },
                changedFiles: changed,
            });
            out.tomBs = { state: verdict.state, text: `tom_bs ${s.version}+${s.build} (${s.commit}, built ${s.builtAt.slice(0, 16).replace('T', ' ')}): ${label(verdict.state, changed)}` };
        }
    }
    for (const name of CLITOOL_BINARIES) {
        if (!fs.existsSync(path.join(dir, exe(platform, name)))) { continue; }
        const s = readJson(path.join(dir, codespecsStamp.stampName(name)));
        const currentHash = currentHashes[name];
        if (!s || !s.sourceHash) {
            out.clitool[name] = { state: 'unknown', text: `${name}: no build stamp: its source is unknown` };
        } else if (!currentHash) {
            out.clitool[name] = { state: 'unknown', text: `${name} (built ${s.builtAt.slice(0, 16).replace('T', ' ')}): no clitool source at ${aiBuild} to compare with` };
        } else {
            const state = s.sourceHash === currentHash ? 'fresh' : 'stale';
            const head = s.clitool && s.clitool.head ? `clitool ${String(s.clitool.head).slice(0, 8)}${s.clitool.dirty ? ', dirty' : ''}, ` : '';
            out.clitool[name] = { state, text: `${name} (${head}built ${s.builtAt.slice(0, 16).replace('T', ' ')}): ${label(state)}` };
        }
    }
    return out;
}

function label(state, changed) {
    if (state === 'fresh') { return '✔ built from the current sources'; }
    if (state === 'stale') { return `⚠️  older than the sources${changed && changed.length ? ` (${changed.length} bridge file(s) changed since)` : ''}`; }
    return 'ℹ freshness unknown';
}

function report(platforms) {
    const layer = layerDir();
    const list = platforms || DEFAULT_PLATFORMS;
    const aiBuild = codespecsStamp.aiBuildCheckout();
    const currentHashes = {};
    for (const name of CLITOOL_BINARIES) {
        if (fs.existsSync(path.join(aiBuild, 'tom_specs_clitool', 'bin', `${name}.dart`))) {
            currentHashes[name] = codespecsStamp.sourceHash(aiBuild, name).hash;
        }
    }
    const currentBridgeHash = fs.existsSync(BRIDGE_DIR) ? bridgeSourceHash() : null;
    console.log('Binaries in the layer (tom_binaries/tom/<platform>/), against the sources here:');
    let stale = 0;
    for (const platform of list) {
        const d = describePlatform(platform, { layer, aiBuild, currentHashes, currentBridgeHash });
        const entries = [d.tomBs, ...CLITOOL_BINARIES.map((name) => d.clitool[name])];
        if (entries.every((e) => !e)) {
            console.log(`  ${platform}: none`);
            continue;
        }
        console.log(`  ${platform}:`);
        for (const entry of entries) {
            if (!entry) { continue; }
            if (entry.state !== 'fresh') { stale++; }
            console.log(`    ${entry.text}`);
        }
    }
    if (stale > 0) {
        console.log(`  ${stale} binary(ies) are older than the sources or of unknown source: the host of that platform rebuilds them (compile_and_install, or create_fleetcompiled_vsix on a reconciled fleet).`);
    }
    return 0;
}

/** The closing lines' warning about layer commits the remote does not have (see the header). */
function unpushed() {
    let repo;
    try {
        if (!fs.existsSync(layerDir())) { return 0; }
        repo = git(['rev-parse', '--show-toplevel'], layerDir());
    } catch {
        return 0;
    }
    try {
        // Only to count: a fetch updates the remote-tracking refs and touches nothing else.
        git(['fetch', '--quiet', 'origin'], repo, { timeout: 30000 });
    } catch {
        // Offline: count against what is known.
    }
    let upstream; let ahead; let behind;
    try {
        upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo);
        ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`], repo));
        behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`], repo));
    } catch {
        return 0;
    }
    if (ahead === 0) { return 0; }
    console.log('');
    console.log(`⚠️  The binaries layer (${repo}) has ${ahead} binaries layer commit(s) not on ${upstream}${behind > 0 ? `, and is behind it by ${behind} (another host's)` : ''}.`);
    console.log('   Other hosts and layer-built VSIXs still get the older binaries. Push them with /tom_push_binaries (or a reconcile).');
    return 0;
}

/** `sync`: the layer level with its remote before packaging (see the header). Answers what it did. */
function sync() {
    let repo;
    try {
        if (!fs.existsSync(layerDir())) { return 'no layer'; }
        repo = git(['rev-parse', '--show-toplevel'], layerDir());
    } catch {
        return 'not a repository';
    }
    try {
        git(['fetch', '--quiet', 'origin'], repo, { timeout: 60000 });
    } catch (e) {
        console.log(`⚠️  The binaries layer could not be fetched (${firstLine(e)}): packaging what it holds.`);
        return 'offline';
    }
    let upstream; let ahead; let behind;
    try {
        upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo);
        ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`], repo));
        behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`], repo));
    } catch {
        return 'no upstream';
    }
    try {
        if (behind > 0 && ahead === 0) {
            git(['merge', '--ff-only', '--quiet', upstream], repo);
            console.log(`  ↻ binaries layer fast-forwarded by ${behind} commit(s) to ${upstream} (the other hosts' binaries)`);
            return 'pulled';
        }
        if (behind > 0) {
            try {
                git(['rebase', '--quiet', upstream], repo);
            } catch (e) {
                try { git(['rebase', '--abort'], repo); } catch { /* nothing to abort */ }
                console.log(`⚠️  The binaries layer has ${ahead} commit(s) of its own and is ${behind} behind ${upstream}; they could not be put on top (${firstLine(e)}).`);
                console.log('   Packaging the layer as it is; bring it level with /tom_push_binaries.');
                return 'diverged';
            }
            console.log(`  ↻ binaries layer: ${ahead} commit(s) of this host put on top of ${behind} from ${upstream}`);
        }
        if (ahead > 0) {
            git(['push', '--quiet'], repo, { timeout: 120000 });
            console.log(`  ⬆ binaries layer: ${ahead} unpushed commit(s) pushed to ${upstream}`);
            return 'pushed';
        }
    } catch (e) {
        console.log(`⚠️  The binaries layer could not be brought level (${firstLine(e)}): packaging what it holds.`);
        return 'failed';
    }
    return 'level';
}

function firstLine(e) {
    return String((e && (e.stderr || e.message)) || e).split('\n').map((l) => l.trim()).find(Boolean) || 'error';
}

/** The layer commit that last changed `rel` (relative to the layer folder): {commit, committedAt}, or null. */
function layerCommitOf(layer, rel) {
    try {
        const line = git(['log', '-1', '--format=%H %cI', '--', rel], layer);
        if (!line) { return null; }
        const [commit, committedAt] = line.split(' ');
        return { commit, committedAt };
    } catch { return null; }
}

/** The stamp of a build tool copied from the layer: what it is and where it came from. */
function toolStamp(layer, platform, name, now = new Date()) {
    const file = exe(platform, name);
    const abs = path.join(layer, platform, file);
    const data = fs.readFileSync(abs);
    const from = layerCommitOf(layer, `${platform}/${file}`);
    return {
        format: 'tom-build-tool-bundle',
        formatVersion: 1,
        name,
        platform,
        file,
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        source: 'binaries layer',
        ...(from ? { layerCommit: from.commit, layerCommittedAt: from.committedAt } : {}),
        bundledAt: now.toISOString(),
    };
}

/** Copy the build tools of `platforms` from the layer into bin/<platform>/ with their stamps; always 0. */
function tools(platforms) {
    const layer = layerDir();
    const list = platforms || DEFAULT_PLATFORMS;
    if (!fs.existsSync(layer)) {
        console.log(`  ⚠️  No binaries layer at ${layer}: the VSIX carries no build tools (${BUILD_TOOLS.join(', ')}).`);
        return 0;
    }
    let count = 0;
    for (const platform of list) {
        const srcDir = path.join(layer, platform);
        const found = BUILD_TOOLS.filter((t) => fs.existsSync(path.join(srcDir, exe(platform, t))));
        const missing = BUILD_TOOLS.filter((t) => !found.includes(t));
        if (found.length === 0) {
            console.log(`  ⚠️  ${platform}: none of the build tools (${BUILD_TOOLS.join(', ')}) in the binaries layer`);
            continue;
        }
        const dstDir = path.join(extBinDir(), platform);
        fs.mkdirSync(dstDir, { recursive: true });
        for (const name of found) {
            const file = exe(platform, name);
            fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
            if (!platform.startsWith('win32')) { fs.chmodSync(path.join(dstDir, file), 0o755); }
            fs.writeFileSync(path.join(dstDir, toolStampName(name)), `${JSON.stringify(toolStamp(layer, platform, name), null, 2)}\n`);
            count++;
        }
        console.log(`  ✔ ${platform}: ${found.map((t) => exe(platform, t)).join(', ')}${missing.length ? ` (not in the layer: ${missing.join(', ')})` : ''}`);
    }
    console.log(`  Bundled ${count} build tools from the binaries layer`);
    return 0;
}

module.exports = { DEFAULT_PLATFORMS, BUILD_TOOLS, toolStampName, toolStamp, tools, layerDir, hostPlatform, bridgeSourceHash, tomBsStamp, publish, bundle, describePlatform, report, unpushed, sync };

if (require.main === module) {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'publish') {
        process.exitCode = publish({ ff: argv.includes('--ff'), push: !argv.includes('--no-push') });
    } else if (cmd === 'bundle') {
        process.exitCode = bundle(platformsArg(argv));
    } else if (cmd === 'tools') {
        process.exitCode = tools(platformsArg(argv));
    } else if (cmd === 'report') {
        process.exitCode = report(platformsArg(argv));
    } else if (cmd === 'unpushed') {
        process.exitCode = unpushed();
    } else if (cmd === 'sync') {
        sync();
        process.exitCode = 0;
    } else {
        console.error('usage: binaries-layer.cjs publish [--ff] [--no-push] | bundle [--platforms a,b] | tools [--platforms a,b] | report [--platforms a,b] | unpushed | sync');
        process.exitCode = 2;
    }
}
