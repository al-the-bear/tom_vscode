#!/usr/bin/env bash
# Run a VS Code scripting introduction example.
#
#   ./run_example.sh                    # run all examples (the aggregator)
#   ./run_example.sh messages           # run a single concept by name
#   ./run_example.sh connect 127.0.0.1  # override the bridge host
#
# Requires a VS Code window with the Tom extension active and its CLI
# Integration Server started ("DS: Start Tom CLI Integration Server"). With no
# server running the examples print the prerequisite and exit 0.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .dart_tool ]; then
  echo "Fetching dependencies (first run)..." >&2
  dart pub get
fi

exec dart run bin/run_example.dart "$@"
