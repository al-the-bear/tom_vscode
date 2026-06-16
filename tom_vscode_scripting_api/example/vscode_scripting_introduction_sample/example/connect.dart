/// Concept: connect to a running VS Code window and read its identity.
///
/// Run:  dart run bin/run_example.dart connect
///
/// Every other example in this sample receives an already-connected
/// [VSCode] instance; this file owns the one piece of infrastructure they
/// share — [connectToFirstWindow] — and demonstrates the simplest thing you
/// can do once connected: ask the window who it is.
///
/// The bridge is a CLI Integration Server that each VS Code window runs on a
/// distinct localhost port in the range 19900–19909. Start it from the command
/// palette with **DS: Start Tom CLI Integration Server**. With no server
/// running, [connectToFirstWindow] returns `null` and the samples report the
/// prerequisite rather than throwing.
///
/// Expected output (with one window open on port 19900):
///   Connected to "tom_agent_container" on 127.0.0.1:19900
///   VS Code version: 1.xx.x
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Scans the CLI bridge port range, connects to the first responsive window,
/// promotes its adapter to the global [VSCode] singleton, and returns the
/// connected adapter (so the caller can [LazyVSCodeBridgeAdapter.disconnect]
/// when done).
///
/// Returns `null` — after printing a clear prerequisite message — when no
/// window is running a CLI Integration Server in the scanned range.
Future<LazyVSCodeBridgeAdapter?> connectToFirstWindow({
  String host = '127.0.0.1',
}) async {
  final windows = await scanBridgePorts(host: host);
  if (windows.isEmpty) {
    print(
      'No VS Code CLI Integration Server found on $host:'
      '$defaultVSCodeBridgePort–$maxVSCodeBridgePort.',
    );
    print(
      'Open a VS Code window with the Tom extension active and run '
      '"DS: Start Tom CLI Integration Server", then try again.',
    );
    return null;
  }

  final port = windows.keys.first;
  final identity = windows[port];
  final adapter = LazyVSCodeBridgeAdapter(host: host, port: port);
  if (!await adapter.connect()) {
    print('Found a window on $host:$port but could not connect to its bridge.');
    return null;
  }

  VSCode.initialize(adapter);
  print('Connected to "$identity" on $host:$port');
  return adapter;
}

/// Concept body: read the connected window's version. Assumes [vscode] is
/// already connected (the aggregator and dispatcher own the connection).
Future<bool> runConnectExample(VSCode vscode) async {
  final version = await vscode.getVersion();
  print('VS Code version: $version');
  return version.isNotEmpty;
}
