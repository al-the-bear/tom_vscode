import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:tom_vscode_bridge/bridge_server.dart';

/// Default port for Tom CLI integration server
const int defaultCliServerPort = 19900;

/// Maximum port in the allocated range for CLI integration server
const int maxCliServerPort = 19909;

/// TCP Socket server for Tom CLI integration
/// 
/// This server accepts connections from Tom CLI and forwards requests
/// to the VS Code bridge, returning responses back to the CLI.
/// 
/// Protocol: Length-prefix framing with JSON-RPC 2.0 messages
/// - 4 bytes: message length (big-endian uint32)
/// - N bytes: JSON payload
class CliIntegrationServer {
  final VSCodeBridgeServer _bridgeServer;
  final int port;
  
  ServerSocket? _serverSocket;
  final List<Socket> _clients = [];
  bool _isRunning = false;

  /// Maps an Agent SDK `streamId` to the client socket that started that query
  /// (via `agentSdk.queryVce`). Server→client traffic the extension pushes for
  /// a stream — `agentSdk.chunk` notifications and `agentSdk.toolCall` /
  /// `agentSdk.canUseTool` reverse-RPC requests — is routed back only to the
  /// originating client, not broadcast to every connection.
  final Map<String, Socket> _agentSdkStreamOwners = {};

  /// Subscription to the bridge's [VSCodeBridgeServer.extensionPushMessages]
  /// relay channel; active only while the server is running.
  StreamSubscription<Map<String, dynamic>>? _pushSubscription;

  /// Whether the server is currently running
  bool get isRunning => _isRunning;
  
  /// The port the server is listening on (or will listen on)
  int get serverPort => port;
  
  CliIntegrationServer(this._bridgeServer, {this.port = defaultCliServerPort});

  /// Test-only: the actual port the server socket is bound to. Differs from
  /// [serverPort] when the server is constructed with `port: 0` to take an
  /// ephemeral port (the robust choice for parallel-safe tests).
  int get debugBoundPort => _serverSocket?.port ?? port;

  /// Test-only: register the most recently connected client as the owner of
  /// [streamId], mirroring the `agentSdk.queryVce` ownership registration (see
  /// [_handleMessage]) without forwarding a hanging `*Vce` request to the
  /// extension. Returns `false` if no client is connected yet.
  bool debugRegisterStreamOwner(String streamId) {
    if (_clients.isEmpty) return false;
    _agentSdkStreamOwners[streamId] = _clients.last;
    return true;
  }

  /// Test-only: stream ids currently owned by a connected client.
  Set<String> get debugOwnedStreamIds => _agentSdkStreamOwners.keys.toSet();

  /// Test-only: number of currently connected clients.
  int get debugClientCount => _clients.length;

  /// Start the TCP socket server
  /// 
  /// Throws [SocketException] if the port is already in use.
  Future<void> start() async {
    if (_isRunning) {
      throw StateError('CLI integration server is already running on port $port');
    }
    
    try {
      _serverSocket = await ServerSocket.bind(
        InternetAddress.loopbackIPv4, // localhost only for security
        port,
        shared: false, // Don't share port with other processes
      );
      
      _isRunning = true;
      _log('CLI integration server started on port $port');

      // Relay Agent SDK server→client traffic (chunks + reverse-RPC) the
      // extension pushes to the bridge back out to the originating CLI client.
      _pushSubscription = _bridgeServer.extensionPushMessages.listen(
        _relayPushMessage,
      );

      _serverSocket!.listen(
        _handleConnection,
        onError: _handleServerError,
        onDone: _handleServerDone,
      );
    } on SocketException catch (e) {
      if (e.osError?.errorCode == 48 || e.osError?.errorCode == 98) {
        // 48 = macOS "Address already in use", 98 = Linux equivalent
        throw SocketException(
          'Port $port is already in use. Another CLI integration server may be running.',
          osError: e.osError,
          address: e.address,
          port: e.port,
        );
      }
      rethrow;
    }
  }
  
  /// Stop the TCP socket server
  Future<void> stop() async {
    if (!_isRunning) return;
    
    _log('Stopping CLI integration server...');

    // Stop relaying extension push traffic and drop stream ownership.
    await _pushSubscription?.cancel();
    _pushSubscription = null;
    _agentSdkStreamOwners.clear();

    // Close all client connections
    for (final client in _clients.toList()) {
      try {
        await client.close();
      } catch (e) {
        _log('Error closing client: $e');
      }
    }
    _clients.clear();
    
    // Close the server socket
    await _serverSocket?.close();
    _serverSocket = null;
    _isRunning = false;
    
    _log('CLI integration server stopped');
  }
  
