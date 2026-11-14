<#
.SYNOPSIS
    Package the private-distribution VSIX files, one per platform, whose binaries are all built now, each
    on its own platform's fleet host; install nothing.
.DESCRIPTION
    One VSIX per platform the layer has (darwin-arm64, linux-x64, win32-x64):
    tom-ai-extension-<platform>.vsix, packed with `vsce package --target`,
    each with only that platform's Dart binaries and build tools
    (TOM_SPLIT_PLATFORMS=1, scripts/vsix-split.cjs). VS Code installs each
    only on its own platform.

    create_fleetcompiled_vsix.ps1 [-DryRun | --dry-run] [-Hosts mbp,bigbeast,... | --hosts mbp,bigbeast,...]

    Run it on a reconciled, quiet fleet (the reconcile is yours to start; this
    script never reconciles or pulls a host):
    1. scripts/fleet-binaries.cjs checks that every build host of the
       fleet_hosts registry (darwin-arm64 mbp, linux-x64 bigbeast, win32-x64
       legiondary01) is reached and at this host's commits, then runs
       compile_and_install --binaries-only on each (this host first; over SSH,
       on Windows through PowerShell). Each builds tom_bs and
       validate_codespecs, fast-forwards its binaries layer, commits its
       platform's binaries there and pushes; this host's layer is then
       fast-forwarded to hold them all. -DryRun stops after the check; -Hosts
       builds on those hosts only (the others' binaries are packaged as the
       layer holds them).
    2. Packages the VSIX through install_extension.ps1 -PackageOnly, taking
       tom_bs and validate_codespecs for darwin-arm64, linux-x64 and win32-x64
       from the layer, with the workspace template, as create_vsix.ps1 (no
       provider SDK: the extension installs them on request).
    It ends with the VSIX path, the template path, the binaries the VSIX
    carries per platform and each binary's build stamp and freshness
    (scripts/binaries-layer.cjs report).

    Every run publishes the VSIX files as the GitHub Release
    `vscode-extension-latest` of al-the-bear/tom_binaries (one asset
    per platform, tom-ai-extension-<platform>.vsix, with vscode_extension/vsix/README.md there;
    scripts/vsix-release.cjs) when the tom_vscode checkout has no local change
    and no unpushed commit; -NoRelease (--no-release) skips it. The VSIX also
    stays here for a local install.
#>
param([switch]$DryRun, [string]$Hosts, [switch]$NoRelease)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')

for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '--dry-run') { $DryRun = $true }
    elseif ($args[$i] -eq '--hosts' -and $i + 1 -lt $args.Count) { $Hosts = $args[$i + 1]; $i++ }
    elseif ($args[$i] -eq '--no-release') { $NoRelease = $true }
    else { Write-Error "Unknown option: $($args[$i]) (usage: create_fleetcompiled_vsix.ps1 [-DryRun | --dry-run] [-Hosts mbp,bigbeast,...] [-NoRelease | --no-release])"; exit 1 }
}
$ReleasePrecheck = Get-TomReleasePrecheck $ScriptDir $NoRelease
$FleetArgs = @()
if ($DryRun) { $FleetArgs += '--dry-run' }
if ($Hosts) { $FleetArgs += @('--hosts', $Hosts) }

Write-Host "-------- 1/2 Binaries on every fleet build host --------"
Push-Location $ScriptDir
$ErrorActionPreference = "Continue"
& node scripts/fleet-binaries.cjs @FleetArgs
$FleetStatus = $LASTEXITCODE
$Platforms = (& node scripts/fleet-binaries.cjs --print-platforms)
$ErrorActionPreference = "Stop"
Pop-Location
if ($FleetStatus -ne 0) { Write-Error "The fleet build did not complete (see above)"; exit 1 }
if ($DryRun) { exit 0 }

Write-Host ""
Write-Host "-------- 2/2 The VSIX, with the fleet's binaries from the layer --------"
$env:TOM_LAYER_BINARIES = '1'
$env:TOM_LAYER_PLATFORMS = "$Platforms"
$env:TOM_PACKAGE_ONLY = '1'
# One VSIX per platform, each with only its own binaries and build tools.
$env:TOM_SPLIT_PLATFORMS = '1'
$env:TOM_SKIP_FINISH_TS = '1'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
} finally {
    foreach ($name in @('TOM_LAYER_BINARIES', 'TOM_LAYER_PLATFORMS', 'TOM_PACKAGE_ONLY', 'TOM_SKIP_FINISH_TS', 'TOM_SPLIT_PLATFORMS')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

Write-TomLayerVsixSummary $ScriptDir "$Platforms"
Publish-TomRelease $ScriptDir "$((Get-TomPlatformVsixes $ScriptDir) -join "`n")" 'create_fleetcompiled_vsix.ps1' $ReleasePrecheck $NoRelease
Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
