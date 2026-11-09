#!/bin/bash

# Package a private-distribution VSIX with this host's binaries built now and
# every other platform's as the binaries layer holds them; install nothing.
#
#   ./create_currentbinaries_vsix.sh
#
# 1. Builds tom_bs and validate_codespecs for THIS host and puts them into the
#    binaries layer, tom_binaries/tom/<platform>/ (compile_and_install.sh
#    --binaries-only: committed there and pushed; a refused push stays a local
#    commit). A Dart SDK is needed; without one use create_vsix_nodart.sh.
# 2. Packages the VSIX through install_extension.sh --package-only, taking
#    tom_bs and validate_codespecs for every platform from the layer
#    (TOM_LAYER_BINARIES=1), with the workspace template, as create_vsix.sh
#    (no provider SDK: the extension installs them on request).
# It ends with the VSIX path, the template path, the binaries the VSIX carries
# per platform and, per platform, each binary's build stamp and whether it is
# older than the sources here (scripts/binaries-layer.cjs report). A platform
# whose binaries are older is rebuilt by its own host (compile_and_install.sh
# there, or create_fleetcompiled_vsix.sh on a reconciled fleet).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

for ARG in "$@"; do
    case "$ARG" in
        -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0)"; exit 1 ;;
    esac
done

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
export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

tom_print_layer_vsix_summary "$SCRIPT_DIR" ""
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
exit 0
