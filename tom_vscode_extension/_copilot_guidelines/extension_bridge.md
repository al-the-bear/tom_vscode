# Extension Bridge

Defines how extension commands and handlers interact with bridge-backed runtime services (the `tom_ai_bridge` Dart subprocess that handles workspace scripting, DartScript execution, and delegated operations). Source: [vscode-bridge.ts](../src/utils/vscode-bridge.ts) + [restartBridge-handler.ts](../src/handlers/restartBridge-handler.ts).

## Role

The bridge client is an **optional** runtime dependency. Activation must fail-soft if the bridge can't start: the extension remains usable; only bridge-delegated commands become no-ops with a clear error message.

## Command families

Bridge-relevant commands:

| Command | Purpose |
| --- | --- |
| `tomAi.bridge.restart` | Restart the bridge subprocess (recover from hangs / profile changes). |
| `tomAi.bridge.switchProfile` | Change the active bridge profile. |
| `tomAi.bridge.toggleDebug` | Toggle bridge debug logging (streams to "Tom Dartbridge Log" output channel). |
| `tomAi.cliServer.start` / `tomAi.cliServer.stop` / `tomAi.cliServer.startCustomPort` | Tom CLI integration server lifecycle. |
| `tomAi.startProcessMonitor` | Launch the optional process monitor. |

## Integration principles

- **Idempotent.** Restart / toggle / switch should be safe to call repeatedly.
- **Status visible.** State surfaces in the bridge output channel and on the status page ([tom_status_page.md](tom_status_page.md)).
- **No hidden coupling.** Unrelated handlers should not reach into bridge internals; delegate through `vscode-bridge.ts` helpers.
- **Graceful degradation.** Every bridge call site must check for availability and surface actionable errors rather than crashing.

## Diagnostics

Use:

- **`@T: Restart Bridge`** — first-line recovery.
- **`@T: Toggle Bridge Debug Logging`** — streams wire traffic to "Tom Dartbridge Log".
- **`@T: Extension Status Page`** — shows bridge profile, PID, last message, connection state.
- **Reload VS Code window** when command metadata is stale (see [reinstall_extension.md](reinstall_extension.md)).

## Related

- [bridge_scripting_guide.md](bridge_scripting_guide.md) — scriptable operations exposed through bridge commands.
- [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) — troubleshooting flow when restart doesn't help.
