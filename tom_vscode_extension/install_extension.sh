#!/bin/bash

# Install script for tom_vscode_extension extension
#
#   ./install_extension.sh [--no-dart] [--all-platforms]
#
# --no-dart builds as on a machine without a Dart SDK (also TOM_NO_DART=1):
# no Dart step runs, and the VSIX carries no validate_codespecs and, from
# source, no tom_bs. Without the option the same happens when no Dart SDK is
# found (scripts/find-dart.cjs). The extension then loses only DartScript and
# CodeSpecs validation; everything else works.
# --all-platforms (also TOM_ALL_PLATFORMS=1) bundles the Agent SDK's Claude CLI
# for darwin-arm64, linux-x64 and win32-x64, not only for this host, so the
# Agent SDK transport also runs where the VSIX is installed on another
# platform (about 110 MB more per platform).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

for ARG in "$@"; do
    case "$ARG" in
        --no-dart) export TOM_NO_DART=1; TOM_NO_DART_REASON="${TOM_NO_DART_REASON:---no-dart given}" ;;
        --all-platforms) export TOM_ALL_PLATFORMS=1 ;;
        -h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-dart] [--all-platforms])"; exit 1 ;;
    esac
done
ALL_PLATFORMS="${TOM_ALL_PLATFORMS:-0}"
NO_DART="${TOM_NO_DART:-0}"
[ "$NO_DART" = "1" ] && TOM_NO_DART_REASON="${TOM_NO_DART_REASON:-TOM_NO_DART=1}"
FROM_SOURCE="${TOM_BRIDGE_FROM_SOURCE:-0}"

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

# The Dart SDK: validate_codespecs (and, from source, tom_bs) are compiled
# below. Find it now — also when `dart` is not on PATH (Flutter's Dart,
# DART_SDK, FLUTTER_ROOT, known locations; scripts/find-dart.cjs). Without one
# the install goes on in no-Dart mode: every Dart step is skipped, and the
# closing warning says what the VSIX lacks.
if [ "$NO_DART" = "1" ]; then
    echo "⚠️  No-Dart mode ($TOM_NO_DART_REASON): the Dart steps are skipped."
else
    echo "🔎 Looking for the Dart SDK..."
    if DART_DIR="$(node scripts/find-dart.cjs)"; then
        export PATH="$DART_DIR:$PATH"
        echo "✅ Dart SDK: $DART_DIR"
    else
        NO_DART=1
        export TOM_NO_DART=1
        TOM_NO_DART_REASON="no Dart SDK found"
        echo "⚠️  No Dart SDK found: building without DartScript and CodeSpecs validation (see the warning at the end)."
    fi
fi
echo ""

# From source: the bridge is compiled against its pubspec.lock, which is
# machine-local and which `dart pub get` never moves. A lock behind the tom_*
# releases the regenerated bridges need fails only at `dart compile exe`, after
# the whole build — so upgrade the bridge's frozen tom_* packages now, in
# seconds (pub.dev, else the pub cache; scripts/bridge-lock-preflight.cjs).
if [ "$FROM_SOURCE" = "1" ] && [ "$NO_DART" != "1" ]; then
    echo "🔎 Checking the bridge's tom_* resolutions..."
    node scripts/bridge-lock-preflight.cjs --fix || exit 1
    echo ""
fi

# Build the TomSpecs SOM TypeScript pair (tom_ai/ai_build) into the two
# tarballs package.json depends on. Must run before `npm install`: the VSIX has
# to carry real copies of both packages, never a link into ai_build.
echo "📦 Building the TomSpecs SOM packages..."
node scripts/build-som-packages.cjs
if [ $? -ne 0 ]; then
    echo "❌ Building the TomSpecs SOM packages failed"
    exit 1
fi

# Install / update dependencies (incl. the host-platform Claude Agent SDK
# native CLI binary, which ships as an optional dependency).
echo "📦 Installing npm dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install failed"
    exit 1
fi

# The model just packed must be the one installed: npm can keep a stale
# tarball, and the extension would then ship an old TomSpecs model.
node scripts/check-som-installed.cjs || exit 1

# Compile TypeScript
echo "📦 Compiling TypeScript..."
npm run compile

if [ $? -ne 0 ]; then
    echo "❌ Compilation failed"
    exit 1
fi

echo ""
echo "✅ Extension compiled successfully!"

