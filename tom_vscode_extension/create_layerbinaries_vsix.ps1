<#
.SYNOPSIS
    Package a private-distribution VSIX with every platform's tom_bs and
    validate_codespecs taken from the binaries layer; build nothing with Dart,
    install nothing.
.DESCRIPTION
    create_layerbinaries_vsix.ps1 [-Layer <dir>] [-Clone]

    For a machine without a Dart SDK: the extension is built from this source
    (Node.js 20+, npm and git; no Dart step runs even when Dart is installed),
    and the Dart binaries come prebuilt from the binaries layer:

      - the workspace's tom_binaries checkout (..\..\..\tom_binaries), else
      - -Layer <dir>: a tom_binaries checkout (or its tom\ folder), else
      - -Clone, or when neither exists: a shallow clone of the public
        https://github.com/al-the-bear/tom_binaries into .tom_binaries\ here
        (refreshed on the next run; gitignored, not in the VSIX).

    The layer holds each platform's latest build, published by its host
    (compile_and_install / create_fleetcompiled_vsix). It ends with the VSIX
    path, the template path, the binaries the VSIX carries per platform and
    each binary's build stamp and whether it is older than the sources here
    (scripts/binaries-layer.cjs report; a platform the layer lacks is named).

    Every run publishes the VSIX as the GitHub Release
    `vscode-extension-latest` of al-the-bear/tom_binaries (asset
    tom-ai-extension.vsix, with vscode_extension/vsix/README.md there;
    scripts/vsix-release.cjs) when the tom_vscode checkout has no local change
    and no unpushed commit; -NoRelease (--no-release) skips it. The VSIX also
    stays here for a local install.
#>
param(
    [string]$Layer = '',
    [switch]$Clone,
    [switch]$NoRelease
)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')
$PublicRepo = 'https://github.com/al-the-bear/tom_binaries.git'
foreach ($Arg in $args) {
    if ($Arg -eq '--no-release') { $NoRelease = $true }
    else { Write-Error "Unknown option: $Arg (usage: create_layerbinaries_vsix.ps1 [-Layer <dir>] [-Clone] [-NoRelease | --no-release])"; exit 1 }
}
$ReleasePrecheck = Get-TomReleasePrecheck $ScriptDir $NoRelease

$WorkspaceLayer = Join-Path $ScriptDir '..\..\..\tom_binaries'
if (-not $Layer -and -not $Clone -and (Test-Path (Join-Path $WorkspaceLayer 'tom'))) { $Layer = $WorkspaceLayer }
if (-not $Layer) {
    $CloneDir = Join-Path $ScriptDir '.tom_binaries'
    if (Test-Path (Join-Path $CloneDir '.git')) {
        Write-Host "Refreshing the clone of $PublicRepo..."
        & git -C $CloneDir fetch --quiet --depth 1 origin
        if ($LASTEXITCODE -ne 0) { Write-Error "git fetch failed"; exit 1 }
        & git -C $CloneDir reset --quiet --hard FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { Write-Error "git reset failed"; exit 1 }
    } else {
        Write-Host "Cloning $PublicRepo (shallow)..."
        if (Test-Path $CloneDir) { Remove-Item -Recurse -Force $CloneDir }
        & git clone --quiet --depth 1 $PublicRepo $CloneDir
        if ($LASTEXITCODE -ne 0) { Write-Error "git clone failed"; exit 1 }
    }
    $Layer = $CloneDir
}
if (Test-Path (Join-Path $Layer 'tom')) { $Layer = Join-Path $Layer 'tom' }
if (-not (Test-Path $Layer)) { Write-Error "No binaries layer at $Layer"; exit 1 }
$Layer = (Resolve-Path $Layer).Path
Write-Host "Binaries layer: $Layer"

$Names = @('TOM_BINARIES_LAYER', 'TOM_LAYER_BINARIES', 'TOM_PACKAGE_ONLY', 'TOM_SKIP_FINISH_TS', 'TOM_NO_DART', 'TOM_NO_DART_REASON')
$env:TOM_BINARIES_LAYER = $Layer
$env:TOM_LAYER_BINARIES = '1'
$env:TOM_PACKAGE_ONLY = '1'
$env:TOM_SKIP_FINISH_TS = '1'
$env:TOM_NO_DART = '1'
$env:TOM_NO_DART_REASON = 'create_layerbinaries_vsix: the binaries come from the layer'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-TomLayerVsixSummary $ScriptDir ''
} finally {
    foreach ($name in $Names) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Publish-TomRelease $ScriptDir "$(Get-TomNewestVsix $ScriptDir)" 'create_layerbinaries_vsix.ps1' $ReleasePrecheck $NoRelease
Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
