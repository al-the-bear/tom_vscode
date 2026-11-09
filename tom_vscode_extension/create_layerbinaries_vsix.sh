#!/bin/bash

# Package a private-distribution VSIX with every platform's tom_bs and
# validate_codespecs taken from the binaries layer; build nothing with Dart,
# install nothing.
#
#   ./create_layerbinaries_vsix.sh [--layer <dir>] [--clone]
#
# For a machine without a Dart SDK: the extension is built from this source
# (Node.js 20+, npm and git; no Dart step runs even when Dart is installed),
# and the Dart binaries come prebuilt from the binaries layer:
#
#   - the workspace's tom_binaries checkout (../../../tom_binaries), else
#   - --layer <dir>: a tom_binaries checkout (or its tom/ folder), else
#   - --clone, or when neither exists: a shallow clone of the public
#     https://github.com/al-the-bear/tom_binaries into .tom_binaries/ here
#     (refreshed on the next run; gitignored, not in the VSIX).
#
# The layer holds each platform's latest build, published by its host
# (compile_and_install.sh / create_fleetcompiled_vsix.sh). It ends with the
# VSIX path, the template path, the binaries the VSIX carries per platform and
# each binary's build stamp and whether it is older than the sources here
# (scripts/binaries-layer.cjs report; a platform the layer lacks is named).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/install_summary.sh"
PUBLIC_REPO="https://github.com/al-the-bear/tom_binaries.git"

LAYER=""
CLONE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --layer) LAYER="${2:-}"; [ -n "$LAYER" ] || { echo "❌ --layer needs a directory"; exit 1; }; shift 2 ;;
        --clone) CLONE=1; shift ;;
        -h|--help) sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $1 (usage: $0 [--layer <dir>] [--clone])"; exit 1 ;;
    esac
done

if [ -z "$LAYER" ] && [ "$CLONE" != "1" ] && [ -d "$SCRIPT_DIR/../../../tom_binaries/tom" ]; then
    LAYER="$SCRIPT_DIR/../../../tom_binaries"
fi
if [ -z "$LAYER" ]; then
    CLONE_DIR="$SCRIPT_DIR/.tom_binaries"
    if [ -d "$CLONE_DIR/.git" ]; then
        echo "📥 Refreshing the clone of $PUBLIC_REPO..."
        git -C "$CLONE_DIR" fetch --quiet --depth 1 origin
        git -C "$CLONE_DIR" reset --quiet --hard FETCH_HEAD
    else
        echo "📥 Cloning $PUBLIC_REPO (shallow)..."
        rm -rf "$CLONE_DIR"
        git clone --quiet --depth 1 "$PUBLIC_REPO" "$CLONE_DIR"
    fi
    LAYER="$CLONE_DIR"
fi
[ -d "$LAYER/tom" ] && LAYER="$LAYER/tom"
if [ ! -d "$LAYER" ]; then
    echo "❌ No binaries layer at $LAYER"
    exit 1
fi
LAYER="$(cd "$LAYER" && pwd)"
echo "📦 Binaries layer: $LAYER"

export TOM_BINARIES_LAYER="$LAYER"
export TOM_LAYER_BINARIES=1
export TOM_PACKAGE_ONLY=1
export TOM_SKIP_FINISH_TS=1
export TOM_NO_DART=1
export TOM_NO_DART_REASON="create_layerbinaries_vsix: the binaries come from the layer"
"$SCRIPT_DIR/install_extension.sh"

tom_print_layer_vsix_summary "$SCRIPT_DIR" ""
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