  /// Handle a new client connection
  void _handleConnection(Socket client) {
    final clientAddress = '${client.remoteAddress.address}:${client.remotePort}';
    _log('Client connected: $clientAddress');
    _clients.add(client);
    
    // Buffer for accumulating data until we have a complete message
    final buffer = BytesBuilder();
    int? expectedLength;
    
    client.listen(
      (Uint8List data) async {
        buffer.add(data);
        
        // Process complete messages from buffer
        while (true) {
          final bytes = buffer.toBytes();
          
          // Need at least 4 bytes for length prefix
          if (bytes.length < 4) break;
          
          // Read expected message length if not already known
          expectedLength ??= _readUint32BE(bytes, 0);
          
          // Check if we have the complete message
          if (bytes.length < 4 + expectedLength!) break;
          
          // Extract the message
          final messageBytes = bytes.sublist(4, 4 + expectedLength!);
          final message = utf8.decode(messageBytes);
          
          // Remove processed bytes from buffer
          final remaining = bytes.sublist(4 + expectedLength!);
          buffer.clear();
          if (remaining.isNotEmpty) {
            buffer.add(remaining);
          }
          expectedLength = null;
          
          // Handle the message - wrap in try-catch to prevent unhandled exceptions
          // when client disconnects during processing
          unawaited(_handleMessage(client, message).catchError((e) {
            _log('Error handling message from $clientAddress: $e');
          }));
        }
      },
      onError: (error) {
        _log('Client error ($clientAddress): $error');
        _removeClient(client);
      },
      onDone: () {
        _log('Client disconnected: $clientAddress');
        _removeClient(client);
      },
      cancelOnError: false, // Don't cancel subscription on error
    );
  }
  
  /// Read a big-endian uint32 from bytes
  int _readUint32BE(Uint8List bytes, int offset) {
    return (bytes[offset] << 24) |
           (bytes[offset + 1] << 16) |
           (bytes[offset + 2] << 8) |
           bytes[offset + 3];
  }
  
  /// Write a big-endian uint32 to bytes
  Uint8List _writeUint32BE(int value) {
    return Uint8List.fromList([
      (value >> 24) & 0xFF,
      (value >> 16) & 0xFF,
      (value >> 8) & 0xFF,
      value & 0xFF,
    ]);
  }
  
  /// Handle a complete JSON-RPC message from a client
  Future<void> _handleMessage(Socket client, String messageStr) async {
    try {
      final message = jsonDecode(messageStr) as Map<String, dynamic>;
      final method = message['method'] as String?;
      final id = message['id'];
      final params = message['params'] as Map<String, dynamic>? ?? {};
      
      if (BridgeLogging.debugLogging) {
        _log('← CLI Request: $method (id: $id)');
      }

      if (method == null) {
        // A reply (no `method`, has `id`) is the client's answer to an Agent
        // SDK reverse-RPC request (`agentSdk.toolCall` / `agentSdk.canUseTool`)
        // that the bridge relayed from the extension. Forward it back to the
        // extension verbatim so its ServerToClientRpc can correlate it.
        if (id != null &&
            (message.containsKey('result') || message.containsKey('error'))) {
          _bridgeServer.forwardReplyToExtension(message);
          return;
        }
        _sendError(client, id, 'Missing method in request');
        return;
      }

      // Remember which client owns an Agent SDK stream so the extension's
      // server→client traffic for it is routed back to this client only.
      if (method == 'agentSdk.queryVce') {
        final streamId = params['streamId'] as String?;
        if (streamId != null) {
          _agentSdkStreamOwners[streamId] = client;
        }
      }

      // Handle the request using the bridge server's handler with socket-based logging
      try {
        final result = await _bridgeServer.handleCliRequest(
          method,
          params,
          id,
          (logMessage) => _sendLogNotification(client, logMessage),
        );
        _sendResponse(client, id, result);
      } catch (e, stackTrace) {
        _sendError(client, id, e.toString(), stackTrace.toString());
      } finally {
        // A cancel ends the stream; drop ownership so it can be reused.
        if (method == 'agentSdk.cancelVce') {
          final streamId = params['streamId'] as String?;
          if (streamId != null) {
            _agentSdkStreamOwners.remove(streamId);
          }
        }
      }
    } catch (e) {
      _log('Failed to parse message: $e');
      _sendError(client, null, 'Failed to parse JSON: $e');
    }
  }
  
