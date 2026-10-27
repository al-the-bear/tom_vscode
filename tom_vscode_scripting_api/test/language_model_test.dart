// The language-model calls through a bridge adapter.
//
// The advanced sample's `language_model` concept found four Copilot models and
// then failed with a timeout after 30 s, although
// `LanguageModelChat.sendRequest` asks for 300 s. Both bridge adapters dropped
// the per-call `timeout` that `VSCodeAdapter.sendRequest` documents as the
// maximum wait, so every call was cut at the client's `requestTimeout`
// (30 s by default) — too short for a model reply, and far too short for VS
// Code's first-use consent prompt. Two faults sat in the script the call sends:
// the messages went to VS Code as plain `{role, content}` objects instead of
// `LanguageModelChatMessage`s, and the reply was read from `part.text`, which a
// `LanguageModelTextPart` does not have (it carries `value`), so even an
// answered request came back empty.
//
//   LM-1 VSCodeBridgeAdapter honours the call's timeout over the client's
//   LM-2 LazyVSCodeBridgeAdapter honours the call's timeout
//   LM-3 the client alone keeps its own requestTimeout
//   LM-4 sendRequest's script builds real messages and reads response.text;
//        it asks for its timeoutSeconds
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// A bridge that answers every request after [delay].
Future<ServerSocket> _slowBridge(Duration delay) async {
  final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((socket) {
    final buffer = <int>[];
    socket.listen((data) async {
      buffer.addAll(data);
      while (buffer.length >= 4) {
        final length = ByteData.sublistView(Uint8List.fromList(buffer.sublist(0, 4))).getUint32(0);
        if (buffer.length < 4 + length) break;
        final request = jsonDecode(utf8.decode(buffer.sublist(4, 4 + length))) as Map<String, dynamic>;
        buffer.removeRange(0, 4 + length);
        await Future<void>.delayed(delay);
        final reply = utf8.encode(jsonEncode({
          'jsonrpc': '2.0',
          'id': request['id'],
          'result': {'success': true, 'result': 'late'},
        }));
        final frame = BytesBuilder()
          ..add((ByteData(4)..setUint32(0, reply.length)).buffer.asUint8List())
          ..add(reply);
        try {
          socket.add(frame.toBytes());
        } catch (_) {/* the client has gone */}
      }
    }, onError: (_) {});
  });
  return server;
}

/// Records what a call sends instead of sending it.
class _CaptureAdapter implements VSCodeAdapter {
  String? method;
  Map<String, dynamic>? params;
  Duration? timeout;

  @override
  Future<Map<String, dynamic>> sendRequest(String method, Map<String, dynamic> params,
      {String? scriptName, Duration timeout = const Duration(seconds: 60)}) async {
    this.method = method;
    this.params = params;
    this.timeout = timeout;
    return {'text': 'Dart is a language.', 'stream': ['Dart is a language.']};
  }
}

void main() {
  test('LM-1: VSCodeBridgeAdapter honours the call\'s timeout', () async {
    final server = await _slowBridge(const Duration(milliseconds: 1500));
    addTearDown(server.close);
    final client = VSCodeBridgeClient(port: server.port, requestTimeout: const Duration(seconds: 1));
    expect(await client.connect(), isTrue);
    addTearDown(client.disconnect);
    final adapter = VSCodeBridgeAdapter(client);

    final answer = await adapter.sendRequest('executeScriptVce', {}, timeout: const Duration(seconds: 5));
    expect(answer['result'], 'late', reason: 'a 5 s call outlasts the client\'s 1 s default');

    final sw = Stopwatch()..start();
    await expectLater(
      adapter.sendRequest('executeScriptVce', {}, timeout: const Duration(milliseconds: 300)),
      throwsA(isA<TimeoutException>()),
    );
    expect(sw.elapsedMilliseconds, lessThan(1000), reason: 'a 300 ms call gives up at 300 ms');
  });

  test('LM-2: LazyVSCodeBridgeAdapter honours the call\'s timeout', () async {
    final server = await _slowBridge(const Duration(milliseconds: 1500));
    addTearDown(server.close);
    final adapter = LazyVSCodeBridgeAdapter(port: server.port);
    addTearDown(adapter.disconnect);

    final sw = Stopwatch()..start();
    await expectLater(
      adapter.sendRequest('executeScriptVce', {}, timeout: const Duration(milliseconds: 300)),
      throwsA(isA<TimeoutException>()),
    );
    expect(sw.elapsedMilliseconds, lessThan(1200), reason: 'not the client\'s 30 s default');
  });

  test('LM-3: the client keeps its own requestTimeout', () async {
    final server = await _slowBridge(const Duration(milliseconds: 1500));
    addTearDown(server.close);
    final client = VSCodeBridgeClient(port: server.port, requestTimeout: const Duration(milliseconds: 300));
    expect(await client.connect(), isTrue);
    addTearDown(client.disconnect);
    await expectLater(client.sendRequest('executeScriptVce', {}), throwsA(isA<TimeoutException>()));
    final late = await client.sendRequest('executeScriptVce', {}, timeout: const Duration(seconds: 5));
    expect(late['result'], 'late');
  });

  test('LM-4: the request script', () async {
    final adapter = _CaptureAdapter();
    final model = LanguageModelChat(
      id: 'm1', vendor: 'copilot', family: 'f', version: '1', name: 'Model', maxInputTokens: 1000,
    );
    final reply = await model.sendRequest(adapter, [
      LanguageModelChatMessage.user('Hi'),
      LanguageModelChatMessage.assistant('Hello'),
    ]);
    expect(reply.text, 'Dart is a language.');
    expect(adapter.method, 'executeScriptVce');
    expect(adapter.timeout, const Duration(seconds: 300));
    final script = adapter.params!['script'] as String;
    expect(script, contains('LanguageModelChatMessage.User('));
    expect(script, contains('LanguageModelChatMessage.Assistant('));
    expect(script, contains('response.text'));
    expect(script, isNot(contains('part.text')), reason: 'a LanguageModelTextPart carries value, not text');
  });
}
