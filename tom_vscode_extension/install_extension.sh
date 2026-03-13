#!/bin/bash

# Tom AI Build - VS Code Extension Installation Script
# This script sets up and installs the VS Code extension for development

set -e  # Exit on error

echo "================================================"
echo "Tom AI Build - VS Code Extension Installation"
echo "================================================"
echo ""

# The extension directory is always the directory where this script lives
EXTENSION_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "📁 Extension directory: $EXTENSION_DIR"
echo ""

# Navigate to extension directory
cd "$EXTENSION_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

CURRENT_NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR_VERSION=$(echo "$CURRENT_NODE_VERSION" | cut -d. -f1)

echo "📋 Current Node.js version: v$CURRENT_NODE_VERSION"

# Check if Node.js version is >= 20
if [ "$NODE_MAJOR_VERSION" -lt 20 ]; then
    echo "⚠️  Node.js version $NODE_MAJOR_VERSION is below the required version 20"
    echo ""
    echo "This extension requires Node.js >= 20"
    echo ""
    
    # Check if nvm is installed
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        echo "✅ Node Version Manager (nvm) is installed"
        
        # Load nvm
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        read -p "Do you want to install Node.js 20 (LTS) and the latest version? (y/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo ""
            echo "📦 Installing Node.js versions..."
            echo ""
            
            # Install Node 20 LTS
            echo "Installing Node.js 20 (LTS)..."
            nvm install 20
            
            # Install latest version
            echo ""
            echo "Installing latest Node.js version..."
            nvm install node
            
            # Use the latest version
            echo ""
            echo "🔄 Switching to latest Node.js version..."
            nvm use node
            
            # Get new version
            CURRENT_NODE_VERSION=$(node --version | sed 's/v//')
            echo ""
            echo "✅ Now using Node.js v$CURRENT_NODE_VERSION"
            echo ""
        else
            echo "❌ Cannot proceed without Node.js >= 20"
            echo "Please upgrade Node.js and run this script again"
            exit 1
        fi
    else
        echo "Node Version Manager (nvm) is not installed"
        echo ""
        read -p "Do you want to install nvm and Node.js >= 20? (y/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo ""
            echo "📦 Installing nvm..."
            
            # Install nvm
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            
            # Load nvm
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            
            echo ""
            echo "📦 Installing Node.js versions..."
            echo ""
            
            # Keep current version if possible
            if command -v node &> /dev/null; then
                CURRENT_VERSION=$(node --version)
                echo "Installing your current Node.js version ($CURRENT_VERSION) via nvm..."
                nvm install "$CURRENT_VERSION" || echo "⚠️  Could not install $CURRENT_VERSION via nvm"
                echo ""
            fi
            
            # Install Node 20 LTS
            echo "Installing Node.js 20 (LTS)..."
            nvm install 20
            
            # Install latest version
            echo ""
            echo "Installing latest Node.js version..."
            nvm install node
            
            # Use the latest version
            echo ""
            echo "🔄 Switching to latest Node.js version..."
            nvm use node
            
            # Get new version
            CURRENT_NODE_VERSION=$(node --version | sed 's/v//')
            echo ""
            echo "✅ Now using Node.js v$CURRENT_NODE_VERSION"
            echo ""
            echo "💡 Tip: To switch Node versions in the future, use:"
            echo "   nvm use 20      # Use Node.js 20"
            echo "   nvm use node    # Use latest version"
            echo "   nvm list        # List installed versions"
            echo ""
        else
            echo "❌ Cannot proceed without Node.js >= 20"
            echo "Please upgrade Node.js manually and run this script again"
            exit 1
        fi
    fi
else
    echo "✅ Node.js version meets requirements (>= 20)"
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    exit 1
fi

echo "✅ npm version: $(npm --version)"
echo ""

# Install dependencies
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "🔨 Compiling TypeScript..."
npm run compile

echo ""
echo "✅ Extension compiled successfully!"
echo ""

# Check if VS Code CLI is installed
CODE_CLI=""
if command -v code &> /dev/null; then
    CODE_CLI="code"
    echo "✅ VS Code CLI detected"
