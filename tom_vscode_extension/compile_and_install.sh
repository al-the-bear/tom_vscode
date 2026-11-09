#!/bin/bash

# Compile the bridge binary for the LOCAL platform from source, then build and
# install the extension bundling only that single host-platform executable.
#
#   ./compile_and_install.sh [--no-dart] [--binaries-only] [--no-layer]
#
# --no-dart builds as on a machine without a Dart SDK (also TOM_NO_DART=1): no
# tom_bs and no validate_codespecs are built, so the VSIX lacks DartScript and
# CodeSpecs validation. The same happens when no Dart SDK is found. The VSIX
# path is printed at the end, to install it on other machines.
# The binaries it builds also go into the binaries layer,
# tom_binaries/tom/<platform>/ (committed there and pushed), so the layer holds
# the latest build of every host; --no-layer (also TOM_NO_LAYER=1) skips that.
# --binaries-only builds tom_bs and validate_codespecs, puts them into the layer
# and stops: no VSIX, nothing installed (create_fleetcompiled_vsix.sh runs it on
# every fleet host).
#
# Thin wrapper over install_extension.sh: TOM_BRIDGE_FROM_SOURCE=1 switches the
# bundling step from "copy all prebuilt platforms out of tom_binaries" to
# "run the versioner, resolve deps, regenerate the d4rt bridges, and dart
# compile exe the bridge for this host only" — built straight into the
# extension's local bin/, with no reliance on $TOM_BINARY_PATH or any tool on
# PATH. Everything else (Node check, npm install, TypeScript compile, the
# workspace template, vsce package, install) is shared with
# install_extension.sh.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

export TOM_BRIDGE_FROM_SOURCE=1

for ARG in "$@"; do
    case "$ARG" in
        --no-dart) export TOM_NO_DART=1; export TOM_NO_DART_REASON="--no-dart given" ;;
        --binaries-only) export TOM_BINARIES_ONLY=1 ;;
        --no-layer) export TOM_NO_LAYER=1 ;;
        -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-dart] [--binaries-only] [--no-layer])"; exit 1 ;;
    esac
done

# Settle the no-Dart mode here, so this wrapper and install_extension.sh agree
# on it (the closing warning is printed here).
if [ "${TOM_NO_DART:-0}" = "1" ]; then
    export TOM_NO_DART_REASON="${TOM_NO_DART_REASON:-TOM_NO_DART=1}"
elif ! ( cd "$SCRIPT_DIR" && node scripts/find-dart.cjs > /dev/null ); then
    export TOM_NO_DART=1
    export TOM_NO_DART_REASON="no Dart SDK found"
fi

if [ "${TOM_BINARIES_ONLY:-0}" = "1" ] && [ "${TOM_NO_DART:-0}" = "1" ]; then
    echo "❌ --binaries-only needs a Dart SDK ($TOM_NO_DART_REASON)"
    exit 1
fi

# Own the closing lines so they reflect this wrapper's completion and print
# exactly once (install_extension.sh skips its own when this is set). Not
# `exec`, so control returns here; set -e propagates a base-script failure
# before them, keeping them a success-only marker.
export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

if [ "${TOM_BINARIES_ONLY:-0}" = "1" ]; then
    ( cd "$SCRIPT_DIR" && node scripts/binaries-layer.cjs report --platforms "$(node -p "process.platform + '-' + process.arch")" )
    echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
    exit 0
fi
tom_print_vsix_path "$SCRIPT_DIR"
[ "${TOM_NO_DART:-0}" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
[ "${TOM_NO_DART:-0}" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
exit 0
