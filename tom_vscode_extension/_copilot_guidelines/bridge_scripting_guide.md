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

## Dart scripting API surface (`tom_vscode_scripting_api`)

Beyond the VS Code command bridge above, scripts written in Dart talk to a
window over the CLI Integration Server using the `tom_vscode_scripting_api`
package. Three parts of that surface were added after this guide's last
revision:

### Agent SDK 1:1 mirror

A low-level Dart mirror of `@anthropic-ai/claude-agent-sdk` (^0.2.110):
`AgentSdkClient.query({prompt, options})` returns an `AgentQuery`
(`Stream<SdkMessage>` + `interrupt()`), with a raw-preserving message/block
surface, a full `Options` type, Dart-defined `sdk` MCP tools, and a
`canUseTool` approval callback. It is a **mirror, not a convenience layer** —
no profiles, allow-lists, trail, or approval gate; the caller owns the SDK
Options and the bridge relays raw `SDKMessage`s verbatim. The profile-gated
path is the separate `agentSdk` *transport* (`anthropic_handler.md`).

> **Security boundary:** scripting-API security is enforced in the **extension**,
> never in the Dart client. The mirror exposes the raw SDK; any gating belongs
> in the extension layer that decides whether to expose it. Restate this in any
> doc or code that touches scripting-API tool gating.

Wire surface: `agentSdk.queryVce` / `agentSdk.cancelVce` (client→server),
`agentSdk.chunk` notifications (server→client), and the reverse-RPC methods
`agentSdk.toolCall` / `agentSdk.canUseTool` (server→client requests routed by a
`BridgeRequestDispatcher`).

### Workspace discovery (targeting a specific window)

Each open VS Code window runs its CLI server on a distinct port in
**19900–19909**. `bridge_discovery.dart` resolves "the window with workspace X":

- `findBridgePortForWorkspace(name)` — scan the range, return the matching port.
- `scanBridgePorts()` — `port → workspace` table for every responsive bridge.
- `connectToWorkspace(name)` — resolve the port and return a connected adapter
  (optionally promoted to the global `VSCode.instance`).

Matching uses a `workspace.getInfoVce` identity handshake and
`normalizeWorkspaceName` (trims, drops `.code-workspace`, strips the
`" (Workspace)"` multi-root suffix) so the bare name, the `.code-workspace`
filename, and the titlebar form all match.

> Full operator + maintainer reference (type surface, examples, file map):
> [../doc/agent_sdk_scripting_mirror.md](../doc/agent_sdk_scripting_mirror.md).
> §3.3 there covers workspace discovery in detail.

### LLM tool registry (`TomToolsApi`)

A script can also invoke the **same LLM tool registry** the chat surfaces use —
the `tomAi_*` tools catalogued in [../doc/llm_tools.md](../doc/llm_tools.md) —
through `TomToolsApi`:

| Method | Wire op | Returns |
| --- | --- | --- |
| `invokeTool(name, [args])` | `tools.invokeVce` | the tool's string result |
| `getToolsJson()` | `tools.getJsonVce` | Anthropic-shaped `{name, description, input_schema}` for the active profile |
| `listAllowedToolNames()` | (same `getJsonVce`) | just the permitted tool **names** |

Both listing and invocation are scoped to the **currently active Anthropic
profile** (its `toolsEnabled` / `enabledTools` set, resolved by the same
`resolveProfileTools` primitive the chat transports use), and when the
**Send-to-Chat target is Copilot** *no* tools are available — the list is empty
and every `invokeTool` is refused.

> **Security boundary (same rule as the Agent SDK mirror):** the gate lives in
> the **extension**, never the Dart client. `TomToolsApi` is a thin
> pass-through with no client-side filtering — a tool the active profile hides
> is refused by the extension *before* the executor runs, so a buggy or
> malicious client cannot widen its own access. `listAllowedToolNames()` is an
> ergonomics/diagnostics convenience (pre-validate a name); the extension
> re-checks on every invoke, so skipping it is always safe.

> Full gating reference: [../doc/llm_tools.md §9](../doc/llm_tools.md#9-scripting-api-access-and-gating).
> Note the standalone MCP server resolves its effective set from its **own**
> picker, not the active chat profile — `TomToolsApi` is the path that follows
> the active Anthropic profile.

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
- [../doc/agent_sdk_scripting_mirror.md](../doc/agent_sdk_scripting_mirror.md) — Agent SDK Dart mirror + workspace discovery (full reference).
- [restart_debugging_flow.backup.md](restart_debugging_flow.backup.md) — recovery steps when bridge operations misbehave.
