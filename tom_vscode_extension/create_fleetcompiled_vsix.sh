#!/bin/bash

# Package the private-distribution VSIX files whose binaries are all built now, each on
# its own platform's fleet host; install nothing.
#
# One VSIX per platform the layer has (darwin-arm64, linux-x64, win32-x64):
# tom-ai-extension-<platform>.vsix, packed with `vsce package --target`, each
# with only that platform's Dart binaries and build tools (TOM_SPLIT_PLATFORMS=1,
# scripts/vsix-split.cjs). VS Code installs each only on its own platform.
#
#   ./create_fleetcompiled_vsix.sh [--dry-run] [--hosts mbp,bigbeast,...] [--no-release]
#
# Run it on a reconciled, quiet fleet (the reconcile is yours to start; this
# script never reconciles or pulls a host):
# 1. scripts/fleet-binaries.cjs checks that every build host of the
#    fleet_hosts registry (darwin-arm64 mbp, linux-x64 bigbeast, win32-x64
#    legiondary01) is reached and at this host's commits, then runs
#    compile_and_install --binaries-only on each (this host first; over SSH,
#    on Windows through PowerShell). Each builds tom_bs and validate_codespecs,
#    fast-forwards its binaries layer, commits its platform's binaries there
#    and pushes; this host's layer is then fast-forwarded to hold them all.
#    --dry-run stops after the check; --hosts builds on those hosts only (the
#    others' binaries are packaged as the layer holds them).
# 2. Packages the VSIX through install_extension.sh --package-only, taking
#    tom_bs and validate_codespecs for darwin-arm64, linux-x64 and win32-x64
#    from the layer, with the workspace template, as create_vsix.sh (no
#    provider SDK: the extension installs them on request).
# Every run publishes the VSIX files as the GitHub Release `vscode-extension-latest` of
# al-the-bear/tom_binaries (one asset per platform, tom-ai-extension-<platform>.vsix, with
# vscode_extension/vsix/README.md there; scripts/vsix-release.cjs) when the
# tom_vscode checkout has no local change and no unpushed commit; --no-release
# skips it. The VSIX files also stay here for a local install.
# It ends with the VSIX paths, the template path, the binaries each VSIX carries
# per platform and each binary's build stamp and freshness
# (scripts/binaries-layer.cjs report).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

FLEET_ARGS=()
DRY_RUN=0
NO_RELEASE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; FLEET_ARGS+=(--dry-run) ;;
        --no-release) NO_RELEASE=1 ;;
        --hosts) [ -n "${2:-}" ] || { echo "❌ --hosts needs a list (mbp,bigbeast,...)"; exit 1; }; FLEET_ARGS+=(--hosts "$2"); shift ;;
        -h|--help) sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $1 (usage: $0 [--dry-run] [--hosts mbp,bigbeast,...] [--no-release])"; exit 1 ;;
    esac
    shift
done
RELEASE_PRECHECK="$(tom_release_precheck "$SCRIPT_DIR" "$NO_RELEASE")"

echo "──────── 1/2 Binaries on every fleet build host ────────"
( cd "$SCRIPT_DIR" && node scripts/fleet-binaries.cjs "${FLEET_ARGS[@]}" )
[ "$DRY_RUN" = "1" ] && exit 0

PLATFORMS="$(cd "$SCRIPT_DIR" && node scripts/fleet-binaries.cjs --print-platforms)"
echo ""
echo "──────── 2/2 The VSIX, with the fleet's binaries from the layer ────────"
export TOM_LAYER_BINARIES=1
export TOM_LAYER_PLATFORMS="$PLATFORMS"
export TOM_PACKAGE_ONLY=1
# One VSIX per platform, each with only its own binaries and build tools.
export TOM_SPLIT_PLATFORMS=1
export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

tom_print_layer_vsix_summary "$SCRIPT_DIR" "$PLATFORMS"
tom_release_publish "$SCRIPT_DIR" "$(tom_platform_vsixes "$SCRIPT_DIR")" "$(basename "$0")" "$RELEASE_PRECHECK" "$NO_RELEASE"
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
exit 0
