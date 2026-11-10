<#
.SYNOPSIS
    Compile the bridge binary for the LOCAL platform from source, then build and
    install the extension bundling only that single host-platform executable.
.DESCRIPTION
    compile_and_install.ps1 [-NoDart | --no-dart]
                            [-BinariesOnly | --binaries-only] [-NoLayer | --no-layer]

    -NoDart (or --no-dart, or TOM_NO_DART=1) builds as on a machine without a
    Dart SDK: no tom_bs and no validate_codespecs are built, so the VSIX lacks
    DartScript and CodeSpecs validation. The same happens when no Dart SDK is
    found. The VSIX path is printed at the end, to install it on other machines.

    The binaries it builds also go into the binaries layer,
    tom_binaries/tom/<platform>/ (committed there and pushed), so the layer
    holds the latest build of every host; -NoLayer (or --no-layer, or
    TOM_NO_LAYER=1) skips that. -BinariesOnly (or --binaries-only) builds
    tom_bs and validate_codespecs, puts them into the layer and stops: no VSIX,
    nothing installed (create_fleetcompiled_vsix.* runs it on every fleet host).

    Thin wrapper over install_extension.ps1: TOM_BRIDGE_FROM_SOURCE=1 switches
    the bundling step from "copy all prebuilt platforms out of tom_binaries" to
    "run the versioner, resolve deps, regenerate the d4rt bridges, and dart
    compile exe the bridge for this host only" - built straight into the
    extension's local bin/, with no reliance on a shared binary location or any
    tool on PATH - and
    auto-confirms the package/install prompt so the script runs unattended.
    Everything else (Node check, npm install, TypeScript compile, workspace
    template, vsce package, install) is shared with install_extension.ps1.
#>
param([switch]$NoDart, [switch]$BinariesOnly, [switch]$NoLayer)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')

foreach ($Arg in $args) {
    if ($Arg -eq '--no-dart') { $NoDart = $true }
    elseif ($Arg -eq '--binaries-only') { $BinariesOnly = $true }
    elseif ($Arg -eq '--no-layer') { $NoLayer = $true }
    else { Write-Error "Unknown option: $Arg (usage: compile_and_install.ps1 [-NoDart | --no-dart] [-BinariesOnly | --binaries-only] [-NoLayer | --no-layer])"; exit 1 }
}
if ($BinariesOnly) { $env:TOM_BINARIES_ONLY = '1' }
if ($NoLayer) { $env:TOM_NO_LAYER = '1' }

$env:TOM_BRIDGE_FROM_SOURCE = '1'
# Settle the no-Dart mode here, so this wrapper and install_extension.ps1 agree
# on it (the closing warning is printed here).
if ($NoDart) {
    $env:TOM_NO_DART = '1'
    $env:TOM_NO_DART_REASON = '--no-dart given'
} elseif ($env:TOM_NO_DART -eq '1') {
    if (-not $env:TOM_NO_DART_REASON) { $env:TOM_NO_DART_REASON = 'TOM_NO_DART=1' }
} else {
    Push-Location $ScriptDir
    $ErrorActionPreference = "Continue"
    $null = & node scripts/find-dart.cjs
    $Found = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = "Stop"
    Pop-Location
    if (-not $Found) {
        $env:TOM_NO_DART = '1'
        $env:TOM_NO_DART_REASON = 'no Dart SDK found'
    }
}
$NoDartMode = ($env:TOM_NO_DART -eq '1')
$Reason = $env:TOM_NO_DART_REASON
if ($BinariesOnly -and $NoDartMode) {
    Write-Error "-BinariesOnly needs a Dart SDK ($Reason)"
    exit 1
}

# Own the closing lines so they reflect this wrapper's completion and print
# exactly once (install_extension.ps1 skips its own when this is set).
$env:TOM_SKIP_FINISH_TS = '1'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
} finally {
    Remove-Item Env:TOM_BRIDGE_FROM_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:TOM_SKIP_FINISH_TS -ErrorAction SilentlyContinue
    Remove-Item Env:TOM_NO_DART -ErrorAction SilentlyContinue
    Remove-Item Env:TOM_NO_DART_REASON -ErrorAction SilentlyContinue
    if ($BinariesOnly) { Remove-Item Env:TOM_BINARIES_ONLY -ErrorAction SilentlyContinue }
    if ($NoLayer) { Remove-Item Env:TOM_NO_LAYER -ErrorAction SilentlyContinue }
}

if ($BinariesOnly) {
    Push-Location $ScriptDir
    $ErrorActionPreference = "Continue"
    $Platform = (& node -p "process.platform + '-' + process.arch" 2>$null)
    $LayerReport = & node scripts/binaries-layer.cjs report --platforms $Platform
    $ErrorActionPreference = "Stop"
    Pop-Location
    foreach ($line in @($LayerReport)) { Write-Host "$line" }
    Write-TomLayerUnpushedWarning $ScriptDir
    Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    exit 0
}

Write-TomLayerUnpushedWarning $ScriptDir
Write-TomVsixPath $ScriptDir
if ($NoDartMode) { Write-TomNoDartWarning $Reason $true }
Write-Host "🕒 Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($NoDartMode) { Write-TomNoDartWarning $Reason $true }
