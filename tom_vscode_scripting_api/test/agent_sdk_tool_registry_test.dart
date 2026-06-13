/// Tests for [AgentSdkToolRegistry] (todo #5): the Dart-side registry that
/// collects the in-process `tool()` handlers from a query's `mcpServers` and
/// dispatches an incoming `agentSdk.toolCall` (over the #4 reverse RPC) to the
/// matching handler, returning the [CallToolResult] as wire JSON.
library;

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

void main() {
  group('AgentSdkToolRegistry.addServers', () {
    test('collects handlers from an sdk server and reports tools present', () {
      final registry = AgentSdkToolRegistry();
      final added = registry.addServers({
        'dartTools': McpSdkServerConfig(
          name: 'dartTools',
          tools: [
            SdkMcpTool(
              name: 'getWeather',
              description: 'weather',
              inputSchema: const {'type': 'object'},
              handler: (args) async => CallToolResult.text('sunny'),
            ),
          ],
        ),
      });
      expect(added, isTrue);
      expect(registry.hasHandlers, isTrue);
    });

    test('ignores non-sdk servers', () {
      final registry = AgentSdkToolRegistry();
      final added = registry.addServers({
        'fs': McpStdioServerConfig(command: 'mcp-fs'),
      });
      expect(added, isFalse);
      expect(registry.hasHandlers, isFalse);
    });

    test('ignores sdk tools that carry no handler (descriptor-only)', () {
      final registry = AgentSdkToolRegistry();
      final added = registry.addServers({
        'dartTools': McpSdkServerConfig(
          name: 'dartTools',
          tools: [
            SdkMcpTool(
              name: 'noHandler',
              description: '',
              inputSchema: const {},
            ),
          ],
        ),
      });
      expect(added, isFalse);
      expect(registry.hasHandlers, isFalse);
    });

    test('null mcpServers reports nothing added', () {
      final registry = AgentSdkToolRegistry();
      expect(registry.addServers(null), isFalse);
    });
  });

  group('AgentSdkToolRegistry.handleToolCall', () {
    test(
      'runs the matching handler and returns its CallToolResult JSON',
      () async {
        final registry = AgentSdkToolRegistry();
        registry.addServers({
          'dartTools': McpSdkServerConfig(
            name: 'dartTools',
            tools: [
              SdkMcpTool(
                name: 'getWeather',
                description: 'weather',
                inputSchema: const {'type': 'object'},
                handler: (args) async =>
                    CallToolResult.text('it is ${args['city']}'),
              ),
            ],
          ),
        });

        final result = await registry.handleToolCall({
          'streamId': 's1',
          'server': 'dartTools',
          'tool': 'getWeather',
          'args': {'city': 'NYC'},
        });

        expect(result['content'], [
          {'type': 'text', 'text': 'it is NYC'},
        ]);
      },
    );

    test('throws for an unknown server', () {
      final registry = AgentSdkToolRegistry();
      registry.addServers({
        'dartTools': McpSdkServerConfig(
          name: 'dartTools',
          tools: [
            SdkMcpTool(
              name: 'getWeather',
              description: '',
              inputSchema: const {},
              handler: (args) async => CallToolResult.text('x'),
            ),
          ],
        ),
      });

      expect(
        () => registry.handleToolCall({
          'server': 'unknown',
          'tool': 'getWeather',
          'args': const {},
        }),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('throws for an unknown tool on a known server', () {
      final registry = AgentSdkToolRegistry();
      registry.addServers({
        'dartTools': McpSdkServerConfig(
          name: 'dartTools',
          tools: [
            SdkMcpTool(
              name: 'getWeather',
              description: '',
              inputSchema: const {},
              handler: (args) async => CallToolResult.text('x'),
            ),
          ],
        ),
      });

      expect(
        () => registry.handleToolCall({
          'server': 'dartTools',
          'tool': 'nope',
          'args': const {},
        }),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
