# Anthropic Agent SDK Guide

`tom_vscode_scripting_api` exposes a **1:1 Dart mirror of the Anthropic Agent
SDK**, driven through the VS Code bridge. A Dart program can launch a streaming
agent query, watch typed messages flow back, expose **in-process Dart tools** to
the agent, and approve or deny each tool call through a **`canUseTool`**
permission callback — exactly the shape of the TypeScript SDK, but in Dart.

The actual agent runs inside the extension (which owns the Anthropic
credentials and the real SDK); the bridge streams its output back and routes the
agent's callbacks to your Dart code. You never handle an API key in the script.

> Prerequisites: connect and obtain a `VSCodeBridgeClient` (see
> [vscode_api_intro.md](vscode_api_intro.md)). The Agent SDK transport needs the
> raw client, because it uses the bidirectional notification + callback channel,
> not just request/response.

---

## The shape of a query

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  final bridge = VSCodeBridgeClient(host: '127.0.0.1', port: 19900);
  await bridge.connect();

  final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(bridge));

  final query = client.query(
    prompt: 'Read lib/parser.dart and suggest three improvements',
    options: Options(
      model: 'claude-sonnet-4',
      maxTurns: 10,
      permissionMode: PermissionMode.acceptEdits,
    ),
  );

  await for (final message in query) {
    switch (message) {
      case SdkAssistantMessage(:final content):
        for (final block in content) {
          if (block is TextBlock) print(block.text);
        }
      case SdkResultMessage(:final raw):
        print('Done: $raw');
      default:
        break;
    }
  }
}
```

### Collecting instead of streaming

```dart
final messages = await client.collectQuery(
  prompt: 'List the test files',
  options: Options(maxTurns: 5),
);
```

`collectQuery` drains the stream and returns `List<SdkMessage>`.

### Interrupting / cancelling

`query()` returns an `AgentQuery` (a `StreamView<SdkMessage>`):

```dart
final query = client.query(prompt: '…', options: Options());
// later, from elsewhere:
await query.interrupt();
```

---

## `AgentSdkClient` and the transport

| Type | Role |
| ---- | ---- |
| `AgentSdkClient(transport)` | High-level entry. `query({required prompt, options})` → `AgentQuery`; `collectQuery({required prompt, options})` → `Future<List<SdkMessage>>`. |
| `AgentQuery` | `extends StreamView<SdkMessage>`; adds `interrupt()`. |
| `AgentSdkTransport` | Abstract seam: `startQuery`, `cancelQuery`, `chunks`, `registerTools`, `registerCanUseTool`. |
| `VSCodeBridgeAgentSdkTransport(client)` | Production transport. Sends `agentSdk.queryVce` / `agentSdk.cancelVce`, receives `agentSdk.chunk` streaming notifications, and routes `agentSdk.toolCall` / `agentSdk.canUseTool` callbacks back to your handlers. |
| `AgentSdkQueryException` | Thrown when a query fails on the bridge side. |

The transport is the only Agent SDK-specific dependency. Inject a fake transport
to unit-test agent-driving code without a socket.

---

## `Options` — the full configuration surface

`Options` mirrors the TypeScript SDK's options object. It is a plain data class
with 50+ fields; the ones you will reach for most:

| Field | Type | Purpose |
| ----- | ---- | ------- |
| `model` | `String?` | Primary model id. |
| `fallbackModel` | `String?` | Used if the primary is unavailable. |
| `systemPrompt` | `SystemPrompt?` | Sealed: preset, append, or full override (see below). |
| `tools` | `ToolsConfig?` | Sealed: which tools the agent may use. |
| `allowedTools` / `disallowedTools` | `List<String>?` | Allow/deny lists by tool name. |
| `mcpServers` | `Map<String, McpServerConfig>?` | MCP servers, including in-process Dart ones. |
| `maxTurns` | `int?` | Cap on agent turns. |
| `maxBudgetUsd` | `double?` | Spend cap. |
| `permissionMode` | `PermissionMode?` | default / acceptEdits / bypassPermissions / plan. |
| `canUseTool` | `CanUseTool?` | Per-call permission callback (not serialized — runs in your process). |
| `settingSources` | `List<SettingSource>?` | Which settings layers to load. |
| `cwd` | `String?` | Working directory for the agent. |
| `resume` / `continueSession` / `sessionId` | session controls | Resume or continue a prior session. |
| `env` | `Map<String, String>?` | Extra environment for the agent. |
| `agents` | `Map<String, AgentDefinition>?` | Named sub-agent definitions. |
| `skills` | `Skills?` | Skill enablement. |
| `plugins` | `List<PluginConfig>?` | Plugin configs. |
| `thinking` | `ThinkingConfig?` | Extended-thinking control. |
| `effort` | `EffortLevel?` | Reasoning effort. |
| `includePartialMessages` | `bool?` | Emit `SdkPartialAssistantMessage` chunks. |
| `onStderr` | callback | Receive agent stderr lines. |

Sealed companions:

- **`SystemPrompt`** — preset / append-to-preset / full override variants.
- **`ToolsConfig`** — the tool-availability policy.
- **`ThinkingConfig`** — extended thinking settings.
- **`Skills`** — skill enablement.
- **`SettingsRef`** — reference to a settings source.

Other value types: `OutputFormat`, `TaskBudget`, `PluginConfig`,
`AgentDefinition`; enums `SettingSource`, `EffortLevel`.

---

## Messages — the typed stream

The query yields a **raw-preserving** sealed `SdkMessage` hierarchy: every
message keeps its original JSON in `raw`, so you never lose fields the typed
layer doesn't model.

| Message | Meaning |
| ------- | ------- |
| `SdkAssistantMessage` | An assistant turn; `content` is a `List<ContentBlock>`. |
| `SdkUserMessage` | A user/tool-result turn fed back into the loop. |
| `SdkResultMessage` | Terminal result for the query (cost, stop reason, etc.). |
| `SdkSystemMessage` | System-level message. |
| `SdkPartialAssistantMessage` | Streaming partial (only with `includePartialMessages`). |
| `SdkSystemEvent` | System event notification. |
| `SdkUnknownMessage` | Anything the mirror doesn't recognise (raw preserved). |

Content blocks (sealed `ContentBlock`):

| Block | Meaning |
| ----- | ------- |
| `TextBlock` | Plain text (`text`). |
| `ThinkingBlock` | Extended-thinking content. |
| `ToolUseBlock` | The agent invoking a tool (`name`, `input`, `id`). |
| `ToolResultBlock` | The result fed back for a tool call. |
| `UnknownBlock` | Unrecognised block (raw preserved). |

Pattern-match on the sealed types:

```dart
await for (final m in query) {
  if (m is SdkAssistantMessage) {
    for (final b in m.content) {
      switch (b) {
        case TextBlock(:final text): stdout.write(text);
        case ToolUseBlock(:final name): print('\n[tool] $name');
        default: break;
      }
    }
  }
}
```

---

## In-process Dart tools (MCP)

You can give the agent tools that **run in your Dart process** — an in-process
MCP server. Define a tool handler, register it under an `McpSdkServerConfig`, and
the agent's `toolCall` requests are routed back to your handler over the bridge.

```dart
final calculator = SdkMcpTool(
  name: 'add',
  description: 'Add two numbers',
  handler: (input) async {
    final sum = (input['a'] as num) + (input['b'] as num);
    return CallToolResult.text('$sum');
  },
);