# The VS Code CLI installs the VSIX. Without it the VSIX is still built (its
# path is printed at the end), only the install is skipped.
CODE_CLI=""
if command -v code &> /dev/null; then
    CODE_CLI="code"
else
    echo "⚠️  VS Code CLI \`code\` not found: the VSIX is built but not installed."
fi

# Check if vsce is available (globally or via npx)
if command -v vsce &> /dev/null; then
    VSCE_CMD="vsce"
else
    echo "📦 Using npx to run @vscode/vsce..."
    VSCE_CMD="npx --yes @vscode/vsce"
fi

# Uninstall old version(s)
if [ -n "$CODE_CLI" ]; then
    echo ""
    echo "🗑️  Uninstalling old version..."
    "$CODE_CLI" --uninstall-extension tom.dartscript-vscode 2>/dev/null || true
    "$CODE_CLI" --uninstall-extension tom.tom-ai-extension 2>/dev/null || true
fi

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

if [ "$FROM_SOURCE" = "1" ] && [ "$NO_DART" = "1" ]; then
    # Without Dart there is nothing to compile tom_bs with: this VSIX carries no
    # bridge for the host, and the extension runs without DartScript.
    echo "📦 No Dart: no tom_bs is built for this host (DartScript will not be available)."
elif [ "$FROM_SOURCE" = "1" ]; then
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

    # 1) Versioner: increment the bridge build number and (re)generate
    #    lib/src/version.versioner.dart (compilation fails if it's missing).
    #    The versioner lives only inside buildkit, so prefer a prebuilt
    #    buildkit binary (PATH, then the tom_binaries layer); fall back to
    #    running it from buildkit's source via `dart run` so a fresh checkout
    #    with only the Dart SDK still works. `-R --project` targets the bridge
    #    from the workspace root without cd-ing into it.
    echo "📦 Running versioner (build number + version.versioner.dart)..."
    BUILDKIT_BIN=""
    if command -v buildkit &> /dev/null; then
        BUILDKIT_BIN="buildkit"
    elif [ -n "${TOM_BINARY_PATH:-}" ] && [ -x "$TOM_BINARY_PATH/$BRIDGE_PLAT/buildkit" ]; then
        BUILDKIT_BIN="$TOM_BINARY_PATH/$BRIDGE_PLAT/buildkit"
    elif [ -x "$HOME/tac/tom_binaries/tom/$BRIDGE_PLAT/buildkit" ]; then
        BUILDKIT_BIN="$HOME/tac/tom_binaries/tom/$BRIDGE_PLAT/buildkit"
    fi
    if [ -n "$BUILDKIT_BIN" ]; then
        ( cd "$WORKSPACE_ROOT" && "$BUILDKIT_BIN" -R --project tom_vscode_bridge :versioner )
    else
        echo "  ℹ buildkit binary not found — running versioner from source"
        BUILDKIT_DIR="$WORKSPACE_ROOT/tom_ai/basics/tom_build_kit"
        ( cd "$BUILDKIT_DIR" && dart pub get )
        ( cd "$WORKSPACE_ROOT" && dart --packages="$BUILDKIT_DIR/.dart_tool/package_config.json" "$BUILDKIT_DIR/bin/buildkit.dart" -R --project tom_vscode_bridge :versioner )
    fi

    # 2) Resolve dependencies for both the generator and the bridge.
    echo "📦 Resolving Dart dependencies (generator + bridge)..."
    ( cd "$GEN_DIR" && dart pub get )
    ( cd "$BRIDGE_DIR" && dart pub get )

    # 3) Regenerate the d4rt bridges for the bridge package. d4rtgen processes
    #    the project in its current directory, so run it from the bridge dir;
    #    --packages runs the generator's entrypoint directly from its source,
    #    without requiring it on PATH or as a dependency of the bridge.
    echo "📦 Regenerating d4rt bridges..."
    ( cd "$BRIDGE_DIR" && dart --packages="$GEN_PKG_CONFIG" "$GEN_DIR/bin/d4rtgen.dart" )

    # 4) Compile the bridge binary for THIS host straight into the extension's
    #    local bin/ — no $TOM_BINARY_PATH, no PATH lookup, no shared location.
    echo "📦 Compiling bridge binary from source for $BRIDGE_PLAT ..."
    for BIN in $BUNDLED_BINARIES; do
        ( cd "$BRIDGE_DIR" && dart compile exe "bin/${BIN}.dart" -o "$DST_DIR/${BIN}" )
        chmod +x "$DST_DIR/${BIN}"
        echo "  ✔ $BRIDGE_PLAT/${BIN} (from source)"
    done

    # 5) The regeneration and the versioner leave tracked files modified on
    #    every build. Put back what changed only by its time stamp (the
    #    bridges' `// Generated:` line, the version stamp when the version is
    #    the same); name what really changed, to be committed with the bridge.
    echo "📦 Checking what the regeneration changed..."
    node "$SCRIPT_DIR/scripts/bridge-generated-churn.cjs" "$BRIDGE_DIR"
