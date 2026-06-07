/// Round-trip tests for the Agent SDK message + content-block mirror.
///
/// These types come *from* the extension's `sdk.query()` stream, so the
/// fidelity contract is: `SdkMessage.fromJson(json).toJson()` reproduces the
/// original SDK JSON verbatim (the `raw` carrier — see proposal §7.0.3), while
/// typed accessors expose the common fields. Payloads below mirror the shapes
/// in `@anthropic-ai/claude-agent-sdk` ^0.2.110 `sdk.d.ts`.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
import 'package:test/test.dart';

void main() {
  group('SdkMessage.fromJson dispatch + raw round-trip', () {
    test('assistant message → SdkAssistantMessage, content blocks parsed', () {
      final json = <String, dynamic>{
        'type': 'assistant',
        'message': {
          'role': 'assistant',
          'content': [
            {'type': 'text', 'text': 'Hello'},
            {'type': 'thinking', 'thinking': 'hmm', 'signature': 'sig'},
            {
              'type': 'tool_use',
              'id': 'tu_1',
              'name': 'Read',
              'input': {'path': '/a'},
            },
          ],
        },
        'parent_tool_use_id': null,
        'uuid': 'u-1',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkAssistantMessage>());
      expect(msg.type, 'assistant');
      expect(msg.uuid, 'u-1');
      expect(msg.sessionId, 's-1');
      expect(msg.toJson(), equals(json));

      final assistant = msg as SdkAssistantMessage;
      expect(assistant.parentToolUseId, isNull);
      expect(assistant.content, hasLength(3));
      expect(assistant.content[0], isA<TextBlock>());
      expect((assistant.content[0] as TextBlock).text, 'Hello');
      expect(assistant.content[1], isA<ThinkingBlock>());
      expect((assistant.content[1] as ThinkingBlock).thinking, 'hmm');
      expect((assistant.content[1] as ThinkingBlock).signature, 'sig');
      expect(assistant.content[2], isA<ToolUseBlock>());
      final tu = assistant.content[2] as ToolUseBlock;
      expect(tu.id, 'tu_1');
      expect(tu.name, 'Read');
      expect(tu.input, {'path': '/a'});
    });

    test('user message → SdkUserMessage with tool_result block', () {
      final json = <String, dynamic>{
        'type': 'user',
        'message': {
          'role': 'user',
          'content': [
            {
              'type': 'tool_result',
              'tool_use_id': 'tu_1',
              'content': 'file body',
              'is_error': false,
            },
          ],
        },
        'parent_tool_use_id': 'tu_0',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkUserMessage>());
      expect(msg.toJson(), equals(json));
      final user = msg as SdkUserMessage;
      expect(user.parentToolUseId, 'tu_0');
      expect(user.content, hasLength(1));
      final tr = user.content.single as ToolResultBlock;
      expect(tr.toolUseId, 'tu_1');
      expect(tr.content, 'file body');
      expect(tr.isError, isFalse);
    });

    test('result success → SdkResultMessage, typed fields', () {
      final json = <String, dynamic>{
        'type': 'result',
        'subtype': 'success',
        'duration_ms': 1200,
        'duration_api_ms': 900,
        'is_error': false,
        'num_turns': 3,
        'result': 'done',
        'stop_reason': 'end_turn',
        'total_cost_usd': 0.0123,
        'usage': {'input_tokens': 10, 'output_tokens': 20},
        'modelUsage': {},
        'permission_denials': [],
        'uuid': 'u-2',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkResultMessage>());
      expect(msg.toJson(), equals(json));
      final result = msg as SdkResultMessage;
      expect(result.subtype, 'success');
      expect(result.isError, isFalse);
      expect(result.numTurns, 3);
      expect(result.result, 'done');
      expect(result.stopReason, 'end_turn');
      expect(result.totalCostUsd, closeTo(0.0123, 1e-9));
      expect(result.durationMs, 1200);
      expect(result.durationApiMs, 900);
      expect(result.usage, {'input_tokens': 10, 'output_tokens': 20});
    });

    test('system init → SdkSystemMessage, typed fields', () {
      final json = <String, dynamic>{
        'type': 'system',
        'subtype': 'init',
        'apiKeySource': 'user',
        'cwd': '/work',
        'tools': ['Read', 'Edit'],
        'mcp_servers': [
          {'name': 'srv', 'status': 'connected'},
        ],
        'model': 'claude-x',
        'permissionMode': 'acceptEdits',
        'slash_commands': ['/help'],
        'skills': [],
        'uuid': 'u-3',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkSystemMessage>());
      expect(msg.toJson(), equals(json));
      final sys = msg as SdkSystemMessage;
      expect(sys.subtype, 'init');
      expect(sys.model, 'claude-x');
      expect(sys.cwd, '/work');
      expect(sys.tools, ['Read', 'Edit']);
      expect(sys.permissionMode, 'acceptEdits');
      expect(sys.slashCommands, ['/help']);
      expect(sys.apiKeySource, 'user');
    });

    test('partial assistant (stream_event) → SdkPartialAssistantMessage', () {
      final json = <String, dynamic>{
        'type': 'stream_event',
        'event': {'type': 'content_block_delta'},
        'parent_tool_use_id': null,
        'uuid': 'u-4',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkPartialAssistantMessage>());
      expect(msg.toJson(), equals(json));
      expect(
        (msg as SdkPartialAssistantMessage).event,
        {'type': 'content_block_delta'},
      );
    });

    test('non-init system subtype → SdkSystemEvent carrier', () {
      final json = <String, dynamic>{
        'type': 'system',
        'subtype': 'compact_boundary',
        'compact_metadata': {'trigger': 'auto', 'pre_tokens': 100},
        'uuid': 'u-5',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkSystemEvent>());
      expect((msg as SdkSystemEvent).subtype, 'compact_boundary');
      expect(msg.toJson(), equals(json));
    });

    test('unknown top-level type → SdkUnknownMessage fallback', () {
      final json = <String, dynamic>{
        'type': 'rate_limit_event',
        'rate_limit_info': {'status': 'allowed'},
        'uuid': 'u-6',
        'session_id': 's-1',
      };

      final msg = SdkMessage.fromJson(json);

      expect(msg, isA<SdkUnknownMessage>());
      expect(msg.type, 'rate_limit_event');
      expect(msg.toJson(), equals(json));
    });
  });

  group('ContentBlock.fromJson dispatch + raw round-trip', () {
    test('each known block type maps to its class and round-trips', () {
      final samples = <String, Type>{
        'text': TextBlock,
        'thinking': ThinkingBlock,
        'tool_use': ToolUseBlock,
        'tool_result': ToolResultBlock,
      };
      final payloads = <Map<String, dynamic>>[
        {'type': 'text', 'text': 't'},
        {'type': 'thinking', 'thinking': 'th'},
        {'type': 'tool_use', 'id': 'i', 'name': 'n', 'input': {}},
        {'type': 'tool_result', 'tool_use_id': 'i', 'content': 'c'},
      ];
      for (final json in payloads) {
        final block = ContentBlock.fromJson(json);
        expect(block.runtimeType, samples[json['type']]);
        expect(block.toJson(), equals(json));
      }
    });

    test('unknown block type → UnknownBlock fallback', () {
      final json = <String, dynamic>{
        'type': 'redacted_thinking',
        'data': 'opaque',
      };
      final block = ContentBlock.fromJson(json);
      expect(block, isA<UnknownBlock>());
      expect(block.type, 'redacted_thinking');
      expect(block.toJson(), equals(json));
    });

    test('tool_result content may be a block list', () {
      final json = <String, dynamic>{
        'type': 'tool_result',
        'tool_use_id': 'i',
        'content': [
          {'type': 'text', 'text': 'a'},
        ],
        'is_error': true,
      };
      final block = ContentBlock.fromJson(json) as ToolResultBlock;
      expect(block.isError, isTrue);
      expect(block.content, isA<List>());
      expect(block.toJson(), equals(json));
    });
  });
}
