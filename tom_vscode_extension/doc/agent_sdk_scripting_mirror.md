# Agent SDK Scripting Mirror

A **1:1, low-level Dart mirror** of the Anthropic Agent SDK
(`@anthropic-ai/claude-agent-sdk`), exposed through the
`tom_vscode_scripting_api` package. A Dart script run through the VS Code
bridge can call `query()` and receive the SDK's `SDKMessage` stream, supply
Dart-defined tools, and answer permission prompts — the same surface a
TypeScript caller gets from the SDK, expressed in Dart types.

> **This is a mirror, not a convenience layer.** It deliberately does *not*
> wrap profiles, allow-lists, history compaction, the approval gate, or the
> `sendToChat` path. The caller controls the SDK's own `Options` directly and
> the bridge relays raw `SDKMessage`s verbatim. The convenience, profile-gated
> path is the `agentSdk` *transport* of the Anthropic handler
> (`handlers/agent-sdk-transport.ts`, see `anthropic_handler.md`) — a different
> thing that happens to use the same SDK.

- **Audience:** script authors targeting a VS Code window over the bridge, and
  maintainers of the mirror.
- **SDK tracked:** `@anthropic-ai/claude-agent-sdk` **^0.2.110**. Wire field
  names are the SDK's own (`sdk.d.ts`): camelCase on inputs (`Options` and its
  sub-configs), snake_case on outputs (`SDKMessage` / content blocks).
- **Source:** `tom_vscode_scripting_api/lib/src/agent_sdk_*.dart` (Dart half)
  and `tom_vscode_extension/src/services/agent-sdk-bridge.ts` +
  `src/handlers/agent-sdk-transport.ts` (extension half).
- **Design basis:** `_ai/quests/vscode_extension/agent_sdk_bridge_proposal.md`
  (finalized) and `agent_sdk_option_audit.md`.

---

## 1. The two SDK paths — don't confuse them

| | **Scripting mirror** (this doc) | **`agentSdk` transport** |
| --- | --- | --- |
| Entry | `AgentSdkClient.query()` (Dart, over the bridge) | Anthropic chat panel, `transport: 'agentSdk'` |
| Backed by | `agentSdk.queryVce` → `services/agent-sdk-bridge.ts` | `handlers/agent-sdk-transport.ts` |
| Options | caller-controlled, relayed verbatim | derived from the active profile/config |
| Profiles / allow-lists / trail / approval gate | **none** | full |
| Use when | a script needs raw, programmatic SDK access | a person drives the SDK from chat |

Both load the **same** ESM-only SDK through the shared `loadSdk()`; they differ
only in what they put around it. The rest of this doc is the scripting mirror.

---

## 2. Type surface

The mirror is a faithful type translation, split by concern. Every *data* type
round-trips (`T.fromJson(t.toJson()).toJson() == t.toJson()`). Callback-bearing
fields are part of the type surface but are **never serialized** — they are
dispatched over the reverse RPC (§5–§6).

### 2.1 Output messages — `agent_sdk_messages.dart` (raw-preserving)

The streamed `SDKMessage` union and content-block union are **raw-preserving**:
every value keeps its full original JSON in `raw`, and `toJson()` returns it
verbatim. Nothing is lost, even for fields this mirror does not type. Typed
accessors are sugar over `raw`.

| Dart type | Mirrors | Typed accessors |
| --- | --- | --- |
| `SdkAssistantMessage` | `type: 'assistant'` | `message`, `content`, `parentToolUseId`, `error` |
| `SdkUserMessage` | `type: 'user'` (incl. replay) | `message`, `content`, `isReplay` |
| `SdkResultMessage` | `type: 'result'` | `subtype`, `isError`, `result`, `numTurns`, `durationMs`, `totalCostUsd`, `usage`, … |
| `SdkSystemMessage` | `type: 'system'`, `subtype: 'init'` | `model`, `cwd`, `tools`, `permissionMode`, `slashCommands`, `mcpServers`, … |
| `SdkPartialAssistantMessage` | `type: 'stream_event'` (only with `includePartialMessages`) | `event`, `parentToolUseId` |
| `SdkSystemEvent` | every other `type: 'system'` subtype (`compact_boundary`, `status`, `rate_limit`, …) | `subtype`, `raw` |
| `SdkUnknownMessage` | any future top-level `type` | `raw` |

Content blocks parse the same way: `TextBlock`, `ThinkingBlock`,
`ToolUseBlock`, `ToolResultBlock`, and `UnknownBlock` (forward-compatible
fallback for `redacted_thinking`, `server_tool_use`, images, …).

