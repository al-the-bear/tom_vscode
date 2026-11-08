#!/bin/bash

# Package a private-distribution VSIX without the Dart binaries: no tom_bs, no
# validate_codespecs (no DartScript, no CodeSpecs validation), no Dart SDK
# needed. Otherwise as create_vsix.sh: the Agent SDK's Claude CLI for
# darwin-arm64, linux-x64 and win32-x64, the workspace template inside the
# VSIX and beside it, nothing installed.
#
#   ./create_vsix_nodart.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for ARG in "$@"; do
    case "$ARG" in
        -h|--help) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0)"; exit 1 ;;
    esac
done
exec "$SCRIPT_DIR/create_vsix.sh" --no-dart
