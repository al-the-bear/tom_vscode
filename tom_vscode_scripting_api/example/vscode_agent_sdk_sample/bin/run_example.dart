/// Dispatcher: run a single Agent SDK concept by name.
///
///   dart run bin/run_example.dart <name> [host]
///
/// where <name> is one of:
///   message_types, options, in_process_tool, can_use_tool, streaming_query
///
/// With no name (or `all`), this delegates to the aggregator (which skips the
/// interactive `streaming_query` concept). The optional second argument
/// overrides the bridge host (default 127.0.0.1). Use this dispatcher to run
/// the interactive `streaming_query` concept when you actually want to drive a
/// live agent run.
///
/// Connects once to the first responsive VS Code window, runs the requested
/// concept, then disconnects. Exits non-zero if the concept fails; exits 0
/// when no live bridge is found (the documented live-window prerequisite).
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import '../example/can_use_tool.dart';
import '../example/in_process_tool.dart';
import '../example/message_types.dart';
import '../example/options.dart';
import '../example/run_all_examples.dart';
import '../example/streaming_query.dart';
import '../example/support.dart';

final Map<String, Future<bool> Function(VSCodeBridgeClient)> _examples = {
  'message_types': runMessageTypesExample,
  'options': runOptionsExample,
  'in_process_tool': runInProcessToolExample,
  'can_use_tool': runCanUseToolExample,
  'streaming_query': runStreamingQueryExample,
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

  final client = await connectToFirstWindow(host: host);
  if (client == null) {
    exit(0); // documented live-window prerequisite, not a failure
  }

  try {
    final ok = await example(client);
    if (!ok) exit(1);
  } finally {
    await client.disconnect();
  }
  // The bridge client keeps a socket open; exit explicitly so the VM doesn't
  // linger after the example has run.
  exit(0);
}
