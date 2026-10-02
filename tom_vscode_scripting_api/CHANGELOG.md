## 1.1.3

- `McpSdkServerConfig` gains `alwaysLoad`. Since Agent SDK 0.3.142, MCP
  servers connect in the background and their tools are deferred behind tool
  search, so a Dart-defined in-process server's tools could be missing on the
  first turn with no way to ask otherwise. Set `alwaysLoad: true` and the
  extension passes it to `createSdkMcpServer` when it rebuilds the server
  (requires a Tom extension build that forwards it). Unset, the wire is
  unchanged.
- The Agent SDK mirror is audited against SDK 0.3.282, the version the
  extension resolves: every key `Options.toJson` writes exists there, and the
  message model already represents every 0.3.282 message type. File headers
  and docs now say so instead of naming ^0.2.110.
- `Options.env` documents what it does: it REPLACES the Claude Code
  subprocess's environment rather than adding to it, and the extension host's
  environment cannot be read from Dart — so leave it null unless you supply
  the whole environment.

## 1.1.2

- Fixed an uncaught `SocketException` from bridge discovery. A port that
  accepts a connection and then resets it — a busy service, or anything that
  is not a VS Code bridge — made `scanBridgePorts` / `fetchBridgeWorkspaceName`
  (and any `VSCodeBridgeClient` whose peer went away) raise an error nobody
  could catch: the reset ran the read side's `onDone`, which dropped the socket
  reference, so `disconnect()` never closed it and the socket's `done` future
  failed unobserved. The client now observes `done` from the moment it
  connects, `disconnect()` tolerates a peer that already went, and
  `isAvailable` destroys its probe socket the same way. Such a port now reads
  as "no bridge here". Regression tests in
  `test/bridge_reset_peer_test.dart`.
- Removed the unused version stamp from `lib/`.

## 1.1.1

- Fixed `TextEditor.fromJson` crashing (`RangeError`) on an empty
  `visibleRanges` array. It previously indexed `visibleRanges[0]` whenever the
  field was non-null, but the bridge reports `visibleRanges: []` for a freshly
  revealed editor (e.g. the `showTextDocument` path), so the whole editor
  snapshot failed to parse. An empty, absent, or non-list `visibleRanges` now
  deserializes to `null`. Added a regression test suite
  (`test/vscode_types_test.dart`).

## 1.1.0

- Added an Agent SDK type surface mirroring `@anthropic-ai/claude-agent-sdk`:
  raw-preserving messages/blocks (`agent_sdk_messages.dart`), the `Options`
  object with sealed config types, and permission/MCP value types
  (`agent_sdk_permissions.dart`, `agent_sdk_mcp.dart`, `agent_sdk_options.dart`).
- Added the streaming `query()` core (`agent_sdk_query.dart`): a typed message
  stream with a pluggable transport seam and a bridge-backed transport.
- Added a bidirectional RPC primitive (`bridge_request_dispatcher.dart`) that
  routes incoming server→client requests to registered handlers and replies
  over the socket.
- Added Dart-defined tools (`agent_sdk_tool_registry.dart`): dispatch incoming
  `agentSdk.toolCall` requests to a query's in-process `tool()` handlers.
- Added the `canUseTool` permission callback dispatch
  (`agent_sdk_permission_dispatch.dart`), turning an incoming
  `agentSdk.canUseTool` request into a `CanUseTool` invocation.
- Added bridge/workspace discovery (`bridge_discovery.dart`): `scanBridgePorts`
  builds a port→workspace table across the CLI bridge port range,
  `findBridgePortForWorkspace` resolves a window by workspace name, and
  `connectToWorkspace` targets a specific window by name.
- Added `listAllowedToolNames()` pre-validation helper and exposed the LLM tool
  registry through the scripting API.
- Added AI APIs for local LLM prompt processing and bot conversation
  (`ai_prompt_api.dart`, `ai_conversation_api.dart`).
- Added Tom workflow APIs: todos, queue, timed requests, documents, workspace,
  tools, and chat (`tom_todo_api.dart`, `tom_queue_api.dart`,
  `tom_timed_api.dart`, `tom_document_api.dart`, `tom_workspace_api.dart`,
  `tom_tools_api.dart`, `tom_chat_api.dart`).
- Updated `repository`/`homepage` metadata to the `tom_vscode` group repo.

## 1.0.1

- Changed license from MIT to BSD-3-Clause.

## 1.0.0

- Initial public release.
- Bridge-agnostic Dart abstractions for the VS Code extension API.
- Core API namespaces: `VSCodeWindow`, `VSCodeWorkspace`, `VSCodeCommands`, `VSCodeExtensions`.
- Language model API (`VSCodeLanguageModel`) for accessing models like GitHub Copilot.
- Chat participant API (`VSCodeChat`) for building chat extensions.
- Socket-based bridge client (`VSCodeBridgeClient`) with JSON-RPC 2.0 communication.
- Convenience script globals (`vscode`, `window`, `workspace`, `commands`, `extensions`, `lm`, `chat`).
- Helper utilities (`VsCodeHelper`) for common VS Code scripting tasks.
