// A port that accepts a connection and resets it — a busy service, or anything
// that is not a VS Code bridge — must read as "no bridge here". It used to
// raise an uncaught SocketException: the peer's reset ran `_onDone`, which
// dropped the socket reference, so `disconnect()` never closed it and the
// socket's `done` future failed with nobody listening. An uncaught error in a
// scan that every Webwork launch runs over 19900–19909 is not "no bridge".
import 'dart:async';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<ServerSocket> _resettingServer() async {
  final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((socket) => socket.destroy());
  return server;
}

/// Runs [body] and returns every error that escaped it uncaught.
Future<List<Object>> _uncaught(Future<void> Function() body) async {
  final escaped = <Object>[];
  final done = Completer<void>();
  runZonedGuarded(() async {
    await body();
    // Give a failing `done` future the turns it needs to surface.
    await Future<void>.delayed(const Duration(milliseconds: 200));
    done.complete();
  }, (error, _) => escaped.add(error));
  await done.future;
  return escaped;
}

void main() {
  test('BRIDGE-RESET-1: a scan over a resetting port finds nothing and '
      'raises nothing', () async {
    final server = await _resettingServer();
    addTearDown(server.close);

    late Map<int, String> found;
    final escaped = await _uncaught(() async {
      found = await scanBridgePorts(
          minPort: server.port, maxPort: server.port);
    });

    expect(found, isEmpty);
    expect(escaped, isEmpty,
        reason: 'the reset escaped the scan as an uncaught error');
  });

  test('BRIDGE-RESET-2: a request to a resetting peer fails as a value, and '
      'nothing escapes', () async {
    final server = await _resettingServer();
    addTearDown(server.close);

    final escaped = await _uncaught(() async {
      final client = VSCodeBridgeClient(port: server.port);
      if (await client.connect()) {
        await expectLater(
          client.sendRequest('workspace.getInfoVce', {}),
          throwsA(anything),
        );
      }
      await client.disconnect();
    });

    expect(escaped, isEmpty);
  });
}
