/**
 * install_extension.sh / .ps1 keep bin/ when a binary step fails (vscimpb105): the binaries are put together in
 * bin.staging/ (TOM_BINARIES_EXT_BIN for the node steps) and replace bin/ only after the last step that writes
 * them; a failure on the way stops the install, says that the previous binaries and stamps are kept, and leaves
 * bin/ as it was. Source checks (the install is too heavy to run here; PowerShell is not installed), and the
 * node steps' honouring of TOM_BINARIES_EXT_BIN run for real.
 *
 *   IB-1 install_extension.sh: no `rm -rf bin` up front; staging set up before the first binary is written; every
 *        writer goes there; the swap after the layer publish and before --binaries-only ends; the EXIT trap says
 *        bin/ is unchanged on a failure and is cleared after the swap
 *   IB-2 install_extension.ps1: the same in a try / finally
 *   IB-3 bin.staging/ is neither tracked nor packaged; the node steps write and read TOM_BINARIES_EXT_BIN
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');

describe('install: bin/ kept when a binary step fails', () => {
    test('IB-1: install_extension.sh', () => {
        const sh = read('install_extension.sh');
        assert.doesNotMatch(sh, /rm -rf "\$SCRIPT_DIR\/bin"\n(?!mv "\$BIN_STAGE")/, 'bin/ is only removed right before the staging folder replaces it');
        const stage = sh.indexOf('BIN_STAGE="$SCRIPT_DIR/bin.staging"');
        const exportAt = sh.indexOf('export TOM_BINARIES_EXT_BIN="$BIN_STAGE"');
        const trapAt = sh.indexOf("trap 'tom_bin_kept_on_failure $?; tom_build_lock_release' EXIT");
        assert.ok(stage > 0 && exportAt > stage && trapAt > exportAt, 'staging, its export and the trap');
        assert.ok(trapAt < sh.indexOf('node scripts/binaries-layer.cjs bundle'), 'before the layer bundle');
        assert.ok(trapAt < sh.indexOf('dart compile exe "bin/${BIN}.dart"'), 'before tom_bs is compiled');
        assert.equal((sh.match(/DST_DIR="\$SCRIPT_DIR\/bin\//g) ?? []).length, 0, 'no writer targets bin/ directly');
        assert.equal((sh.match(/DST_DIR="\$BIN_STAGE\//g) ?? []).length, 2);
        const swap = sh.indexOf('rm -rf "$SCRIPT_DIR/bin"\nmv "$BIN_STAGE" "$SCRIPT_DIR/bin"\nunset TOM_BINARIES_EXT_BIN\ntrap \'tom_build_lock_release\' EXIT');
        assert.ok(swap > sh.indexOf('node scripts/build-validate-codespecs.cjs'), 'after the CodeSpecs CLIs');
        assert.ok(swap > sh.indexOf('node scripts/binaries-layer.cjs tools'), 'after the build tools');
        assert.ok(swap > sh.indexOf('node scripts/binaries-layer.cjs publish'), 'after the layer publish');
        assert.ok(swap < sh.indexOf('if [ "$BINARIES_ONLY" = "1" ]; then\n    echo ""\n    echo "✅ Binaries built'), 'before --binaries-only ends');
        assert.ok(swap < sh.indexOf('build-workspace-template.cjs'), 'before packaging');
        assert.match(sh, /tom_bin_kept_on_failure\(\) \{\n\s+if \[ "\$1" != "0" \] && \[ -d "\$BIN_STAGE" \]; then[\s\S]*bin\/ is unchanged, the previous[\s\S]*binaries and stamps are kept/);
        // The trap's message, run for real.
        const fn = /tom_bin_kept_on_failure\(\) \{[\s\S]*?\n\}/.exec(sh)![0];
        const dir = fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb105_trap-'));
        try {
            const run = (code: number) => spawnSync('bash', ['-c', `BIN_STAGE="${dir}"\n${fn}\ntrap 'tom_bin_kept_on_failure $?' EXIT\nexit ${code}`], { encoding: 'utf8' });
            assert.match(run(1).stdout, /The install stopped before its binaries were complete: bin\/ is unchanged/);
            assert.equal(run(0).stdout, '', 'nothing on success');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('IB-2: install_extension.ps1', () => {
        const ps = read('install_extension.ps1');
        const stage = ps.indexOf("$ExtBinDir = Join-Path $ExtensionDir 'bin.staging'");
        const tryAt = ps.indexOf('$BinSwapped = $false\n    try {');
        assert.ok(stage > 0 && tryAt > stage, 'staging, then the try');
        assert.ok(ps.indexOf('$env:TOM_BINARIES_EXT_BIN = $ExtBinDir') > stage);
        assert.doesNotMatch(ps.slice(0, stage), /Remove-Item -Recurse -Force \$ExtBinDir/, 'bin\\ is not removed up front');
        const swap = ps.indexOf('Move-Item -Path $ExtBinDir -Destination $FinalBinDir\n    $BinSwapped = $true\n    } finally {');
        assert.ok(swap > ps.indexOf('node scripts/build-validate-codespecs.cjs') && swap > ps.indexOf('node scripts/binaries-layer.cjs publish'), 'after every binary step');
        assert.ok(swap < ps.indexOf('Binaries built for this host and put into the binaries layer (no VSIX: -BinariesOnly)'));
        assert.match(ps, /\} finally \{\n\s+Remove-Item Env:TOM_BINARIES_EXT_BIN -ErrorAction SilentlyContinue\n\s+if \(-not \$BinSwapped\) \{[\s\S]*bin\\ is unchanged, the previous/);
    });

    test('IB-3: the staging folder and the node steps', () => {
        assert.ok(read('.gitignore').split('\n').includes('bin.staging/'));
        assert.ok(read('.vscodeignore').split('\n').includes('bin.staging/**'));
        assert.match(read('scripts/build-validate-codespecs.cjs'), /process\.env\.TOM_BINARIES_EXT_BIN \? path\.resolve\(process\.env\.TOM_BINARIES_EXT_BIN\) : path\.join\(EXT_ROOT, 'bin'\)/);
        assert.match(read('scripts/check-tom-bs-provenance.cjs'), /process\.env\.TOM_BINARIES_EXT_BIN/);
        assert.match(read('scripts/binaries-layer.cjs'), /process\.env\.TOM_BINARIES_EXT_BIN/);
    });
});
