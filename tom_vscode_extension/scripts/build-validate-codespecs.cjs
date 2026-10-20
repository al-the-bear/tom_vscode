#!/usr/bin/env node
/**
 * Compile the validate_codespecs CLI for THIS host into the extension's
 * bin/<platform>/, where the CodeSpecs tools look for it.
 *
 *   node scripts/build-validate-codespecs.cjs     (npm run codespecs:build)
 *
 * The CLI is tom_specs_clitool's `bin/validate_codespecs.dart` (the 37
 * codespecs_derivation_contract.md §6 checks, plus the `--backlinks` index).
 * Its reader parses source text only, so `dart compile exe` produces a
 * standalone binary: the installed extension never runs `dart run` and never
 * needs a Dart SDK. The SDK is needed here, at build time, exactly as it is for
 * the tom_bs bridge binary the install scripts compile beside it.
 *
 * The package lives in ai_build, two levels up from this extension's repo
 * (tom_ai/ai_build). TOM_SOM_AI_BUILD overrides that location, as for
 * `npm run som:pack`. ai_build is shared with other sessions, so uncommitted
 * edits in tom_specs_clitool are listed before the build: the binary is built
 * from the working tree.
 *
 * Beside the binary it writes validate_codespecs.build.json, a hash of the
 * source it was built from; `npm run codespecs:check` and the CV-8 guard test
 * compare it with the source as it is now (codespecs-binary-stamp.cjs).
 *
 * The platform folder uses VS Code's naming (darwin-arm64, linux-x64,
 * win32-x64, …), the one src/utils/executableResolver.ts resolves against.
 *
 * Exit codes: 0 built, 1 a step failed (the message names it).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeStamp } = require('./codespecs-binary-stamp.cjs');
const { findDart, notFoundMessage } = require('./find-dart.cjs');

const EXT_ROOT = path.resolve(__dirname, '..');
const AI_BUILD_CHECKOUT = process.env.TOM_SOM_AI_BUILD
    ? path.resolve(process.env.TOM_SOM_AI_BUILD)
    : path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const CLITOOL_DIR = path.join(AI_BUILD_CHECKOUT, 'tom_specs_clitool');
const ENTRY = path.join('bin', 'validate_codespecs.dart');

/** VS Code's platform naming for this host — getCurrentPlatform() in executableResolver.ts. */
function hostPlatform() {
    return `${process.platform}-${process.arch}`;
}

function binaryName() {
    return process.platform === 'win32' ? 'validate_codespecs.exe' : 'validate_codespecs';
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
    if (!fs.existsSync(path.join(CLITOOL_DIR, ENTRY))) {
        console.error(`❌ ${path.join(CLITOOL_DIR, ENTRY)} not found. Check out tom_ai/ai_build beside tom_ai/vscode, or set TOM_SOM_AI_BUILD.`);
        return 1;
    }
    // The Dart SDK, also when `dart` is not on PATH (find-dart.cjs).
    const { found, looked } = findDart();
    if (!found) {
        console.error(`❌ ${notFoundMessage(looked)}`);
        return 1;
    }
    const dart = found.dart;
    if (found.via !== 'PATH') { console.log(`ℹ️  Dart SDK: ${dart} (${found.via})`); }
    listDirtyEdits();
    const outDir = path.join(EXT_ROOT, 'bin', hostPlatform());
    const outFile = path.join(outDir, binaryName());
    fs.mkdirSync(outDir, { recursive: true });
    try {
        console.log('📦 Resolving tom_specs_clitool dependencies...');
        run(dart, ['pub', 'get'], CLITOOL_DIR);
        console.log(`📦 Compiling validate_codespecs for ${hostPlatform()} ...`);
        run(dart, ['compile', 'exe', ENTRY, '-o', outFile], CLITOOL_DIR);
    } catch (e) {
        console.error(`❌ Building validate_codespecs failed: ${e.message}`);
        return 1;
    }
    if (process.platform !== 'win32') { fs.chmodSync(outFile, 0o755); }
    // What it was built from, for the freshness guard (codespecs-binary-stamp.cjs).
    const stamp = writeStamp({ extRoot: EXT_ROOT, aiBuild: AI_BUILD_CHECKOUT, platform: hostPlatform() });
    console.log(`  ✔ ${path.relative(EXT_ROOT, outFile)} (source ${stamp.sourceHash.slice(0, 12)}, ${stamp.sourceFiles} files)`);
    return 0;
}

process.exitCode = main();
