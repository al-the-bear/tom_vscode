/// Tests for the streaming `query()` core (todo #3): the Dart side maps
/// `streamId`-keyed chunk notifications into a typed `Stream<SdkMessage>` and
/// cancels the underlying query when the subscription is cancelled.
///
/// The transport is faked so the logic is unit-testable without a socket:
/// [_FakeAgentSdkTransport] records the `startQuery` params and `cancelQuery`
/// calls and lets the test push simulated chunk notifications.
library;

import 'dart:async';

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// A transport double: captures outgoing calls and exposes a sink the test
/// uses to feed simulated `agentSdk.chunk` notification payloads.
class _FakeAgentSdkTransport implements AgentSdkTransport {
  final _chunks = StreamController<Map<String, dynamic>>.broadcast();
  final List<Map<String, dynamic>> startedQueries = [];
  final List<String> cancelledStreams = [];
  final Map<String, AgentSdkToolRegistry> registeredTools = {};
  final List<String> unregisteredTools = [];
  final Map<String, CanUseTool> registeredCanUseTool = {};
  final List<String> unregisteredCanUseTool = [];

  /// Push a simulated chunk notification (already unwrapped `params`).
  void emit(Map<String, dynamic> chunk) => _chunks.add(chunk);

  @override
  Stream<Map<String, dynamic>> get chunks => _chunks.stream;

  @override
  Future<void> startQuery(Map<String, dynamic> params) async {
    startedQueries.add(params);
  }

  @override
  Future<void> cancelQuery(String streamId) async {
    cancelledStreams.add(streamId);
  }

  @override
  void registerTools(String streamId, AgentSdkToolRegistry registry) {
    registeredTools[streamId] = registry;
  }

  @override
  void unregisterTools(String streamId) {
    unregisteredTools.add(streamId);
  }

  @override
  void registerCanUseTool(String streamId, CanUseTool callback) {
    registeredCanUseTool[streamId] = callback;
  }

  @override
  void unregisterCanUseTool(String streamId) {
    unregisteredCanUseTool.add(streamId);
  }

  Future<void> dispose() => _chunks.close();
}

/// A transport that also supports caller-owned streaming input.
class _FakeInputTransport extends _FakeAgentSdkTransport
    implements AgentSdkInputTransport {
  /// Every input sent, in order, as `(streamId, message)`.
  final List<(String, Map<String, dynamic>)> inputs = [];
  final List<String> endedInputs = [];

  @override
  Future<void> sendInput(String streamId, Map<String, dynamic> message) async {
    inputs.add((streamId, message));
  }

  @override
  Future<void> endInput(String streamId) async {
    endedInputs.add(streamId);
  }
}

/// A bridge client double that records requests instead of using a socket.
class _RecordingClient extends VSCodeBridgeClient {
  final List<(String, Map<String, dynamic>)> requests = [];

  @override
  Future<Map<String, dynamic>> sendRequest(
    String method,
    Map<String, dynamic> params,
  ) async {
    requests.add((method, params));
    return {'success': true};
  }
}

