#!/bin/bash

# Compile the bridge binary for the LOCAL platform from source, then build and
# install the extension bundling only that single host-platform executable.
#
#   ./compile_and_install.sh [--no-dart]
#
# --no-dart builds as on a machine without a Dart SDK (also TOM_NO_DART=1): no
# tom_bs and no validate_codespecs are built, so the VSIX lacks DartScript and
# CodeSpecs validation. The same happens when no Dart SDK is found. The VSIX
# path is printed at the end, to install it on other machines.
#
# Thin wrapper over install_extension.sh: TOM_BRIDGE_FROM_SOURCE=1 switches the
# bundling step from "copy all prebuilt platforms out of tom_binaries" to
# "run the versioner, resolve deps, regenerate the d4rt bridges, and dart
# compile exe the bridge for this host only" — built straight into the
# extension's local bin/, with no reliance on $TOM_BINARY_PATH or any tool on
# PATH. Everything else (Node check, npm install, TypeScript compile, Claude
# Agent SDK host binary, vsce package, install) is shared with
# install_extension.sh.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/install_summary.sh
source "$SCRIPT_DIR/scripts/install_summary.sh"

export TOM_BRIDGE_FROM_SOURCE=1

for ARG in "$@"; do
    case "$ARG" in
        --no-dart) export TOM_NO_DART=1; export TOM_NO_DART_REASON="--no-dart given" ;;
        -h|--help) sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-dart])"; exit 1 ;;
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

# Own the closing lines so they reflect this wrapper's completion and print
# exactly once (install_extension.sh skips its own when this is set). Not
# `exec`, so control returns here; set -e propagates a base-script failure
# before them, keeping them a success-only marker.
export TOM_SKIP_FINISH_TS=1
"$SCRIPT_DIR/install_extension.sh"

tom_print_vsix_path "$SCRIPT_DIR"
[ "${TOM_NO_DART:-0}" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
echo "🕒 Finished at $(date '+%Y-%m-%d %H:%M:%S %Z')"
[ "${TOM_NO_DART:-0}" = "1" ] && tom_print_no_dart_warning "$TOM_NO_DART_REASON" 1
exit 0
