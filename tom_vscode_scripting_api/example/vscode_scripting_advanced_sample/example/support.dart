/// Shared infrastructure for the advanced samples.
///
/// The introduction sample taught the connection model; this file just reuses
/// it so the advanced concepts can focus on what they demonstrate. It also
/// provides a [scratchDir] helper that gives each file-touching concept a
/// private, cleaned-up working directory inside the connected window's
/// workspace.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Scans the CLI bridge port range, connects to the first responsive window,
/// promotes its adapter to the global [VSCode] singleton, and returns the
/// connected adapter. Returns `null` — after printing a prerequisite message —
/// when no window is running a CLI Integration Server.
///
/// See `vscode_scripting_introduction_sample/example/connect.dart` for the
/// line-by-line explanation of this helper.
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

/// Absolute path to a private scratch directory under the connected window's
/// workspace root, or `null` when the window has no folder open.
///
/// The directory is `<workspaceRoot>/ztmp/advanced_sample/<sub>`; callers are
/// responsible for creating files inside it and cleaning them up.
Future<String?> scratchDir(VSCode vscode, String sub) async {
  final root = await vscode.workspace.getRootPath();
  if (root == null) return null;
  return '$root/ztmp/advanced_sample/$sub';
}
