<#
.SYNOPSIS
    Package a private-distribution VSIX without the Dart binaries.
.DESCRIPTION
    create_vsix_nodart.ps1

    No tom_bs, no validate_codespecs (no DartScript, no CodeSpecs validation),
    no Dart SDK needed. Otherwise as create_vsix.ps1: the Agent SDK's Claude
    CLI for darwin-arm64, linux-x64 and win32-x64, the workspace template
    inside the VSIX and beside it, nothing installed.
#>
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($args.Count -gt 0) { Write-Error "Unknown option: $($args[0]) (usage: create_vsix_nodart.ps1)"; exit 1 }
& (Join-Path $ScriptDir 'create_vsix.ps1') -NoDart
