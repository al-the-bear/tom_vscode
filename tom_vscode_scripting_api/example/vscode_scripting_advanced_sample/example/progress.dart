/// Concept: report progress from a long-running script.
///
/// Run:  dart run bin/run_example.dart progress
///
/// There is no blocking "withProgress" modal in the scripting surface — a
/// script reports progress the way a CLI does: incremental lines to a named
/// **output channel** plus a one-line **status bar** summary. The output
/// channel is the durable log; the status bar is the at-a-glance indicator.
///
/// Expected output (mirrored into the "Advanced Sample" output channel):
///   Working: step 1/5
///   ...
///   Working: step 5/5
///   Done — 5 steps in <n> ms.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: drive a fake 5-step job, reporting to an output channel and
/// the status bar at each step.
Future<bool> runProgressExample(VSCode vscode) async {
  const channelName = 'Advanced Sample';
  const steps = 5;
  final started = DateTime.now();

  await vscode.window.createOutputChannel(channelName);
  await vscode.window.showOutputChannel(channelName);

  for (var step = 1; step <= steps; step++) {
    final line = 'Working: step $step/$steps';
    await vscode.window.appendToOutputChannel(channelName, line);
    await vscode.window.setStatusBarMessage('$line …');
    print(line);
    // Simulate work between progress reports.
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }

  final elapsed = DateTime.now().difference(started).inMilliseconds;
  final summary = 'Done — $steps steps in $elapsed ms.';
  await vscode.window.appendToOutputChannel(channelName, summary);
  await vscode.window.setStatusBarMessage(summary);
  print(summary);

  return true;
}