### 2.2 Input options — `agent_sdk_options.dart`

`Options` mirrors the SDK's `Options` argument to `sdk.query({prompt, options})`.
Every documented data field is present (`model`, `systemPrompt`, `tools`,
`allowedTools`/`disallowedTools`, `mcpServers`, `maxTurns`, `permissionMode`,
`thinking`, `effort`, session controls, `agents`, `skills`, `plugins`, …). The
union-typed fields are modeled as sealed Dart classes with `fromWire`/`toWire`:

- `SystemPrompt` → `SystemPromptText` | `SystemPromptList` | `SystemPromptPreset`
- `ToolsConfig` → `ToolsList` | `ToolsClaudeCodePreset`
- `ThinkingConfig` → `ThinkingEnabled` | `ThinkingDisabled` | `ThinkingAdaptive`
- `Skills` → `SkillsList` | `SkillsAll`
- `SettingsRef` → `SettingsPath` | `SettingsInline`

**Intentionally excluded** (proposal §7.0.5): callback fields beyond
`canUseTool`/`onStderr` (`hooks`, `onElicitation`, `sessionStore`) and
bridge-managed fields (`abortController`, `executable`, …). `abortController`
in particular is owned by the extension bridge — it creates one per `streamId`
so cancellation works (§4).

### 2.3 Permissions — `agent_sdk_permissions.dart`

`PermissionMode` (six values; `default` is `PermissionMode.default_` in Dart),
the `CanUseTool` callback typedef, its `PermissionResult` return
(`PermissionAllow` | `PermissionDeny`), the `PermissionUpdate` rule mutations
(`addRules`/`replaceRules`/`removeRules`/`setMode`/`add|removeDirectories`), and
`CanUseToolContext` (carries `suggestions`).

### 2.4 MCP — `agent_sdk_mcp.dart`

`McpServerConfig` → `McpStdioServerConfig` | `McpSSEServerConfig` |
`McpHttpServerConfig` | `McpSdkServerConfig`. The first three describe
**external** servers and cross the bridge as plain data (§7). `McpSdkServerConfig`
describes an **in-process ("sdk")** server: it carries a serializable
*descriptor* (`name`, `version`, and `SdkMcpTool` entries — `name`,
`description`, JSON-Schema `inputSchema`) plus the Dart `ToolHandler`s, which
stay in Dart and are never serialized (§5).

---

## 3. Running a query — `AgentSdkClient`

`AgentSdkClient.query({required String prompt, Options? options})` mirrors
`sdk.query(...)`. It returns an `AgentQuery`, which is a `Stream<SdkMessage>`
plus an `interrupt()` control method:

```dart
final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(bridgeClient));

final query = client.query(
  prompt: 'Summarize the open editors',
  options: Options(model: 'claude-sonnet-4-6', maxTurns: 4),
);

await for (final msg in query) {
  if (msg is SdkAssistantMessage) {
    for (final block in msg.content.whereType<TextBlock>()) {
      print(block.text);
    }
  } else if (msg is SdkResultMessage) {
    print('done: ${msg.numTurns} turns, \$${msg.totalCostUsd}');
  }
}
```

- The query starts **lazily** when the stream is first listened to; chunks are
  subscribed *before* the start request so no early message is dropped.
- `AgentSdkClient.collectQuery(...)` is the one-line `await query(...).toList()`
  convenience.
- An `error` chunk surfaces as an `AgentSdkQueryException` on the stream.

### 3.1 Cancellation

Cancelling the stream subscription **or** calling `query.interrupt()` aborts the
underlying query (`agentSdk.cancelVce`). `interrupt()` is idempotent. The
extension bridge owns the `AbortController` keyed by `streamId`.

### 3.2 The transport seam

`AgentSdkClient` talks to an `AgentSdkTransport`, isolating the correlation
logic from the wire so it is unit-testable with a double. Production uses
`VSCodeBridgeAgentSdkTransport`, backed by a `VSCodeBridgeClient`. Wire methods:

| Direction | Method | Purpose |
| --- | --- | --- |
| client → server | `agentSdk.queryVce` | start a query (`streamId`, `prompt`, serialized `options`) |
| client → server | `agentSdk.cancelVce` | abort a query by `streamId` |
| server → client (notification) | `agentSdk.chunk` | one `SDKMessage`, or `done: true`, or `error`, keyed by `streamId` |

