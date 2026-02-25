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
    # Ask if user wants to package and install as VSIX
    $Result = Read-Host "Do you want to package and install the extension (VSIX)? (y/n)"
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
