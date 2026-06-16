/// Shared infrastructure for the agent-tools samples.
///
/// Unlike the scripting samples, the concepts here drive the Tom AI
/// extension's **own** feature APIs (`TomWorkspaceApi`, `TomTodoApi`, …). Those
/// are static-method classes that each need their adapter set with
/// `<Class>.setAdapter(adapter)` — they do **not** read the `VSCode` singleton.
/// So this helper returns the connected *adapter*, and each concept sets it on
/// the API class(es) it uses.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Scans the CLI bridge port range, connects to the first responsive window,
/// and returns the connected adapter. Returns `null` — after printing a
/// prerequisite message — when no window is running a CLI Integration Server.
///
/// See `vscode_scripting_introduction_sample/example/connect.dart` for the
/// line-by-line explanation of the scan/connect handshake.
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

  print('Connected to "$identity" on $host:$port');
  return adapter;
}
