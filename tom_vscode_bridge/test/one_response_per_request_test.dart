// One answer per request (qrfix15).
//
// The bridge answered executeFileVcb / executeScriptVcb twice: `_executeScript`
// sent its result itself, and the request handler sent it again, because its
// guard still named the methods before their Vcb suffix. A script run for a
// CLI client also wrote a stray answer to stdout, under the CLI client's id.
// Now the request handler alone answers a request from stdin — the result or
// the error — and a CLI request is answered only over its socket.
//
// These tests drive the real server through its stdin handler
// (`debugHandleLine`) and count every message it writes (`debugOutput`):
//   * executeScriptVcb, executeFileVcb, executeExpressionVcb and a plain method
//     (getDebugLogging) get exactly one response each;
//   * a script that throws gets one response (success: false); an unknown
//     method and a missing parameter get one error response, no result;
//   * a request from a CLI client (handleCliRequest) is answered by its return
//     value and writes nothing to stdout; a failing one throws to the CLI
//     server and writes nothing either.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tom_vscode_bridge/bridge_server.dart';

void main() {
  late VSCodeBridgeServer bridge;
  final out = <Map<String, dynamic>>[];
  late Directory tmp;

  setUpAll(() {
    bridge = VSCodeBridgeServer();
    bridge.debugOutput.listen((line) {
      try {
        out.add(jsonDecode(line) as Map<String, dynamic>);
      } catch (_) {
        // not a JSON message
      }
    });
    tmp = Directory.systemTemp.createTempSync('one-response-');
  });

  tearDownAll(() {
    tmp.deleteSync(recursive: true);
  });

  /// The answers (responses and errors, not requests) written for [id].
  List<Map<String, dynamic>> answersFor(Object id) => out
      .where((m) => m['id'] == id && !m.containsKey('method'))
      .toList();

  /// Send [method] with [params] as id [id]; wait for its first answer, then a
  /// little longer, so a second answer would be seen.
  Future<List<Map<String, dynamic>>> request(
    Object id,
    String method,
    Map<String, dynamic> params,
  ) async {
    bridge.debugHandleLine(
      jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}),
    );
    final deadline = DateTime.now().add(const Duration(seconds: 60));
    while (answersFor(id).isEmpty && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return answersFor(id);
  }

  test('executeScriptVcb: one response', () async {
    final answers = await request(1, 'executeScriptVcb', {
      'script': 'main() => 42;',
      'params': <String, dynamic>{},
    });
    expect(answers, hasLength(1));
    expect(answers.single['result']['success'], isTrue);
    expect(answers.single['result']['result'], 42);
  });

  test('executeFileVcb: one response', () async {
    final file = File('${tmp.path}/script.dart')
      ..writeAsStringSync("main() => 'from a file';\n");
    final answers = await request(2, 'executeFileVcb', {
      'filePath': file.path,
      'params': <String, dynamic>{},
    });
    expect(answers, hasLength(1));
    expect(answers.single['result']['result'], 'from a file');
  });

  test('executeExpressionVcb: one response', () async {
    final answers = await request(3, 'executeExpressionVcb', {'expression': '1 + 2'});
    expect(answers, hasLength(1));
    expect(answers.single['result']['success'], isTrue);
    expect(answers.single['result']['result'], 3);
  });

  test('a plain method: one response', () async {
    final answers = await request(4, 'getDebugLogging', <String, dynamic>{});
    expect(answers, hasLength(1));
    expect(answers.single.containsKey('result'), isTrue);
  });

  test('a script that throws: one response, success false', () async {
    final answers = await request(5, 'executeScriptVcb', {
      'script': "main() { throw 'boom'; }",
      'params': <String, dynamic>{},
    });
    expect(answers, hasLength(1));
    expect(answers.single['result']['success'], isFalse);
    expect(answers.single['result']['error'], contains('boom'));
  });

  test('an unknown method and a missing parameter: one error response each', () async {
    final unknown = await request(6, 'noSuchMethod', <String, dynamic>{});
    expect(unknown, hasLength(1));
    expect(unknown.single.containsKey('error'), isTrue);
    expect(unknown.single.containsKey('result'), isFalse);
    expect(unknown.single['error']['message'], contains('Unknown method'));

    final missing = await request(7, 'executeExpressionVcb', <String, dynamic>{});
    expect(missing, hasLength(1));
    expect(missing.single['error']['message'], contains('expression parameter is required'));
  });

  test('a CLI request is answered by its return value, never on stdout', () async {
    final logs = <String>[];
    final result = await bridge.handleCliRequest(
      'executeScriptVcb',
      {'script': 'main() => 7;', 'params': <String, dynamic>{}},
      'cli-1',
      logs.add,
    );
    expect(result?['success'], isTrue);
    expect(result?['result'], 7);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(answersFor('cli-1'), isEmpty, reason: 'nothing for the CLI id on stdout');

    await expectLater(
      bridge.handleCliRequest('noSuchMethod', <String, dynamic>{}, 'cli-2', logs.add),
      throwsA(isA<Exception>()),
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(answersFor('cli-2'), isEmpty, reason: 'the CLI server answers the error on the socket');
  });
}