> **Delivery caveat:** end-to-end `agentSdk.chunk` delivery over the standalone
> `tom_vscode_bridge` CLI socket also requires that server to relay extension
> notifications to the connected client (today the CLI relay forwards `log`).
> That relay is tracked as a completion step; the Dart client half is complete
> and correct. The in-process path is unaffected.

### 3.3 Targeting a specific window — workspace discovery

A query needs a `VSCodeBridgeClient` bound to a **specific** VS Code window.
Each open window runs its CLI Integration Server on a distinct port in the
inclusive range **19900–19909** (`defaultVSCodeBridgePort`–`maxVSCodeBridgePort`,
ten windows), so a script that wants "the window with workspace X open" must
discover which port that is. `bridge_discovery.dart` provides three helpers:

| Function | Returns | Purpose |
| --- | --- | --- |
| `findBridgePortForWorkspace(name)` | `Future<int>` | scan the range, return the port whose window has workspace `name` open |
| `scanBridgePorts()` | `Future<Map<int, String>>` | `port → workspace` table for every responsive bridge (for listing/diagnostics) |
| `connectToWorkspace(name)` | `Future<LazyVSCodeBridgeAdapter>` | resolve the port and return a **connected** adapter bound to it |

```dart
// One call: find the window, connect, and (optionally) make it the global target.
final adapter = await connectToWorkspace(
  'vscode_extension',
  initializeVSCode: true, // promotes the adapter to VSCode.instance
);

// Now run an Agent SDK query against that window's bridge.
final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(adapter.client));
```

**The identity handshake.** For each responsive port the scan issues a
lightweight `workspace.getInfoVce` request and derives the window's workspace
name from the result (`fetchBridgeWorkspaceName` → `_deriveWorkspaceName`),
preferring, in order: the open `.code-workspace` file's basename, the reported
workspace `name`, then the root folder basename.

**Name normalization.** Matching is done through `normalizeWorkspaceName`, which
trims whitespace, drops a trailing `.code-workspace` extension, and strips VS
Code's `" (Workspace)"` multi-root suffix — so the bare name, the
`.code-workspace` filename, and the titlebar form all match each other. Note the
asymmetry: `findBridgePortForWorkspace` normalizes both sides before comparing,
while `scanBridgePorts` reports the **raw** identity strings (scanning is a
reporting concern; normalization is a matching concern).

**Failure modes.** `findBridgePortForWorkspace` (and therefore
`connectToWorkspace`) throws `BridgeWorkspaceNotFoundException` when no
responsive bridge in the range has the requested workspace open;
`connectToWorkspace` throws `StateError` if the matching bridge is found but
cannot be connected. Ports are probed in ascending order; the probe and
identity fetch are injectable seams (`BridgePortProbe`, `BridgeIdentityFetcher`)
so the scan is unit-testable against faked per-port bridges.

---

## 4. Reverse RPC — `BridgeRequestDispatcher`

The bridge is normally client→server. The callback-bearing features (Dart tools
§5, `canUseTool` §6) need the reverse: the **extension** issues a request to the
*Dart client* mid-query and awaits the answer. `BridgeRequestDispatcher` is the
generic client half — it recognizes an incoming server→client request (both
`method` and `id` present), routes it to a registered handler, and writes the
handler's reply back as a JSON-RPC response through an injected sink. It knows
nothing about the Agent SDK. The matching extension half is `ServerToClientRpc`
(`src/services/server-to-client-rpc.ts`).

`maybeHandle(message)` returns `false` for anything that is not a request
(responses, notifications), so the bridge client falls through to its existing
routing.

---

## 5. Dart-defined tools

A query's `Options.mcpServers` may carry an `McpSdkServerConfig` whose
`SdkMcpTool`s hold Dart `ToolHandler`s (`Future<CallToolResult> Function(args)`).

