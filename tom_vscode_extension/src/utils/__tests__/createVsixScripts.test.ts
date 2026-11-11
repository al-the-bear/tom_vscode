/**
 * The private-distribution scripts (vsc_setup-3): create_vsix.sh / .ps1 and
 * create_vsix_nodart.sh / .ps1 package a VSIX through install_extension.*
 * without installing it. Source checks (PowerShell cannot run here) and the
 * bash summary helper run for real.
 *
 *   CS-1 create_vsix.sh: from source, package only (no provider SDK), through install_extension.sh; --no-dart
 *        on purpose is a plain note, no Dart SDK found the red warning; it ends with the VSIX path, the template
 *        path, the per-platform report and, with Dart, that the Dart binaries are for this platform only
 *   CS-2 create_vsix_nodart.sh is create_vsix.sh --no-dart; both executable
 *   CS-3 create_vsix.ps1 / create_vsix_nodart.ps1: the same flags and endings
 *   CS-4 install_extension.sh --package-only / install_extension.ps1 -PackageOnly: no uninstall, no install,
 *        no prompt; still packaged and checked
 *   CS-5 the summary prints the VSIX path and the workspace template beside it (bash, run for real)
 *   CS-6 create_currentbinaries_vsix.sh: needs Dart; this host's binaries through compile_and_install.sh
 *        --binaries-only, then one package-only run of install_extension.sh with every platform's binaries
 *        from the layer (no second build); ends with the layer summary (VSIX, template, per-platform
 *        contents, build stamps and freshness)
 *   CS-7 create_fleetcompiled_vsix.sh: the fleet build (scripts/fleet-binaries.cjs, --dry-run / --hosts
 *        passed on, a dry run packages nothing), then the same packaging for the fleet's platforms
 *   CS-8 the PowerShell pair of CS-6 / CS-7
 *   CS-9 install_extension.sh / .ps1: --binaries-only (from source with Dart only: no npm, no TypeScript,
 *        no VSIX, ends after the layer, before the template), --layer-binaries (bundle from the layer, no Dart build), a
 *        from-source build puts its binaries into the layer (--ff and fatal under TOM_LAYER_FF=1),
 *        --no-layer; the wrong combinations refused (bash, run for real)
 *   CS-10 compile_and_install.sh / .ps1 pass --binaries-only / --no-layer on; --binaries-only without Dart
 *        is refused and ends with the layer report for this platform
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variables as the scripts read them */
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
        for (const flag of ['export TOM_BRIDGE_FROM_SOURCE=1', 'export TOM_PACKAGE_ONLY=1', 'export TOM_SKIP_FINISH_TS=1']) {
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
        for (const flag of ["$env:TOM_BRIDGE_FROM_SOURCE = '1'", "$env:TOM_PACKAGE_ONLY = '1'", "$env:TOM_SKIP_FINISH_TS = '1'"]) {
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
        assert.match(sh, /if \[ "\$PACKAGE_ONLY" = "1" \]; then\n\s+echo "📦 Package only: the VSIX is built and checked, not installed\."\nelif CODE_CLI="\$\(tom_find_code_cli\)"/, 'no code CLI looked up: no uninstall');
        assert.match(sh, /# Uninstall old version\(s\)\nif \[ -n "\$CODE_CLI" \]; then/);
        assert.match(sh, /elif \[ "\$PACKAGE_ONLY" = "1" \]; then\n\s+echo ""\n\s+echo "📦 Package only: not installed/);
        assert.ok(sh.indexOf('node scripts/check-vsix-contents.cjs "$VSIX_FILE"') < sh.indexOf('📦 Package only: not installed'), 'still checked');
        const ps1 = read('install_extension.ps1');
        assert.match(ps1, /param\(\[switch\]\$NoDart, \[switch\]\$PackageOnly[,)]/);
        assert.match(ps1, /elseif \(\$Arg -eq '--package-only'\) \{ \$PackageOnly = \$true \}/);
        assert.match(ps1, /if \(\$FromSource -or \$PackageOnlyMode[^)]*\) \{\s+\$Result = 'y'/, 'no prompt');
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

    test('CS-6: create_currentbinaries_vsix.sh', () => {
        const sh = read('create_currentbinaries_vsix.sh');
        assert.match(sh, /node scripts\/find-dart\.cjs > \/dev\/null \); then\n\s+echo "❌ No Dart SDK found/);
        const build = sh.indexOf('"$SCRIPT_DIR/compile_and_install.sh" --binaries-only');
        const pack = sh.indexOf('"$SCRIPT_DIR/install_extension.sh"');
        assert.ok(build > 0 && pack > build, 'this host built first, then packaged');
        const packaging = sh.slice(build, pack);
        for (const flag of ['export TOM_LAYER_BINARIES=1', 'export TOM_PACKAGE_ONLY=1', 'export TOM_SKIP_FINISH_TS=1']) {
            assert.ok(packaging.includes(flag), flag);
        }
        assert.ok(!sh.includes('TOM_BRIDGE_FROM_SOURCE'), 'the packaging builds nothing again');
        assert.match(sh.slice(pack), /tom_print_layer_vsix_summary "\$SCRIPT_DIR" ""/);
        assert.ok((fs.statSync(path.join(EXT, 'create_currentbinaries_vsix.sh')).mode & 0o111) !== 0, 'executable');
        const help = spawnSync('bash', [path.join(EXT, 'create_currentbinaries_vsix.sh'), '--help'], { encoding: 'utf8' });
        assert.equal(help.status, 0);
        assert.match(help.stdout, /there, or create_fleetcompiled_vsix\.sh on a reconciled fleet\)\.\n$/, 'the whole help');
        assert.equal(spawnSync('bash', [path.join(EXT, 'create_currentbinaries_vsix.sh'), '--bogus'], { encoding: 'utf8' }).status, 1);
    });

    test('CS-7: create_fleetcompiled_vsix.sh', () => {
        const sh = read('create_fleetcompiled_vsix.sh');
        assert.match(sh, /--dry-run\) DRY_RUN=1; FLEET_ARGS\+=\(--dry-run\) ;;/);
        assert.match(sh, /--hosts\) \[ -n "\$\{2:-\}" \]/);
        const fleetRun = sh.indexOf('node scripts/fleet-binaries.cjs "${FLEET_ARGS[@]}"');
        const dry = sh.indexOf('[ "$DRY_RUN" = "1" ] && exit 0');
        const pack = sh.indexOf('"$SCRIPT_DIR/install_extension.sh"');
        assert.ok(fleetRun > 0 && dry > fleetRun && pack > dry, 'fleet build, dry-run exit, then packaging');
        assert.match(sh, /PLATFORMS="\$\(cd "\$SCRIPT_DIR" && node scripts\/fleet-binaries\.cjs --print-platforms\)"/);
        for (const flag of ['export TOM_LAYER_BINARIES=1', 'export TOM_LAYER_PLATFORMS="$PLATFORMS"', 'export TOM_PACKAGE_ONLY=1', 'export TOM_SKIP_FINISH_TS=1']) {
            assert.ok(sh.slice(dry, pack).includes(flag), flag);
        }
        assert.ok(!sh.includes('TOM_BRIDGE_FROM_SOURCE'));
        assert.match(sh.slice(pack), /tom_print_layer_vsix_summary "\$SCRIPT_DIR" "\$PLATFORMS"/);
        assert.ok((fs.statSync(path.join(EXT, 'create_fleetcompiled_vsix.sh')).mode & 0o111) !== 0, 'executable');
        const help = spawnSync('bash', [path.join(EXT, 'create_fleetcompiled_vsix.sh'), '--help'], { encoding: 'utf8' });
        assert.equal(help.status, 0);
        assert.match(help.stdout, /\(scripts\/binaries-layer\.cjs report\)\.\n$/, 'the whole help');
        assert.equal(spawnSync('bash', [path.join(EXT, 'create_fleetcompiled_vsix.sh'), '--hosts'], { encoding: 'utf8' }).status, 1);
        const platforms = spawnSync('node', [path.join(EXT, 'scripts', 'fleet-binaries.cjs'), '--print-platforms'], { encoding: 'utf8' });
        assert.equal(platforms.stdout.trim(), 'darwin-arm64,linux-x64,win32-x64');
    });

    test('CS-8: the PowerShell pair', () => {
        const cur = read('create_currentbinaries_vsix.ps1');
        assert.ok(cur.indexOf("& (Join-Path $ScriptDir 'compile_and_install.ps1') -BinariesOnly") < cur.indexOf("& (Join-Path $ScriptDir 'install_extension.ps1')"));
        for (const flag of ["$env:TOM_LAYER_BINARIES = '1'", "$env:TOM_PACKAGE_ONLY = '1'", "$env:TOM_SKIP_FINISH_TS = '1'"]) {
            assert.ok(cur.includes(flag), flag);
        }
        assert.match(cur, /Write-TomLayerVsixSummary \$ScriptDir ''/);
        assert.ok(!cur.includes('TOM_BRIDGE_FROM_SOURCE'));
        const fleetPs = read('create_fleetcompiled_vsix.ps1');
        assert.match(fleetPs, /param\(\[switch\]\$DryRun, \[string\]\$Hosts\)/);
        assert.match(fleetPs, /& node scripts\/fleet-binaries\.cjs @FleetArgs/);
        assert.match(fleetPs, /if \(\$DryRun\) \{ exit 0 \}/);
        assert.ok(fleetPs.includes('$env:TOM_LAYER_PLATFORMS = "$Platforms"'));
        assert.match(fleetPs, /Write-TomLayerVsixSummary \$ScriptDir "\$Platforms"/);
        assert.match(read('scripts/install_summary.ps1'), /function Write-TomLayerVsixSummary\(\[string\]\$Dir, \[string\]\$Platforms\)/);
    });

    test('CS-9: install_extension binaries-only, layer-binaries and the layer', () => {
        const sh = read('install_extension.sh');
        for (const opt of ['--binaries-only) export TOM_BINARIES_ONLY=1 ;;', '--layer-binaries) export TOM_LAYER_BINARIES=1 ;;', '--no-layer) export TOM_NO_LAYER=1 ;;']) {
            assert.ok(sh.includes(opt), opt);
        }
        const skipStart = sh.indexOf('if [ "$BINARIES_ONLY" != "1" ]; then\n# Build the TomSpecs SOM');
        const skipEnd = sh.indexOf('rm -f *.vsix\nfi # BINARIES_ONLY');
        assert.ok(skipStart > 0 && skipEnd > skipStart, 'SOM, npm, TypeScript, code CLI and vsce skipped');
        assert.ok(sh.indexOf('npm install\n') > skipStart && sh.indexOf('npm install\n') < skipEnd);
        assert.match(sh, /if \[ "\$LAYER_BINARIES" = "1" \]; then\n[\s\S]*?node scripts\/binaries-layer\.cjs bundle "\$\{LAYER_ARGS\[@\]\}" \|\| exit 1\nelif \[ "\$FROM_SOURCE" = "1" \] && \[ "\$NO_DART" = "1" \]/);
        const publish = sh.indexOf('node scripts/binaries-layer.cjs publish "${PUBLISH_ARGS[@]}"');
        assert.ok(publish > sh.indexOf('node scripts/build-validate-codespecs.cjs'), 'after both binaries are built');
        assert.match(sh, /if \[ "\$FROM_SOURCE" = "1" \] && \[ "\$NO_DART" != "1" \] && \[ "\$NO_LAYER" != "1" \]; then/);
        assert.match(sh, /\[ "\$\{TOM_LAYER_FF:-0\}" = "1" \] && PUBLISH_ARGS=\(--ff\)/);
        const exitAt = sh.indexOf('(no VSIX: --binaries-only)."\n    exit 0');
        assert.ok(exitAt > publish && exitAt < sh.indexOf('# ── The workspace template'), 'binaries-only ends before the template and the VSIX');
        const env = { ...process.env, TOM_BRIDGE_FROM_SOURCE: '', TOM_BINARIES_ONLY: '', TOM_LAYER_BINARIES: '' };
        const notFromSource = spawnSync('bash', [path.join(EXT, 'install_extension.sh'), '--binaries-only'], { encoding: 'utf8', env });
        assert.equal(notFromSource.status, 1);
        assert.match(notFromSource.stdout, /--binaries-only builds the binaries from source with Dart/);
        const layerFromSource = spawnSync('bash', [path.join(EXT, 'install_extension.sh'), '--layer-binaries'], { encoding: 'utf8', env: { ...env, TOM_BRIDGE_FROM_SOURCE: '1' } });
        assert.equal(layerFromSource.status, 1);
        assert.match(layerFromSource.stdout, /--layer-binaries takes the binaries from the layer/);

        const ps1 = read('install_extension.ps1');
        assert.match(ps1, /param\(\[switch\]\$NoDart, \[switch\]\$PackageOnly, \[switch\]\$BinariesOnly, \[switch\]\$LayerBinaries, \[switch\]\$NoLayer\)/);
        assert.match(ps1, /if \(-not \$BinariesOnlyMode\) \{\n# Build the TomSpecs SOM/);
        assert.match(ps1, /\} # BinariesOnlyMode/);
        assert.match(ps1, /if \(\$LayerBinariesMode\) \{[\s\S]*?Invoke-Native \{ node scripts\/binaries-layer\.cjs bundle --platforms \$env:TOM_LAYER_PLATFORMS \}/);
        assert.match(ps1, /if \(\$FromSource -and -not \$NoDartMode -and -not \$NoLayerMode\) \{/);
        assert.match(ps1, /Invoke-Native \{ node scripts\/binaries-layer\.cjs publish --ff \}/);
        const psExit = ps1.indexOf('(no VSIX: -BinariesOnly)."\n        exit 0');
        assert.ok(psExit > 0 && psExit < ps1.indexOf('# ── The workspace template'));
    });

    test('CS-10: compile_and_install passes the modes on', () => {
        const sh = read('compile_and_install.sh');
        assert.ok(sh.includes('--binaries-only) export TOM_BINARIES_ONLY=1 ;;'));
        assert.ok(sh.includes('--no-layer) export TOM_NO_LAYER=1 ;;'));
        assert.match(sh, /if \[ "\$\{TOM_BINARIES_ONLY:-0\}" = "1" \] && \[ "\$\{TOM_NO_DART:-0\}" = "1" \]; then\n\s+echo "❌ --binaries-only needs a Dart SDK/);
        assert.match(sh, /node scripts\/binaries-layer\.cjs report --platforms/);
        const noDart = spawnSync('bash', [path.join(EXT, 'compile_and_install.sh'), '--binaries-only', '--no-dart'], { encoding: 'utf8' });
        assert.equal(noDart.status, 1);
        assert.match(noDart.stdout, /--binaries-only needs a Dart SDK \(--no-dart given\)/);
        const ps1 = read('compile_and_install.ps1');
        assert.match(ps1, /param\(\[switch\]\$NoDart, \[switch\]\$BinariesOnly, \[switch\]\$NoLayer\)/);
        assert.match(ps1, /if \(\$BinariesOnly -and \$NoDartMode\) \{\s+Write-Error "-BinariesOnly needs a Dart SDK/);
        assert.match(ps1, /& node scripts\/binaries-layer\.cjs report --platforms \$Platform/);
    });
});

