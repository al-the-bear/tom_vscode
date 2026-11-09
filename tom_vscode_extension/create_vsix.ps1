<#
.SYNOPSIS
    Package a private-distribution VSIX: build everything, install nothing.
.DESCRIPTION
    create_vsix.ps1 [-NoDart | --no-dart]

    The VSIX carries:
      - tom_bs and validate_codespecs for THIS host's platform (compiled from
        source, as compile_and_install.ps1; a Dart binary cannot be built for
        another platform);
      - the workspace template (resources/workspace_template.zip), which
        @T: Setup New Workspace Folder unpacks; a copy is written beside the VSIX.
    -NoDart (create_vsix_nodart.ps1) builds without the Dart binaries.

    No provider SDK: the extension installs them on request (Provider SDKs
    page). A thin wrapper over install_extension.ps1 (TOM_BRIDGE_FROM_SOURCE=1,
    TOM_PACKAGE_ONLY=1); it ends with the VSIX path, the
    template path and the binaries the VSIX carries per platform.
#>
param([switch]$NoDart)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir 'scripts/install_summary.ps1')

foreach ($Arg in $args) {
    if ($Arg -eq '--no-dart') { $NoDart = $true }
    else { Write-Error "Unknown option: $Arg (usage: create_vsix.ps1 [-NoDart | --no-dart])"; exit 1 }
}

$env:TOM_BRIDGE_FROM_SOURCE = '1'
$env:TOM_PACKAGE_ONLY = '1'
# Settle the no-Dart mode here, so this wrapper and install_extension.ps1
# agree on it. On purpose (-NoDart) it is a plain note at the end; without a
# Dart SDK found it is the red warning, as in compile_and_install.ps1.
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

$env:TOM_SKIP_FINISH_TS = '1'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
} finally {
    foreach ($name in @('TOM_BRIDGE_FROM_SOURCE', 'TOM_PACKAGE_ONLY', 'TOM_SKIP_FINISH_TS', 'TOM_NO_DART', 'TOM_NO_DART_REASON')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "-------- Private distribution VSIX --------"
Write-TomVsixPath $ScriptDir
$Vsix = Get-TomNewestVsix $ScriptDir
if ($Vsix) {
    Push-Location $ScriptDir
    $ErrorActionPreference = "Continue"
    $Report = & node scripts/check-vsix-contents.cjs $Vsix
    $ErrorActionPreference = "Stop"
    Pop-Location
    foreach ($line in @($Report | Select-Object -Skip 1)) { Write-Host "$line" }
}
$ErrorActionPreference = "Continue"
$Platform = (& node -p "process.platform + '-' + process.arch" 2>$null)
$ErrorActionPreference = "Stop"
if (-not $NoDartMode) {
    Write-Host "tom_bs and validate_codespecs are in this VSIX for $Platform only: a Dart binary"
    Write-Host "cannot be built for another platform. Elsewhere the extension says what is missing"
    Write-Host "and how to add it (@T: Missing Dart Binaries)."
} elseif ($NoDart) {
    Write-Host "Built without the Dart binaries (-NoDart): no DartScript and no CodeSpecs"
    Write-Host "validation on any platform; everything else works."
} else {
    Write-TomNoDartWarning $Reason $true
}
Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($NoDartMode -and -not $NoDart) { Write-TomNoDartWarning $Reason $true }
