/// Client side of the bidirectional RPC primitive (todo #4).
///
/// The bridge is normally client→server: the Dart client calls the extension
/// and awaits a reply. The callback-bearing Agent SDK features (#5 Dart-defined
/// tools, #6 `canUseTool`) need the reverse — the extension issues a request to
/// *this* client mid-query and awaits the answer. [BridgeRequestDispatcher] is
/// that client half: it recognises an incoming server→client request, routes it
/// to a registered handler, and writes the handler's reply back as a JSON-RPC
/// response.
///
/// It is deliberately generic — it knows nothing about the Agent SDK — and the
/// reply sink is injected so it is unit-testable without a socket. The matching
/// extension half is `ServerToClientRpc` (`src/services/server-to-client-rpc.ts`).
library;

import 'dart:async';

/// A handler for an incoming server→client request `method`. Receives the
/// request `params` and returns the JSON-encodable result (sync or async).
typedef BridgeRequestHandler =
    FutureOr<Object?> Function(Map<String, dynamic> params);

/// Routes incoming server→client requests to registered handlers and writes
/// their replies through an injected sink.
class BridgeRequestDispatcher {
  /// Creates a dispatcher that writes JSON-RPC response frames via [sendReply].
  BridgeRequestDispatcher({
    required void Function(Map<String, dynamic>) sendReply,
  }) : _sendReply = sendReply;

  final void Function(Map<String, dynamic>) _sendReply;
  final Map<String, BridgeRequestHandler> _handlers = {};

  /// Register [handler] for server→client requests with the given [method].
  /// Re-registering a method replaces the previous handler.
  void register(String method, BridgeRequestHandler handler) {
    _handlers[method] = handler;
  }

  /// Remove the handler for [method], if any.
  void unregister(String method) {
    _handlers.remove(method);
  }

  /// If [message] is a server→client request (both `method` and `id` present),
  /// route it to its handler and return `true`; the reply is sent through the
  /// injected sink once the (possibly async) handler completes.
  ///
  /// Returns `false` for anything that is not a request — responses (`id` but
  /// no `method`) and notifications (`method` but no `id`) — so the caller can
  /// fall through to its existing response/notification routing.
  bool maybeHandle(Map<String, dynamic> message) {
    final method = message['method'];
    final id = message['id'];
    if (method is! String || id == null) {
      return false;
    }

    final handler = _handlers[method];
    if (handler == null) {
      _replyError(
        id,
        "No handler registered for server→client request '$method'",
      );
      return true;
    }

    final params = _asParams(message['params']);
    // Run the handler asynchronously so a throwing or async handler both
    // produce a single reply via the same code path.
    Future<void>(() async {
      try {
        final result = await handler(params);
        _replyResult(id, result);
      } catch (err) {
        _replyError(id, err.toString());
      }
    });
    return true;
  }

  Map<String, dynamic> _asParams(Object? raw) {
    if (raw is Map<String, dynamic>) {
      return raw;
    }
    if (raw is Map) {
      return raw.cast<String, dynamic>();
    }
    return <String, dynamic>{};
  }

  void _replyResult(Object id, Object? result) {
    _sendReply({'jsonrpc': '2.0', 'id': id, 'result': result});
  }

  void _replyError(Object id, String message) {
    _sendReply({
      'jsonrpc': '2.0',
      'id': id,
      'error': {'code': -32000, 'message': message},
    });
  }
}
