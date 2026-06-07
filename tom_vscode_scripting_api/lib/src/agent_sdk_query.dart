/// Streaming `query()` core — the Dart half of the 1:1 Agent SDK mirror
/// (proposal §7.1, todo #3).
///
/// [AgentSdkClient.query] mirrors `sdk.query({prompt, options})`. It returns an
/// [AgentQuery] (a `Stream<SdkMessage>` plus an [AgentQuery.interrupt] control
/// method). Under the hood it asks the extension to start a query via the
/// `agentSdk.queryVce` bridge method and correlates the `streamId`-keyed
/// `agentSdk.chunk` notifications back into a typed message stream. Cancelling
/// the subscription (or calling [AgentQuery.interrupt]) aborts the underlying
/// query via `agentSdk.cancelVce`.
///
/// This is the **thin pass-through** path: the caller controls the SDK's own
/// [Options] directly and the bridge relays raw `SDKMessage`s verbatim. It does
/// not route through profiles, allow-lists, or the convenience sendToChat path.
///
/// The reverse-RPC dependent features (Dart-defined `tool()` handlers,
/// `canUseTool`) and the `AgentQuery` control methods that need streaming-input
/// (`setPermissionMode`, `setModel`, `initializationResult`,
/// `supportedCommands`) are layered on in later todos (#4–#6).
library;

import 'dart:async';

import 'agent_sdk_messages.dart';
import 'agent_sdk_options.dart';
import 'agent_sdk_permission_dispatch.dart';
import 'agent_sdk_permissions.dart';
import 'agent_sdk_tool_registry.dart';
import 'vscode_bridge_client.dart';

/// Transport seam for streaming Agent SDK queries.
///
/// Isolates [AgentSdkClient] from the concrete wire so the correlation logic is
/// unit-testable with a double. The production implementation is
/// [VSCodeBridgeAgentSdkTransport].
abstract class AgentSdkTransport {
  /// Starts a query on the extension. [params] carries `streamId`, `prompt`,
  /// and (optionally) `options` (the serialized [Options] wire JSON).
  ///
  /// Returns once the query has been *started*; the resulting `SDKMessage`s
  /// arrive asynchronously on [chunks], not as the result of this call.
  Future<void> startQuery(Map<String, dynamic> params);

  /// Aborts the query identified by [streamId] (`agentSdk.cancelVce`).
  Future<void> cancelQuery(String streamId);

  /// The stream of incoming `agentSdk.chunk` notification payloads (the
  /// unwrapped `params` map). Each carries a `streamId` plus one of:
  ///  - `message`: a raw `SDKMessage` JSON map,
  ///  - `done: true`: the query completed,
  ///  - `error`: the query failed.
  Stream<Map<String, dynamic>> get chunks;

  /// Registers [registry] so incoming `agentSdk.toolCall` requests for
  /// [streamId] are dispatched to the query's Dart [ToolHandler]s (todo #5).
  ///
  /// Default: no-op — only the reverse-RPC-capable transport
  /// ([VSCodeBridgeAgentSdkTransport]) needs to act on it.
  void registerTools(String streamId, AgentSdkToolRegistry registry) {}

  /// Removes the tool registry for [streamId] (on query completion/cancel).
  /// Default: no-op.
  void unregisterTools(String streamId) {}

  /// Registers [callback] so incoming `agentSdk.canUseTool` requests for
  /// [streamId] are dispatched to the query's [CanUseTool] approval callback
  /// (todo #6).
  ///
  /// Default: no-op — only the reverse-RPC-capable transport
  /// ([VSCodeBridgeAgentSdkTransport]) needs to act on it.
  void registerCanUseTool(String streamId, CanUseTool callback) {}

  /// Removes the canUseTool callback for [streamId] (on query completion/cancel).
  /// Default: no-op.
  void unregisterCanUseTool(String streamId) {}
}

/// Thrown into an [AgentQuery]'s stream when the extension reports a query
/// failure via an `error` chunk.
class AgentSdkQueryException implements Exception {
  /// The error message reported by the extension.
  final String message;

  AgentSdkQueryException(this.message);

  @override
  String toString() => 'AgentSdkQueryException: $message';
}

