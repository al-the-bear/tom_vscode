#!/usr/bin/env node
/**
 * Compile tom_specs_clitool's one binary, tomspecs (`bin/tomspecs.dart`), for
 * THIS host into the extension's bin/<platform>/, where the tools look for it.
 * Its commands are what the tools run:
 *
 *   - `:codespecs-validate` (the codespecs_derivation_contract.md §6 checks,
 *     plus the `--backlinks` index) — the CodeSpecs tools;
 *   - `:spec-*` (the TomSpecs process checks, doc/process_checks.md) — the
 *     tomAi_spec* process-check tools;
 *   - `:ir-map` (Phase 4's mapping of each generation unit from the IR) —
 *     tomAi_specCodeSpecsMap.
 *
 *   node scripts/build-validate-codespecs.cjs     (npm run codespecs:build)
 *
 * `dart compile exe` produces a standalone binary (the model is embedded):
 * the installed extension never runs `dart run` and never needs a Dart SDK. The SDK is needed here, at build time, exactly as it is for
 * the tom_bs bridge binary the install scripts compile beside it.
 *
 * The package lives in ai_build, two levels up from this extension's repo
 * (tom_ai/ai_build). TOM_SOM_AI_BUILD overrides that location, as for
 * `npm run som:pack`. ai_build is shared with other sessions, so uncommitted
 * edits in tom_specs_clitool are listed before the build: the binary is built
 * from the working tree.
 *
 * Beside the binary it writes <name>.build.json, a hash of the source it was
 * built from; `npm run codespecs:check` and the CV-8 guard test
 * compare it with the source as it is now (codespecs-binary-stamp.cjs).
 *
 * The platform folder uses VS Code's naming (darwin-arm64, linux-x64,
 * win32-x64, …), the one src/utils/executableResolver.ts resolves against.
 *
 * The binary is compiled into a scratch folder first (out/codespecs-build/
 * <platform>/) and copied, with its stamp, into bin/<platform>/ only when it
 * built: a failing build (another session's uncommitted edit that does not
 * compile, say) leaves the binary and stamp there as they were, and says so
 * (vscimpb105). A successful build also deletes the clitool binaries tomspecs
 * replaced (RETIRED_CLITOOL_BINARIES) and their stamps from bin/<platform>/.
 * TOM_BINARIES_EXT_BIN names another bin folder (the install's staging folder).
 *
 * Exit codes: 0 built, 1 a step failed (the message names it).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CLITOOL_BINARIES, binaryName, removeRetired, stampName, writeStamp } = require('./codespecs-binary-stamp.cjs');
const { findDart, notFoundMessage } = require('./find-dart.cjs');

const EXT_ROOT = path.resolve(__dirname, '..');
const AI_BUILD_CHECKOUT = process.env.TOM_SOM_AI_BUILD
    ? path.resolve(process.env.TOM_SOM_AI_BUILD)
    : path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const CLITOOL_DIR = path.join(AI_BUILD_CHECKOUT, 'tom_specs_clitool');
const entry = (name) => path.join('bin', `${name}.dart`);

/** VS Code's platform naming for this host — getCurrentPlatform() in executableResolver.ts. */
function hostPlatform() {
    return `${process.platform}-${process.arch}`;
}

function run(cmd, args, cwd) {
    // `dart` is a .bat on Windows, which needs a shell to start; quoted, since
    // the found path may hold spaces.
    const shell = process.platform === 'win32';
    execFileSync(shell ? `"${cmd}"` : cmd, args, { cwd, stdio: 'inherit', shell });
}

function listDirtyEdits() {
    try {
        const out = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: CLITOOL_DIR, encoding: 'utf8' });
        if (out.trim()) {
            console.warn('⚠️  tom_specs_clitool has uncommitted edits; the binary is built from the working tree:');
            console.warn(out.trimEnd().split('\n').map((l) => `    ${l}`).join('\n'));
        }
    } catch {
        // Not a git checkout (a source drop): nothing to compare against.
    }
}

function main() {
    for (const name of CLITOOL_BINARIES) {
        if (!fs.existsSync(path.join(CLITOOL_DIR, entry(name)))) {
            console.error(`❌ ${path.join(CLITOOL_DIR, entry(name))} not found. Check out tom_ai/ai_build beside tom_ai/vscode, or set TOM_SOM_AI_BUILD.`);
            return 1;
        }
    }
    // The Dart SDK, also when `dart` is not on PATH (find-dart.cjs).
    const { found, looked, disabled } = findDart();
    if (!found) {
        console.error(`❌ ${notFoundMessage(looked, disabled)}`);
        return 1;
    }
    const dart = found.dart;
    if (found.via !== 'PATH') { console.log(`ℹ️  Dart SDK: ${dart} (${found.via})`); }
    listDirtyEdits();
    return buildAll({ dart });
}

