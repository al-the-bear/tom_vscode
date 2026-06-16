/// Aggregator: connect once, run every introduction concept, tally results.
///
/// Run:  dart run example/run_all_examples.dart
///   (or via the wrappers: ./run_example.sh  /  ./run_example.ps1)
///
/// Exit codes:
///   0  all examples passed, OR no live VS Code bridge was found (skipped —
///      the socket calls have a documented live-window prerequisite).
///   1  at least one example failed against a live window.
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'commands.dart';
import 'connect.dart';
import 'messages.dart';
import 'read_open_file.dart';
import 'workspace_folders.dart';

/// One named concept to run against a connected [VSCode] window.
typedef Example = ({String name, Future<bool> Function(VSCode) run});

/// The introduction concepts, in teaching order.
const List<Example> introductionExamples = [
  (name: 'connect', run: runConnectExample),
  (name: 'messages', run: runMessagesExample),
  (name: 'commands', run: runCommandsExample),
  (name: 'workspace_folders', run: runWorkspaceFoldersExample),
  (name: 'read_open_file', run: runReadOpenFileExample),
];

Future<void> main() => runAllExamples();

/// Connect once, run every concept, tally, and set the process exit code.
/// Exposed so the dispatcher (`bin/run_example.dart all`) can reuse it.
Future<void> runAllExamples() async {
  final adapter = await connectToFirstWindow();
  if (adapter == null) {
    // No live window: a documented prerequisite, not a failure.
    exit(0);
  }

  final vscode = VSCode.instance;
  final failures = <String>[];

  try {
    for (final example in introductionExamples) {
      stdout.writeln('\n=== ${example.name} ===');
      try {
        final ok = await example.run(vscode);
        if (!ok) failures.add(example.name);
        stdout.writeln(ok ? '  [PASS] ${example.name}' : '  [FAIL] ${example.name}');
      } catch (e, st) {
        failures.add(example.name);
        stdout.writeln('  [FAIL] ${example.name}: $e');
        stderr.writeln(st);
      }
    }
  } finally {
    await adapter.disconnect();
  }

  final total = introductionExamples.length;
  final passed = total - failures.length;
  stdout.writeln('\n$passed/$total examples passed.');
  if (failures.isNotEmpty) {
    stdout.writeln('Failed: ${failures.join(', ')}');
    exit(1);
  }
  // The bridge client keeps a socket open; exit explicitly so the VM doesn't
  // linger after all examples have run.
  exit(0);
}
