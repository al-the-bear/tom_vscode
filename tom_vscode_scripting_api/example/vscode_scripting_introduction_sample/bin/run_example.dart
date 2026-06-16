/// Dispatcher: run a single introduction concept by name.
///
///   dart run bin/run_example.dart <name> [host]
///
/// where <name> is one of:
///   connect, messages, commands, workspace_folders, read_open_file
///
/// With no name (or `all`), this delegates to the aggregator. The optional
/// second argument overrides the bridge host (default 127.0.0.1).
///
/// Connects once to the first responsive VS Code window, runs the requested
/// concept, then disconnects. Exits non-zero if the concept fails; exits 0
/// when no live bridge is found (the documented live-window prerequisite).
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import '../example/commands.dart';
import '../example/connect.dart';
import '../example/messages.dart';
import '../example/read_open_file.dart';
import '../example/run_all_examples.dart';
import '../example/workspace_folders.dart';

final Map<String, Future<bool> Function(VSCode)> _examples = {
  'connect': runConnectExample,
  'messages': runMessagesExample,
  'commands': runCommandsExample,
  'workspace_folders': runWorkspaceFoldersExample,
  'read_open_file': runReadOpenFileExample,
};

Future<void> main(List<String> args) async {
  final name = args.isEmpty ? 'all' : args.first;
  final host = args.length > 1 ? args[1] : '127.0.0.1';

  if (name == 'all') {
    await runAllExamples();
    return;
  }

  final example = _examples[name];
  if (example == null) {
    stderr.writeln('Unknown example: $name');
    stderr.writeln('Available: ${_examples.keys.join(', ')}, all');
    exit(64); // EX_USAGE
  }

  final adapter = await connectToFirstWindow(host: host);
  if (adapter == null) {
    exit(0); // documented live-window prerequisite, not a failure
  }

  try {
    final ok = await example(VSCode.instance);
    if (!ok) exit(1);
  } finally {
    await adapter.disconnect();
  }
  // The bridge client keeps a socket open; exit explicitly so the VM doesn't
  // linger after the example has run.
  exit(0);
}
