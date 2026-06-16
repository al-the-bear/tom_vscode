/// Aggregator: connect once, run every advanced concept, tally results.
///
/// Run:  dart run example/run_all_examples.dart
///   (or via the wrappers: ./run_example.sh  /  ./run_example.ps1)
///
/// Concepts flagged `interactive: true` block on the user (quick pick / input
/// box), so the auto-run **skips** them — a headless aggregator must never
/// hang. Run those directly through the dispatcher when a human is present:
///   dart run bin/run_example.dart quick_pick_input
///
/// Exit codes:
///   0  all non-interactive examples passed, OR no live VS Code bridge was
///      found (skipped — the socket calls have a documented live-window
///      prerequisite).
///   1  at least one example failed against a live window.
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'editor_edits.dart';
import 'file_batch.dart';
import 'helper_layer.dart';
import 'language_model.dart';
import 'progress.dart';
import 'quick_pick_input.dart';
import 'support.dart';

/// One named concept to run against a connected [VSCode] window.
///
/// `interactive` concepts block on user input and are skipped by the auto-run;
/// invoke them by name through `bin/run_example.dart` when a human is present.
typedef Example = ({
  String name,
  Future<bool> Function(VSCode) run,
  bool interactive,
});

/// The advanced concepts, in teaching order.
const List<Example> advancedExamples = [
  (name: 'file_batch', run: runFileBatchExample, interactive: false),
  (name: 'editor_edits', run: runEditorEditsExample, interactive: false),
  (name: 'progress', run: runProgressExample, interactive: false),
  (name: 'helper_layer', run: runHelperLayerExample, interactive: false),
  (name: 'language_model', run: runLanguageModelExample, interactive: false),
  (name: 'quick_pick_input', run: runQuickPickInputExample, interactive: true),
];

Future<void> main() => runAllExamples();

/// Connect once, run every non-interactive concept, tally, and set the process
/// exit code. Exposed so the dispatcher (`bin/run_example.dart all`) can reuse
/// it.
Future<void> runAllExamples() async {
  final adapter = await connectToFirstWindow();
  if (adapter == null) {
    // No live window: a documented prerequisite, not a failure.
    exit(0);
  }

  final vscode = VSCode.instance;
  final failures = <String>[];
  var skipped = 0;

  try {
    for (final example in advancedExamples) {
      if (example.interactive) {
        skipped++;
        stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
        continue;
      }
      stdout.writeln('\n=== ${example.name} ===');
      try {
        final ok = await example.run(vscode);
        if (!ok) failures.add(example.name);
        stdout.writeln(
          ok ? '  [PASS] ${example.name}' : '  [FAIL] ${example.name}',
        );
      } catch (e, st) {
        failures.add(example.name);
        stdout.writeln('  [FAIL] ${example.name}: $e');
        stderr.writeln(st);
      }
    }
  } finally {
    await adapter.disconnect();
  }

  final ran = advancedExamples.length - skipped;
  final passed = ran - failures.length;
  stdout.writeln('\n$passed/$ran examples passed ($skipped interactive '
      'skipped).');
  if (failures.isNotEmpty) {
    stdout.writeln('Failed: ${failures.join(', ')}');
    exit(1);
  }
  // The bridge client keeps a socket open; exit explicitly so the VM doesn't
  // linger after all examples have run.
  exit(0);
}
