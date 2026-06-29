#!/bin/bash

# Compile the bridge binary for the LOCAL platform from source, then build and
# install the extension bundling only that single host-platform executable.
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

export TOM_BRIDGE_FROM_SOURCE=1
exec "$SCRIPT_DIR/install_extension.sh" "$@"
