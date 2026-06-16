#!/bin/bash

# Install script for tom_vscode_extension extension

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔧 Installing tom_vscode_extension..."

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    exit 1
fi

CURRENT_NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR_VERSION=$(echo "$CURRENT_NODE_VERSION" | cut -d. -f1)

echo "📋 Current Node.js version: v$CURRENT_NODE_VERSION"

# Check if Node.js version is >= 20
if [ "$NODE_MAJOR_VERSION" -lt 20 ]; then
    echo "⚠️  Node.js version $NODE_MAJOR_VERSION is below the required version 20"
    
    # Check if nvm is installed
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        echo "✅ Node Version Manager (nvm) is installed"
        
        # Load nvm
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        # Check if Node 20 is already installed
        if nvm list | grep -q "v20"; then
            echo "📦 Node.js 20 is already installed, switching to it..."
            nvm use 20
        else
            echo "📦 Installing Node.js 20 (LTS)..."
            nvm install 20
            nvm use 20
        fi
        
        # Get new version
        CURRENT_NODE_VERSION=$(node --version | sed 's/v//')
        echo "✅ Now using Node.js v$CURRENT_NODE_VERSION"
    else
        echo "❌ Error: Node Version Manager (nvm) is not installed"
        echo "Please install Node.js >= 20 or install nvm first"
        exit 1
    fi
else
    echo "✅ Node.js version meets requirements (>= 20)"
fi

echo ""

# Install / update dependencies (incl. the host-platform Claude Agent SDK
# native CLI binary, which ships as an optional dependency).
echo "📦 Installing npm dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install failed"
    exit 1
fi

# Compile TypeScript
echo "📦 Compiling TypeScript..."
npm run compile

if [ $? -ne 0 ]; then
    echo "❌ Compilation failed"
    exit 1
fi

echo ""
echo "✅ Extension compiled successfully!"

# Check if VS Code CLI is available
CODE_CLI=""
if command -v code &> /dev/null; then
    CODE_CLI="code"
else
    echo "⚠️  VS Code CLI not found. Extension compiled but not installed."
    echo "   Press F5 to test in Extension Development Host"
    exit 0
fi

# Check if vsce is available (globally or via npx)
if command -v vsce &> /dev/null; then
    VSCE_CMD="vsce"
else
    echo "📦 Using npx to run @vscode/vsce..."
    VSCE_CMD="npx --yes @vscode/vsce"
fi

# Uninstall old version(s)
echo ""
echo "🗑️  Uninstalling old version..."
"$CODE_CLI" --uninstall-extension tom.dartscript-vscode 2>/dev/null || true
"$CODE_CLI" --uninstall-extension tom.tom-ai-extension 2>/dev/null || true

# Remove old VSIX files to prevent stale packaging
rm -f *.vsix

# ── Bundle bridge binaries ───────────────────────────────────────────────────
# Default: copy prebuilt binaries for all 5 platforms out of the binaries layer
# (tom_binaries). When TOM_BRIDGE_FROM_SOURCE=1 (set by compile_and_install.sh):
# resolve deps, regenerate the d4rt bridges, and compile the bridge for THIS
# host from source — bundling only that one binary, built into the extension's
# local bin/ (never $TOM_BINARY_PATH or a PATH-resolved location).
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TOM_BIN_DIR="$WORKSPACE_ROOT/tom_binaries/tom"
BRIDGE_DIR="$WORKSPACE_ROOT/tom_ai/vscode/tom_vscode_bridge"
BUNDLED_BINARIES="tom_bs"

# Clean previous bin/ to avoid stale binaries
rm -rf "$SCRIPT_DIR/bin"

if [ "${TOM_BRIDGE_FROM_SOURCE:-0}" = "1" ]; then
    if ! command -v dart &> /dev/null; then
        echo "❌ Error: Dart SDK not found — cannot compile the bridge from source"
        exit 1
    fi
    GEN_DIR="$WORKSPACE_ROOT/tom_ai/d4rt/tom_d4rt_generator"
    GEN_PKG_CONFIG="$GEN_DIR/.dart_tool/package_config.json"

    # Map the running host to VS Code's platform-vs naming.
    case "$(uname -s)" in
        Darwin) BRIDGE_OS="darwin" ;;
        Linux)  BRIDGE_OS="linux" ;;
        *)      echo "❌ Unsupported host OS for from-source build: $(uname -s)"; exit 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)   BRIDGE_ARCH="x64" ;;
        arm64|aarch64)  BRIDGE_ARCH="arm64" ;;
        *)              echo "❌ Unsupported host arch for from-source build: $(uname -m)"; exit 1 ;;
    esac
    BRIDGE_PLAT="$BRIDGE_OS-$BRIDGE_ARCH"
    DST_DIR="$SCRIPT_DIR/bin/$BRIDGE_PLAT"
    mkdir -p "$DST_DIR"

    # 1) Resolve dependencies for both the generator and the bridge.
    echo "📦 Resolving Dart dependencies (generator + bridge)..."
    ( cd "$GEN_DIR" && dart pub get )
    ( cd "$BRIDGE_DIR" && dart pub get )

    # 2) Regenerate the d4rt bridges for the bridge package. d4rtgen processes
    #    the project in its current directory, so run it from the bridge dir;
    #    --packages runs the generator's entrypoint directly from its source,
    #    without requiring it on PATH or as a dependency of the bridge.
    echo "📦 Regenerating d4rt bridges..."
    ( cd "$BRIDGE_DIR" && dart --packages="$GEN_PKG_CONFIG" "$GEN_DIR/bin/d4rtgen.dart" )

    # 3) Compile the bridge binary for THIS host straight into the extension's
    #    local bin/ — no $TOM_BINARY_PATH, no PATH lookup, no shared location.
    echo "📦 Compiling bridge binary from source for $BRIDGE_PLAT ..."
    for BIN in $BUNDLED_BINARIES; do
        ( cd "$BRIDGE_DIR" && dart compile exe "bin/${BIN}.dart" -o "$DST_DIR/${BIN}" )
        chmod +x "$DST_DIR/${BIN}"
        echo "  ✔ $BRIDGE_PLAT/${BIN} (from source)"
    done
