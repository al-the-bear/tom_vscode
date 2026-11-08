<#
.SYNOPSIS
    Tom AI Build - VS Code Extension Installation Script
    This script sets up and installs the VS Code extension for development.
.DESCRIPTION
    install_extension.ps1 [-NoDart | --no-dart] [-AllPlatforms | --all-platforms]

    -NoDart (or --no-dart, or TOM_NO_DART=1) builds as on a machine without a
    Dart SDK: no Dart step runs, and the VSIX carries no validate_codespecs and,
    from source, no tom_bs. Without the option the same happens when no Dart
    SDK is found (scripts/find-dart.cjs). The extension then loses only
    DartScript and CodeSpecs validation; everything else works.

    -AllPlatforms (or --all-platforms, or TOM_ALL_PLATFORMS=1) bundles the
    Agent SDK's Claude CLI for darwin-arm64, linux-x64 and win32-x64, not only
    for this host, so the Agent SDK transport also runs where the VSIX is
    installed on another platform (about 110 MB more per platform).
#>
param([switch]$NoDart, [switch]$AllPlatforms)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'scripts/install_summary.ps1')

foreach ($Arg in $args) {
    if ($Arg -eq '--no-dart') { $NoDart = $true }
    elseif ($Arg -eq '--all-platforms') { $AllPlatforms = $true }
    else { Write-Error "Unknown option: $Arg (usage: install_extension.ps1 [-NoDart | --no-dart] [-AllPlatforms | --all-platforms])"; exit 1 }
}
if ($AllPlatforms) { $env:TOM_ALL_PLATFORMS = '1' }
$AllPlatformsMode = ($env:TOM_ALL_PLATFORMS -eq '1')
if ($NoDart) {
    $env:TOM_NO_DART = '1'
    if (-not $env:TOM_NO_DART_REASON) { $env:TOM_NO_DART_REASON = '--no-dart given' }
}
$NoDartMode = ($env:TOM_NO_DART -eq '1')
if ($NoDartMode -and -not $env:TOM_NO_DART_REASON) { $env:TOM_NO_DART_REASON = 'TOM_NO_DART=1' }
$FromSource = ($env:TOM_BRIDGE_FROM_SOURCE -eq '1')

# Runs a native program (npm, dart, node, vsce, code, ...) so that what it
# writes to stderr is logged rather than fatal.
# Why: under Windows PowerShell 5.1 with "Stop" in effect, a native program's
# stderr becomes a terminating NativeCommandError as soon as the script's
# output is redirected (`*>`, `2>&1`, a log file) - i.e. on every unattended
# run. `dart pub get` prints its upgrade advice to stderr, so such runs died
# there with an empty log. Success is decided by the `$LASTEXITCODE` check
# after each call, which is unaffected (it is global, not scoped).
# Every native call in this script goes through this function; the extension
# test src/utils/__tests__/installScriptNativeCalls.test.ts holds that.
function Invoke-Native([scriptblock]$Block) {
    $ErrorActionPreference = "Continue"
    & $Block
}

Write-Host "================================================"
Write-Host "Tom AI Build - VS Code Extension Installation"
Write-Host "================================================"
Write-Host ""

# The extension directory is always the directory where this script lives
$ExtensionDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Extension directory: $ExtensionDir"
Write-Host ""

# Navigate to extension directory
Push-Location $ExtensionDir

# Check if Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Error: Node.js is not installed"
    Write-Host "Please install Node.js from https://nodejs.org/"
    exit 1
}

$CurrentNodeVersion = (Invoke-Native { node --version }) -replace 'v',''
$NodeMajorVersion = [int]$CurrentNodeVersion.Split('.')[0]

Write-Host "Current Node.js version: v$CurrentNodeVersion"

