/// Dart mirror of the Agent SDK MCP surface: the [McpServerConfig] variants
/// referenced from `Options.mcpServers`, the [SdkMcpTool] descriptor, and the
/// [CallToolResult] a Dart tool handler returns.
///
/// The SDK's in-process server (`createSdkMcpServer`) holds a live, non-
/// serializable `McpServer`. Over the bridge it crosses as a **descriptor**
/// (proposal §7.0.4): server name/version plus each tool's name/description/
/// JSON-Schema. The extension rebuilds the real instance and routes tool calls
/// back into Dart over the reverse RPC (todo #5). Wire field names match
/// `sdk.d.ts` ^0.2.110.
library;

/// A tool callback that runs in Dart. Mirrors the handler passed to `tool()`.
///
/// Declared here as part of the 1:1 type surface; the reverse-RPC dispatch that
/// invokes it mid-query is wired in todo #5.
typedef ToolHandler = Future<CallToolResult> Function(
  Map<String, dynamic> args,
);

/// The result a [ToolHandler] returns. Mirrors MCP `CallToolResult`.
class CallToolResult {
  /// Content items (each an MCP content payload, e.g. `{type:'text', text}`).
  final List<Map<String, dynamic>> content;

  /// Whether the tool call failed.
  final bool? isError;

  CallToolResult({required this.content, this.isError});

  /// Convenience for a single text result.
  factory CallToolResult.text(String text, {bool? isError}) => CallToolResult(
        content: [
          {'type': 'text', 'text': text},
        ],
        isError: isError,
      );

  /// Parses a [CallToolResult] from wire JSON.
  factory CallToolResult.fromJson(Map<String, dynamic> json) => CallToolResult(
        content: ((json['content'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => m.cast<String, dynamic>())
            .toList(),
        isError: json['isError'] as bool?,
      );

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {
        'content': content,
        if (isError != null) 'isError': isError,
      };
}

/// An in-process tool definition. Mirrors `SdkMcpToolDefinition` / the object
/// built by `tool()`.
///
/// [inputSchema] is JSON-Schema (the extension converts it to Zod via
/// `jsonSchemaToZod`). [handler] runs in Dart; it is part of the type surface
/// but is never serialized — only the descriptor crosses the bridge.
class SdkMcpTool {
  /// The tool name.
  final String name;

  /// A human-readable description.
  final String description;

  /// The JSON-Schema for the tool input.
  final Map<String, dynamic> inputSchema;

  /// The Dart handler invoked when the model calls this tool (wired in #5).
  final ToolHandler? handler;

  SdkMcpTool({
    required this.name,
    required this.description,
    required this.inputSchema,
    this.handler,
  });

  /// Parses a tool descriptor from wire JSON. The handler is not transported.
  factory SdkMcpTool.fromJson(Map<String, dynamic> json) => SdkMcpTool(
        name: json['name'] as String,
        description: json['description'] as String? ?? '',
        inputSchema:
            (json['inputSchema'] as Map?)?.cast<String, dynamic>() ?? const {},
      );

  /// Serializes the descriptor (name/description/schema) — never the handler.
  Map<String, dynamic> toJson() => {
        'name': name,
        'description': description,
        'inputSchema': inputSchema,
      };
}

/// Per-tool permission policy for a remote MCP server. Mirrors
/// `McpServerToolPolicy` (`permission_policy` is snake_case on the wire).
class McpServerToolPolicy {
  /// The tool name.
  final String name;

  /// `always_allow` | `always_ask` | `always_deny`.
  final String permissionPolicy;

  McpServerToolPolicy({required this.name, required this.permissionPolicy});

  /// Parses from wire JSON.
  factory McpServerToolPolicy.fromJson(Map<String, dynamic> json) =>
      McpServerToolPolicy(
        name: json['name'] as String,
        permissionPolicy: json['permission_policy'] as String,
      );

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson() => {
        'name': name,
        'permission_policy': permissionPolicy,
      };
}

/// An MCP server configuration referenced from `Options.mcpServers`.
/// Mirrors `McpServerConfig` (stdio / sse / http / sdk variants).
sealed class McpServerConfig {
  const McpServerConfig();

  /// The server `type` discriminator.
  String get type;

  /// Serializes to wire JSON.
  Map<String, dynamic> toJson();

  /// Parses [json] into the matching variant. A missing `type` defaults to
  /// `stdio` (the SDK treats `type` as optional for stdio servers).
  factory McpServerConfig.fromJson(Map<String, dynamic> json) {
    switch (json['type']) {
      case 'sse':
        return McpSSEServerConfig.fromJson(json);
      case 'http':
        return McpHttpServerConfig.fromJson(json);
      case 'sdk':
        return McpSdkServerConfig.fromJson(json);
      case 'stdio':
      case null:
        return McpStdioServerConfig.fromJson(json);
      default:
        throw ArgumentError('Unknown McpServerConfig type: ${json['type']}');
    }
  }
}

/// A stdio MCP server. Mirrors `McpStdioServerConfig`.
final class McpStdioServerConfig extends McpServerConfig {
  /// The command to spawn.
  final String command;

  /// Command arguments.
  final List<String>? args;

  /// Environment overrides for the spawned process.
  final Map<String, String>? env;

  /// Whether the server's tools are always loaded (never deferred).
  final bool? alwaysLoad;

  McpStdioServerConfig({
    required this.command,
    this.args,
    this.env,
    this.alwaysLoad,
  });

  /// Parses from wire JSON.
  factory McpStdioServerConfig.fromJson(Map<String, dynamic> json) =>
      McpStdioServerConfig(
        command: json['command'] as String,
        args: (json['args'] as List?)?.map((e) => e.toString()).toList(),
        env: (json['env'] as Map?)?.map((k, v) => MapEntry('$k', '$v')),
        alwaysLoad: json['alwaysLoad'] as bool?,
      );

  @override
  String get type => 'stdio';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'command': command,
        if (args != null) 'args': args,
        if (env != null) 'env': env,
        if (alwaysLoad != null) 'alwaysLoad': alwaysLoad,
      };
}

/// An SSE MCP server. Mirrors `McpSSEServerConfig`.
final class McpSSEServerConfig extends McpServerConfig {
  /// The SSE endpoint URL.
  final String url;