else
    echo "📦 Bundling bridge binaries..."
    # The prebuilt tom_bs binaries are not rebuilt: compile_and_install.sh is
    # the install route on every host, and this one serves a machine without
    # the d4rt and bridge checkouts.
    echo "  ℹ The prebuilt tom_bs binaries in tom_binaries are not kept current; compile_and_install.sh builds a current one for this host."
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
    # The prebuilt binaries are only as fresh as the bridges they were built
    # from. With Dart at hand, say when the committed bridges lag behind the
    # scripting API (BRIDGE-FRESH-01, ~6 s); a warning, not a stop.
    if [ "$NO_DART" != "1" ] && command -v dart &> /dev/null; then
        # The bridge's lock decides what the bridge's tests run against: name
        # frozen tom_* resolutions (a warning; from source upgrades them).
        echo "📦 Checking the bridge's tom_* resolutions..."
        ( cd "$SCRIPT_DIR" && node scripts/bridge-lock-preflight.cjs --warn ) || true
        echo "📦 Checking that the committed d4rt bridges are fresh..."
        ( cd "$SCRIPT_DIR" && node scripts/check-bridge-fresh.cjs > /dev/null 2>&1 ) \
            && echo "  ✔ the committed bridges match the scripting API" \
            || echo "  ⚠️  The committed bridges of tom_vscode_bridge are stale or could not be checked (npm run check:bridges): tom_bs may lack scripting-API members. compile_and_install.sh rebuilds them."
    fi
    # Which bridge source the host's prebuilt tom_bs was built from (the
    # versioner stamp it prints on start), against the committed bridge sources:
    # a warning when it is older; compile_and_install.sh builds a fresh one.
    echo "📦 Checking which bridge source the prebuilt tom_bs was built from..."
    ( cd "$SCRIPT_DIR" && node scripts/check-tom-bs-provenance.cjs ) | sed 's/^/  /' || true
fi

# ── Bundle validate_codespecs for THIS host ──────────────────────────────────
# The CodeSpecs tools (validate, trace over a trio) run tom_specs_clitool's
# validate_codespecs as a compiled binary from bin/<platform>/ — never via
# `dart run`. It is compiled here from tom_ai/ai_build, like tom_bs above in
# from-source mode, with the Dart SDK found at the start of this script.
# Without Dart the VSIX carries none and CodeSpecs validation is unavailable.
if [ "$NO_DART" = "1" ]; then
    echo "📦 No Dart: validate_codespecs is not built (CodeSpecs validation will not be available)."
else
    ( cd "$SCRIPT_DIR" && node scripts/build-validate-codespecs.cjs ) || {
        echo "❌ Error: building validate_codespecs failed"
        exit 1
    }
fi

# ── Claude Agent SDK native CLI: this host's, or the fleet's ──────────────────
# Since SDK >=0.2.13x the Claude CLI ships as a platform-specific native binary
# via optional deps (@anthropic-ai/claude-agent-sdk-<platform>) rather than a
# bundled cli.js. `vsce package` only includes what is physically present in
# node_modules, and only the host's package may be there (vsce's `npm list`
# refuses another platform's as invalid), so by default the VSIX runs the Agent
# SDK transport only on this platform; elsewhere the transport says the CLI is
# missing (resources/agent_sdk/missing_agent_sdk_cli.md). With --all-platforms
# the fleet's other CLIs (darwin-arm64, linux-x64, win32-x64) are fetched with
# `npm pack` (no platform check) into .cache/agent-sdk-cli/ and bundled as
# bin/<platform>/claude[.exe], which the transport hands to the SDK
# (pathToClaudeCodeExecutable). bin/ was emptied above, so a default build
# carries none of them. Older SDKs that still bundle cli.js need nothing.
echo ""
if [ "$ALL_PLATFORMS" = "1" ]; then
    echo "📦 Ensuring the Claude Agent SDK native CLI for this host and the fleet (--all-platforms)..."