/// A live Agent SDK query: a `Stream<SdkMessage>` plus control methods.
///
/// Mirrors the SDK's `Query` (which extends `AsyncGenerator<SDKMessage>`).
/// Todo #3 wires the stream and [interrupt]; the streaming-input control
/// methods (`setPermissionMode`, `setModel`, …) follow in later todos.
class AgentQuery extends StreamView<SdkMessage> {
  final Future<void> Function() _interrupt;

  AgentQuery._(super.stream, {required Future<void> Function() interrupt})
      : _interrupt = interrupt;

  /// Aborts the underlying query (`agentSdk.cancelVce`). Idempotent.
  ///
  /// Cancelling the stream subscription has the same effect.
  Future<void> interrupt() => _interrupt();
}

/// Entry point mirroring the SDK's `query()` free function, bound to a
/// [AgentSdkTransport].
class AgentSdkClient {
  /// The transport used to start/cancel queries and receive chunks.
  final AgentSdkTransport transport;

  int _counter = 0;

  AgentSdkClient(this.transport);

  /// Mirrors `sdk.query({prompt, options})`.
  ///
  /// Returns an [AgentQuery] that emits each `SDKMessage` the extension relays
  /// for this query. The query is started lazily when the stream is first
  /// listened to. Cancelling the subscription (or calling
  /// [AgentQuery.interrupt]) aborts it.
  AgentQuery query({required String prompt, Options? options}) {
    final streamId = _nextStreamId();
    final controller = StreamController<SdkMessage>();
    StreamSubscription<Map<String, dynamic>>? sub;
    var finished = false;

    // Index any Dart-defined (`sdk`) MCP tool handlers so the extension can
    // invoke them mid-query over the reverse RPC (todo #5).
    final toolRegistry = AgentSdkToolRegistry();
    final hasTools = toolRegistry.addServers(options?.mcpServers);

    // The caller's `canUseTool` approval callback, dispatched over the reverse
    // RPC whenever the model requests a tool (todo #6).
    final canUseTool = options?.canUseTool;

    Future<void> finish({bool cancelRemote = false}) async {
      if (finished) return;
      finished = true;
      if (hasTools) {
        transport.unregisterTools(streamId);
      }
      if (canUseTool != null) {
        transport.unregisterCanUseTool(streamId);
      }
      await sub?.cancel();
      if (cancelRemote) {
        try {
          await transport.cancelQuery(streamId);
        } catch (_) {
          // Best-effort: the remote may already have completed.
        }
      }
      if (!controller.isClosed) {
        await controller.close();
      }
    }

    controller.onListen = () {
      // Subscribe to chunks *before* starting the query so no early message
      // is dropped between start and subscription.
      sub = transport.chunks
          .where((chunk) => chunk['streamId'] == streamId)
          .listen((chunk) {
        if (finished) return;
        final error = chunk['error'];
        if (error != null) {
          controller.addError(AgentSdkQueryException(error.toString()));
          finish();
          return;
        }
        if (chunk['done'] == true) {
          finish();
          return;
        }
        final message = chunk['message'];
        if (message is Map) {
          controller.add(SdkMessage.fromJson(message.cast<String, dynamic>()));
        }
      });

      // Register tool handlers before starting so an early `agentSdk.toolCall`
      // cannot arrive before the registry is in place.
      if (hasTools) {
        transport.registerTools(streamId, toolRegistry);
      }

      // Likewise register the approval callback before starting so an early
      // `agentSdk.canUseTool` request has a handler.
      if (canUseTool != null) {
        transport.registerCanUseTool(streamId, canUseTool);
      }

      transport.startQuery({
        'streamId': streamId,
        'prompt': prompt,
        if (options != null) 'options': options.toJson(),
      }).catchError((Object e) {
        if (finished) return;
        controller.addError(e);
        finish();
      });
    };

    // A subscriber cancelling the stream aborts the underlying query.
    controller.onCancel = () => finish(cancelRemote: true);

    return AgentQuery._(
      controller.stream,
      interrupt: () => finish(cancelRemote: true),
    );
  }

  /// One-line convenience over [query]: runs the query to completion and
  /// returns every message. Mirrors `await query(...).toList()`.
  Future<List<SdkMessage>> collectQuery({
    required String prompt,
    Options? options,
  }) {
    return query(prompt: prompt, options: options).toList();
  }

