/// Concept: inspect the connected window's workspace.
///
/// Run:  dart run bin/run_example.dart workspace_folders
///
/// A window may have zero, one, or several root folders (multi-root
/// workspaces). `workspace.getWorkspaceFolders()` lists them; `getRootPath()`
/// and `getWorkspaceName()` return the primary root and the workspace label.
///
/// Expected output:
///   Workspace: <name> (root: <path or null>)
///   1 folder(s):
///     - tom_agent_container -> /abs/path/to/tom_agent_container
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: print the workspace identity and its root folders.
Future<bool> runWorkspaceFoldersExample(VSCode vscode) async {
  final name = await vscode.workspace.getWorkspaceName();
  final root = await vscode.workspace.getRootPath();
  print('Workspace: $name (root: $root)');

  final folders = await vscode.workspace.getWorkspaceFolders();
  print('${folders.length} folder(s):');
  for (final folder in folders) {
    print('  - ${folder.name} -> ${folder.uri.fsPath}');
  }
  return true;
}
