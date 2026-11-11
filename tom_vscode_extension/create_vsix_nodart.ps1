<#
.SYNOPSIS
    Package a private-distribution VSIX without the Dart binaries.
.DESCRIPTION
    create_vsix_nodart.ps1 [-NoRelease | --no-release]

    No tom_bs, no validate_codespecs (no DartScript, no CodeSpecs validation),
    no Dart SDK needed. Otherwise as create_vsix.ps1: the workspace template
    inside the VSIX and beside it, no provider SDK (installed on request),
    nothing installed.

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
foreach ($Arg in $args) {
    if ($Arg -eq '--no-release') { $NoRelease = $true }
    else { Write-Error "Unknown option: $Arg (usage: create_vsix_nodart.ps1 [-NoRelease | --no-release])"; exit 1 }
}
$env:TOM_RELEASE_SCRIPT = 'create_vsix_nodart.ps1'
try {
    & (Join-Path $ScriptDir 'create_vsix.ps1') -NoDart -NoRelease:$NoRelease
} finally {
    Remove-Item Env:TOM_RELEASE_SCRIPT -ErrorAction SilentlyContinue
}