# Check if Node.js version is >= 20
if ($NodeMajorVersion -lt 20) {
    Write-Warning "Node.js version $NodeMajorVersion is below the required version 20"
    
    # Check if nvm is installed
    if (Get-Command nvm -ErrorAction SilentlyContinue) {
        Write-Host "Node Version Manager (nvm) is detected"
        
        # Try to use Node 20
        Write-Host "Attempting to switch to Node.js 20..."
        Invoke-Native { nvm use 20 }
        
        # Check if switch was successful or if install is needed
        if ($LASTEXITCODE -ne 0) {
            Write-Host "'nvm use 20' failed. Attempting to install Node.js 20..."
            Invoke-Native { nvm install 20 }
            Invoke-Native { nvm use 20 }
        }
        
        # Verify version again
        $CurrentNodeVersion = (Invoke-Native { node --version }) -replace 'v',''
        $NodeMajorVersion = [int]$CurrentNodeVersion.Split('.')[0]
        
        if ($NodeMajorVersion -ge 20) {
            Write-Host "Now using Node.js v$CurrentNodeVersion"
        } else {
            Write-Error "Failed to switch to Node.js 20. Current version is still $CurrentNodeVersion"
            Write-Host "Note: 'nvm use' on Windows may require Administrator privileges."
            exit 1
        }
    } else {
        Write-Host ""
        Write-Host "This extension requires Node.js >= 20"
        Write-Host "Please upgrade Node.js or install 'nvm' to manage versions."
        exit 1
    }
} else {
    Write-Host "Node.js version meets requirements (>= 20)"
}

# Check if npm is installed
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "Error: npm is not installed"
    exit 1
}

$NpmVersion = Invoke-Native { npm --version }
Write-Host "npm version: $NpmVersion"
Write-Host ""

# The Dart SDK: validate_codespecs (and, from source, tom_bs) are compiled
# below. Find it now - also when `dart` is not on PATH (Flutter's Dart,
# DART_SDK, FLUTTER_ROOT, known locations; scripts/find-dart.cjs). Without one
# the install goes on in no-Dart mode: every Dart step is skipped, and the
# closing warning says what the VSIX lacks.
if ($NoDartMode) {
    Write-Warning "No-Dart mode ($($env:TOM_NO_DART_REASON)): the Dart steps are skipped."
} else {
    Write-Host "Looking for the Dart SDK..."
    $DartDir = Invoke-Native { node scripts/find-dart.cjs }
    if ($LASTEXITCODE -ne 0 -or -not $DartDir) {
        $NoDartMode = $true
        $env:TOM_NO_DART = '1'
        $env:TOM_NO_DART_REASON = 'no Dart SDK found'
        Write-Warning "No Dart SDK found: building without DartScript and CodeSpecs validation (see the warning at the end)."
    } else {
        $DartDir = ($DartDir | Select-Object -Last 1).ToString().Trim()
        $env:Path = "$DartDir;$env:Path"
        Write-Host "Dart SDK: $DartDir"
    }
}
Write-Host ""

# From source: the bridge is compiled against its pubspec.lock, which is
# machine-local and which `dart pub get` never moves. A lock behind the tom_*
# releases the regenerated bridges need fails only at `dart compile exe`, after
# the whole build - so upgrade the bridge's frozen tom_* packages now, in
# seconds (pub.dev, else the pub cache; scripts/bridge-lock-preflight.cjs).
if ($FromSource -and -not $NoDartMode) {
    Write-Host "Checking the bridge's tom_* resolutions..."
    Invoke-Native { node scripts/bridge-lock-preflight.cjs --fix }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Upgrading the bridge's tom_* packages failed (see above)"
        exit 1
    }
    Write-Host ""
}

# Build the TomSpecs SOM TypeScript pair (tom_ai/ai_build) into the two
# tarballs package.json depends on. Must run before `npm install`: the VSIX has
# to carry real copies of both packages, never a link into ai_build.
Write-Host "Building the TomSpecs SOM packages..."
Invoke-Native { node scripts/build-som-packages.cjs }
if ($LASTEXITCODE -ne 0) {
    Write-Error "Building the TomSpecs SOM packages failed"
    exit 1
}

# Install dependencies
Write-Host "Installing npm dependencies..."
Invoke-Native { npm install }
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed"
    exit 1
}

# The model just packed must be the one installed: npm can keep a stale
# tarball, and the extension would then ship an old TomSpecs model.
Invoke-Native { node scripts/check-som-installed.cjs }
if ($LASTEXITCODE -ne 0) {
    Write-Error "The installed TomSpecs model is not the packed one"
    exit 1
}

Write-Host ""
Write-Host "Compiling TypeScript..."
Invoke-Native { npm run compile }
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed"
    exit 1
}

