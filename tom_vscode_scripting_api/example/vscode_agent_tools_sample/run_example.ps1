# Run a Tom agent-tools example.
#
#   ./run_example.ps1                          # run all examples (the aggregator)
#   ./run_example.ps1 workspace_metadata       # run a single concept by name
#   ./run_example.ps1 send_to_chat             # run the interactive concept
#   ./run_example.ps1 todos 127.0.0.1          # override the bridge host
#
# Requires a VS Code window with the Tom extension active and its CLI
# Integration Server started ("DS: Start Tom CLI Integration Server"). With no
# server running the examples print the prerequisite and exit 0.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".dart_tool")) {
  Write-Host "Fetching dependencies (first run)..."
  dart pub get
}

dart run bin/run_example.dart @args
