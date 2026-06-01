<#
.SYNOPSIS
    Development reinstall script for tom_vscode_extension extension
    This script marks the installation as a "test reinstall" which triggers
    a reminder notification when VS Code reloads
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "🔧 Reinstalling tom_vscode_extension for testing..." -ForegroundColor Cyan

# Create marker file to indicate this is a test reinstall
$MarkerFile = Join-Path $env:USERPROFILE ".vscode-tom-test-reinstall"
[DateTimeOffset]::Now.ToUnixTimeSeconds() | Out-File -FilePath $MarkerFile -Encoding utf8 -NoNewline
Write-Host "📍 Created test reinstall marker: $MarkerFile"
Write-Host ""

# Check Node.js version
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: Node.js is not installed" -ForegroundColor Red
    exit 1
}

$CurrentNodeVersion = (node --version) -replace '^v', ''
$NodeMajorVersion = [int]$CurrentNodeVersion.Split('.')[0]

Write-Host "📋 Current Node.js version: v$CurrentNodeVersion"

if ($NodeMajorVersion -lt 20) {
    Write-Host "⚠️  Node.js version $NodeMajorVersion is below the required version 20" -ForegroundColor Yellow

    # Check if nvm-windows is installed
    if (Get-Command nvm -ErrorAction SilentlyContinue) {
        Write-Host "✅ Node Version Manager (nvm) is installed" -ForegroundColor Green

        # Check if Node 20 is already installed
        $NvmList = nvm list 2>&1
        if ($NvmList -match "20\.") {
            Write-Host "📦 Node.js 20 is already installed, switching to it..."
            nvm use 20
        } else {
            Write-Host "📦 Installing Node.js 20 (LTS)..."
            nvm install 20
            nvm use 20
        }

        $CurrentNodeVersion = (node --version) -replace '^v', ''
        Write-Host "✅ Now using Node.js v$CurrentNodeVersion" -ForegroundColor Green
    } else {
        Write-Host "❌ Error: Node Version Manager (nvm) is not installed" -ForegroundColor Red
        Write-Host "Please install Node.js >= 20 or install nvm-windows first"
        exit 1
    }
} else {
    Write-Host "✅ Node.js version meets requirements (>= 20)" -ForegroundColor Green
}

Write-Host ""

# Install / update dependencies (incl. the host-platform Claude Agent SDK
# native CLI binary, which ships as an optional dependency).
Write-Host "📦 Installing npm dependencies..." -ForegroundColor Cyan
npm install

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ npm install failed" -ForegroundColor Red
    exit 1
}

# Compile TypeScript
Write-Host "📦 Compiling TypeScript..." -ForegroundColor Cyan
npm run compile

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Compilation failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Extension compiled successfully!" -ForegroundColor Green

# Check if VS Code CLI is available
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  VS Code CLI not found. Extension compiled but not installed." -ForegroundColor Yellow
    Write-Host "   Press F5 to test in Extension Development Host"
    exit 0
}

# Check if vsce is installed
if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
    Write-Host "📦 Installing @vscode/vsce..."
    npm install -g @vscode/vsce
}

# Uninstall old version(s)
Write-Host ""
Write-Host "🗑️  Uninstalling old version..." -ForegroundColor Yellow
try {
    & code --uninstall-extension tom.dartscript-vscode 2>&1 | Out-Null
} catch {
    # Ignore errors if extension was not installed
}
try {
    & code --uninstall-extension tom.tom-ai-extension 2>&1 | Out-Null
} catch {
    # Ignore errors if extension was not installed
}

# Remove old VSIX files to prevent stale packaging
Remove-Item -Path "*.vsix" -Force -ErrorAction SilentlyContinue

# ── Bundle bridge binaries for all platforms ─────────────────────────────────
$WorkspaceRoot = (Resolve-Path (Join-Path $ScriptDir '..\..\..')).Path
$TomBinDir = Join-Path $WorkspaceRoot 'tom_binaries' 'tom'
$BundledBinaries = @('tom_bs')
# Platforms and their executable extension
$Platforms = @(
    @{ Id = 'darwin-arm64'; Ext = '' },
    @{ Id = 'darwin-x64';   Ext = '' },
    @{ Id = 'linux-x64';    Ext = '' },
    @{ Id = 'linux-arm64';  Ext = '' },
    @{ Id = 'win32-x64';    Ext = '.exe' }
)

Write-Host "📦 Bundling bridge binaries..." -ForegroundColor Cyan
# Clean previous bin/ to avoid stale binaries
$ExtBinDir = Join-Path $ScriptDir 'bin'
if (Test-Path $ExtBinDir) { Remove-Item -Recurse -Force $ExtBinDir }

