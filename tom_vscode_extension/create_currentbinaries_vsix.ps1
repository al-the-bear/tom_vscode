<#
.SYNOPSIS
    Package a private-distribution VSIX with this host's binaries built now and
    every other platform's as the binaries layer holds them; install nothing.
.DESCRIPTION
    create_currentbinaries_vsix.ps1

    1. Builds tom_bs and validate_codespecs for THIS host and puts them into
       the binaries layer, tom_binaries/tom/<platform>/
       (compile_and_install.ps1 -BinariesOnly: committed there and pushed; a
       refused push stays a local commit). A Dart SDK is needed; without one
       use create_vsix_nodart.ps1.
    2. Packages the VSIX through install_extension.ps1 -PackageOnly, taking
       tom_bs and validate_codespecs for every platform from the layer
       (TOM_LAYER_BINARIES=1), with the workspace template, as
       create_vsix.ps1 (no provider SDK: the extension installs them on
       request).
    It ends with the VSIX path, the template path, the binaries the VSIX
    carries per platform and, per platform, each binary's build stamp and
    whether it is older than the sources here (scripts/binaries-layer.cjs
    report). A platform whose binaries are older is rebuilt by its own host
    (compile_and_install there, or create_fleetcompiled_vsix on a reconciled
    fleet).

    Every run publishes the VSIX as the GitHub Release
    `vscode-extension-latest` of al-the-bear/tom_binaries (asset
    tom-ai-extension.vsix, with vscode_extension/vsix/README.md there;
    scripts/vsix-release.cjs) when the tom_vscode checkout has no local change
    and no unpushed commit; -NoRelease (--no-release) skips it. The VSIX also
    stays here for a local install.
#>
param([switch]$NoRelease)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')
foreach ($Arg in $args) {
    if ($Arg -eq '--no-release') { $NoRelease = $true }
    else { Write-Error "Unknown option: $Arg (usage: create_currentbinaries_vsix.ps1 [-NoRelease | --no-release])"; exit 1 }
}
$ReleasePrecheck = Get-TomReleasePrecheck $ScriptDir $NoRelease

Push-Location $ScriptDir
$ErrorActionPreference = "Continue"
$null = & node scripts/find-dart.cjs
$Found = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = "Stop"
Pop-Location
if (-not $Found) {
    Write-Error "No Dart SDK found: this host's binaries cannot be built (create_vsix_nodart.ps1 packages without them)."
    exit 1
}

Write-Host "-------- 1/2 This host's binaries into the binaries layer --------"
& (Join-Path $ScriptDir 'compile_and_install.ps1') -BinariesOnly

Write-Host ""
Write-Host "-------- 2/2 The VSIX, with every platform's binaries from the layer --------"
$env:TOM_LAYER_BINARIES = '1'
$env:TOM_PACKAGE_ONLY = '1'
$env:TOM_SKIP_FINISH_TS = '1'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
} finally {
    foreach ($name in @('TOM_LAYER_BINARIES', 'TOM_PACKAGE_ONLY', 'TOM_SKIP_FINISH_TS')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

Write-TomLayerVsixSummary $ScriptDir ''
Publish-TomRelease $ScriptDir "$(Get-TomNewestVsix $ScriptDir)" 'create_currentbinaries_vsix.ps1' $ReleasePrecheck $NoRelease
Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
