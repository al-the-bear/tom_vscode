# Bridge Scripting Guide

This guide covers scriptable operations exposed through the extension bridge ecosystem.

## Core idea

The extension can delegate actions through bridge-backed commands for workspace/editor/terminal automation while retaining VS Code command-level integration.

## Key commands

- `tomAi.bridge.restart`
- `tomAi.bridge.switchProfile`
- `tomAi.cliServer.start`
- `tomAi.cliServer.startCustomPort`
- `tomAi.cliServer.stop`

## Scripting boundaries

- Keep privileged operations explicit and command-scoped.
- Prefer command APIs over hidden side effects.
- Ensure failures return actionable errors to user-facing surfaces.

## Development notes

- Validate bridge profile assumptions before script execution.
- Keep script payloads structured and versionable.
- Update this guide when adding/removing bridge-facing commands.
