/**
 * The private-distribution scripts (vsc_setup-3): create_vsix.sh / .ps1 and
 * create_vsix_nodart.sh / .ps1 package a VSIX through install_extension.*
 * without installing it. Source checks (PowerShell cannot run here) and the
 * bash summary helper run for real.
 *
 *   CS-1 create_vsix.sh: from source, all platforms, package only, through install_extension.sh; --no-dart
 *        on purpose is a plain note, no Dart SDK found the red warning; it ends with the VSIX path, the template
 *        path, the per-platform report and, with Dart, that the Dart binaries are for this platform only
 *   CS-2 create_vsix_nodart.sh is create_vsix.sh --no-dart; both executable
 *   CS-3 create_vsix.ps1 / create_vsix_nodart.ps1: the same flags and endings
 *   CS-4 install_extension.sh --package-only / install_extension.ps1 -PackageOnly: no uninstall, no install,
 *        no prompt; still packaged and checked
 *   CS-5 the summary prints the VSIX path and the workspace template beside it (bash, run for real)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');

describe('create_vsix scripts', () => {
    test('CS-1: create_vsix.sh', () => {
        const sh = read('create_vsix.sh');
        for (const flag of ['export TOM_BRIDGE_FROM_SOURCE=1', 'export TOM_ALL_PLATFORMS=1', 'export TOM_PACKAGE_ONLY=1', 'export TOM_SKIP_FINISH_TS=1']) {
            assert.ok(sh.includes(flag), flag);
        }
        assert.ok(sh.indexOf('export TOM_PACKAGE_ONLY=1') < sh.indexOf('"$SCRIPT_DIR/install_extension.sh"'), 'flags set before the base runs');
        assert.match(sh, /--no-dart\) NO_DART_ON_PURPOSE=1 ;;/);
        assert.match(sh, /node scripts\/find-dart\.cjs > \/dev\/null[\s\S]*TOM_NO_DART_REASON="no Dart SDK found"/);
        const tail = sh.slice(sh.indexOf('"$SCRIPT_DIR/install_extension.sh"'));
        assert.match(tail, /tom_print_vsix_path "\$SCRIPT_DIR"/);
        assert.match(tail, /node scripts\/check-vsix-contents\.cjs "\$VSIX"/);
        assert.match(tail, /tom_bs and validate_codespecs are in this VSIX for \$PLATFORM only: a Dart binary/);
        assert.match(tail, /Built without the Dart binaries \(--no-dart\)/);
        assert.match(tail, /tom_print_no_dart_warning "\$TOM_NO_DART_REASON" 1\nfi\necho "🕒 Finished at/, 'the red warning only when Dart was not found');
        assert.doesNotMatch(sh, /--install-extension"? "\$/, 'nothing installed by the wrapper');
    });

    test('CS-2: create_vsix_nodart.sh', () => {
        assert.match(read('create_vsix_nodart.sh'), /exec "\$SCRIPT_DIR\/create_vsix\.sh" --no-dart/);
        for (const f of ['create_vsix.sh', 'create_vsix_nodart.sh']) {
            assert.ok((fs.statSync(path.join(EXT, f)).mode & 0o111) !== 0, `${f} is executable`);
        }
        const help = spawnSync('bash', [path.join(EXT, 'create_vsix.sh'), '--help'], { encoding: 'utf8' });
        assert.equal(help.status, 0);
        assert.match(help.stdout, /template path and the binaries the VSIX carries per platform\.\n$/, 'the whole help');
        const bad = spawnSync('bash', [path.join(EXT, 'create_vsix.sh'), '--bogus'], { encoding: 'utf8' });
        assert.equal(bad.status, 1);
    });

    test('CS-3: the PowerShell pair', () => {
        const ps1 = read('create_vsix.ps1');
        for (const flag of ["$env:TOM_BRIDGE_FROM_SOURCE = '1'", "$env:TOM_ALL_PLATFORMS = '1'", "$env:TOM_PACKAGE_ONLY = '1'", "$env:TOM_SKIP_FINISH_TS = '1'"]) {
            assert.ok(ps1.includes(flag), flag);
        }
        assert.ok(ps1.indexOf("$env:TOM_PACKAGE_ONLY = '1'") < ps1.indexOf("& (Join-Path $ScriptDir 'install_extension.ps1')"));
        assert.match(ps1, /if \(\$Arg -eq '--no-dart'\) \{ \$NoDart = \$true \}/);
        assert.match(ps1, /Write-TomVsixPath \$ScriptDir/);
        assert.match(ps1, /& node scripts\/check-vsix-contents\.cjs \$Vsix/);
        assert.match(ps1, /tom_bs and validate_codespecs are in this VSIX for \$Platform only/);
        assert.match(read('create_vsix_nodart.ps1'), /& \(Join-Path \$ScriptDir 'create_vsix\.ps1'\) -NoDart/);
    });

    test('CS-4: package only', () => {
        const sh = read('install_extension.sh');
        assert.match(sh, /--package-only\) export TOM_PACKAGE_ONLY=1 ;;/);
        assert.match(sh, /if \[ "\$PACKAGE_ONLY" = "1" \]; then\n\s+echo "📦 Package only: the VSIX is built and checked, not installed\."\nelif command -v code/, 'no code CLI looked up: no uninstall');
        assert.match(sh, /# Uninstall old version\(s\)\nif \[ -n "\$CODE_CLI" \]; then/);
        assert.match(sh, /elif \[ "\$PACKAGE_ONLY" = "1" \]; then\n\s+echo ""\n\s+echo "📦 Package only: not installed/);
        assert.ok(sh.indexOf('node scripts/check-vsix-contents.cjs "$VSIX_FILE"') < sh.indexOf('📦 Package only: not installed'), 'still checked');
        const ps1 = read('install_extension.ps1');
        assert.match(ps1, /param\(\[switch\]\$NoDart, \[switch\]\$AllPlatforms, \[switch\]\$PackageOnly\)/);
        assert.match(ps1, /elseif \(\$Arg -eq '--package-only'\) \{ \$PackageOnly = \$true \}/);
        assert.match(ps1, /if \(\$FromSource -or \$PackageOnlyMode\) \{\s+\$Result = 'y'/, 'no prompt');
        assert.match(ps1, /if \(\$PackageOnlyMode\) \{\s+Write-Host ""\s+Write-Host "Package only: not installed/);
    });

    test('CS-5: the summary names the template', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-vsix-'));
        fs.writeFileSync(path.join(dir, 'tom-ai-extension-0.1.0.vsix'), '');
        fs.writeFileSync(path.join(dir, 'workspace_template.zip'), '');
        const run = spawnSync('bash', ['-c', `source "${path.join(EXT, 'scripts', 'install_summary.sh')}" && tom_print_vsix_path "${dir}"`], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.ok(run.stdout.includes(`📦 VSIX: ${dir}/tom-ai-extension-0.1.0.vsix`));
        assert.ok(run.stdout.includes(`📦 Workspace template: ${dir}/workspace_template.zip (also inside the VSIX)`));
        assert.match(read('scripts/install_summary.ps1'), /Write-Host "Workspace template: \$template \(also inside the VSIX\)"/);
    });
});
