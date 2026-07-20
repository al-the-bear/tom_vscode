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
