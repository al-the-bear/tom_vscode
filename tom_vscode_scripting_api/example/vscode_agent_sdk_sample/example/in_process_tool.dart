/// Concept: an in-process Dart `tool()` exposed to the agent.
///
/// Run:  dart run bin/run_example.dart in_process_tool
///
/// The SDK lets you define tools whose handler runs *in your process*. In Dart
/// that is an [SdkMcpTool] (name + description + JSON-Schema + a [ToolHandler])
/// grouped under an [McpSdkServerConfig], passed through [Options.mcpServers].
/// The live `McpServer` is not serializable, so over the bridge the server
/// crosses as a **descriptor** (name/version + each tool's schema); the
/// extension rebuilds the real instance and routes each tool call back into
/// your Dart [ToolHandler] over the reverse RPC mid-query.
///
/// This concept builds such a server, invokes the handler directly to show what
/// the model would receive, and prints the descriptor JSON that actually
/// crosses the bridge — deterministic, no live run required.
///
/// Expected output: the tool descriptor JSON, plus the handler's
/// [CallToolResult] for a sample argument set.
library;

import 'dart:convert';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<bool> runInProcessToolExample(VSCodeBridgeClient client) async {
  print('  (bridge connected: ${client.isConnected}; '
      'this concept is offline-deterministic)');

  // Define a tool with a JSON-Schema input and a Dart handler. The handler is
  // never serialized — only the descriptor crosses the bridge; the extension
  // calls back into this closure when the model invokes the tool.
  final addTool = SdkMcpTool(
    name: 'add',
    description: 'Adds two integers and returns the sum.',
    inputSchema: const {
      'type': 'object',
      'properties': {
        'a': {'type': 'integer'},
        'b': {'type': 'integer'},
      },
      'required': ['a', 'b'],
    },
    handler: (args) async {
      final a = (args['a'] as num).toInt();
      final b = (args['b'] as num).toInt();
      return CallToolResult.text('${a + b}');
    },
  );

  // Group the tool(s) under an in-process ("sdk") server.
  final server = McpSdkServerConfig(
    name: 'calculator',
    version: '1.0.0',
    tools: [addTool],
  );

  // This is what travels over the bridge — note the handler is absent.
  const encoder = JsonEncoder.withIndent('  ');
  print('McpSdkServerConfig.toJson() (descriptor that crosses the bridge):');
  print(encoder.convert(server.toJson()));

  // Wire it into Options exactly as you would for a real query.
  final options = Options(mcpServers: {'calculator': server});
  print('mcpServers wired into Options: ${options.mcpServers?.keys.toList()}');

  // Invoke the handler directly to show the model-facing result shape.
  final result = await addTool.handler!({'a': 2, 'b': 3});
  print('add(2, 3) -> ${jsonEncode(result.toJson())}');

  final ok = result.content.first['text'] == '5';
  return ok;
}
