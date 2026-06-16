<#
.SYNOPSIS
    Compile the bridge binary for the LOCAL platform from source, then build and
    install the extension bundling only that single host-platform executable.
.DESCRIPTION
    Thin wrapper over install_extension.ps1: TOM_BRIDGE_FROM_SOURCE=1 switches
    the bundling step from "copy all prebuilt platforms out of tom_binaries" to
    "resolve deps, regenerate the d4rt bridges, and dart compile exe the bridge
    for this host only" - built straight into the extension's local bin/, with
    no reliance on a shared binary location or any tool on PATH - and
    auto-confirms the package/install prompt so the script runs unattended.
    Everything else (Node check, npm install, TypeScript compile, Claude Agent
    SDK host binary, vsce package, install) is shared with install_extension.ps1.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$env:TOM_BRIDGE_FROM_SOURCE = '1'
try {
    & (Join-Path $ScriptDir 'install_extension.ps1')
} finally {
    Remove-Item Env:TOM_BRIDGE_FROM_SOURCE -ErrorAction SilentlyContinue
}