  /// Send a log notification to the client socket
  void _sendLogNotification(Socket client, String message) {
    final notification = {
      'jsonrpc': '2.0',
      'method': 'log',
      'params': {'message': message},
    };
    _sendMessage(client, jsonEncode(notification));
  }
  
  /// Relay an Agent SDK server→client message (pushed by the extension to the
  /// bridge) to the CLI client that owns its `streamId`.
  ///
  /// `agentSdk.chunk` notifications and `agentSdk.toolCall` /
  /// `agentSdk.canUseTool` reverse-RPC requests all carry a `streamId` in their
  /// params. The message is sent only to the originating client; if the owner
  /// is unknown (or the message has no `streamId`) it is broadcast to every
  /// connected client as a fallback. A terminal `agentSdk.chunk` (`done` or
  /// `error`) releases the stream ownership.
  void _relayPushMessage(Map<String, dynamic> message) {
    final params = message['params'];
    final streamId = params is Map ? params['streamId'] as String? : null;
    final encoded = jsonEncode(message);

    if (streamId == null) {
      for (final client in _clients.toList()) {
        _sendMessage(client, encoded);
      }
      return;
    }

    final owner = _agentSdkStreamOwners[streamId];
    if (owner != null && _clients.contains(owner)) {
      _sendMessage(owner, encoded);
    } else {
      // Owner unknown/disconnected: broadcast so a late-binding client can
      // still correlate by streamId.
      for (final client in _clients.toList()) {
        _sendMessage(client, encoded);
      }
    }

    // Release ownership once the stream completes.
    if (message['method'] == 'agentSdk.chunk' &&
        params is Map &&
        (params['done'] == true || params['error'] != null)) {
      _agentSdkStreamOwners.remove(streamId);
    }
  }

  /// Send a JSON-RPC response to a client
  void _sendResponse(Socket client, Object? id, dynamic result) {
    final response = {
      'jsonrpc': '2.0',
      'id': id,
      'result': result,
    };
    _sendMessage(client, jsonEncode(response));
  }
  
  /// Send a JSON-RPC error to a client
  void _sendError(Socket client, Object? id, String message, [String? data]) {
    final response = {
      'jsonrpc': '2.0',
      'id': id,
      'error': {
        'code': -32000,
        'message': message,
        if (data != null) 'data': data,
      },
    };
    _sendMessage(client, jsonEncode(response));
  }
  
  /// Send a length-prefixed message to a client
  void _sendMessage(Socket client, String message) {
    // Don't attempt to send if client is not connected
    if (!_clients.contains(client)) {
      return;
    }
    
    final messageBytes = utf8.encode(message);
    final lengthBytes = _writeUint32BE(messageBytes.length);
    
    try {
      client.add(lengthBytes);
      client.add(messageBytes);
      // Flush and catch any socket errors
      unawaited(client.flush().catchError((e) {
        _log('Failed to flush message to client: $e');
        _removeClient(client);
      }));
    } on SocketException catch (e) {
      _log('Socket error sending message to client: $e');
      _removeClient(client);
    } catch (e) {
      _log('Failed to send message to client: $e');
      _removeClient(client);
    }
    
    if (BridgeLogging.debugLogging) {
      _log('→ CLI Response: ${message.length > 200 ? '${message.substring(0, 200)}...' : message}');
    }
  }
  
  void _removeClient(Socket client) {
    _clients.remove(client);
    // Drop any Agent SDK streams this client owned so stale routing entries
    // don't linger after it disconnects.
    _agentSdkStreamOwners.removeWhere((_, owner) => identical(owner, client));
    try {
      client.destroy();
    } catch (e) {
      // Ignore
    }
  }
  
  void _handleServerError(dynamic error) {
    _log('Server error: $error');
  }
  
  void _handleServerDone() {
    _log('Server socket closed');
    _isRunning = false;
  }
  
  void _log(String message) {
    stderr.writeln('[CliServer] $message');
  }
}
