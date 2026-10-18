#!/usr/bin/env node
/**
 * Build the TomSpecs SOM TypeScript pair and drop it into vendor/tom_som/ as
 * two version-free tarballs the extension's package.json depends on.
 *
 *   node scripts/build-som-packages.cjs        (npm run som:pack)
 *
 * Why tarballs and not `file:` folder links: a folder link is a symlink in
 * node_modules, and the VSIX must carry real files — the installed extension
 * may never reach back into an ai_build checkout. tom_specs measured the route
 * (vsctsa36): `npm pack` both packages and install the two tarballs, and the
 * installed tree holds no symlink, with one runtime instance shared by the
 * facade (the runtime is the facade's peer dependency).
 *
 * Why version-free names: package.json then stays the same across model bumps;
 * the versions are recorded in vendor/tom_som/versions.json instead, with the
 * packed model's `modelHash`: a model can change under an unchanged version,
 * and only the hash says so.
 *
 * The packages live in ai_build, two levels up from this extension's repo
 * (tom_ai/ai_build). TOM_SOM_AI_BUILD overrides that location. Neither package
 * commits dist/ or a lockfile, so each is installed (`npm install`, not ci)
 * and packed; `npm pack` runs their prepack build.
 *
 * After packing, the installed copies in node_modules and their lockfile
 * entries are removed: npm keeps a `file:` tarball dependency whose name and
 * version did not change, even when its content did, so without this a
 * rebuilt runtime never reaches the extension. Run `npm install` afterwards
 * (install_extension.sh does).
 *
 * It also copies the CodeSpecs area catalogue
 * (tom_specs_model/generated-doc/codespecs/codespecs_areas.json) to
 * resources/codespecs/: the catalogue is not part of either package, and the
 * VSIX must carry it like everything else the tools load (vsctsa10). The copy
 * is gitignored build output; a guard test holds it equal to the source.
 * Beside it goes the CodeSpecs derivation contract
 * (tom_core_codespecs/doc/codespecs_derivation_contract.md, in tom_ai/core;
 * TOM_CORE_CHECKOUT overrides that location), whose §3 entries the step-context
 * tool hands an authoring step (vsctsa20). It is copied from tom_core's
 * working tree in every mode, `--from-head` included, which exports ai_build
 * only.
 *
 * The packages are built from ai_build's WORKING TREE, and ai_build is shared
 * with other sessions: an uncommitted edit there (someone's work in progress)
 * ends up in the extension. The script lists such edits before it packs, and
 * `--from-head` packs ai_build's committed HEAD instead (exported with
 * `git archive` into <workspace>/ztmp/som-pack-head/), so the extension gets
 * only what was committed.
 *
 * Exit codes: 0 built, 1 a step failed (the message names it).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const AI_BUILD_CHECKOUT = process.env.TOM_SOM_AI_BUILD
    ? path.resolve(process.env.TOM_SOM_AI_BUILD)
    : path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const VENDOR_DIR = path.join(EXT_ROOT, 'vendor', 'tom_som');

/** The CodeSpecs area catalogue, in ai_build and in the extension. */
const CATALOG_SOURCE = path.join('tom_specs_model', 'generated-doc', 'codespecs', 'codespecs_areas.json');
const CATALOG_TARGET = path.join(EXT_ROOT, 'resources', 'codespecs', 'codespecs_areas.json');

/** The CodeSpecs derivation contract, in tom_core and in the extension. */
const CORE_CHECKOUT = process.env.TOM_CORE_CHECKOUT
    ? path.resolve(process.env.TOM_CORE_CHECKOUT)
    : path.resolve(EXT_ROOT, '..', '..', 'core');
const CONTRACT_SOURCE = path.join(CORE_CHECKOUT, 'tom_core_codespecs', 'doc', 'codespecs_derivation_contract.md');
const CONTRACT_TARGET = path.join(EXT_ROOT, 'resources', 'codespecs', 'codespecs_derivation_contract.md');

