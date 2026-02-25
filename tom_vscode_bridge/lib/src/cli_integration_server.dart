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
  
  /// Whether the server is currently running
  bool get isRunning => _isRunning;
  
  /// The port the server is listening on (or will listen on)
  int get serverPort => port;
  
  CliIntegrationServer(this._bridgeServer, {this.port = defaultCliServerPort});
  
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
        _sendError(client, id, 'Missing method in request');
        return;
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