final options = Options(
  mcpServers: {
    'math': McpSdkServerConfig(tools: [calculator]),
  },
);
```

MCP value types:

| Type | Purpose |
| ---- | ------- |
| `ToolHandler` | typedef — `FutureOr<CallToolResult> Function(Map input)`. |
| `SdkMcpTool` | An in-process tool (name, description, handler). |
| `CallToolResult` | Tool result. `CallToolResult.text('…')`; `fromJson`/`toJson`. |
| `McpServerToolPolicy` | Per-server tool allow policy. |
| `McpSdkServerConfig` | **In-process** server backed by your Dart `SdkMcpTool`s. |
| `McpStdioServerConfig` | External MCP server over stdio. |
| `McpSSEServerConfig` | External MCP server over SSE. |
| `McpHttpServerConfig` | External MCP server over HTTP. |

`McpServerConfig` is the sealed base of the four config variants.

Under the hood, `AgentSdkToolRegistry` (`addServers`, `hasHandlers`,
`handleToolCall`) dispatches incoming `agentSdk.toolCall` requests to the right
`SdkMcpTool.handler`. You normally don't touch it directly — registering the
servers on `Options` is enough — but it's there if you need custom routing.

---

## Permissions — the `canUseTool` callback

For fine-grained, per-call approval, supply a `canUseTool` callback on
`Options`. The agent pauses before each tool use and asks your Dart code whether
to allow it.

```dart
final options = Options(
  canUseTool: (toolName, input, context) async {
    if (toolName == 'Bash' && (input['command'] as String).contains('rm -rf')) {
      return PermissionDeny(message: 'Destructive command blocked');
    }
    return PermissionAllow();
  },
);
```

Permission types:

| Type | Purpose |
| ---- | ------- |
| `CanUseTool` | typedef — `Future<PermissionResult> Function(String toolName, Map input, CanUseToolContext context)`. |
| `CanUseToolContext` | Context for the decision (signal, suggestions). |
| `PermissionResult` (sealed) | `PermissionAllow` / `PermissionDeny`. |
| `PermissionAllow` | Allow; may carry updated input / permission updates. |
| `PermissionDeny` | Deny with a `message`. |
| `PermissionUpdate` (sealed) | `…Rules` / `…SetMode` / `…Directories` — mutate the permission state. |
| `PermissionRuleValue` | A single rule value. |
| enums | `PermissionMode`, `PermissionBehavior`, `PermissionUpdateDestination`, `PermissionDecisionClassification`. |

The callback is wired through `dispatchCanUseTool(callback, params)` (in
`agent_sdk_permission_dispatch.dart`), which turns an incoming
`agentSdk.canUseTool` request into your `CanUseTool` invocation. As with the tool
registry, registration via `Options.canUseTool` is all you normally need.

> `canUseTool` is **not serialized** — it runs in your process and is reached
> through the bridge's server→client callback channel (`BridgeRequestDispatcher`
> on the client, `ServerToClientRpc` in the extension). It works alongside, not
> instead of, `permissionMode`: the mode sets the default posture; the callback
> overrides per call.

---

## What is and isn't exposed

**Exposed (1:1):** streaming `query()`, `Options` (full field set), the message
and content-block hierarchies (raw-preserving), in-process MCP tools, external
MCP server configs, the permission system, `canUseTool`, session
resume/continue, sub-agents, skills, plugins, and thinking/effort controls.

**Not in this package:** the Anthropic credentials and the underlying SDK
runtime — those live in the extension. You drive the agent; the extension runs
it. There is no direct HTTP-to-Anthropic path in the Dart client.

---

## End-to-end example

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  final bridge = VSCodeBridgeClient(host: '127.0.0.1', port: 19900);
  await bridge.connect();
  final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(bridge));

  final wordCount = SdkMcpTool(
    name: 'word_count',
    description: 'Count words in a string',
    handler: (input) async =>
        CallToolResult.text('${(input['text'] as String).split(' ').length}'),
  );

  final query = client.query(
    prompt: 'Use word_count on the README summary line and report the number',
    options: Options(
      model: 'claude-sonnet-4',
      maxTurns: 8,
      mcpServers: {'text': McpSdkServerConfig(tools: [wordCount])},
      canUseTool: (name, input, ctx) async => PermissionAllow(),
    ),
  );

  await for (final m in query) {
    if (m is SdkAssistantMessage) {
      for (final b in m.content) {
        if (b is TextBlock) stdout.write(b.text);
      }
    }
  }
  await bridge.disconnect();
}
```

Next: the [extension scripting guide](vscode_api_extension_scripting_guide.md)
for the Tom AI extension's own features.
