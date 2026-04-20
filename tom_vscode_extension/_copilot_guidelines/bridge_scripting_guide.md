# Bridge Scripting Guide

Scriptable operations exposed through the extension bridge ecosystem. See [extension_bridge.md](extension_bridge.md) for the role of the bridge subprocess.

## Core idea

The extension can delegate actions through bridge-backed commands for workspace / editor / terminal / DartScript automation, while retaining VS Code command-level integration for user surfaces.

## Key commands

- `tomAi.bridge.restart`
- `tomAi.bridge.switchProfile`
- `tomAi.bridge.toggleDebug`
- `tomAi.cliServer.start`
- `tomAi.cliServer.startCustomPort`
- `tomAi.cliServer.stop`
- `tomAi.startProcessMonitor`

## Scripting boundaries

- Keep privileged operations explicit and command-scoped. A bridge call should correspond to a single user-intent action.
- Prefer command APIs (`vscode.commands.executeCommand('tomAi.*')`) over hidden bridge side effects from inside other handlers.
- Ensure failures return actionable errors to user-facing surfaces — route through the approval-bar / notification flow, not silent swallow.

## Development notes

- Validate bridge profile assumptions before script execution — a profile switch in-flight invalidates cached capability checks.
- Keep script payloads structured (typed interfaces in `vscode-bridge.ts`) and versionable. Bump a minor field rather than breaking the shape.
- Update this guide when adding or removing bridge-facing commands so the command-family section in [extension_bridge.md](extension_bridge.md) stays accurate.

## Related

- [extension_bridge.md](extension_bridge.md) — role, diagnostics, command families.
- [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) — recovery steps when bridge operations misbehave.
