#!/bin/bash

# Package a private-distribution VSIX without the Dart binaries: no tom_bs, no
# validate_codespecs (no DartScript, no CodeSpecs validation), no Dart SDK
# needed. Otherwise as create_vsix.sh: the workspace template inside the VSIX
# and beside it, no provider SDK (installed on request), nothing installed.
#
#   ./create_vsix_nodart.sh [--no-release]
#
# Every run publishes the VSIX as the GitHub Release `vscode-extension-latest` of
# al-the-bear/tom_binaries (asset tom-ai-extension.vsix, with
# vscode_extension/vsix/README.md there; scripts/vsix-release.cjs) when the
# tom_vscode checkout has no local change and no unpushed commit; --no-release
# skips it. The VSIX also stays here for a local install.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=()
for ARG in "$@"; do
    case "$ARG" in
        --no-release) PASS+=(--no-release) ;;
        -h|--help) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Unknown option: $ARG (usage: $0 [--no-release])"; exit 1 ;;
    esac
done
export TOM_RELEASE_SCRIPT="create_vsix_nodart.sh"
exec "$SCRIPT_DIR/create_vsix.sh" --no-dart "${PASS[@]}"