else
    echo "📦 Bundling bridge binaries..."
    TOTAL_BUNDLED=0
    for PLAT_SPEC in "darwin-arm64:" "darwin-x64:" "linux-x64:" "linux-arm64:" "win32-x64:.exe"; do
        PLAT_ID="${PLAT_SPEC%%:*}"
        PLAT_EXT="${PLAT_SPEC#*:}"
        SRC_DIR="$TOM_BIN_DIR/$PLAT_ID"
        DST_DIR="$SCRIPT_DIR/bin/$PLAT_ID"
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
                echo "  ✔ $PLAT_ID/${BIN}${PLAT_EXT}"
            else
                echo "  ⚠️  Missing: $PLAT_ID/${BIN}${PLAT_EXT}"
            fi
        done
    done
    echo "  Bundled $TOTAL_BUNDLED binaries across 5 platforms"
fi

# ── Ensure Claude Agent SDK native CLI binary for THIS host ──────────────────
# Since SDK >=0.2.13x the Claude CLI ships as a platform-specific native binary
# via optional deps (@anthropic-ai/claude-agent-sdk-<platform>) rather than a
# bundled cli.js. `vsce package` only includes what is physically present in
# node_modules, so a vsix is portable only for the host it was built on. We
# build and install on the same machine, so we only ensure the host binary is
# present. Older SDKs that still bundle cli.js need nothing. Missing it yields:
#   "Native CLI binary for <platform>-<arch> not found ..."
echo ""
echo "📦 Ensuring Claude Agent SDK native CLI binary for this host..."
SDK_PKG_DIR="$SCRIPT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
if [ -f "$SDK_PKG_DIR/cli.js" ]; then
    echo "  ✔ SDK bundles cli.js — no per-platform binary needed"
elif [ -d "$SDK_PKG_DIR" ]; then
    # Map the running host to the SDK's platform package suffix.
    case "$(uname -s)" in
        Linux)  SDK_OS="linux" ;;
        Darwin) SDK_OS="darwin" ;;
        *)      SDK_OS="unknown" ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)   SDK_ARCH="x64" ;;
        arm64|aarch64)  SDK_ARCH="arm64" ;;
        *)              SDK_ARCH="unknown" ;;
    esac
    HOST_PLAT="$SDK_OS-$SDK_ARCH"
    # musl libc (e.g. Alpine) uses a distinct binary package.
    if [ "$SDK_OS" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
        HOST_PLAT="$HOST_PLAT-musl"
    fi
    SDK_VER="$(node -p "require('$SDK_PKG_DIR/package.json').version")"
    HOST_PKG="@anthropic-ai/claude-agent-sdk-$HOST_PLAT"
    if [ -d "$SCRIPT_DIR/node_modules/@anthropic-ai/claude-agent-sdk-$HOST_PLAT" ]; then
        echo "  ✔ $HOST_PKG already present"
    else
        echo "  ⬇  installing $HOST_PKG@$SDK_VER ..."
        # --no-save / --no-package-lock keep the committed manifests untouched;
        # we only need the binary physically in node_modules for packaging.
        if npm install --no-save --no-package-lock "$HOST_PKG@$SDK_VER"; then
            echo "  ✔ $HOST_PKG@$SDK_VER"
        else
            echo "  ❌ Failed to install $HOST_PKG@$SDK_VER"
            echo "     The packaged extension will fail at runtime on this host."
            exit 1
        fi
    fi
else
    echo "  ⚠️  @anthropic-ai/claude-agent-sdk not found in node_modules — run 'npm install' first"
fi

# Package as VSIX
echo ""
echo "📦 Packaging extension as VSIX..."
$VSCE_CMD package --allow-missing-repository --skip-license --baseContentUrl https://github.com/al-the-bear/tom/blob/main/tom_vscode_extension

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
            echo "🔄 Reloading VS Code window..."
            echo "   Please manually reload: Cmd+Shift+P → 'Developer: Reload Window'"
        else
            echo "❌ Failed to install extension"
            exit 1
        fi
    else
        echo "❌ Could not find generated VSIX file"
        exit 1
    fi
else
    echo "❌ Failed to package extension"
    exit 1
fi