  String _nextStreamId() =>
      'agentsdk-${DateTime.now().microsecondsSinceEpoch}-${_counter++}';
}

/// Production [AgentSdkTransport] backed by a [VSCodeBridgeClient].
///
/// Starts/cancels queries with the client's request channel and listens for
/// `agentSdk.chunk` notifications on the client's [VSCodeBridgeClient.notifications]
/// stream.
///
/// NOTE: end-to-end delivery of `agentSdk.chunk` over the CLI socket also
/// requires the `tom_vscode_bridge` CLI server to relay extension notifications
/// to the connected client (today it only relays `log`). That relay is tracked
/// as a completion step for this todo; this class is the correct client half.
class VSCodeBridgeAgentSdkTransport implements AgentSdkTransport {
  /// The connected bridge client.
  final VSCodeBridgeClient client;

  /// Per-stream tool registries, routed to by an incoming `agentSdk.toolCall`'s
  /// `streamId`. One method-keyed request handler serves every concurrent query.
  final Map<String, AgentSdkToolRegistry> _toolRegistries = {};

  /// Whether the single `agentSdk.toolCall` request handler is installed.
  bool _toolHandlerRegistered = false;

  /// Per-stream `canUseTool` callbacks, routed to by an incoming
  /// `agentSdk.canUseTool` request's `streamId`. One method-keyed handler
  /// serves every concurrent query.
  final Map<String, CanUseTool> _canUseToolHandlers = {};

  /// Whether the single `agentSdk.canUseTool` request handler is installed.
  bool _canUseToolHandlerRegistered = false;

  VSCodeBridgeAgentSdkTransport(this.client);

  @override
  Stream<Map<String, dynamic>> get chunks => client.notifications
      .where((n) => n['method'] == 'agentSdk.chunk')
      .map((n) => (n['params'] as Map?)?.cast<String, dynamic>() ?? const {});

  @override
  Future<void> startQuery(Map<String, dynamic> params) async {
    await client.sendRequest('agentSdk.queryVce', params);
  }

  @override
  Future<void> cancelQuery(String streamId) async {
    await client.sendRequest('agentSdk.cancelVce', {'streamId': streamId});
  }

  @override
  void registerTools(String streamId, AgentSdkToolRegistry registry) {
    _toolRegistries[streamId] = registry;
    if (!_toolHandlerRegistered) {
      _toolHandlerRegistered = true;
      // One method-keyed handler routes by streamId, so concurrent queries
      // (each with its own registry) share the single `agentSdk.toolCall` hook.
      client.registerRequestHandler('agentSdk.toolCall', _dispatchToolCall);
    }
  }

  @override
  void unregisterTools(String streamId) {
    _toolRegistries.remove(streamId);
  }

  /// Routes an incoming `agentSdk.toolCall` to the registry for its `streamId`.
  Future<Object?> _dispatchToolCall(Map<String, dynamic> params) {
    final streamId = params['streamId'] as String?;
    final registry = _toolRegistries[streamId];
    if (registry == null) {
      throw ArgumentError('No tool registry for streamId "$streamId"');
    }
    return registry.handleToolCall(params);
  }

  @override
  void registerCanUseTool(String streamId, CanUseTool callback) {
    _canUseToolHandlers[streamId] = callback;
    if (!_canUseToolHandlerRegistered) {
      _canUseToolHandlerRegistered = true;
      // One method-keyed handler routes by streamId, so concurrent queries
      // (each with its own callback) share the single `agentSdk.canUseTool` hook.
      client.registerRequestHandler('agentSdk.canUseTool', _dispatchCanUseTool);
    }
  }

  @override
  void unregisterCanUseTool(String streamId) {
    _canUseToolHandlers.remove(streamId);
  }

  /// Routes an incoming `agentSdk.canUseTool` to the callback for its `streamId`.
  Future<Object?> _dispatchCanUseTool(Map<String, dynamic> params) {
    final streamId = params['streamId'] as String?;
    final callback = _canUseToolHandlers[streamId];
    if (callback == null) {
      throw ArgumentError('No canUseTool handler for streamId "$streamId"');
    }
    return dispatchCanUseTool(callback, params);
  }
}
