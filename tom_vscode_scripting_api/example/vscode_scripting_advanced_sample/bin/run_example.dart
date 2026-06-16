/// Dispatcher: run a single advanced concept by name.
///
///   dart run bin/run_example.dart <name> [host]
///
/// where <name> is one of:
///   file_batch, editor_edits, progress, helper_layer, language_model,
///   quick_pick_input
///
/// With no name (or `all`), this delegates to the aggregator (which skips the
/// interactive concepts). The optional second argument overrides the bridge
/// host (default 127.0.0.1). Use this dispatcher to run the interactive
/// `quick_pick_input` concept when a human is present.
///
/// Connects once to the first responsive VS Code window, runs the requested
/// concept, then disconnects. Exits non-zero if the concept fails; exits 0
/// when no live bridge is found (the documented live-window prerequisite).
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import '../example/editor_edits.dart';
import '../example/file_batch.dart';
import '../example/helper_layer.dart';
import '../example/language_model.dart';
import '../example/progress.dart';
import '../example/quick_pick_input.dart';
import '../example/run_all_examples.dart';
import '../example/support.dart';

final Map<String, Future<bool> Function(VSCode)> _examples = {
  'file_batch': runFileBatchExample,
  'editor_edits': runEditorEditsExample,
  'progress': runProgressExample,
  'helper_layer': runHelperLayerExample,
  'language_model': runLanguageModelExample,
  'quick_pick_input': runQuickPickInputExample,
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
