/// Dart-side dispatch for in-process (`sdk`) MCP tools (proposal §7.0.4,
/// todo #5).
///
/// A query's [Options.mcpServers] may carry [McpSdkServerConfig]s whose
/// [SdkMcpTool]s hold Dart [ToolHandler]s. The descriptor (name/description/
/// JSON-Schema) crosses the bridge so the extension can rebuild a real
/// `sdk.createSdkMcpServer()`; the *handler* stays in Dart. When the model
/// calls such a tool mid-query, the extension issues an `agentSdk.toolCall`
/// request back over the #4 reverse RPC, which [AgentSdkClient] routes here.
///
/// This registry is the lookup half: it indexes the local handlers by
/// `server → tool` and runs the matching one, returning the [CallToolResult]
/// as wire JSON. It is pure (no socket, no `dart:io`) so it is unit-testable on
/// its own and reused by the bridge-backed transport.
library;

import 'agent_sdk_mcp.dart';

/// Indexes the Dart [ToolHandler]s a query exposes and dispatches incoming
/// `agentSdk.toolCall` requests to them.
class AgentSdkToolRegistry {
  /// `serverName → (toolName → handler)`.
  final Map<String, Map<String, ToolHandler>> _handlers = {};

  /// Registers the handlers carried by [mcpServers]'s [McpSdkServerConfig]
  /// entries. Non-sdk servers and handler-less (descriptor-only) tools are
  /// ignored. Returns `true` if at least one handler was registered.
  bool addServers(Map<String, McpServerConfig>? mcpServers) {
    if (mcpServers == null) return false;
    var added = false;
    mcpServers.forEach((serverName, config) {
      if (config is! McpSdkServerConfig) return;
      for (final tool in config.tools) {
        final handler = tool.handler;
        if (handler == null) continue;
        (_handlers[serverName] ??= {})[tool.name] = handler;
        added = true;
      }
    });
    return added;
  }

  /// Whether any tool handlers are registered.
  bool get hasHandlers => _handlers.isNotEmpty;

  /// Dispatches an `agentSdk.toolCall` request to the matching handler.
  ///
  /// [params] carries `server`, `tool`, and `args` (plus the routing
  /// `streamId`, unused here). Returns the handler's [CallToolResult] as wire
  /// JSON. Throws [ArgumentError] when no handler matches `server`/`tool`.
  Future<Map<String, dynamic>> handleToolCall(
    Map<String, dynamic> params,
  ) async {
    final server = params['server'] as String?;
    final tool = params['tool'] as String?;
    final handler = _handlers[server]?[tool];
    if (handler == null) {
      throw ArgumentError(
        'No Dart tool handler for server "$server" tool "$tool"',
      );
    }
    final args = (params['args'] as Map?)?.cast<String, dynamic>() ?? const {};
    final result = await handler(args);
    return result.toJson();
  }
}
