/// Aggregator: connect once, run every agent-tools concept, tally results.
///
/// Run:  dart run example/run_all_examples.dart
///   (or via the wrappers: ./run_example.sh  /  ./run_example.ps1)
///
/// These concepts drive the Tom extension's **own** feature APIs
/// (`TomWorkspaceApi`, `TomTodoApi`, …). Each is a static-method class, so every
/// concept sets the adapter on the API class(es) it uses with
/// `<Class>.setAdapter(adapter)` — there is no `VSCode` singleton here. That is
/// why each `run` takes a [VSCodeAdapter], not a `VSCode`.
///
/// Concepts flagged `interactive: true` have a real side-effect (e.g.
/// `send_to_chat` occupies the live chat transport and can be rejected mid-turn),
/// so the auto-run **skips** them — a headless aggregator must never disturb a
/// working window or block. Run those directly through the dispatcher when you
/// mean it:
///   dart run bin/run_example.dart send_to_chat
///
/// Exit codes:
///   0  all non-interactive examples passed, OR no live VS Code bridge was
///      found (skipped — the socket calls have a documented live-window
///      prerequisite).
///   1  at least one example failed against a live window.
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'documents.dart';
import 'queue.dart';
import 'send_to_chat.dart';
import 'support.dart';
import 'timed_requests.dart';
import 'todos.dart';
import 'tools.dart';
import 'workspace_metadata.dart';

/// One named concept to run against a connected window [adapter].
///
/// `interactive` concepts have side-effects or block, and are skipped by the
/// auto-run; invoke them by name through `bin/run_example.dart` when you mean to.
typedef Example = ({
  String name,
  Future<bool> Function(VSCodeAdapter) run,
  bool interactive,
});

/// The agent-tools concepts, in teaching order.
const List<Example> agentToolsExamples = [
  (
    name: 'workspace_metadata',
    run: runWorkspaceMetadataExample,
    interactive: false,
  ),
  (name: 'todos', run: runTodosExample, interactive: false),
  (name: 'queue', run: runQueueExample, interactive: false),
  (name: 'timed_requests', run: runTimedRequestsExample, interactive: false),
  (name: 'documents', run: runDocumentsExample, interactive: false),
  (name: 'tools', run: runToolsExample, interactive: false),
  (name: 'send_to_chat', run: runSendToChatExample, interactive: true),
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

  final failures = <String>[];
  var skipped = 0;

  try {
    for (final example in agentToolsExamples) {
      if (example.interactive) {
        skipped++;
        stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
        continue;
      }
      stdout.writeln('\n=== ${example.name} ===');
      try {
        final ok = await example.run(adapter);
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

  final ran = agentToolsExamples.length - skipped;
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
