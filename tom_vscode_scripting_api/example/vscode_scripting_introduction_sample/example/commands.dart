/// Concept: enumerate and execute VS Code commands.
///
/// Run:  dart run bin/run_example.dart commands
///
/// `commands.getCommands()` returns every command id the window knows about;
/// `commands.executeCommand(id, [args])` runs one and returns its result. Here
/// we run `workbench.action.files.save`, a safe no-op when nothing is dirty.
///
/// Expected output:
///   Window exposes <N> commands.
///   A few: workbench.action.files.save, workbench.action.closeActiveEditor, ...
///   Executed workbench.action.files.save -> <result>
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: list the command surface and execute a harmless command.
Future<bool> runCommandsExample(VSCode vscode) async {
  final commands = await vscode.commands.getCommands();
  print('Window exposes ${commands.length} commands.');
  final sample = commands.take(5).join(', ');
  print('A few: $sample');

  final result = await vscode.commands.executeCommand(
    'workbench.action.files.save',
  );
  print('Executed workbench.action.files.save -> $result');
  return commands.isNotEmpty;
}