What crosses the bridge is only the **descriptor** (server name/version, each
tool's name/description/JSON-Schema). The extension rebuilds a real
`sdk.createSdkMcpServer()` from it (converting JSON-Schema inputs to Zod with the
shared `toRawShape`). When the model calls such a tool mid-query, the extension
issues an `agentSdk.toolCall` request back over the reverse RPC; the Dart
`AgentSdkToolRegistry` looks up the handler by `server → tool`, runs it, and
returns the `CallToolResult` as wire JSON.

```dart
final options = Options(
  mcpServers: {
    'scratch': McpSdkServerConfig(
      name: 'scratch',
      tools: [
        SdkMcpTool(
          name: 'add',
          description: 'Add two numbers',
          inputSchema: {
            'type': 'object',
            'properties': {'a': {'type': 'number'}, 'b': {'type': 'number'}},
            'required': ['a', 'b'],
          },
          handler: (args) async => CallToolResult.text(
            '${(args['a'] as num) + (args['b'] as num)}',
          ),
        ),
      ],
    ),
  },
);
```

The registry is registered on the transport **before** the query starts (so an
early `agentSdk.toolCall` has a handler) and unregistered on completion/cancel.
A single method-keyed `agentSdk.toolCall` handler routes by `streamId`, so
concurrent queries share the hook while keeping per-query registries.

> Note the asymmetry with TypeScript: the SDK's `tool()` / `createSdkMcpServer()`
> free functions live on the **extension** side. In Dart you construct
> `SdkMcpTool` + `McpSdkServerConfig` directly and the extension reconstructs
> the live server.

---

## 6. Tool approval — `canUseTool`

`Options.canUseTool` is a Dart `CanUseTool` callback. It does **not** cross the
bridge as data — `Options.toJson()` emits only a `canUseTool: true` capability
flag. Seeing that flag, the extension installs a real SDK callback that, on each
tool request, issues an `agentSdk.canUseTool` request over the reverse RPC.
`AgentSdkClient` routes it (by `streamId`) through `dispatchCanUseTool`, which
invokes the Dart callback and serializes the returned `PermissionResult`:

```dart
final options = Options(
  canUseTool: (toolName, input, context) async {
    if (toolName == 'Bash') {
      return PermissionDeny(message: 'Shell disabled for this script');
    }
    return PermissionAllow();
  },
);
```

A `PermissionAllow` may rewrite the tool input (`updatedInput`) and/or persist
permission rules (`updatedPermissions`); `context.suggestions` surfaces the
SDK's suggested updates. Like tools, the callback is registered before start and
removed on finish.

---

## 7. External MCP pass-through

`McpStdioServerConfig`, `McpSSEServerConfig`, and `McpHttpServerConfig` describe
servers the SDK connects to itself. They are plain data with no Dart-side
callback — they serialize straight through to `sdk.query()` Options and need no
reverse RPC. Per-tool permission policies (`McpServerToolPolicy`,
`always_allow` | `always_ask` | `always_deny`) are carried on the sse/http
variants. This is the option-fidelity surface backed by `agent_sdk_option_audit.md`.

---

## 8. Security boundary

**Security is enforced in the extension, never in the Dart client.** The mirror
intentionally exposes the raw SDK surface; it does not gate, allow-list, or
sandbox anything. That is sound because:

- the scripting mirror is only reachable over the **in-process bridge**, and
- any allow-listing or profile gating belongs in the extension layer that
  decides whether to expose this surface at all — not in the Dart API, which a
  script controls.

The convenience, profile-gated path (the `agentSdk` transport, the standalone
MCP server) is where gating lives; see `anthropic_handler.md` and
`mcp_server.md`. Any doc or code touching tool gating must restate this
boundary.

---

## 9. File map

| File | Role |
| --- | --- |
| `lib/src/agent_sdk_messages.dart` | output `SDKMessage` + content-block union (raw-preserving) |
| `lib/src/agent_sdk_options.dart` | `Options` + sealed input sub-configs |
| `lib/src/agent_sdk_permissions.dart` | `PermissionMode`, `CanUseTool`, `PermissionResult`, `PermissionUpdate` |
| `lib/src/agent_sdk_mcp.dart` | `McpServerConfig` variants, `SdkMcpTool`, `CallToolResult` |
| `lib/src/agent_sdk_query.dart` | `AgentSdkClient`, `AgentQuery`, transport seam, bridge transport |
| `lib/src/bridge_discovery.dart` | window discovery: `findBridgePortForWorkspace`, `scanBridgePorts`, `connectToWorkspace` (§3.3) |
| `lib/src/bridge_request_dispatcher.dart` | generic server→client RPC client half |
| `lib/src/agent_sdk_tool_registry.dart` | dispatch `agentSdk.toolCall` to Dart handlers |
| `lib/src/agent_sdk_permission_dispatch.dart` | dispatch `agentSdk.canUseTool` to the Dart callback |
| `src/services/agent-sdk-bridge.ts` | extension: thin pass-through behind `agentSdk.queryVce`/`cancelVce` |
| `src/handlers/agent-sdk-transport.ts` | extension: the separate profile-gated `agentSdk` transport |

For targeting a specific VS Code window from a script (workspace discovery,
`findBridgePortForWorkspace`, `scanBridgePorts`, `connectToWorkspace`), see
§3.3 above. The same surface is also summarized in the broader
`bridge_scripting_guide.md`.
