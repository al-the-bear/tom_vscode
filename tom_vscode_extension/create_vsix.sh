#!/bin/bash

# Package a private-distribution VSIX: build everything, install nothing.
#
#   ./create_vsix.sh [--no-dart] [--no-release]
#
# The VSIX carries:
#   - tom_bs and validate_codespecs for THIS host's platform (compiled from
#     source, as compile_and_install.sh; a Dart binary cannot be built for
#     another platform);
#   - the workspace template (resources/workspace_template.zip), which
#     @T: Setup New Workspace Folder unpacks; a copy is written beside the VSIX.
# --no-dart (create_vsix_nodart.sh) builds without the Dart binaries.
#
# No provider SDK: the extension installs them on request (Provider SDKs page).
# Every run publishes the VSIX as the GitHub Release `vscode-extension-latest` of
# al-the-bear/tom_binaries (asset tom-ai-extension.vsix, with
# vscode_extension/vsix/README.md there; scripts/vsix-release.cjs) when the
# tom_vscode checkout has no local change and no unpushed commit; --no-release
# skips it. The VSIX also stays here for a local install.
# A thin wrapper over install_extension.sh (TOM_BRIDGE_FROM_SOURCE=1,
# TOM_PACKAGE_ONLY=1); it ends with the VSIX path, the
# template path and the binaries the VSIX carries per platform.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

NO_DART_ON_PURPOSE=0
NO_RELEASE=0
for ARG in "$@"; do
    case "$ARG" in
        --no-dart) NO_DART_ON_PURPOSE=1 ;;
        --no-release) NO_RELEASE=1 ;;
        -h|--help) sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-dart] [--no-release])"; exit 1 ;;
    esac
done
# The release must name a commit anyone can check out: checked before anything is built.
RELEASE_PRECHECK="$(tom_release_precheck "$SCRIPT_DIR" "$NO_RELEASE")"
RELEASE_SCRIPT="${TOM_RELEASE_SCRIPT:-$(basename "$0")}"

export TOM_BRIDGE_FROM_SOURCE=1
export TOM_PACKAGE_ONLY=1

# Settle the no-Dart mode here, so this wrapper and install_extension.sh agree
# on it. On purpose (--no-dart) it is a plain note at the end; without a Dart
# SDK found it is the red warning, as in compile_and_install.sh.
if [ "$NO_DART_ON_PURPOSE" = "1" ]; then
    export TOM_NO_DART=1
    export TOM_NO_DART_REASON="--no-dart given"
elif [ "${TOM_NO_DART:-0}" = "1" ]; then
    export TOM_NO_DART_REASON="${TOM_NO_DART_REASON:-TOM_NO_DART=1}"
elif ! ( cd "$SCRIPT_DIR" && node scripts/find-dart.cjs > /dev/null ); then
    export TOM_NO_DART=1
    export TOM_NO_DART_REASON="no Dart SDK found"
fi

export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

VSIX="$(tom_newest_vsix "$SCRIPT_DIR")"
echo ""
echo "──────── Private distribution VSIX ────────"
tom_print_vsix_path "$SCRIPT_DIR"
[ -n "$VSIX" ] && ( cd "$SCRIPT_DIR" && node scripts/check-vsix-contents.cjs "$VSIX" | sed -n '2,$p' )
PLATFORM="$(node -p "process.platform + '-' + process.arch")"
if [ "${TOM_NO_DART:-0}" != "1" ]; then
    echo "ℹ️  tom_bs and validate_codespecs are in this VSIX for $PLATFORM only: a Dart binary"
    echo "   cannot be built for another platform. Elsewhere the extension says what is missing"
    echo "   and how to add it (@T: Missing Dart Binaries)."
elif [ "$NO_DART_ON_PURPOSE" = "1" ]; then
    echo "ℹ️  Built without the Dart binaries (--no-dart): no DartScript and no CodeSpecs"
    echo "   validation on any platform; everything else works."
else
    tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
fi
tom_release_publish "$SCRIPT_DIR" "$VSIX" "$RELEASE_SCRIPT" "$RELEASE_PRECHECK" "$NO_RELEASE"
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
if [ "${TOM_NO_DART:-0}" = "1" ] && [ "$NO_DART_ON_PURPOSE" != "1" ]; then
    tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
fi
exit 0