$TotalBundled = 0
foreach ($plat in $Platforms) {
    $srcDir = Join-Path $TomBinDir $plat.Id
    $dstDir = Join-Path $ScriptDir 'bin' $plat.Id
    if (-not (Test-Path $srcDir)) {
        Write-Host "  ⚠️  Source not found: $($plat.Id) — skipping" -ForegroundColor Yellow
        continue
    }
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    foreach ($bin in $BundledBinaries) {
        $src = Join-Path $srcDir "$bin$($plat.Ext)"
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination (Join-Path $dstDir "$bin$($plat.Ext)") -Force
            $TotalBundled++
            Write-Host "  ✔ $($plat.Id)/$bin$($plat.Ext)" -ForegroundColor Green
        } else {
            Write-Host "  ⚠️  Missing: $($plat.Id)/$bin$($plat.Ext)" -ForegroundColor Yellow
        }
    }
}
Write-Host "  Bundled $TotalBundled binaries across $($Platforms.Count) platforms" -ForegroundColor Cyan

Write-Host ""

# ── Ensure Claude Agent SDK native CLI binary for THIS host ──────────────────
# Since SDK >=0.2.13x the Claude CLI ships as a platform-specific native binary
# via optional deps (@anthropic-ai/claude-agent-sdk-<platform>) instead of a
# bundled cli.js. `vsce package` only includes what is physically present in
# node_modules, so a vsix is portable only for the host it was built on. We
# build and install on the same machine, so we only ensure the host binary is
# present. `npm install` above already fetches it — this verifies/repairs it.
Write-Host "📦 Ensuring Claude Agent SDK native CLI binary for this host..." -ForegroundColor Cyan
$SdkPkgDir = Join-Path $ScriptDir 'node_modules/@anthropic-ai/claude-agent-sdk'
if (Test-Path (Join-Path $SdkPkgDir 'cli.js')) {
    Write-Host "  SDK bundles cli.js - no per-platform binary needed"
} elseif (Test-Path $SdkPkgDir) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'arm64' }
        default { 'x64' }
    }
    $HostPlat = "win32-$arch"
    $SdkPkgJson = ($SdkPkgDir -replace '\\', '/') + '/package.json'
    $SdkVer = (node -p "require('$SdkPkgJson').version")
    $HostPkg = "@anthropic-ai/claude-agent-sdk-$HostPlat"
    $HostPkgDir = Join-Path $ScriptDir "node_modules/@anthropic-ai/claude-agent-sdk-$HostPlat"
    if (Test-Path $HostPkgDir) {
        Write-Host "  $HostPkg already present"
    } else {
        Write-Host "  Installing $HostPkg@$SdkVer ..."
        # --no-save / --no-package-lock keep the committed manifests untouched;
        # we only need the binary in node_modules to package.
        npm install --no-save --no-package-lock "$HostPkg@$SdkVer"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to install $HostPkg@$SdkVer - the packaged extension would fail at runtime on this host."
            exit 1
        }
    }
} else {
    Write-Warning "@anthropic-ai/claude-agent-sdk not found in node_modules - run 'npm install' first"
}
Write-Host ""

# Package as VSIX
Write-Host ""
Write-Host "📦 Packaging extension as VSIX..." -ForegroundColor Cyan
vsce package --allow-missing-repository --skip-license --baseContentUrl https://github.com/al-the-bear/tom/blob/main/tom_vscode_extension

if ($LASTEXITCODE -eq 0) {
    # Find the generated VSIX file
    $VsixFile = Get-ChildItem -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

    if ($VsixFile) {
        Write-Host ""
        Write-Host "✅ Package created: $($VsixFile.Name)" -ForegroundColor Green
        Write-Host ""
        Write-Host "🚀 Installing extension in VS Code..." -ForegroundColor Cyan
        & code --install-extension "$($VsixFile.FullName)"

        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✅ Extension installed successfully!" -ForegroundColor Green
            Write-Host ""
            Write-Host "🔄 Reloading VS Code window..." -ForegroundColor Cyan
            Write-Host "   Please manually reload: Ctrl+Shift+P → 'Developer: Reload Window'"
            Write-Host ""
            Write-Host "🔔 The reminder notification will appear ~2 seconds after reload."
        } else {
            Write-Host "❌ Failed to install extension" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "❌ Could not find generated VSIX file" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "❌ Failed to package extension" -ForegroundColor Red
    exit 1
}
