#!/usr/bin/env node
/**
 * Check that `npm install` installed the TomSpecs model `som:pack` just packed.
 *
 *   node scripts/check-som-installed.cjs      (npm run som:check)
 *
 * The install scripts run `som:pack` and then `npm install` on every install,
 * so the extension always carries ai_build's current model. npm can still keep
 * an old copy: it does not re-extract a `file:` tarball whose name and version
 * did not change, and serves it from its cache by the old integrity
 * (build-som-packages.cjs removes the installed copies and lockfile entries to
 * prevent exactly that). This check makes the outcome certain: the facade
 * meta's `modelHash` in node_modules must equal the one the pack recorded in
 * vendor/tom_som/versions.json. The install stops otherwise, instead of
 * packaging a stale model.
 *
 * Exit codes: 0 the packed model is installed, 1 it is not (the message says why).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FACADE = 'tom_som_typescript_v0';

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @returns {{ ok: boolean, message: string }} */
function checkSomInstalled(extRoot) {
    const versionsFile = path.join(extRoot, 'vendor', 'tom_som', 'versions.json');
    if (!fs.existsSync(versionsFile)) {
        return { ok: false, message: `No pack record at ${versionsFile}: run npm run som:pack first.` };
    }
    const packed = readJson(versionsFile);
    const facadeDir = path.join(extRoot, 'node_modules', FACADE);
    const metaFile = path.join(facadeDir, 'meta', 'spec_model.meta.json');
    if (!fs.existsSync(metaFile)) {
        return { ok: false, message: `${FACADE} is not installed (${metaFile} is missing): run npm install.` };
    }
    const installedHash = readJson(metaFile).modelHash ?? null;
    const installedVersion = readJson(path.join(facadeDir, 'package.json')).version;
    if (!packed.modelHash || installedHash !== packed.modelHash) {
        return {
            ok: false,
            message: `The installed TomSpecs model (${installedVersion}, ${String(installedHash).slice(0, 12)}) is not the packed one `
                + `(${packed[FACADE]}, ${String(packed.modelHash).slice(0, 12)}). npm kept a stale copy: delete `
                + `node_modules/${FACADE} and node_modules/tom_som_typescript_runtime, then run npm install again.`,
        };
    }
    return { ok: true, message: `TomSpecs model ${installedVersion} installed as packed (${installedHash.slice(0, 12)}).` };
}

if (require.main === module) {
    const result = checkSomInstalled(path.resolve(__dirname, '..'));
    (result.ok ? console.log : console.error)(`${result.ok ? '✅' : '❌'} ${result.message}`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { checkSomInstalled };