Write-Host ""
Write-Host "Extension compiled successfully!"
Write-Host ""

# The VS Code CLI installs the VSIX. Without it the VSIX is still built (its
# path is printed at the end), only the install is skipped.
$CodeCli = ""
if (Get-Command code -ErrorAction SilentlyContinue) {
    $CodeCli = "code"
    Write-Host "VS Code CLI detected"
} else {
    Write-Warning "VS Code CLI 'code' not found in PATH: the VSIX is built but not installed."
}

Write-Host ""

$VsixBuilt = $false
# Ask if user wants to package (and install) as VSIX. compile_and_install.ps1
# sets TOM_BRIDGE_FROM_SOURCE=1 to run unattended (auto-confirm).
if ($FromSource) {
    $Result = 'y'
} else {
    $Result = Read-Host "Do you want to package (and install) the extension (VSIX)? (y/n)"
}
Write-Host ""

if ($Result -match "^[Yy]") {
    # Check if vsce is installed
    if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
        Write-Host "Installing @vscode/vsce globally..."
        Invoke-Native { npm install -g @vscode/vsce }
        
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to install vsce."
            Write-Host "After installing vsce, run this script again."
            exit 1
        }
    }
    
    Write-Host ""
    Write-Host "Packaging extension as VSIX..."

    # ── Bundle bridge binaries ───────────────────────────────────────
    # Default: copy prebuilt binaries for all 5 platforms out of the
    # binaries layer (tom_binaries). When TOM_BRIDGE_FROM_SOURCE=1 (set by
    # compile_and_install.ps1): resolve deps, regenerate the d4rt bridges,
    # and compile the bridge for THIS host from source - bundling only that
    # one binary, built into the extension's local bin/ (never a shared or
    # PATH-resolved location).
    $WorkspaceRoot = (Resolve-Path (Join-Path $ExtensionDir '..\..\..')).Path
    $TomBinDir = Join-Path (Join-Path $WorkspaceRoot 'tom_binaries') 'tom'
    $BridgeDir = Join-Path $WorkspaceRoot 'tom_ai/vscode/tom_vscode_bridge'
    $BundledBinaries = @('tom_bs')

    $ExtBinDir = Join-Path $ExtensionDir 'bin'
    if (Test-Path $ExtBinDir) { Remove-Item -Recurse -Force $ExtBinDir }

    if ($FromSource -and $NoDartMode) {
        # Without Dart there is nothing to compile tom_bs with: this VSIX
        # carries no bridge for the host, and the extension runs without
        # DartScript.
        Write-Host "No Dart: no tom_bs is built for this host (DartScript will not be available)."
    } elseif ($FromSource) {
        if (-not (Get-Command dart -ErrorAction SilentlyContinue)) {
            Write-Error "Dart SDK not found - cannot compile the bridge from source"
            exit 1
        }
        $GenDir = Join-Path $WorkspaceRoot 'tom_ai/d4rt/tom_d4rt_generator'
        $GenPkgConfig = Join-Path $GenDir '.dart_tool/package_config.json'
        $GenEntrypoint = Join-Path $GenDir 'bin/d4rtgen.dart'

        $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
            'ARM64' { 'arm64' }
            default { 'x64' }
        }
        $HostPlat = "win32-$arch"
        $dstDir = Join-Path $ExtBinDir $HostPlat
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null

        # 1) Versioner: increment the bridge build number and (re)generate
        #    lib/src/version.versioner.dart (compilation fails if missing).
        #    The versioner lives only inside buildkit, so prefer a prebuilt
        #    buildkit binary (PATH, then the tom_binaries layer); fall back to
        #    running it from buildkit's source via dart so a fresh checkout
        #    with only the Dart SDK still works. -R --project targets the
        #    bridge from the workspace root without cd-ing into it.
        Write-Host "Running versioner (build number + version.versioner.dart)..."
        $BuildkitBin = $null
        if (Get-Command buildkit -ErrorAction SilentlyContinue) {
            $BuildkitBin = 'buildkit'
        } elseif ($env:TOM_BINARY_PATH -and (Test-Path (Join-Path $env:TOM_BINARY_PATH "$HostPlat/buildkit.exe"))) {
            $BuildkitBin = Join-Path $env:TOM_BINARY_PATH "$HostPlat/buildkit.exe"
        } elseif (Test-Path (Join-Path $HOME "tac/tom_binaries/tom/$HostPlat/buildkit.exe")) {
            $BuildkitBin = Join-Path $HOME "tac/tom_binaries/tom/$HostPlat/buildkit.exe"
        }
        if ($BuildkitBin) {
            Push-Location $WorkspaceRoot
            Invoke-Native { & $BuildkitBin -R --project tom_vscode_bridge :versioner }
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "versioner failed"; exit 1 }
            Pop-Location
        } else {
            Write-Host "  buildkit binary not found - running versioner from source"
            $BuildkitDir = Join-Path $WorkspaceRoot 'tom_ai/basics/tom_build_kit'
            Push-Location $BuildkitDir
            Invoke-Native { dart pub get }
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $BuildkitDir"; exit 1 }
            Pop-Location
            $BuildkitPkgConfig = Join-Path $BuildkitDir '.dart_tool/package_config.json'
            $BuildkitEntrypoint = Join-Path $BuildkitDir 'bin/buildkit.dart'
            Push-Location $WorkspaceRoot
            Invoke-Native { dart --packages="$BuildkitPkgConfig" "$BuildkitEntrypoint" -R --project tom_vscode_bridge :versioner }
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "versioner failed"; exit 1 }
            Pop-Location
        }

        # 2) Resolve dependencies for both the generator and the bridge.
        Write-Host "Resolving Dart dependencies (generator + bridge)..."
        Push-Location $GenDir
        Invoke-Native { dart pub get }
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $GenDir"; exit 1 }
        Pop-Location
        Push-Location $BridgeDir
        Invoke-Native { dart pub get }
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $BridgeDir"; exit 1 }

        # 3) Regenerate the d4rt bridges. d4rtgen processes the project in its
        #    current directory, so run it from the bridge dir; --packages runs
        #    the generator's entrypoint directly from its source, without
        #    requiring it on PATH or as a dependency of the bridge.
        Write-Host "Regenerating d4rt bridges..."
        Invoke-Native { dart --packages="$GenPkgConfig" "$GenEntrypoint" }
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "d4rt bridge generation failed"; exit 1 }

        # 4) Compile the bridge binary for THIS host straight into the
        #    extension's local bin/ - no shared location, no PATH lookup.
        Write-Host "Compiling bridge binary from source for $HostPlat ..."
        foreach ($bin in $BundledBinaries) {
            $dst = Join-Path $dstDir "$bin.exe"
            Invoke-Native { dart compile exe (Join-Path 'bin' "$bin.dart") -o $dst }
            if ($LASTEXITCODE -ne 0) {
                Pop-Location
                Write-Error "Failed to compile $bin from source"
                exit 1
            }
            Write-Host "  $HostPlat/$bin.exe (from source)"
        }
        Pop-Location

        # 5) Put back what changed only by its time stamp (the bridges'
        #    `// Generated:` line, the version stamp when the version is the
        #    same); name what really changed, to be committed.
        Write-Host "Checking what the regeneration changed..."
        Invoke-Native { node (Join-Path $PSScriptRoot 'scripts/bridge-generated-churn.cjs') $BridgeDir }
    } else {
        $Platforms = @(
            @{ Id = 'darwin-arm64'; Ext = '' },
            @{ Id = 'darwin-x64';   Ext = '' },
            @{ Id = 'linux-x64';    Ext = '' },
            @{ Id = 'linux-arm64';  Ext = '' },
            @{ Id = 'win32-x64';    Ext = '.exe' }
        )

        Write-Host "Bundling bridge binaries..."
        # The prebuilt tom_bs binaries are not rebuilt: compile_and_install.ps1
        # is the install route on every host, and this one serves a machine
        # without the d4rt and bridge checkouts.
        Write-Host "  The prebuilt tom_bs binaries in tom_binaries are not kept current; compile_and_install.ps1 builds a current one for this host."
        $TotalBundled = 0
        foreach ($plat in $Platforms) {
            $srcDir = Join-Path $TomBinDir $plat.Id
            $dstDir = Join-Path $ExtBinDir $plat.Id
            if (-not (Test-Path $srcDir)) {
                Write-Host "  Warning: Source not found: $($plat.Id) - skipping"
                continue
            }
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
            foreach ($bin in $BundledBinaries) {
                $src = Join-Path $srcDir "$bin$($plat.Ext)"
                if (Test-Path $src) {
                    Copy-Item -Path $src -Destination (Join-Path $dstDir "$bin$($plat.Ext)") -Force
                    $TotalBundled++
                }
            }
        }
        Write-Host "Bundled $TotalBundled binaries across $($Platforms.Count) platforms"
        # The prebuilt binaries are only as fresh as the bridges they were
        # built from: with Dart at hand, warn when the committed bridges lag
        # behind the scripting API (BRIDGE-FRESH-01). Not a stop.
        if (-not $NoDartMode -and (Get-Command dart -ErrorAction SilentlyContinue)) {
            # The bridge's lock decides what the bridge's tests run against:
            # name frozen tom_* resolutions (a warning; from source upgrades them).
            Write-Host "Checking the bridge's tom_* resolutions..."
            $LockReport = Invoke-Native { node (Join-Path $PSScriptRoot 'scripts/bridge-lock-preflight.cjs') --warn }
            foreach ($line in @($LockReport)) { Write-Host "$line" }
            Write-Host "Checking that the committed d4rt bridges are fresh..."
            $null = Invoke-Native { node (Join-Path $PSScriptRoot 'scripts/check-bridge-fresh.cjs') 2>&1 }
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  The committed bridges match the scripting API"
            } else {
                Write-Host "  Warning: the committed bridges of tom_vscode_bridge are stale or could not be checked (npm run check:bridges): tom_bs may lack scripting-API members. compile_and_install.ps1 rebuilds them."
            }
        }
        # Which bridge source the host's prebuilt tom_bs was built from (the
        # versioner stamp it prints on start), against the committed bridge
        # sources: a warning when it is older; compile_and_install.ps1
        # builds a fresh one.
        Write-Host "Checking which bridge source the prebuilt tom_bs was built from..."
        $Provenance = Invoke-Native { node (Join-Path $PSScriptRoot 'scripts/check-tom-bs-provenance.cjs') }
        foreach ($line in @($Provenance)) { Write-Host "  $line" }
    }

    # ── Bundle validate_codespecs for THIS host ──────────────────────────
    # The CodeSpecs tools run tom_specs_clitool's validate_codespecs as a
    # compiled binary from bin/<platform>/ - never via `dart run`. It is
    # compiled here from tom_ai/ai_build, like tom_bs in from-source mode.
    # The Dart SDK was found at the start of this script. Without Dart the
    # VSIX carries none and CodeSpecs validation is unavailable.
    if ($NoDartMode) {
        Write-Host "No Dart: validate_codespecs is not built (CodeSpecs validation will not be available)."
    } else {
        Push-Location $ExtensionDir
        Invoke-Native { node scripts/build-validate-codespecs.cjs }
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "building validate_codespecs failed"; exit 1 }
        Pop-Location
    }
    Write-Host ""

    # ── Claude Agent SDK native CLI: this host's, or the fleet's ──────────
    # Since SDK >=0.2.13x the Claude CLI ships as a platform-specific native
    # binary via optional deps (@anthropic-ai/claude-agent-sdk-<platform>)
    # rather than a bundled cli.js. `vsce package` only includes what is
    # physically present in node_modules, and only the host's package may be
    # there (vsce's `npm list` refuses another platform's as invalid), so by
    # default the VSIX runs the Agent SDK transport only on this platform;
    # elsewhere the transport says the CLI is missing
    # (resources/agent_sdk/missing_agent_sdk_cli.md). With -AllPlatforms the
    # fleet's other CLIs (darwin-arm64, linux-x64, win32-x64) are fetched with
    # `npm pack` (no platform check) into .cache/agent-sdk-cli/ and bundled as
    # bin/<platform>/claude[.exe], which the transport hands to the SDK
    # (pathToClaudeCodeExecutable). bin/ was emptied above, so a default build
    # carries none of them. Older SDKs that still bundle cli.js need nothing.
    if ($AllPlatformsMode) {
        Write-Host "Ensuring the Claude Agent SDK native CLI for this host and the fleet (-AllPlatforms)..."
    } else {
        Write-Host "Ensuring the Claude Agent SDK native CLI for this host (only; -AllPlatforms adds the fleet's)..."
    }
    $SdkPkgDir = Join-Path $ExtensionDir 'node_modules/@anthropic-ai/claude-agent-sdk'
    if (Test-Path (Join-Path $SdkPkgDir 'cli.js')) {
        Write-Host "  SDK bundles cli.js - no per-platform binary needed"
    } elseif (Test-Path $SdkPkgDir) {
        $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
            'ARM64' { 'arm64' }
            default { 'x64' }
        }
        $HostPlat = "win32-$arch"
        $SdkPkgJson = ($SdkPkgDir -replace '\\', '/') + '/package.json'
        $SdkVer = Invoke-Native { node -p "require('$SdkPkgJson').version" }
        $HostPkg = "@anthropic-ai/claude-agent-sdk-$HostPlat"
        # Only the host's package: another platform's would fail vsce's npm list.
        $SdkScopeDir = Join-Path $ExtensionDir 'node_modules/@anthropic-ai'
        foreach ($dir in @(Get-ChildItem -Path $SdkScopeDir -Directory -Filter 'claude-agent-sdk-*' -ErrorAction SilentlyContinue)) {
            $plat = $dir.Name.Substring('claude-agent-sdk-'.Length)
            if ($plat -ne $HostPlat) {
                Remove-Item -Recurse -Force $dir.FullName
                Write-Host "  removed the $plat package (only the host's may be in node_modules)"
            }
        }
        if (Test-Path (Join-Path $SdkScopeDir "claude-agent-sdk-$HostPlat")) {
            Write-Host "  $HostPkg already present"
        } else {
            Write-Host "  Installing $HostPkg@$SdkVer ..."
            # --no-save / --no-package-lock keep the committed manifests
            # untouched; we only need the binary in node_modules to package.
            Invoke-Native { npm install --no-save --no-package-lock "$HostPkg@$SdkVer" }
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Failed to install $HostPkg@$SdkVer - the packaged extension would fail at runtime on this host."
                exit 1
            }
        }
        if ($AllPlatformsMode) {
            $CliCache = Join-Path $ExtensionDir '.cache/agent-sdk-cli'
            New-Item -ItemType Directory -Path $CliCache -Force | Out-Null
            foreach ($plat in @('darwin-arm64', 'linux-x64', 'win32-x64')) {
                if ($plat -eq $HostPlat) { continue }
                $exe = if ($plat -like 'win32-*') { '.exe' } else { '' }
                $pkg = "@anthropic-ai/claude-agent-sdk-$plat@$SdkVer"
                $tgz = Join-Path $CliCache "anthropic-ai-claude-agent-sdk-$plat-$SdkVer.tgz"
                if (-not (Test-Path $tgz)) {
                    Write-Host "  Fetching $pkg ..."
                    Push-Location $CliCache
                    $null = Invoke-Native { npm pack $pkg --silent }
                    $packed = $LASTEXITCODE
                    Pop-Location
                    if ($packed -ne 0) { Write-Error "Failed to fetch $pkg"; exit 1 }
                }
                $unpack = Join-Path $CliCache "unpacked-$plat"
                if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
                New-Item -ItemType Directory -Path $unpack -Force | Out-Null
                Invoke-Native { tar -xzf $tgz -C $unpack }
                if ($LASTEXITCODE -ne 0) { Write-Error "Failed to unpack $tgz"; exit 1 }
                $dstDir = Join-Path $ExtensionDir "bin/$plat"
                New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
                Copy-Item -Path (Join-Path $unpack "package/claude$exe") -Destination (Join-Path $dstDir "claude$exe") -Force
                Remove-Item -Recurse -Force $unpack
                Write-Host "  bin/$plat/claude$exe ($pkg)"
            }
        }
    } else {
        Write-Warning "@anthropic-ai/claude-agent-sdk not found in node_modules - run 'npm install' first"
    }
    Write-Host ""

    # ── The workspace template ───────────────────────────────────────────
    # What @T: Setup New Workspace Folder unpacks: the workspace's config,
    # guidelines, CLAUDE.md and the generic _ai folders, checked for personal
    # files and literal secrets. Built into resources/ (packed into the VSIX)
    # and copied beside the VSIX (scripts/build-workspace-template.cjs).
    Write-Host "Building the workspace template..."
    Invoke-Native { node scripts/build-workspace-template.cjs --copy-to $ExtensionDir }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Building the workspace template failed (see above)"
        exit 1
    }
    Write-Host ""

    # The README's relative links are rewritten against the package's folder in
    # its repository (package.json `repository`; vsce itself drops the folder).
    $BaseContentUrl = Invoke-Native { node scripts/vsix-base-url.cjs content }
    $BaseImagesUrl = Invoke-Native { node scripts/vsix-base-url.cjs images }
    Invoke-Native { cmd /c vsce package --skip-license --baseContentUrl $BaseContentUrl --baseImagesUrl $BaseImagesUrl }
    
    if ($LASTEXITCODE -eq 0) {
        # Find the generated VSIX file
        $VsixFile = Get-ChildItem -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        
        if ($VsixFile) {
            Write-Host ""
            Write-Host "Package created: $($VsixFile.Name)"
            # The VSIX must be self-contained: SOM packages as real files, no symlinks.
            Invoke-Native { node scripts/check-vsix-contents.cjs "$($VsixFile.FullName)" }
            if ($LASTEXITCODE -ne 0) {
                Write-Error "The VSIX is not self-contained; not installing it"
                exit 1
            }
            $VsixBuilt = $true
            if (-not $CodeCli) {
                Write-Host ""
                Write-Warning "Not installed: VS Code CLI 'code' not found (install the VSIX by hand, path below)."
            } else {
                Write-Host ""
                Write-Host "Installing extension in VS Code..."
                Invoke-Native { & $CodeCli --install-extension "$($VsixFile.FullName)" }

                if ($LASTEXITCODE -eq 0) {
                    Write-Host ""
                    Write-Host "Extension installed successfully!"
                    Write-Host ""
                    Write-Host "Next steps:"
                    Write-Host "  1. Restart VS Code or reload the window"
                    Write-Host "     (Ctrl+Shift+P -> 'Developer: Reload Window')"
                    Write-Host "  2. Open a workspace with Dart files"
                    Write-Host "  3. Use Command Palette and search for 'Tom AI Build'"
                    Write-Host ""
                } else {
                    Write-Error "Failed to install extension"
                    Write-Host "You can manually install by:"
                    Write-Host "  1. Open VS Code"
                    Write-Host "  2. Ctrl+Shift+P -> 'Extensions: Install from VSIX...'"
                    Write-Host "  3. Select: $($VsixFile.FullName)"
                }
            }
        } else {
            Write-Error "Could not find generated VSIX file"
        }
    } else {
        Write-Error "Failed to package extension"
        Write-Host "Try running: vsce package"
    }
} else {
    Write-Host ""
    Write-Host "To run the extension in development mode:"
    Write-Host "  1. Open the extension folder in VS Code:"
    Write-Host "     cd $ExtensionDir"
    Write-Host "     code ."
    Write-Host "  2. Press F5 to launch the extension in a new VS Code window"
    Write-Host ""
    
    # Ask if user wants to open in VS Code for development
    if ($CodeCli) {
        $OpenDev = Read-Host "Do you want to open the extension in VS Code now? (y/n)"
        Write-Host ""
        if ($OpenDev -match "^[Yy]") {
            Write-Host "Opening in VS Code..."
            Invoke-Native { & $CodeCli "$ExtensionDir" }
        }
    }
}

Pop-Location

Write-Host ""
Write-Host "================================================"
Write-Host "Installation complete!"
Write-Host "================================================"
# The closing lines: the VSIX path, the no-Dart warning, the finish time and
# the warning again, so it is the last thing on screen. A wrapper
# (compile_and_install.ps1) sets TOM_SKIP_FINISH_TS=1 and prints them itself,
# so they appear once.
if ($env:TOM_SKIP_FINISH_TS -ne '1') {
    if ($VsixBuilt) { Write-TomVsixPath $ExtensionDir }
    if ($NoDartMode) { Write-TomNoDartWarning $env:TOM_NO_DART_REASON $FromSource }
    Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    if ($NoDartMode) { Write-TomNoDartWarning $env:TOM_NO_DART_REASON $FromSource }
}
