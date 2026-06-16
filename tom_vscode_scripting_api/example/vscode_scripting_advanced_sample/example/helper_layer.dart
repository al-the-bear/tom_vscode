/// Concept: the `VsCodeHelper` static convenience layer.
///
/// Run:  dart run bin/run_example.dart helper_layer
///
/// Everything in the other concepts goes through the `VSCode` singleton
/// (`vscode.workspace.…`, `vscode.window.…`). `VsCodeHelper` is a thin static
/// façade over that same singleton: once `VSCode.initialize(adapter)` has run,
/// you can call `VsCodeHelper.writeFile(...)` without threading a `vscode`
/// handle through every function. It's the ergonomic layer for short scripts.
///
/// This concept proves the two layers operate on the same connection: it reads
/// the window id and workspace root through the helper, round-trips a scratch
/// file through `VsCodeHelper.writeFile`/`readFile`, and verifies the result
/// with the singleton's `workspace.fileExists` — helper-written, singleton-read.
///
/// Expected output:
///   Helper sees window "<id>" rooted at <root>.
///   Round-tripped a scratch file through the helper layer.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

/// Concept body: read identity via the helper, round-trip a file across both
/// layers, then clean up.
Future<bool> runHelperLayerExample(VSCode vscode) async {
  // The helper resolves the same singleton the other concepts use.
  final windowId = await VsCodeHelper.getWindowId();
  final root = await VsCodeHelper.getWorkspaceRoot();
  if (root == null) {
    print('No workspace folder open; cannot demonstrate the helper layer.');
    return false;
  }
  print('Helper sees window "$windowId" rooted at $root.');

  final dir = await scratchDir(vscode, 'helper_layer');
  if (dir == null) return false;
  final path = '$dir/helper_${VsCodeHelper.generateTimestampId()}.txt';
  const payload = 'written through VsCodeHelper';

  // Write through the static helper …
  await VsCodeHelper.writeFile(path, payload);
  // … and read back through the singleton, to prove they share a connection.
  final exists = await vscode.workspace.fileExists(path);
  final readBack = exists ? await vscode.workspace.readFile(path) : '';
  await vscode.workspace.deleteFile(path);

  final ok = exists && readBack == payload;
  print(
    ok
        ? 'Round-tripped a scratch file through the helper layer.'
        : 'Helper round-trip did not verify.',
  );
  return ok;
}
