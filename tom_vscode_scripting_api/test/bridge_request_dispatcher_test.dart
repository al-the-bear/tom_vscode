/// Tests for the client side of the bidirectional RPC primitive (todo #4):
/// when the extension issues a server→client request over the bridge socket,
/// [BridgeRequestDispatcher] routes it to a registered handler and writes the
/// handler's reply back as a JSON-RPC response.
///
/// The reply sink is injected so the dispatcher is unit-testable without a
/// socket: tests capture the reply frames it produces.
library;

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

void main() {
  group('BridgeRequestDispatcher.maybeHandle — request routing', () {
    test(
      'routes a request to its handler and replies with the result',
      () async {
        final replies = <Map<String, dynamic>>[];
        final dispatcher = BridgeRequestDispatcher(
          sendReply: (m) => replies.add(m),
        );
        dispatcher.register('client.add', (params) {
          final a = params['a'] as int;
          final b = params['b'] as int;
          return a + b;
        });

        final handled = dispatcher.maybeHandle({
          'jsonrpc': '2.0',
          'id': 'r1',
          'method': 'client.add',
          'params': {'a': 2, 'b': 3},
        });
        expect(handled, isTrue);

        // The reply is sent after the (possibly async) handler completes.
        await Future<void>.delayed(Duration.zero);
        expect(replies, hasLength(1));
        expect(replies.single['id'], 'r1');
        expect(replies.single['result'], 5);
        expect(replies.single.containsKey('error'), isFalse);
      },
    );

    test('awaits an async handler before replying', () async {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );
      dispatcher.register('client.slow', (params) async {
        await Future<void>.delayed(const Duration(milliseconds: 5));
        return 'done';
      });

      final handled = dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'id': 'r2',
        'method': 'client.slow',
        'params': <String, dynamic>{},
      });
      expect(handled, isTrue);
      expect(replies, isEmpty); // not yet — handler still running

      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(replies.single['id'], 'r2');
      expect(replies.single['result'], 'done');
    });
  });

  group('BridgeRequestDispatcher.maybeHandle — error replies', () {
    test('replies with an error for an unregistered method', () async {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );

      final handled = dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'id': 'r3',
        'method': 'client.unknown',
        'params': <String, dynamic>{},
      });
      expect(handled, isTrue);

      await Future<void>.delayed(Duration.zero);
      expect(replies.single['id'], 'r3');
      final error = replies.single['error'] as Map<String, dynamic>;
      expect(error['message'].toString(), contains('client.unknown'));
      expect(replies.single.containsKey('result'), isFalse);
    });

    test('replies with an error when the handler throws', () async {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );
      dispatcher.register('client.boom', (params) {
        throw StateError('kaboom');
      });

      dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'id': 'r4',
        'method': 'client.boom',
        'params': <String, dynamic>{},
      });

      await Future<void>.delayed(Duration.zero);
      expect(replies.single['id'], 'r4');
      final error = replies.single['error'] as Map<String, dynamic>;
      expect(error['message'].toString(), contains('kaboom'));
    });
  });

  group('BridgeRequestDispatcher.maybeHandle — non-requests', () {
    test('returns false for a response (id but no method)', () {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );
      final handled = dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'id': 'x1',
        'result': 42,
      });
      expect(handled, isFalse);
      expect(replies, isEmpty);
    });

    test('returns false for a notification (method but no id)', () {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );
      final handled = dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'method': 'someNotification',
        'params': <String, dynamic>{},
      });
      expect(handled, isFalse);
      expect(replies, isEmpty);
    });
  });

  group('BridgeRequestDispatcher.unregister', () {
    test('a request for an unregistered (removed) method errors', () async {
      final replies = <Map<String, dynamic>>[];
      final dispatcher = BridgeRequestDispatcher(
        sendReply: (m) => replies.add(m),
      );
      dispatcher.register('client.temp', (params) => 'ok');
      dispatcher.unregister('client.temp');

      dispatcher.maybeHandle({
        'jsonrpc': '2.0',
        'id': 'r5',
        'method': 'client.temp',
        'params': <String, dynamic>{},
      });

      await Future<void>.delayed(Duration.zero);
      expect(replies.single.containsKey('error'), isTrue);
    });
  });
}
