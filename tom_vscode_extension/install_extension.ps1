<#
.SYNOPSIS
    Tom AI Build - VS Code Extension Installation Script
    This script sets up and installs the VS Code extension for development.
#>

$ErrorActionPreference = "Stop"

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

$CurrentNodeVersion = (node --version) -replace 'v',''
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
        nvm use 20
        
        # Check if switch was successful or if install is needed
        if ($LASTEXITCODE -ne 0) {
            Write-Host "'nvm use 20' failed. Attempting to install Node.js 20..."
            nvm install 20
            nvm use 20
        }
        
        # Verify version again
        $CurrentNodeVersion = (node --version) -replace 'v',''
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

Write-Host "npm version: $(npm --version)"
Write-Host ""

# Install dependencies
Write-Host "Installing npm dependencies..."
npm install

Write-Host ""
Write-Host "Compiling TypeScript..."
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed"
    exit 1
}

Write-Host ""
Write-Host "Extension compiled successfully!"
Write-Host ""

# Check if VS Code CLI is installed
$CodeCli = ""
if (Get-Command code -ErrorAction SilentlyContinue) {
    $CodeCli = "code"
    Write-Host "VS Code CLI detected"
} else {
    Write-Warning "VS Code CLI 'code' not found in PATH."
    Write-Host "To assume VS Code is installed, we can try to find it, but it's recommended to add 'code' to your PATH."
}

Write-Host ""

