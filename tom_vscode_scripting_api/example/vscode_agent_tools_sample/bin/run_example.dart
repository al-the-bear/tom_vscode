/// Dispatcher: run a single agent-tools concept by name.
///
///   dart run bin/run_example.dart <name> [host]
///
/// where <name> is one of:
///   workspace_metadata, todos, queue, timed_requests, documents, tools,
///   send_to_chat
///
/// With no name (or `all`), this delegates to the aggregator (which skips the
/// interactive concepts). The optional second argument overrides the bridge
/// host (default 127.0.0.1). Use this dispatcher to run the interactive
/// `send_to_chat` concept when you actually want to drive the chat transport.
///
/// Connects once to the first responsive VS Code window, runs the requested
/// concept, then disconnects. Exits non-zero if the concept fails; exits 0
/// when no live bridge is found (the documented live-window prerequisite).
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import '../example/documents.dart';
import '../example/queue.dart';
import '../example/run_all_examples.dart';
import '../example/send_to_chat.dart';
import '../example/support.dart';
import '../example/timed_requests.dart';
import '../example/todos.dart';
import '../example/tools.dart';
import '../example/workspace_metadata.dart';

final Map<String, Future<bool> Function(VSCodeAdapter)> _examples = {
  'workspace_metadata': runWorkspaceMetadataExample,
  'todos': runTodosExample,
  'queue': runQueueExample,
  'timed_requests': runTimedRequestsExample,
  'documents': runDocumentsExample,
  'tools': runToolsExample,
  'send_to_chat': runSendToChatExample,
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
    final ok = await example(adapter);
    if (!ok) exit(1);
  } finally {
    await adapter.disconnect();
  }
  // The bridge client keeps a socket open; exit explicitly so the VM doesn't
  // linger after the example has run.
  exit(0);
}
