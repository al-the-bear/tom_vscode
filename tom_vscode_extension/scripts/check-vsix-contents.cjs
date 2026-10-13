#!/usr/bin/env node
/**
 * Check that a packaged VSIX is self-contained for the TomSpecs SOM runtime.
 *
 *   node scripts/check-vsix-contents.cjs [path/to/extension.vsix]
 *   (default: the newest *.vsix in the extension root)
 *
 * The installed extension must never reach back into an ai_build checkout, so
 * the VSIX has to carry tom_som_typescript_runtime and tom_som_typescript_v0 as
 * real files. vsce packages what it finds in node_modules; a `file:` folder
 * dependency would be a symlink there, which either goes missing from the VSIX
 * or travels as a link that resolves nowhere on another machine.
 *
 * Checked, from the zip's central directory (no unzip, no dependency, the same
 * on every platform):
 *   - every REQUIRED entry is present;
 *   - no entry under the SOM packages is a symlink (a Unix-made zip entry whose
 *     mode is S_IFLNK);
 *   - no symlink anywhere in the VSIX (reported; vsctsa1 forbids them).
 *
 * Exit codes: 0 ok, 1 a check failed (each failure is listed), 2 no VSIX or an
 * unreadable zip.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');

/**
 * Entries the SOM tools load at run time. Later additions (the CodeSpecs area
 * catalogue, the validate_codespecs binary) are appended here when they ship.
 */
const REQUIRED = [
    'extension/node_modules/tom_som_typescript_runtime/package.json',
    'extension/node_modules/tom_som_typescript_runtime/dist/src/index.js',
    'extension/node_modules/tom_som_typescript_v0/package.json',
    'extension/node_modules/tom_som_typescript_v0/dist/tom_som_typescript_v0.js',
    'extension/node_modules/tom_som_typescript_v0/dist/tom_som_typescript_v0_schemas.js',
    'extension/node_modules/tom_som_typescript_v0/meta/spec_model.meta.json',
    'extension/node_modules/tom_som_typescript_v0/schemas/solution-blueprint/solution-blueprint.1.0.docspecs-schema.yaml',
    'extension/out/services/som-model-service.js',
    'extension/out/services/som-document-store.js',
    'extension/out/services/som-document-io-vscode.js',
];

const SOM_PREFIXES = [
    'extension/node_modules/tom_som_typescript_runtime/',
    'extension/node_modules/tom_som_typescript_v0/',
];

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const HOST_UNIX = 3;

function newestVsix() {
    const vsix = fs.readdirSync(EXT_ROOT)
        .filter((f) => f.endsWith('.vsix'))
        .map((f) => path.join(EXT_ROOT, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return vsix[0];
}

/**
 * The zip's central directory: one {name, isSymlink} per entry. Handles the
 * zip64 end record, because a VSIX with node_modules can be large.
 */
function readCentralDirectory(buf) {
    // End of central directory: signature 0x06054b50, within the last 64 KiB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('no end-of-central-directory record (not a zip?)'); }
    let count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || offset === 0xffffffff) {
        const locator = eocd - 20;
        if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) {
            throw new Error('zip64 values without a zip64 locator');
        }
        const z64 = Number(buf.readBigUInt64LE(locator + 8));
        if (buf.readUInt32LE(z64) !== 0x06064b50) { throw new Error('bad zip64 end record'); }
        count = Number(buf.readBigUInt64LE(z64 + 32));
        offset = Number(buf.readBigUInt64LE(z64 + 48));
    }
    const entries = [];
    let p = offset;
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) { throw new Error(`bad central directory entry #${n}`); }
        const madeBy = buf.readUInt16LE(p + 4) >> 8;
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const mode = buf.readUInt32LE(p + 38) >>> 16;
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries.push({ name, isSymlink: madeBy === HOST_UNIX && (mode & S_IFMT) === S_IFLNK });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function main() {
    const vsixPath = process.argv[2] ? path.resolve(process.argv[2]) : newestVsix();
    if (!vsixPath || !fs.existsSync(vsixPath)) {
        console.error('❌ No VSIX found. Package the extension first (install_extension.sh).');
        process.exit(2);
    }
    let entries;
    try {
        entries = readCentralDirectory(fs.readFileSync(vsixPath));
    } catch (e) {
        console.error(`❌ ${path.basename(vsixPath)}: ${e.message}`);
        process.exit(2);
    }
    const names = new Set(entries.map((e) => e.name));
    const failures = [];
    for (const required of REQUIRED) {
        if (!names.has(required)) { failures.push(`missing: ${required}`); }
    }
    for (const e of entries.filter((x) => x.isSymlink)) {
        const som = SOM_PREFIXES.some((prefix) => e.name.startsWith(prefix));
        failures.push(`symlink${som ? ' in a SOM package' : ''}: ${e.name}`);
    }
    const somFiles = entries.filter((e) => SOM_PREFIXES.some((prefix) => e.name.startsWith(prefix))).length;
    if (failures.length > 0) {
        console.error(`❌ ${path.basename(vsixPath)} is not self-contained:`);
        for (const f of failures) { console.error(`   ${f}`); }
        process.exit(1);
    }
    console.log(`✅ ${path.basename(vsixPath)}: SOM runtime + facade bundled as real files (${somFiles} entries), no symlinks.`);
}

if (require.main === module) {
    main();
}

module.exports = { readCentralDirectory };