if ($CodeCli) {
    # Ask if user wants to package and install as VSIX. compile_and_install.ps1
    # sets TOM_BRIDGE_FROM_SOURCE=1 to run unattended (auto-confirm).
    if ($env:TOM_BRIDGE_FROM_SOURCE -eq '1') {
        $Result = 'y'
    } else {
        $Result = Read-Host "Do you want to package and install the extension (VSIX)? (y/n)"
    }
    Write-Host ""
    
    if ($Result -match "^[Yy]") {
        # Check if vsce is installed
        if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
            Write-Host "Installing @vscode/vsce globally..."
            npm install -g @vscode/vsce
            
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

        if ($env:TOM_BRIDGE_FROM_SOURCE -eq '1') {
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
                & $BuildkitBin -R --project tom_vscode_bridge :versioner
                if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "versioner failed"; exit 1 }
                Pop-Location
            } else {
                Write-Host "  buildkit binary not found - running versioner from source"
                $BuildkitDir = Join-Path $WorkspaceRoot 'tom_ai/basics/tom_build_kit'
                Push-Location $BuildkitDir
                dart pub get
                if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $BuildkitDir"; exit 1 }
                Pop-Location
                $BuildkitPkgConfig = Join-Path $BuildkitDir '.dart_tool/package_config.json'
                $BuildkitEntrypoint = Join-Path $BuildkitDir 'bin/buildkit.dart'
                Push-Location $WorkspaceRoot
                dart --packages="$BuildkitPkgConfig" "$BuildkitEntrypoint" -R --project tom_vscode_bridge :versioner
                if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "versioner failed"; exit 1 }
                Pop-Location
            }

            # 2) Resolve dependencies for both the generator and the bridge.
            Write-Host "Resolving Dart dependencies (generator + bridge)..."
            Push-Location $GenDir
            dart pub get
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $GenDir"; exit 1 }
            Pop-Location
            Push-Location $BridgeDir
            dart pub get
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "dart pub get failed in $BridgeDir"; exit 1 }

            # 3) Regenerate the d4rt bridges. d4rtgen processes the project in its
            #    current directory, so run it from the bridge dir; --packages runs
            #    the generator's entrypoint directly from its source, without
            #    requiring it on PATH or as a dependency of the bridge.
            Write-Host "Regenerating d4rt bridges..."
            dart --packages="$GenPkgConfig" "$GenEntrypoint"
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "d4rt bridge generation failed"; exit 1 }

            # 4) Compile the bridge binary for THIS host straight into the
            #    extension's local bin/ - no shared location, no PATH lookup.
            Write-Host "Compiling bridge binary from source for $HostPlat ..."
            foreach ($bin in $BundledBinaries) {
                $dst = Join-Path $dstDir "$bin.exe"
                dart compile exe (Join-Path 'bin' "$bin.dart") -o $dst
                if ($LASTEXITCODE -ne 0) {
                    Pop-Location
                    Write-Error "Failed to compile $bin from source"
                    exit 1
                }
                Write-Host "  $HostPlat/$bin.exe (from source)"
            }
            Pop-Location
        } else {
            $Platforms = @(
                @{ Id = 'darwin-arm64'; Ext = '' },
                @{ Id = 'darwin-x64';   Ext = '' },
                @{ Id = 'linux-x64';    Ext = '' },
                @{ Id = 'linux-arm64';  Ext = '' },
                @{ Id = 'win32-x64';    Ext = '.exe' }
            )

            Write-Host "Bundling bridge binaries..."
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
        }
        Write-Host ""

        # ── Ensure Claude Agent SDK native CLI binary for THIS host ──────────
        # Since SDK >=0.2.13x the Claude CLI ships as a platform-specific native
        # binary via optional deps (@anthropic-ai/claude-agent-sdk-<platform>)
        # rather than a bundled cli.js. `vsce package` only includes what is
        # physically present in node_modules, so a vsix is portable only for the
        # host it was built on. We build and install on the same machine, so we
        # only ensure the host binary is present. Older SDKs that still bundle
        # cli.js need nothing. Missing it yields at runtime:
        #   "Native CLI binary for <platform>-<arch> not found ..."
        Write-Host "Ensuring Claude Agent SDK native CLI binary for this host..."
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
            $SdkVer = (node -p "require('$SdkPkgJson').version")
            $HostPkg = "@anthropic-ai/claude-agent-sdk-$HostPlat"
            $HostPkgDir = Join-Path $ExtensionDir "node_modules/@anthropic-ai/claude-agent-sdk-$HostPlat"
            if (Test-Path $HostPkgDir) {
                Write-Host "  $HostPkg already present"
            } else {
                Write-Host "  Installing $HostPkg@$SdkVer ..."
                # --no-save / --no-package-lock keep the committed manifests
                # untouched; we only need the binary in node_modules to package.
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

        cmd /c vsce package --allow-missing-repository --skip-license --baseContentUrl https://github.com/al-the-bear/tom/blob/main/tom_dartscript_extension
        
        if ($LASTEXITCODE -eq 0) {
            # Find the generated VSIX file
            $VsixFile = Get-ChildItem -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            
            if ($VsixFile) {
                Write-Host ""
                Write-Host "Package created: $($VsixFile.Name)"
                Write-Host ""
                Write-Host "Installing extension in VS Code..."
                & $CodeCli --install-extension "$($VsixFile.FullName)"
                
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
        $OpenDev = Read-Host "Do you want to open the extension in VS Code now? (y/n)"
        Write-Host ""
        if ($OpenDev -match "^[Yy]") {
            Write-Host "Opening in VS Code..."
            & $CodeCli "$ExtensionDir"
        }
    }
} else {
    Write-Host "Manual installation steps:"
    Write-Host ""
    Write-Host "Option 1: Package and install as VSIX"
    Write-Host "  1. Install vsce: npm install -g @vscode/vsce"
    Write-Host "  2. Package: cd $ExtensionDir; vsce package"
    Write-Host "  3. In VS Code: Ctrl+Shift+P -> 'Extensions: Install from VSIX...'"
    Write-Host "  4. Select the .vsix file"
    Write-Host ""
    Write-Host "Option 2: Development mode"
    Write-Host "  1. Open Visual Studio Code"
    Write-Host "  2. File -> Open Folder -> Select: $ExtensionDir"
    Write-Host "  3. Press F5 to launch the extension in a new window"
}

Pop-Location

Write-Host ""
Write-Host "================================================"
Write-Host "Installation complete!"
Write-Host "================================================"