elif [ -f "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
    CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    echo "✅ VS Code app detected (but CLI not in PATH)"
    echo "💡 Tip: Install VS Code CLI by opening VS Code and running:"
    echo "   Command Palette (Cmd+Shift+P) → 'Shell Command: Install code command in PATH'"
elif [ -d "/Applications/Visual Studio Code.app" ]; then
    echo "✅ VS Code app detected (but CLI not accessible)"
    echo "💡 To install VS Code CLI:"
    echo "   1. Open Visual Studio Code"
    echo "   2. Press Cmd+Shift+P (Command Palette)"
    echo "   3. Type and select: 'Shell Command: Install code command in PATH'"
    echo "   4. Run this script again"
else
    echo "⚠️  VS Code not detected"
fi

echo ""

if [ -n "$CODE_CLI" ]; then
    # Ask if user wants to package and install as VSIX
    read -p "Do you want to package and install the extension (VSIX)? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Check if vsce is installed
        if ! command -v vsce &> /dev/null; then
            echo "📦 Installing @vscode/vsce globally..."
            npm install -g @vscode/vsce
            
            if [ $? -ne 0 ]; then
                echo "⚠️  Failed to install vsce. You may need to run with sudo:"
                echo "    sudo npm install -g @vscode/vsce"
                echo ""
                echo "After installing vsce, run this script again."
                exit 1
            fi
        fi
        
        echo ""
        echo "📦 Packaging extension as VSIX..."

        # ── Bundle bridge binaries for all platforms ─────────────────────
        WORKSPACE_ROOT="$(cd "$EXTENSION_DIR/../../.." && pwd)"
        TOM_BIN_DIR="$WORKSPACE_ROOT/tom_binaries/tom"
        BUNDLED_BINARIES="tom_bs"

        echo "Bundling bridge binaries..."
        rm -rf "$EXTENSION_DIR/bin"

        TOTAL_BUNDLED=0
        for PLAT_SPEC in "darwin-arm64:" "darwin-x64:" "linux-x64:" "linux-arm64:" "win32-x64:.exe"; do
            PLAT_ID="${PLAT_SPEC%%:*}"
            PLAT_EXT="${PLAT_SPEC#*:}"
            SRC_DIR="$TOM_BIN_DIR/$PLAT_ID"
            DST_DIR="$EXTENSION_DIR/bin/$PLAT_ID"
            if [ ! -d "$SRC_DIR" ]; then
                echo "  ⚠️  Source not found: $PLAT_ID — skipping"
                continue
            fi
            mkdir -p "$DST_DIR"
            for BIN in $BUNDLED_BINARIES; do
                SRC="$SRC_DIR/${BIN}${PLAT_EXT}"
                if [ -f "$SRC" ]; then
                    cp "$SRC" "$DST_DIR/${BIN}${PLAT_EXT}"
                    chmod +x "$DST_DIR/${BIN}${PLAT_EXT}"
                    TOTAL_BUNDLED=$((TOTAL_BUNDLED + 1))
                fi
            done
        done
        echo "Bundled $TOTAL_BUNDLED binaries across 5 platforms"
        echo ""

        vsce package
        
        if [ $? -eq 0 ]; then
            # Find the generated VSIX file
            VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -n 1)
            
            if [ -n "$VSIX_FILE" ]; then
                echo ""
                echo "✅ Package created: $VSIX_FILE"
                echo ""
                echo "🚀 Installing extension in VS Code..."
                "$CODE_CLI" --install-extension "$VSIX_FILE"
                
                if [ $? -eq 0 ]; then
                    echo ""
                    echo "✅ Extension installed successfully!"
                    echo ""
                    echo "📝 Next steps:"
                    echo "  1. Restart VS Code or reload the window"
                    echo "     (Cmd+Shift+P → 'Developer: Reload Window')"
                    echo "  2. Open a workspace with Dart files"
                    echo "  3. Use Command Palette (Cmd+Shift+P) and search for 'Tom AI Build'"
                    echo ""
                else
                    echo "❌ Failed to install extension"
                    echo "You can manually install by:"
                    echo "  1. Open VS Code"
                    echo "  2. Cmd+Shift+P → 'Extensions: Install from VSIX...'"
                    echo "  3. Select: $EXTENSION_DIR/$VSIX_FILE"
                fi
            else
                echo "❌ Could not find generated VSIX file"
            fi
        else
            echo "❌ Failed to package extension"
            echo "Try running: vsce package"
        fi
    else
        echo ""
        echo "📝 To run the extension in development mode:"
        echo "  1. Open the extension folder in VS Code:"
        echo "     cd $EXTENSION_DIR"
        if [ "$CODE_CLI" = "code" ]; then
            echo "     code ."
        else
            echo "     open -a 'Visual Studio Code' ."
        fi
        echo "  2. Press F5 to launch the extension in a new VS Code window"
        echo ""
        
        # Ask if user wants to open in VS Code for development
        read -p "Do you want to open the extension in VS Code now? (y/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "🚀 Opening in VS Code..."
            if [ "$CODE_CLI" = "code" ]; then
                "$CODE_CLI" "$EXTENSION_DIR"
            else
                open -a "Visual Studio Code" "$EXTENSION_DIR"
            fi
        fi
    fi
else
    echo "📝 Manual installation steps:"
    echo ""
    echo "Option 1: Package and install as VSIX"
    echo "  1. Install vsce: npm install -g @vscode/vsce"
    echo "  2. Package: cd $EXTENSION_DIR && vsce package"
    echo "  3. In VS Code: Cmd+Shift+P → 'Extensions: Install from VSIX...'"
    echo "  4. Select the .vsix file"
    echo ""
    echo "Option 2: Development mode"
    echo "  1. Open Visual Studio Code"
    echo "  2. File → Open Folder → Select: $EXTENSION_DIR"
    echo "  3. Press F5 to launch the extension in a new window"
fi

echo ""
echo "================================================"
echo "Installation complete!"
echo "================================================"