  /// Request headers.
  final Map<String, String>? headers;

  /// Per-tool permission policies.
  final List<McpServerToolPolicy>? tools;

  /// Whether the server's tools are always loaded.
  final bool? alwaysLoad;

  McpSSEServerConfig({
    required this.url,
    this.headers,
    this.tools,
    this.alwaysLoad,
  });

  /// Parses from wire JSON.
  factory McpSSEServerConfig.fromJson(Map<String, dynamic> json) =>
      McpSSEServerConfig(
        url: json['url'] as String,
        headers: (json['headers'] as Map?)?.map((k, v) => MapEntry('$k', '$v')),
        tools: _toolPolicies(json['tools']),
        alwaysLoad: json['alwaysLoad'] as bool?,
      );

  @override
  String get type => 'sse';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'url': url,
        if (headers != null) 'headers': headers,
        if (tools != null) 'tools': tools!.map((t) => t.toJson()).toList(),
        if (alwaysLoad != null) 'alwaysLoad': alwaysLoad,
      };
}

/// An HTTP MCP server. Mirrors `McpHttpServerConfig`.
final class McpHttpServerConfig extends McpServerConfig {
  /// The HTTP endpoint URL.
  final String url;

  /// Request headers.
  final Map<String, String>? headers;

  /// Per-tool permission policies.
  final List<McpServerToolPolicy>? tools;

  /// Whether the server's tools are always loaded.
  final bool? alwaysLoad;

  McpHttpServerConfig({
    required this.url,
    this.headers,
    this.tools,
    this.alwaysLoad,
  });

  /// Parses from wire JSON.
  factory McpHttpServerConfig.fromJson(Map<String, dynamic> json) =>
      McpHttpServerConfig(
        url: json['url'] as String,
        headers: (json['headers'] as Map?)?.map((k, v) => MapEntry('$k', '$v')),
        tools: _toolPolicies(json['tools']),
        alwaysLoad: json['alwaysLoad'] as bool?,
      );

  @override
  String get type => 'http';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'url': url,
        if (headers != null) 'headers': headers,
        if (tools != null) 'tools': tools!.map((t) => t.toJson()).toList(),
        if (alwaysLoad != null) 'alwaysLoad': alwaysLoad,
      };
}

/// An in-process ("sdk") MCP server. Mirrors `McpSdkServerConfigWithInstance`,
/// but carries a serializable **descriptor** instead of a live `McpServer`
/// (proposal §7.0.4): the extension reconstructs the real instance.
final class McpSdkServerConfig extends McpServerConfig {
  /// The server name.
  final String name;

  /// The server version.
  final String version;

  /// The tool descriptors this server exposes.
  final List<SdkMcpTool> tools;

  McpSdkServerConfig({
    required this.name,
    this.version = '1.0.0',
    this.tools = const [],
  });

  /// Parses the descriptor from wire JSON (tool handlers are not transported).
  factory McpSdkServerConfig.fromJson(Map<String, dynamic> json) =>
      McpSdkServerConfig(
        name: json['name'] as String,
        version: json['version'] as String? ?? '1.0.0',
        tools: ((json['tools'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => SdkMcpTool.fromJson(m.cast<String, dynamic>()))
            .toList(),
      );

  @override
  String get type => 'sdk';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'name': name,
        'version': version,
        'tools': tools.map((t) => t.toJson()).toList(),
      };
}

/// Parses a list of [McpServerToolPolicy] from a JSON value.
List<McpServerToolPolicy>? _toolPolicies(Object? value) {
  if (value is List) {
    return value
        .whereType<Map>()
        .map((m) => McpServerToolPolicy.fromJson(m.cast<String, dynamic>()))
        .toList();
  }
  return null;
}
