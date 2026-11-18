#!/bin/bash

# Package the private-distribution VSIX files with this host's binaries built now and
# every other platform's as the binaries layer holds them; install nothing.
#
# One VSIX per platform the layer has (darwin-arm64, linux-x64, win32-x64):
# tom-ai-extension-<platform>.vsix, packed with `vsce package --target`, each
# with only that platform's Dart binaries and build tools (TOM_SPLIT_PLATFORMS=1,
# scripts/vsix-split.cjs). VS Code installs each only on its own platform.
#
#   ./create_currentbinaries_vsix.sh [--no-release]
#
# 1. Builds tom_bs and tomspecs for THIS host and puts them into the
#    binaries layer, tom_binaries/tom/<platform>/ (compile_and_install.sh
#    --binaries-only: committed there and pushed; a refused push stays a local
#    commit). A Dart SDK is needed; without one use create_vsix_nodart.sh.
# 2. Packages the VSIX through install_extension.sh --package-only, taking
#    tom_bs and tomspecs for every platform from the layer
#    (TOM_LAYER_BINARIES=1), with the workspace template, as create_vsix.sh
#    (no provider SDK: the extension installs them on request).
# Every run publishes the VSIX files as the GitHub Release `vscode-extension-latest` of
# al-the-bear/tom_binaries (one asset per platform, tom-ai-extension-<platform>.vsix, with
# vscode_extension/vsix/README.md there; scripts/vsix-release.cjs) when the
# tom_vscode checkout has no local change and no unpushed commit; --no-release
# skips it. The VSIX files also stay here for a local install.
# It ends with the VSIX paths, the template path, the binaries each VSIX carries
# per platform and, per platform, each binary's build stamp and whether it is
# older than the sources here (scripts/binaries-layer.cjs report). A platform
# whose binaries are older is rebuilt by its own host (compile_and_install.sh
# there, or create_fleetcompiled_vsix.sh on a reconciled fleet).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

NO_RELEASE=0
for ARG in "$@"; do
    case "$ARG" in
        --no-release) NO_RELEASE=1 ;;
        -h|--help) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-release])"; exit 1 ;;
    esac
done
RELEASE_PRECHECK="$(tom_release_precheck "$SCRIPT_DIR" "$NO_RELEASE")"

if ! ( cd "$SCRIPT_DIR" && node scripts/find-dart.cjs > /dev/null ); then
    echo "❌ No Dart SDK found: this host's binaries cannot be built (create_vsix_nodart.sh packages without them)."
    exit 1
fi

echo "──────── 1/2 This host's binaries into the binaries layer ────────"
"$SCRIPT_DIR/compile_and_install.sh" --binaries-only

echo ""
echo "──────── 2/2 The VSIX, with every platform's binaries from the layer ────────"
export TOM_LAYER_BINARIES=1
export TOM_PACKAGE_ONLY=1
# One VSIX per platform, each with only its own binaries and build tools.
export TOM_SPLIT_PLATFORMS=1
export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

tom_print_layer_vsix_summary "$SCRIPT_DIR" ""
tom_release_publish "$SCRIPT_DIR" "$(tom_platform_vsixes "$SCRIPT_DIR")" "$(basename "$0")" "$RELEASE_PRECHECK" "$NO_RELEASE"
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
exit 0
