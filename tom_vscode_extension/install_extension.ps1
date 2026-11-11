<#
.SYNOPSIS
    Tom AI Build - VS Code Extension Installation Script
    This script sets up and installs the VS Code extension for development.
.DESCRIPTION
    install_extension.ps1 [-NoDart | --no-dart] [-PackageOnly | --package-only]
                          [-BinariesOnly | --binaries-only] [-LayerBinaries | --layer-binaries] [-NoLayer | --no-layer]

    -NoDart (or --no-dart, or TOM_NO_DART=1) builds as on a machine without a
    Dart SDK: no Dart step runs, and the VSIX carries no validate_codespecs and,
    from source, no tom_bs. Without the option the same happens when no Dart
    SDK is found (scripts/find-dart.cjs). The extension then loses only
    DartScript and CodeSpecs validation; everything else works.

    -PackageOnly (or --package-only, or TOM_PACKAGE_ONLY=1) builds and checks
    the VSIX without the prompt and does not install it (create_vsix*.ps1 use
    it).

    -BinariesOnly (or --binaries-only, or TOM_BINARIES_ONLY=1; from source
    only) builds tom_bs and validate_codespecs for this host and puts them into
    the binaries layer - no npm, no TypeScript, no VSIX (the fleet build of
    create_fleetcompiled_vsix.* runs it on every fleet host).

    -LayerBinaries (or --layer-binaries, or TOM_LAYER_BINARIES=1) builds
    nothing with Dart: tom_bs and validate_codespecs for every platform come
    from the binaries layer (TOM_LAYER_PLATFORMS=a,b,... narrows them;
    create_*binaries_vsix.*).

    A from-source build puts the binaries it built into the binaries layer,
    tom_binaries/tom/<platform>/, commits them there and pushes
    (scripts/binaries-layer.cjs publish; TOM_LAYER_FF=1 fast-forwards the
    layer first, as the fleet build does). -NoLayer (or --no-layer, or
    TOM_NO_LAYER=1) leaves the layer alone.
#>
param([switch]$NoDart, [switch]$PackageOnly, [switch]$BinariesOnly, [switch]$LayerBinaries, [switch]$NoLayer)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'scripts/install_summary.ps1')
. (Join-Path $PSScriptRoot 'scripts/find_code_cli.ps1')

foreach ($Arg in $args) {
    if ($Arg -eq '--no-dart') { $NoDart = $true }
    elseif ($Arg -eq '--package-only') { $PackageOnly = $true }
    elseif ($Arg -eq '--binaries-only') { $BinariesOnly = $true }
    elseif ($Arg -eq '--layer-binaries') { $LayerBinaries = $true }
    elseif ($Arg -eq '--no-layer') { $NoLayer = $true }
    else { Write-Error "Unknown option: $Arg (usage: install_extension.ps1 [-NoDart | --no-dart] [-PackageOnly | --package-only] [-BinariesOnly | --binaries-only] [-LayerBinaries | --layer-binaries] [-NoLayer | --no-layer])"; exit 1 }
}
if ($BinariesOnly) { $env:TOM_BINARIES_ONLY = '1' }
if ($LayerBinaries) { $env:TOM_LAYER_BINARIES = '1' }
if ($NoLayer) { $env:TOM_NO_LAYER = '1' }
$BinariesOnlyMode = ($env:TOM_BINARIES_ONLY -eq '1')
$LayerBinariesMode = ($env:TOM_LAYER_BINARIES -eq '1')
$NoLayerMode = ($env:TOM_NO_LAYER -eq '1')
if ($PackageOnly) { $env:TOM_PACKAGE_ONLY = '1' }
$PackageOnlyMode = ($env:TOM_PACKAGE_ONLY -eq '1')
if ($NoDart) {
    $env:TOM_NO_DART = '1'
    if (-not $env:TOM_NO_DART_REASON) { $env:TOM_NO_DART_REASON = '--no-dart given' }
}
$NoDartMode = ($env:TOM_NO_DART -eq '1')
if ($NoDartMode -and -not $env:TOM_NO_DART_REASON) { $env:TOM_NO_DART_REASON = 'TOM_NO_DART=1' }
$FromSource = ($env:TOM_BRIDGE_FROM_SOURCE -eq '1')
if ($BinariesOnlyMode -and (-not $FromSource -or $NoDartMode -or $LayerBinariesMode)) {
    Write-Error "-BinariesOnly builds the binaries from source with Dart (compile_and_install.ps1 -BinariesOnly)"
    exit 1
}
if ($LayerBinariesMode -and $FromSource) {
    Write-Error "-LayerBinaries takes the binaries from the layer; it does not build from source"
    exit 1
}

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

# Binaries only: none of the extension's own build - straight to the Dart
# binaries below.
$CodeCli = ""
if (-not $BinariesOnlyMode) {
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

# The VS Code CLI installs the VSIX. Without it (or with -PackageOnly) the
# VSIX is still built (its path is printed at the end), only the install is
# skipped.
if ($PackageOnlyMode) {
    Write-Host "Package only: the VSIX is built and checked, not installed."
} elseif ($found = Find-TomCodeCli) {
    $CodeCli = $found
    Write-Host "VS Code CLI: $CodeCli"
} else {
    Write-Warning "VS Code CLI 'code' not found (not on PATH, not in the VS Code installation; set TOM_CODE_CLI to its path): the VSIX is built but not installed."
}
} # BinariesOnlyMode

Write-Host ""

