/**
 * The VSIX check (scripts/check-vsix-contents.cjs) over fixture packages: it
 * fails on what makes a VSIX unusable anywhere (missing SOM / resource
 * entries, symlinks) and only reports the Dart-built binaries, so a VSIX built
 * without a Dart SDK passes (vsc_nodart-1).
 *
 *   CVX-1 a VSIX without validate_codespecs and tom_bs passes and reports both missing for this host
 *   CVX-2 binaries for other platforms are listed per platform, with `.exe` on Windows
 *   CVX-3 a missing required entry still fails (exit 1)
 *   CVX-4 a symlink still fails (exit 1)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(EXT_ROOT, 'scripts', 'check-vsix-contents.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { REQUIRED, dartBinaryReport } = require(SCRIPT) as {
    REQUIRED: string[]; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    dartBinaryReport(names: Set<string>, host?: string): Array<{ platform: string; binaries: Record<string, boolean>; buildTools: Record<string, boolean> }>;
};
const HOST = `${process.platform}-${process.arch}`;

interface Entry { name: string; symlink?: boolean }

/** A stored (uncompressed) zip with empty files: enough for a central-directory reader. */
function zip(entries: Entry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(name.length, 28);
        const mode = e.symlink ? 0o120777 : 0o100644;
        central.writeUInt32LE((mode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-vsix-'));
function check(name: string, entries: Entry[]): { status: number | null; stdout: string; stderr: string } {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zip(entries));
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const required = (): Entry[] => REQUIRED.map((name) => ({ name }));

describe('check-vsix-contents', () => {
    test('CVX-1: no Dart-built binaries is a valid package', () => {
        assert.ok(!REQUIRED.some((r) => r.includes('validate_codespecs') || r.includes('tom_bs')), 'no binary is required');
        const r = check('no-dart.vsix', required());
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /no symlinks/);
        assert.match(r.stdout, new RegExp(`${HOST} \\(this host\\): tom_bs — missing, validate_codespecs — missing`));
    });

    test('CVX-2: per platform', () => {
        const names = new Set([
            'extension/bin/darwin-arm64/tom_bs', 'extension/bin/darwin-arm64/validate_codespecs', 'extension/bin/darwin-arm64/spec_checks',
            'extension/bin/win32-x64/tom_bs.exe', 'extension/bin/win32-x64/spec_checks.exe', 'extension/bin/linux-x64/validate_codespecs',
        ]);
        assert.deepEqual(dartBinaryReport(names, 'linux-arm64'), [
            { platform: 'darwin-arm64', binaries: { tom_bs: true, validate_codespecs: true, spec_checks: true }, buildTools: { buildkit: false, d4rtgen: false, reflectiongenerator: false, testkit: false } }, // eslint-disable-line @typescript-eslint/naming-convention
            { platform: 'linux-arm64', binaries: { tom_bs: false, validate_codespecs: false, spec_checks: false }, buildTools: { buildkit: false, d4rtgen: false, reflectiongenerator: false, testkit: false } }, // eslint-disable-line @typescript-eslint/naming-convention
            { platform: 'linux-x64', binaries: { tom_bs: false, validate_codespecs: true, spec_checks: false }, buildTools: { buildkit: false, d4rtgen: false, reflectiongenerator: false, testkit: false } }, // eslint-disable-line @typescript-eslint/naming-convention
            { platform: 'win32-x64', binaries: { tom_bs: true, validate_codespecs: false, spec_checks: true }, buildTools: { buildkit: false, d4rtgen: false, reflectiongenerator: false, testkit: false } }, // eslint-disable-line @typescript-eslint/naming-convention
        ]);
        const exe = process.platform === 'win32' ? '.exe' : '';
        const r = check('host.vsix', [...required(), { name: `extension/bin/${HOST}/validate_codespecs${exe}` }]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`${HOST} \\(this host\\): tom_bs — missing, validate_codespecs ✔`));
    });

    test('CVX-5: the build tools, per platform', () => {
        const names = new Set([
            'extension/bin/darwin-arm64/buildkit', 'extension/bin/darwin-arm64/d4rtgen', 'extension/bin/darwin-arm64/reflectiongenerator', 'extension/bin/darwin-arm64/testkit',
            'extension/bin/win32-x64/buildkit.exe', 'extension/bin/win32-x64/testkit.exe',
        ]);
        const report = dartBinaryReport(names, 'darwin-arm64');
        assert.deepEqual(report.map((r) => [r.platform, r.buildTools]), [
            ['darwin-arm64', { buildkit: true, d4rtgen: true, reflectiongenerator: true, testkit: true }],
            ['win32-x64', { buildkit: true, d4rtgen: false, reflectiongenerator: false, testkit: true }],
        ]);
        const exe = process.platform === 'win32' ? '.exe' : '';
        const r = check('tools.vsix', [...required(), { name: `extension/bin/${HOST}/buildkit${exe}` }]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Build tools, the last fallback \(informational\):/);
        assert.match(r.stdout, new RegExp(`${HOST} \\(this host\\): buildkit ✔, d4rtgen — missing, reflectiongenerator — missing, testkit — missing`));
    });

    test('CVX-3: a missing required entry fails', () => {
        const r = check('missing.vsix', required().filter((e) => !e.name.endsWith('llm_tools.md')));
        assert.equal(r.status, 1);
        assert.match(r.stderr, /missing: extension\/doc\/llm_tools\.md/);
    });

    test('CVX-4: a symlink fails', () => {
        const r = check('symlink.vsix', [...required(), { name: 'extension/node_modules/tom_som_typescript_v0/link', symlink: true }]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /symlink in a SOM package: extension\/node_modules\/tom_som_typescript_v0\/link/);
    });
});