/** What a failed build leaves: the binaries in bin/<platform>/ as they were. */
function keptMessage(outDir) {
    const kept = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.endsWith('.json')) : [];
    return kept.length
        ? `   ${path.relative(EXT_ROOT, outDir) || outDir} is unchanged: the previous binaries and stamps are kept (${kept.join(', ')}).`
        : `   ${path.relative(EXT_ROOT, outDir) || outDir} is unchanged (it holds no binaries).`;
}

/**
 * Compile every CLI into a scratch folder, then copy the binaries and their
 * stamps into `outDir` — all of them, or none. `compile(name, outFile)` and
 * `stampFor(name, dir)` are replaceable for the tests.
 */
function buildAll({
    dart,
    platform = hostPlatform(),
    outDir = path.join(process.env.TOM_BINARIES_EXT_BIN ? path.resolve(process.env.TOM_BINARIES_EXT_BIN) : path.join(EXT_ROOT, 'bin'), platform),
    scratch = path.join(EXT_ROOT, 'out', 'codespecs-build', platform),
    resolve = () => run(dart, ['pub', 'get'], CLITOOL_DIR),
    compile = (name, outFile) => run(dart, ['compile', 'exe', entry(name), '-o', outFile], CLITOOL_DIR),
    stampFor = (name, dir) => writeStamp({ extRoot: EXT_ROOT, aiBuild: AI_BUILD_CHECKOUT, platform, name, dir }),
} = {}) {
    try {
        console.log('📦 Resolving tom_specs_clitool dependencies...');
        resolve();
    } catch (e) {
        console.error(`❌ Resolving tom_specs_clitool's dependencies failed: ${e.message}`);
        console.error(keptMessage(outDir));
        return 1;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const built = [];
    for (const name of CLITOOL_BINARIES) {
        const file = binaryName(platform, name);
        const scratchFile = path.join(scratch, file);
        try {
            console.log(`📦 Compiling ${name} for ${platform} ...`);
            compile(name, scratchFile);
            if (!fs.existsSync(scratchFile)) { throw new Error(`${file} was not written`); }
        } catch (e) {
            console.error(`❌ Building ${name} failed: ${e.message}`);
            console.error(`   Nothing was copied: ${CLITOOL_BINARIES.length === 1 ? `${CLITOOL_BINARIES[0]} is taken over only when it builds` : `${CLITOOL_BINARIES.join(', ')} are taken over only when all of them build`}.`);
            console.error(keptMessage(outDir));
            fs.rmSync(scratch, { recursive: true, force: true });
            return 1;
        }
        if (process.platform !== 'win32') { fs.chmodSync(scratchFile, 0o755); }
        // What it was built from, for the freshness guard (codespecs-binary-stamp.cjs).
        const stamp = stampFor(name, scratch);
        built.push({ name, file, stamp });
    }
    // Every one built: take them over, each binary with its stamp.
    fs.mkdirSync(outDir, { recursive: true });
    for (const { name, file, stamp } of built) {
        fs.copyFileSync(path.join(scratch, file), path.join(outDir, file));
        if (process.platform !== 'win32') { fs.chmodSync(path.join(outDir, file), 0o755); }
        const stampFile = stampName(name);
        if (fs.existsSync(path.join(scratch, stampFile))) { fs.copyFileSync(path.join(scratch, stampFile), path.join(outDir, stampFile)); }
        console.log(`  ✔ ${path.relative(EXT_ROOT, path.join(outDir, file))} (source ${String(stamp.sourceHash).slice(0, 12)}, ${stamp.sourceFiles} files)`);
    }
    // The clitool binaries tomspecs replaced go, with their stamps.
    const removed = removeRetired(outDir, platform);
    if (removed.length) { console.log(`  ✖ removed the retired ${removed.join(', ')} from ${path.relative(EXT_ROOT, outDir) || outDir}`); }
    fs.rmSync(scratch, { recursive: true, force: true });
    // The scratch's parent (out/codespecs-build/) goes too once it is empty.
    try { fs.rmdirSync(path.dirname(scratch)); } catch { /* other platforms' scratch, or already gone */ }
    return 0;
}

module.exports = { buildAll, keptMessage };

if (require.main === module) {
    process.exitCode = main();
}