void main() {
  group('AgentSdkClient.query — chunk correlation', () {
    late _FakeAgentSdkTransport transport;
    late AgentSdkClient client;

    setUp(() {
      transport = _FakeAgentSdkTransport();
      client = AgentSdkClient(transport);
    });

    tearDown(() => transport.dispose());

    test('forwards prompt + options to startQuery with a streamId', () async {
      final q = client.query(
        prompt: 'hello',
        options: Options(model: 'claude-x', maxTurns: 3),
      );
      // onListen drives startQuery; subscribe to trigger it.
      final sub = q.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      expect(transport.startedQueries, hasLength(1));
      final sent = transport.startedQueries.single;
      expect(sent['prompt'], 'hello');
      expect(sent['streamId'], isA<String>());
      expect((sent['streamId'] as String).isNotEmpty, isTrue);
      expect(sent['options'], isA<Map>());
      expect((sent['options'] as Map)['model'], 'claude-x');
      expect((sent['options'] as Map)['maxTurns'], 3);

      await sub.cancel();
    });

    test(
      'maps chunks for its streamId into the typed SdkMessage sequence',
      () async {
        final q = client.query(prompt: 'go');
        final received = <SdkMessage>[];
        final done = Completer<void>();
        q.listen(received.add, onDone: done.complete);
        await Future<void>.delayed(Duration.zero);

        final streamId = transport.startedQueries.single['streamId'] as String;

        transport.emit({
          'streamId': streamId,
          'message': {
            'type': 'assistant',
            'session_id': 's1',
            'message': {
              'content': [
                {'type': 'text', 'text': 'hi'},
              ],
            },
          },
        });
        transport.emit({
          'streamId': streamId,
          'message': {
            'type': 'result',
            'subtype': 'success',
            'is_error': false,
            'num_turns': 1,
            'result': 'done',
          },
        });
        transport.emit({'streamId': streamId, 'done': true});

        await done.future;

        expect(received, hasLength(2));
        expect(received[0], isA<SdkAssistantMessage>());
        expect((received[0] as SdkAssistantMessage).sessionId, 's1');
        expect(received[1], isA<SdkResultMessage>());
        expect((received[1] as SdkResultMessage).result, 'done');
      },
    );

    test('ignores chunks belonging to a different streamId', () async {
      final q = client.query(prompt: 'go');
      final received = <SdkMessage>[];
      q.listen(received.add);
      await Future<void>.delayed(Duration.zero);

      transport.emit({
        'streamId': 'someone-else',
        'message': {'type': 'assistant', 'message': {}},
      });
      await Future<void>.delayed(Duration.zero);

      expect(received, isEmpty);
    });

    test('surfaces an error chunk as a stream error', () async {
      final q = client.query(prompt: 'go');
      final errors = <Object>[];
      final done = Completer<void>();
      q.listen((_) {}, onError: errors.add, onDone: done.complete);
      await Future<void>.delayed(Duration.zero);

      final streamId = transport.startedQueries.single['streamId'] as String;
      transport.emit({'streamId': streamId, 'error': 'boom'});

      await done.future;
      expect(errors, hasLength(1));
      expect(errors.single.toString(), contains('boom'));
    });
  });

  group('AgentSdkClient.query — cancellation', () {
    test('cancelling the subscription aborts the underlying query', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);

      final q = client.query(prompt: 'go');
      final sub = q.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      final streamId = transport.startedQueries.single['streamId'] as String;
      await sub.cancel();
      await Future<void>.delayed(Duration.zero);

      expect(transport.cancelledStreams, contains(streamId));
      await transport.dispose();
    });

    test('interrupt() aborts the underlying query', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);

      final q = client.query(prompt: 'go');
      q.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      final streamId = transport.startedQueries.single['streamId'] as String;
      await q.interrupt();
      await Future<void>.delayed(Duration.zero);

      expect(transport.cancelledStreams, contains(streamId));
      await transport.dispose();
    });
  });

  group('AgentSdkClient.query — Dart-defined tools', () {
    test(
      'registers a tool registry on start and unregisters on finish',
      () async {
        final transport = _FakeAgentSdkTransport();
        final client = AgentSdkClient(transport);

        final q = client.query(
          prompt: 'go',
          options: Options(
            mcpServers: {
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
            },
          ),
        );
        final done = Completer<void>();
        final sub = q.listen((_) {}, onDone: done.complete);
        await Future<void>.delayed(Duration.zero);

        final streamId = transport.startedQueries.single['streamId'] as String;
        expect(transport.registeredTools.containsKey(streamId), isTrue);
        expect(transport.registeredTools[streamId]!.hasHandlers, isTrue);

        transport.emit({'streamId': streamId, 'done': true});
        await done.future;

        expect(transport.unregisteredTools, contains(streamId));
        await sub.cancel();
        await transport.dispose();
      },
    );

    test('does not register tools when no sdk server is present', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);

      final q = client.query(
        prompt: 'go',
        options: Options(model: 'x'),
      );
      final sub = q.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      expect(transport.registeredTools, isEmpty);
      await sub.cancel();
      await transport.dispose();
    });
  });

  group('AgentSdkClient.query — canUseTool', () {
    test(
      'registers the canUseTool callback on start and unregisters on finish',
      () async {
        final transport = _FakeAgentSdkTransport();
        final client = AgentSdkClient(transport);

        final q = client.query(
          prompt: 'go',
          options: Options(
            canUseTool: (name, input, ctx) async => PermissionAllow(),
          ),
        );
        final done = Completer<void>();
        final sub = q.listen((_) {}, onDone: done.complete);
        await Future<void>.delayed(Duration.zero);

        final streamId = transport.startedQueries.single['streamId'] as String;
        expect(transport.registeredCanUseTool.containsKey(streamId), isTrue);

        transport.emit({'streamId': streamId, 'done': true});
        await done.future;

        expect(transport.unregisteredCanUseTool, contains(streamId));
        await sub.cancel();
        await transport.dispose();
      },
    );

    test('does not register canUseTool when no callback is supplied', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);

      final q = client.query(
        prompt: 'go',
        options: Options(model: 'x'),
      );
      final sub = q.listen((_) {});
      await Future<void>.delayed(Duration.zero);

      expect(transport.registeredCanUseTool, isEmpty);
      await sub.cancel();
      await transport.dispose();
    });
  });

  group('AgentSdkClient.collectQuery', () {
    test('collects the full message sequence into a list', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);

      final future = client.collectQuery(prompt: 'go');
      await Future<void>.delayed(Duration.zero);
      final streamId = transport.startedQueries.single['streamId'] as String;

      transport.emit({
        'streamId': streamId,
        'message': {'type': 'assistant', 'message': {}},
      });
      transport.emit({'streamId': streamId, 'done': true});

      final messages = await future;
      expect(messages, hasLength(1));
      expect(messages.single, isA<SdkAssistantMessage>());
      await transport.dispose();
    });
  });

  // Streaming input owned by the caller (`sdk.query({prompt: AsyncIterable})`).
  // The string `query` cannot send a second message, and the extension keeps
  // its stdin open for it only until it answers that one message.
  group('AgentSdkClient.streamQuery (SQ-*)', () {
    test('SQ-1: starts with promptStream, sends each input in order after the '
        'start, and ends the input when the prompt stream is done', () async {
      final transport = _FakeInputTransport();
      final client = AgentSdkClient(transport);
      final prompt = StreamController<SdkUserInput>();
      final messages = <SdkMessage>[];
      final done = Completer<void>();
      final query = client.streamQuery(
        prompt: prompt.stream,
        options: Options(model: 'm'),
      );
      query.listen(messages.add, onDone: done.complete);
      await pumpEventQueue();

      expect(transport.startedQueries, hasLength(1));
      final start = transport.startedQueries.single;
      final streamId = start['streamId'] as String;
      expect(start['promptStream'], isTrue);
      expect(start.containsKey('prompt'), isFalse);
      expect(start['options'], {'model': 'm'});

      prompt.add(SdkUserInput.text('first'));
      prompt.add(SdkUserInput.text('second'));
      await pumpEventQueue();
      expect(transport.inputs.map((e) => (e.$1, e.$2['message']['content'])), [
        (streamId, 'first'),
        (streamId, 'second'),
      ]);
      expect(transport.endedInputs, isEmpty);

      await prompt.close();
      await pumpEventQueue();
      expect(transport.endedInputs, [streamId]);

      transport.emit({
        'streamId': streamId,
        'message': {'type': 'result', 'subtype': 'success'},
      });
      transport.emit({'streamId': streamId, 'done': true});
      await done.future;
      expect(messages.single, isA<SdkResultMessage>());
      await transport.dispose();
    });

    test('SQ-2: SdkUserInput serializes to the SDK user-message shape', () {
      expect(SdkUserInput.text('hi', uuid: 'u-1').toJson(), {
        'type': 'user',
        'message': {'role': 'user', 'content': 'hi'},
        'parent_tool_use_id': null,
        'session_id': '',
        'uuid': 'u-1',
      });
      final blocks = SdkUserInput.blocks([
        {'type': 'text', 'text': 'look'},
      ]).toJson();
      expect(blocks['message'], {
        'role': 'user',
        'content': [
          {'type': 'text', 'text': 'look'},
        ],
      });
      expect(blocks.containsKey('uuid'), isFalse);
    });

    test('SQ-3: a transport without input support fails the query, and '
        'starts nothing', () async {
      final transport = _FakeAgentSdkTransport();
      final client = AgentSdkClient(transport);
      await expectLater(
        client.streamQuery(prompt: const Stream.empty()),
        emitsError(isA<UnsupportedError>()),
      );
      expect(transport.startedQueries, isEmpty);
      await transport.dispose();
    });

    test(
      'SQ-4: interrupting stops forwarding input and cancels the query',
      () async {
        final transport = _FakeInputTransport();
        final client = AgentSdkClient(transport);
        final prompt = StreamController<SdkUserInput>();
        final query = client.streamQuery(prompt: prompt.stream);
        final sub = query.listen((_) {});
        await pumpEventQueue();
        final streamId = transport.startedQueries.single['streamId'] as String;

        await query.interrupt();
        prompt.add(SdkUserInput.text('too late'));
        await pumpEventQueue();
        expect(transport.inputs, isEmpty);
        expect(transport.cancelledStreams, [streamId]);
        expect(prompt.hasListener, isFalse);
        await sub.cancel();
        await prompt.close();
        await transport.dispose();
      },
    );

    test('SQ-5: the bridge transport sends inputVce / endInputVce', () async {
      final client = _RecordingClient();
      final transport = VSCodeBridgeAgentSdkTransport(client);
      await transport.sendInput('s1', SdkUserInput.text('x').toJson());
      await transport.endInput('s1');
      expect(client.requests.map((r) => r.$1), [
        'agentSdk.inputVce',
        'agentSdk.endInputVce',
      ]);
      expect(client.requests.first.$2['streamId'], 's1');
      expect(client.requests.first.$2['message']['message']['content'], 'x');
      expect(client.requests.last.$2, {'streamId': 's1'});
    });
  });
}
