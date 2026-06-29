// Tests for the CLI integration server's Agent SDK push relay (OE-6).
//
// The bridge accepts `agentSdk.chunk` streaming notifications (and the
// `agentSdk.toolCall` / `agentSdk.canUseTool` reverse-RPC requests) that the
// VS Code extension pushes over stdin, forwards them onto its
// `extensionPushMessages` channel, and the `CliIntegrationServer` relays them
// back over the CLI socket to the client that owns the stream's `streamId`.
//
// These tests pin that relay's routing contract end-to-end over real loopback
// sockets:
//   * a chunk for a known streamId reaches only the owning client;
//   * a chunk with no streamId, or an unknown streamId, broadcasts as a
//     fallback so a late-binding client can still correlate;
//   * a terminal chunk (`done`/`error`) releases the stream ownership;
//   * a client disconnect drops any ownership it held.
//
// The extension half (stdin) is replaced by `debugInjectExtensionPush`, which
// feeds the *same* internal relay channel `_handleMessage` uses for the
// allow-listed push methods — so the relay routing under test is the real one.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:tom_vscode_bridge/bridge_server.dart';
import 'package:tom_vscode_bridge/src/cli_integration_server.dart';
import 'package:test/test.dart';

/// A loopback client that decodes the bridge's length-prefixed (4-byte BE
/// uint32 + UTF-8 JSON) frames into a broadcast stream of JSON maps.
class _FrameClient {
  final Socket socket;
  final _frames = StreamController<Map<String, dynamic>>.broadcast();
  final _buffer = BytesBuilder();
  int? _expected;

  _FrameClient._(this.socket) {
    socket.listen(_onData);
  }

  static Future<_FrameClient> connect(int port) async {
    final socket = await Socket.connect(InternetAddress.loopbackIPv4, port);
    return _FrameClient._(socket);
  }

  Stream<Map<String, dynamic>> get frames => _frames.stream;

  void _onData(Uint8List data) {
    _buffer.add(data);
    while (true) {
      final bytes = _buffer.toBytes();
      if (bytes.length < 4) break;
      _expected ??=
          (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
      if (bytes.length < 4 + _expected!) break;
      final json = utf8.decode(bytes.sublist(4, 4 + _expected!));
      final remaining = bytes.sublist(4 + _expected!);
      _buffer.clear();
      if (remaining.isNotEmpty) _buffer.add(remaining);
      _expected = null;
      _frames.add(jsonDecode(json) as Map<String, dynamic>);
    }
  }

  Future<void> close() async {
    await socket.close();
    await _frames.close();
  }
}

void main() {
  late VSCodeBridgeServer bridge;
  late CliIntegrationServer server;
  final openClients = <_FrameClient>[];

  setUp(() async {
    bridge = VSCodeBridgeServer();
    // port 0 → ephemeral bind, parallel-safe; read the real port back.
    server = CliIntegrationServer(bridge, port: 0);
    await server.start();
  });

  tearDown(() async {
    for (final client in openClients) {
      await client.close();
    }
    openClients.clear();
    await server.stop();
  });

  /// Connect a client and wait until the server has registered it.
  Future<_FrameClient> connectClient() async {
    final before = server.debugClientCount;
    final client = await _FrameClient.connect(server.debugBoundPort);
    openClients.add(client);
    await _waitFor(() => server.debugClientCount > before);
    return client;
  }

  /// Collect every frame a client receives into a growing list.
  List<Map<String, dynamic>> collect(_FrameClient client) {
    final out = <Map<String, dynamic>>[];
    client.frames.listen(out.add);
    return out;
  }

  Map<String, dynamic> chunk(
    String? streamId, {
    bool done = false,
    String? error,
    String? text,
  }) =>
      {
        'jsonrpc': '2.0',
        'method': 'agentSdk.chunk',
        'params': {
          if (streamId != null) 'streamId': streamId,
          if (text != null) 'message': text,
          'done': done,
          if (error != null) 'error': error,
        },
      };

  group('agentSdk.chunk relay routing (OE-6)', () {
    test('a chunk for a known streamId reaches only the owning client',
        () async {
      final owner = await connectClient();
      // The most recently connected client owns the stream.
      expect(server.debugRegisterStreamOwner('s1'), isTrue);
      final other = await connectClient();

      final ownerFrames = collect(owner);
      final otherFrames = collect(other);

      bridge.debugInjectExtensionPush(chunk('s1', text: 'hello'));
      await _settle();

      expect(ownerFrames, hasLength(1));
      expect(ownerFrames.single['method'], 'agentSdk.chunk');
      expect(ownerFrames.single['params']['message'], 'hello');
      // The non-owner sees nothing — the chunk is routed, not broadcast.
      expect(otherFrames, isEmpty);
    });

    test('a chunk with no streamId broadcasts to every client', () async {
      final a = await connectClient();
      final b = await connectClient();
      final aFrames = collect(a);
      final bFrames = collect(b);

      bridge.debugInjectExtensionPush(chunk(null, text: 'broadcast'));
      await _settle();

      expect(aFrames, hasLength(1));
      expect(bFrames, hasLength(1));
      expect(aFrames.single['params']['message'], 'broadcast');
      expect(bFrames.single['params']['message'], 'broadcast');
    });

    test('a chunk for an unknown streamId broadcasts as a fallback', () async {
      final a = await connectClient();
      final b = await connectClient();
      final aFrames = collect(a);
      final bFrames = collect(b);

      // No owner registered for 'ghost'.
      bridge.debugInjectExtensionPush(chunk('ghost', text: 'late-binding'));
      await _settle();

      expect(aFrames, hasLength(1));
      expect(bFrames, hasLength(1));
    });

    test('a terminal chunk (done) releases the stream ownership', () async {
      final owner = await connectClient();
      expect(server.debugRegisterStreamOwner('s1'), isTrue);
      expect(server.debugOwnedStreamIds, contains('s1'));

      final ownerFrames = collect(owner);
      bridge.debugInjectExtensionPush(chunk('s1', done: true));
      await _settle();

      // The owner still receives the terminal chunk…
      expect(ownerFrames, hasLength(1));
      expect(ownerFrames.single['params']['done'], isTrue);
      // …and the streamId is no longer owned afterwards.
      expect(server.debugOwnedStreamIds, isNot(contains('s1')));
    });

    test('a terminal chunk (error) releases the stream ownership', () async {
      await connectClient();
      expect(server.debugRegisterStreamOwner('s2'), isTrue);

      bridge.debugInjectExtensionPush(chunk('s2', error: 'boom'));
      await _settle();

      expect(server.debugOwnedStreamIds, isNot(contains('s2')));
    });

    test('a client disconnect drops any stream ownership it held', () async {
      final owner = await connectClient();
      expect(server.debugRegisterStreamOwner('s3'), isTrue);
      expect(server.debugOwnedStreamIds, contains('s3'));

      await owner.close();
      openClients.remove(owner);
      // The server detects the disconnect and clears its routing entry.
      await _waitFor(() => !server.debugOwnedStreamIds.contains('s3'));
      expect(server.debugClientCount, 0);
    });
  });
}

Future<void> _settle() => Future<void>.delayed(const Duration(milliseconds: 80));

Future<void> _waitFor(bool Function() condition) async {
  for (var i = 0; i < 200; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  throw StateError('condition not met within timeout');
}