/** Copy the CodeSpecs area catalogue (from `aiBuild`) and the derivation contract (from tom_core) into the extension. */
function copyCodeSpecsCatalog(aiBuild) {
    const copies = [[path.join(aiBuild, CATALOG_SOURCE), CATALOG_TARGET, 'the CodeSpecs area catalogue'],
        [CONTRACT_SOURCE, CONTRACT_TARGET, 'the CodeSpecs derivation contract']];
    for (const [source, target, what] of copies) {
        if (!fs.existsSync(source)) {
            fail(`${what} is missing at ${source}.`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        console.log(`  ✔ ${path.relative(EXT_ROOT, target)}`);
    }
}

/** In dependency order: the facade's prepack builds against the runtime. */
const PACKAGES = ['tom_som_typescript_runtime', 'tom_som_typescript_v0'];

function fail(message) {
    console.error(`❌ ${message}`);
    process.exit(1);
}

function npm(args, cwd) {
    // `shell: true` resolves npm.cmd on Windows; the arguments are fixed
    // literals and paths we built, so nothing user-supplied reaches the shell.
    return execFileSync('npm', args, {
        cwd,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
    });
}

/** Uncommitted changes under the packed paths of a git checkout; [] when clean or not a git checkout. */
function uncommitted(aiBuild) {
    try {
        const out = execFileSync('git', ['-C', aiBuild, 'status', '--porcelain', '--', ...PACKAGES, CATALOG_SOURCE], { encoding: 'utf8' });
        return out.split('\n').filter((l) => l.trim() !== '');
    } catch {
        return [];
    }
}

/** ai_build's committed HEAD of the packed paths, exported into the workspace's ztmp/. */
function exportHead(aiBuild) {
    const target = path.resolve(EXT_ROOT, '..', '..', '..', 'ztmp', 'som-pack-head');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const archive = execFileSync('git', ['-C', aiBuild, 'archive', 'HEAD', ...PACKAGES, path.dirname(CATALOG_SOURCE)], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', target], { input: archive });
    console.log(`📦 packing ai_build's committed HEAD (exported to ${target})`);
    return target;
}

function main(aiBuild) {
    if (!fs.existsSync(aiBuild)) {
        fail(`ai_build not found at ${aiBuild}. The SOM packages are built from it; set TOM_SOM_aiBuild to its location.`);
    }
    const dirty = uncommitted(aiBuild);
    if (dirty.length > 0) {
        console.warn(`⚠️  ai_build has uncommitted changes in the packed paths; they will be in the extension:\n${dirty.map((l) => `     ${l}`).join('\n')}\n   Use --from-head to pack only what is committed.`);
    }
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    const versions = {};

    for (const pkg of PACKAGES) {
        const dir = path.join(aiBuild, pkg);
        const manifestPath = path.join(dir, 'package.json');
        if (!fs.existsSync(manifestPath)) {
            fail(`${pkg} not found at ${dir}.`);
        }
        const version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
        console.log(`📦 ${pkg} ${version}: npm install + npm pack ...`);
        try {
            npm(['install', '--no-audit', '--no-fund'], dir);
            const out = npm(['pack', '--json', '--pack-destination', VENDOR_DIR], dir);
            // `npm pack --json` prints a JSON array; prepack output may precede
            // it, so take the array from its first '['.
            const packed = JSON.parse(out.slice(out.indexOf('[')));
            const produced = path.join(VENDOR_DIR, packed[0].filename);
            const target = path.join(VENDOR_DIR, `${pkg}.tgz`);
            fs.renameSync(produced, target);
            console.log(`  ✔ ${path.relative(EXT_ROOT, target)}`);
        } catch (e) {
            fail(`building ${pkg} failed in ${dir}: ${e.message}. Run 'npm install && npm pack' there to see the error.`);
        }
        versions[pkg] = version;
    }

    // The content identity of the packed model (the facade meta's `modelHash`).
    // The versions alone cannot say a model changed under an unchanged version;
    // a test holds this against ai_build's meta (CS-2b).
    const meta = JSON.parse(fs.readFileSync(path.join(aiBuild, PACKAGES[1], 'meta', 'spec_model.meta.json'), 'utf8'));
    versions.modelHash = meta.modelHash ?? null;
    fs.writeFileSync(path.join(VENDOR_DIR, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
    // npm does not re-extract a `file:` tarball whose name and version are
    // unchanged, even when its content changed, and reinstalling it serves the
    // old content from its cache by the integrity the lockfile recorded
    // (both measured 2026-10-13). So drop the installed copies AND their
    // lockfile entries (package-lock.json is local, gitignored); the next
    // `npm install` then takes the new tarballs and records their integrity.
    for (const pkg of PACKAGES) {
        fs.rmSync(path.join(EXT_ROOT, 'node_modules', pkg), { recursive: true, force: true });
    }
    for (const lock of ['package-lock.json', path.join('node_modules', '.package-lock.json')]) {
        const lockPath = path.join(EXT_ROOT, lock);
        if (!fs.existsSync(lockPath)) { continue; }
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        for (const pkg of PACKAGES) {
            if (data.packages) { delete data.packages[`node_modules/${pkg}`]; }
        }
        fs.writeFileSync(lockPath, `${JSON.stringify(data, null, 2)}\n`);
    }
    copyCodeSpecsCatalog(aiBuild);
    if (versions[PACKAGES[0]] !== versions[PACKAGES[1]]) {
        fail(`version mismatch: ${JSON.stringify(versions)}. The runtime and the facade carry the model version and move together.`);
    }
    console.log(`✅ TomSpecs SOM packages ${versions[PACKAGES[0]]} ready in ${path.relative(EXT_ROOT, VENDOR_DIR)}/`);
}

if (require.main === module) {
    const source = process.argv.includes('--from-head') ? exportHead(AI_BUILD_CHECKOUT) : AI_BUILD_CHECKOUT;
    if (process.argv.includes('--catalog-only')) {
        copyCodeSpecsCatalog(source);
    } else {
        main(source);
    }
}

module.exports = { CATALOG_SOURCE, CATALOG_TARGET, CONTRACT_SOURCE, CONTRACT_TARGET };
