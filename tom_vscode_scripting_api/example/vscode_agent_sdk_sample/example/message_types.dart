/// Concept: the typed `SdkMessage` / `ContentBlock` output surface.
///
/// Run:  dart run bin/run_example.dart message_types
///
/// `query()` yields a stream of [SdkMessage]s. Each is parsed from the wire by
/// [SdkMessage.fromJson], which dispatches on the SDK `type` discriminator into
/// a sealed subclass with typed accessors — while keeping the full original
/// payload in `raw` (so nothing is ever lost). This concept parses
/// representative payloads — exactly what the extension relays over
/// `agentSdk.chunk` — and reads them back with the typed API. It is fully
/// deterministic and needs no live agent run, which makes it the best place to
/// learn the output surface while the chunk relay is still a completion step.
///
/// Expected output: a system/init line, an assistant turn with a text block and
/// a tool-use block, and a result line with cost/turns — all read through the
/// typed accessors.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<bool> runMessageTypesExample(VSCodeBridgeClient client) async {
  // The transport is wired the same way as for a live query; this concept just
  // exercises parsing rather than firing one.
  print('  (bridge connected: ${client.isConnected}; '
      'this concept is offline-deterministic)');

  // 1. system/init — the first message of every run: model, cwd, tools, …
  final init = SdkMessage.fromJson({
    'type': 'system',
    'subtype': 'init',
    'session_id': 'demo-session',
    'model': 'claude-sonnet-4-5',
    'cwd': '/workspace',
    'tools': ['Read', 'Edit', 'Bash'],
    'permissionMode': 'default',
    'slash_commands': ['/help', '/clear'],
    'apiKeySource': 'env',
    'mcp_servers': [],
  });
  if (init is SdkSystemMessage) {
    print('system/init:');
    print('  model           ${init.model}');
    print('  cwd             ${init.cwd}');
    print('  tools           ${init.tools.join(', ')}');
    print('  permissionMode  ${init.permissionMode}');
    print('  slashCommands   ${init.slashCommands.join(', ')}');
  }

  // 2. assistant — one turn carrying a text block and a tool-use block.
  final assistant = SdkMessage.fromJson({
    'type': 'assistant',
    'session_id': 'demo-session',
    'message': {
      'role': 'assistant',
      'content': [
        {'type': 'text', 'text': 'Let me read the changelog first.'},
        {
          'type': 'tool_use',
          'id': 'toolu_01',
          'name': 'Read',
          'input': {'path': 'CHANGELOG.md'},
        },
      ],
    },
  });
  if (assistant is SdkAssistantMessage) {
    print('assistant:');
    for (final block in assistant.content) {
      switch (block) {
        case TextBlock(:final text):
          print('  text       "$text"');
        case ToolUseBlock(:final name, :final input):
          print('  tool_use   $name($input)');
        default:
          print('  ${block.type}');
      }
    }
  }

  // 3. result — the terminal message: outcome, turns, duration, cost, usage.
  final result = SdkMessage.fromJson({
    'type': 'result',
    'subtype': 'success',
    'session_id': 'demo-session',
    'is_error': false,
    'result': 'The changelog documents three releases.',
    'num_turns': 2,
    'duration_ms': 4200,
    'total_cost_usd': 0.0123,
    'usage': {'input_tokens': 1200, 'output_tokens': 80},
  });
  if (result is SdkResultMessage) {
    print('result:');
    print('  isError    ${result.isError}');
    print('  result     "${result.result}"');
    print('  numTurns   ${result.numTurns}');
    print('  durationMs ${result.durationMs}');
    print('  costUsd    ${result.totalCostUsd}');
    print('  usage      ${result.usage}');
  }

  // Raw-preserving: a type this mirror does not model still round-trips.
  final unknown = SdkMessage.fromJson({'type': 'future_kind', 'x': 1});
  final preserved = unknown is SdkUnknownMessage && unknown.toJson()['x'] == 1;
  print('unknown message preserved verbatim: $preserved');

  return preserved;
}