$VsixBuilt = $false
# Ask if user wants to package (and install) as VSIX. compile_and_install.ps1
# sets TOM_BRIDGE_FROM_SOURCE=1, create_vsix*.ps1 TOM_PACKAGE_ONLY=1, to run
# unattended (auto-confirm).
if ($FromSource -or $PackageOnlyMode -or $LayerBinariesMode) {
    $Result = 'y'
} else {
    $Result = Read-Host "Do you want to package (and install) the extension (VSIX)? (y/n)"
}
Write-Host ""

if ($Result -match "^[Yy]") {
    # Check if vsce is installed
    if (-not $BinariesOnlyMode -and -not (Get-Command vsce -ErrorAction SilentlyContinue)) {
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

    if ($LayerBinariesMode) {
        # Every platform's tom_bs and validate_codespecs from the binaries
        # layer, as its hosts left them (create_fleetcompiled_vsix.ps1,
        # create_currentbinaries_vsix.ps1); how current each is, is reported
        # there.
        # The layer level with its remote first: the other hosts' binaries pulled, this
        # host's unpushed ones pushed (scripts/binaries-layer.cjs sync; TOM_LAYER_NO_SYNC=1 skips it).
        if ($env:TOM_LAYER_NO_SYNC -ne '1') {
            Write-Host "Bringing the binaries layer level with its remote..."
            Invoke-Native { node scripts/binaries-layer.cjs sync }
        }
        Write-Host "Bundling tom_bs, validate_codespecs and spec_checks from the binaries layer..."
        if ($env:TOM_LAYER_PLATFORMS) {
            Invoke-Native { node scripts/binaries-layer.cjs bundle --platforms $env:TOM_LAYER_PLATFORMS }
        } else {
            Invoke-Native { node scripts/binaries-layer.cjs bundle }
        }
        if ($LASTEXITCODE -ne 0) { Write-Error "Bundling the binaries from the layer failed"; exit 1 }
    } elseif ($FromSource -and $NoDartMode) {
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
            @{ Id = 'linux-x64';    Ext = '' },
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

    # ── Bundle validate_codespecs and spec_checks for THIS host ──────────
    # The CodeSpecs tools and the TomSpecs process check tools run
    # tom_specs_clitool's validate_codespecs and spec_checks as compiled
    # binaries from bin/<platform>/ - never via `dart run`. They are compiled
    # here from tom_ai/ai_build, like tom_bs in from-source mode. The Dart SDK
    # was found at the start of this script. Without Dart the VSIX carries
    # neither: CodeSpecs validation and the process checks are unavailable.
    if ($LayerBinariesMode) {
        # taken from the binaries layer above
    } elseif ($NoDartMode) {
        Write-Host "No Dart: validate_codespecs and spec_checks are not built (CodeSpecs validation and the TomSpecs process checks will not be available)."
    } else {
        Push-Location $ExtensionDir
        Invoke-Native { node scripts/build-validate-codespecs.cjs }
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "building validate_codespecs / spec_checks failed"; exit 1 }
        Pop-Location
    }
    Write-Host ""

    # ── Put the binaries built from source into the binaries layer ───────
    # tom_binaries/tom/<platform>/ always holds the latest build of the host
    # that built it, so a VSIX for several platforms can take theirs from
    # there (scripts/binaries-layer.cjs publish: copy, build stamps, commit
    # those files, push). A refused push leaves the commit local and is not
    # fatal here; in the fleet build (TOM_LAYER_FF=1) the layer is
    # fast-forwarded first and every failure is.
    if ($FromSource -and -not $NoDartMode -and -not $NoLayerMode) {
        Write-Host "Putting this host's binaries into the binaries layer..."
        Push-Location $ExtensionDir
        if ($env:TOM_LAYER_FF -eq '1') {
            Invoke-Native { node scripts/binaries-layer.cjs publish --ff }
        } else {
            Invoke-Native { node scripts/binaries-layer.cjs publish }
        }
        $PublishStatus = $LASTEXITCODE
        Pop-Location
        if ($PublishStatus -eq 1 -or ($PublishStatus -ne 0 -and $env:TOM_LAYER_FF -eq '1')) {
            Write-Error "Putting the binaries into the binaries layer failed (see above)"
            exit 1
        }
        Write-Host ""
    }
    if ($BinariesOnlyMode) {
        Pop-Location
        Write-Host "Binaries built for this host and put into the binaries layer (no VSIX: -BinariesOnly)."
        exit 0
    }

    # The provider SDKs (the Anthropic SDK and the Agent SDK with its Claude
    # CLI) are not in the VSIX: they are devDependencies, which vsce leaves
    # out, and the extension installs them on request (Provider SDKs page).

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
            if ($PackageOnlyMode) {
                Write-Host ""
                Write-Host "Package only: not installed (install the VSIX with 'code --install-extension', path below)."
            } elseif (-not $CodeCli) {
                Write-Host ""
                Write-Warning "Not installed: no VS Code CLI found - not on PATH, not in the VS Code installation (set TOM_CODE_CLI to its path, or install the VSIX by hand, path below)."
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
    Write-TomLayerUnpushedWarning $ExtensionDir
    if ($VsixBuilt) { Write-TomVsixPath $ExtensionDir }
    if ($NoDartMode) { Write-TomNoDartWarning $env:TOM_NO_DART_REASON $FromSource }
    Write-Host "Finished at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    if ($NoDartMode) { Write-TomNoDartWarning $env:TOM_NO_DART_REASON $FromSource }
}