else
    echo "📦 Ensuring the Claude Agent SDK native CLI for this host (only; --all-platforms adds the fleet's)..."
fi
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
    # Only the host's package: another platform's would fail vsce's npm list.
    for DIR in "$SCRIPT_DIR"/node_modules/@anthropic-ai/claude-agent-sdk-*; do
        [ -d "$DIR" ] || continue
        PLAT="${DIR##*/claude-agent-sdk-}"
        if [ "$PLAT" != "$HOST_PLAT" ]; then
            rm -rf "$DIR"
            echo "  🗑  removed the $PLAT package (only the host's may be in node_modules)"
        fi
    done
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
    if [ "$ALL_PLATFORMS" = "1" ]; then
        CLI_CACHE="$SCRIPT_DIR/.cache/agent-sdk-cli"
        mkdir -p "$CLI_CACHE"
        for PLAT in darwin-arm64 linux-x64 win32-x64; do
            [ "$PLAT" = "$HOST_PLAT" ] && continue
            EXE=""
            case "$PLAT" in win32-*) EXE=".exe" ;; esac
            PKG="@anthropic-ai/claude-agent-sdk-$PLAT@$SDK_VER"
            TGZ="$CLI_CACHE/anthropic-ai-claude-agent-sdk-$PLAT-$SDK_VER.tgz"
            if [ ! -f "$TGZ" ]; then
                echo "  ⬇  fetching $PKG ..."
                ( cd "$CLI_CACHE" && npm pack "$PKG" --silent > /dev/null ) || {
                    echo "  ❌ Failed to fetch $PKG"
                    exit 1
                }
            fi
            UNPACK="$CLI_CACHE/unpacked-$PLAT"
            rm -rf "$UNPACK" && mkdir -p "$UNPACK"
            tar -xzf "$TGZ" -C "$UNPACK"
            mkdir -p "$SCRIPT_DIR/bin/$PLAT"
            cp "$UNPACK/package/claude$EXE" "$SCRIPT_DIR/bin/$PLAT/claude$EXE"
            chmod +x "$SCRIPT_DIR/bin/$PLAT/claude$EXE"
            rm -rf "$UNPACK"
            echo "  ✔ bin/$PLAT/claude$EXE ($PKG)"
        done
    fi
else
    echo "  ⚠️  @anthropic-ai/claude-agent-sdk not found in node_modules — run 'npm install' first"
fi

# Package as VSIX
echo ""
echo "📦 Packaging extension as VSIX..."
# The README's relative links are rewritten against the package's folder in its
# repository (package.json `repository`; vsce itself would drop the folder).
$VSCE_CMD package --skip-license --baseContentUrl "$(node scripts/vsix-base-url.cjs content)" --baseImagesUrl "$(node scripts/vsix-base-url.cjs images)"

if [ $? -eq 0 ]; then
    # Find the generated VSIX file
    VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -n 1)
    
    if [ -n "$VSIX_FILE" ]; then
        echo ""
        echo "✅ Package created: $VSIX_FILE"
        # The VSIX must be self-contained: SOM packages as real files, no symlinks.
        if ! node scripts/check-vsix-contents.cjs "$VSIX_FILE"; then
            echo "❌ The VSIX is not self-contained; not installing it"
            exit 1
        fi
        if [ -n "$CODE_CLI" ]; then
            echo ""
            echo "🚀 Installing extension in VS Code..."
            if "$CODE_CLI" --install-extension "$VSIX_FILE"; then
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
            echo ""
            echo "⚠️  Not installed: VS Code CLI \`code\` not found (install the VSIX by hand, path below)."
        fi
    else
        echo "❌ Could not find generated VSIX file"
        exit 1
    fi
else
    echo "❌ Failed to package extension"
    exit 1
fi

# The closing lines: the VSIX path, the no-Dart warning, the finish time and
# the warning again, so it is the last thing on screen. A wrapper
# (compile_and_install.sh) sets TOM_SKIP_FINISH_TS=1 and prints them itself,
# so they appear once.
if [ "${TOM_SKIP_FINISH_TS:-0}" != "1" ]; then
    tom_print_vsix_path "$SCRIPT_DIR"
    [ "$NO_DART" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" "$FROM_SOURCE"
    echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
    [ "$NO_DART" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" "$FROM_SOURCE"
fi
exit 0
