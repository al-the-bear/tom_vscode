<#
.SYNOPSIS
    Compile the bridge binary for the LOCAL platform from source, then build and
    install the extension bundling only that single host-platform executable.
.DESCRIPTION
    compile_and_install.ps1 [-NoDart | --no-dart] [-AllPlatforms | --all-platforms]

    -NoDart (or --no-dart, or TOM_NO_DART=1) builds as on a machine without a
    Dart SDK: no tom_bs and no validate_codespecs are built, so the VSIX lacks
    DartScript and CodeSpecs validation. The same happens when no Dart SDK is
    found. The VSIX path is printed at the end, to install it on other machines.

    -AllPlatforms (or --all-platforms, or TOM_ALL_PLATFORMS=1) bundles the
    Agent SDK's Claude CLI for darwin-arm64, linux-x64 and win32-x64, so the
    Agent SDK transport runs on those platforms too (by default only on this
    one).

    Thin wrapper over install_extension.ps1: TOM_BRIDGE_FROM_SOURCE=1 switches
    the bundling step from "copy all prebuilt platforms out of tom_binaries" to
    "run the versioner, resolve deps, regenerate the d4rt bridges, and dart
    compile exe the bridge for this host only" - built straight into the
    extension's local bin/, with no reliance on a shared binary location or any
    tool on PATH - and
    auto-confirms the package/install prompt so the script runs unattended.
    Everything else (Node check, npm install, TypeScript compile, Claude Agent
    SDK host binary, vsce package, install) is shared with install_extension.ps1.
#>
param([switch]$NoDart, [switch]$AllPlatforms)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')

foreach ($Arg in $args) {
    if ($Arg -eq '--no-dart') { $NoDart = $true }
    elseif ($Arg -eq '--all-platforms') { $AllPlatforms = $true }
    else { Write-Error "Unknown option: $Arg (usage: compile_and_install.ps1 [-NoDart | --no-dart] [-AllPlatforms | --all-platforms])"; exit 1 }
}
if ($AllPlatforms) { $env:TOM_ALL_PLATFORMS = '1' }

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
    if ($AllPlatforms) { Remove-Item Env:TOM_ALL_PLATFORMS -ErrorAction SilentlyContinue }
}

Write-TomVsixPath $ScriptDir
if ($NoDartMode) { Write-TomNoDartWarning $Reason $true }
Write-Host "🕒 Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($NoDartMode) { Write-TomNoDartWarning $Reason $true }
