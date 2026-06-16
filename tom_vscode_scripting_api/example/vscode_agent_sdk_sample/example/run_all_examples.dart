/// Aggregator: connect once, run every Agent SDK concept, tally results.
///
/// Run:  dart run example/run_all_examples.dart
///   (or via the wrappers: ./run_example.sh  /  ./run_example.ps1)
///
/// These concepts drive the Agent SDK 1:1 mirror over the **raw**
/// [VSCodeBridgeClient] (wrapped with [VSCodeBridgeAgentSdkTransport] →
/// [AgentSdkClient]) — not the `VSCode` singleton and not per-class
/// `setAdapter`. That is why each `run` takes a [VSCodeBridgeClient].
///
/// Four concepts are deterministic and exercise the *type surface* offline
/// (message parsing, the `Options` input, in-process tools, `canUseTool`); they
/// run in the auto-run. The fifth (`streaming_query`) fires a real agent run
/// and depends on the `agentSdk.chunk` relay (a documented completion step), so
/// it is flagged `interactive: true` and the auto-run **skips** it — a headless
/// aggregator must never spend budget or block. Run it directly when you mean
/// it:
///   dart run bin/run_example.dart streaming_query
///
/// Exit codes:
///   0  all non-interactive examples passed, OR no live VS Code bridge was
///      found (skipped — the socket calls have a documented live-window
///      prerequisite).
///   1  at least one example failed against a live window.
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'can_use_tool.dart';
import 'in_process_tool.dart';
import 'message_types.dart';
import 'options.dart';
import 'streaming_query.dart';
import 'support.dart';

/// One named concept to run against a connected window [client].
///
/// `interactive` concepts have side-effects or block, and are skipped by the
/// auto-run; invoke them by name through `bin/run_example.dart` when you mean to.
typedef Example = ({
  String name,
  Future<bool> Function(VSCodeBridgeClient) run,
  bool interactive,
});

/// The Agent SDK concepts, in teaching order.
const List<Example> agentSdkExamples = [
  (name: 'message_types', run: runMessageTypesExample, interactive: false),
  (name: 'options', run: runOptionsExample, interactive: false),
  (name: 'in_process_tool', run: runInProcessToolExample, interactive: false),
  (name: 'can_use_tool', run: runCanUseToolExample, interactive: false),
  (name: 'streaming_query', run: runStreamingQueryExample, interactive: true),
];

Future<void> main() => runAllExamples();

/// Connect once, run every non-interactive concept, tally, and set the process
/// exit code. Exposed so the dispatcher (`bin/run_example.dart all`) can reuse
/// it.
Future<void> runAllExamples() async {
  final client = await connectToFirstWindow();
  if (client == null) {
    // No live window: a documented prerequisite, not a failure.
    exit(0);
  }

  final failures = <String>[];
  var skipped = 0;

  try {
    for (final example in agentSdkExamples) {
      if (example.interactive) {
        skipped++;
        stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
        continue;
      }
      stdout.writeln('\n=== ${example.name} ===');
      try {
        final ok = await example.run(client);
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
    await client.disconnect();
  }

  final ran = agentSdkExamples.length - skipped;
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
