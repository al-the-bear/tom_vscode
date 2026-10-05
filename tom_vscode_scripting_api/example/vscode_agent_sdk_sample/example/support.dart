/// Shared infrastructure for the Agent SDK samples.
///
/// Unlike the scripting samples (which use the `VSCode` singleton) and the
/// agent-tools samples (which use per-class `setAdapter`), the Agent SDK path
/// is built on the **raw** [VSCodeBridgeClient]: the streaming query needs the
/// client's bidirectional notification + reverse-RPC channel directly. So this
/// helper returns a connected *client*, and each concept wraps it with
/// [VSCodeBridgeAgentSdkTransport] → [AgentSdkClient].
///
/// The deterministic concepts here exercise the full *type surface* offline.
/// The two live concepts (`streaming_query.dart`, `streaming_input.dart`) run
/// real queries, and bound their waits ([drainQuery] for the first) so that a
/// busy or out-of-date window is reported as a skip instead of hanging.
library;

import 'dart:async';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Scans the CLI bridge port range, connects to the first responsive window,
/// and returns the connected **raw** [VSCodeBridgeClient]. Returns `null` —
/// after printing a prerequisite message — when no window is running a CLI
/// Integration Server.
///
/// See `vscode_scripting_introduction_sample/example/connect.dart` for the
/// line-by-line explanation of the scan/connect handshake.
Future<VSCodeBridgeClient?> connectToFirstWindow({
  String host = '127.0.0.1',
}) async {
  final windows = await scanBridgePorts(host: host);
  if (windows.isEmpty) {
    print(
      'No VS Code CLI Integration Server found on $host:'
      '$defaultVSCodeBridgePort–$maxVSCodeBridgePort.',
    );
    print(
      'Open a VS Code window with the Tom extension active and run '
      '"DS: Start Tom CLI Integration Server", then try again.',
    );
    return null;
  }

  final port = windows.keys.first;
  final identity = windows[port];
  final client = VSCodeBridgeClient(host: host, port: port);
  if (!await client.connect()) {
    print('Found a window on $host:$port but could not connect to its bridge.');
    return null;
  }

  print('Connected to "$identity" on $host:$port');
  return client;
}

/// Builds the [AgentSdkClient] over a connected bridge [client].
///
/// The client is wrapped in the production [VSCodeBridgeAgentSdkTransport],
/// which starts/cancels queries via `agentSdk.queryVce`/`agentSdk.cancelVce`
/// and correlates the `agentSdk.chunk` notifications back into a typed
/// [SdkMessage] stream.
AgentSdkClient agentSdkClientFor(VSCodeBridgeClient client) =>
    AgentSdkClient(VSCodeBridgeAgentSdkTransport(client));

/// The outcome of draining a live [AgentQuery] within a timeout.
///
/// - [messages]: the typed messages received before completion/timeout.
/// - [completed]: the query ended on its own (a `done` chunk).
/// - [timedOut]: the stream went quiet for the whole timeout before completing
///   (a busy window, or a stuck query).
/// - [error]: a query failure reported by the extension (an `error` chunk), or
///   any other unexpected error.
typedef QueryOutcome = ({
  List<SdkMessage> messages,
  bool completed,
  bool timedOut,
  Object? error,
});

/// Drains [query] until it completes, errors, or [timeout] elapses with no
/// further message.
///
/// Rather than hang on a query that has gone quiet, this collects whatever
/// arrives and, after [timeout] without a message, [AgentQuery.interrupt]s the
/// underlying run. A timeout is treated as a skip, not a failure.
Future<QueryOutcome> drainQuery(
  AgentQuery query, {
  Duration timeout = const Duration(seconds: 8),
}) async {
  final messages = <SdkMessage>[];
  Object? error;
  var completed = false;
  var timedOut = false;
  try {
    await for (final message in query.timeout(timeout)) {
      messages.add(message);
    }
    completed = true;
  } on TimeoutException {
    timedOut = true;
    await query.interrupt();
  } on AgentSdkQueryException catch (e) {
    error = e;
  } catch (e) {
    error = e;
  }
  return (
    messages: messages,
    completed: completed,
    timedOut: timedOut,
    error: error,
  );
}

/// Prints a one-line human summary of a drained [outcome] and the typed
/// messages it carried. Shared so each live concept renders the result the
/// same way.
void printQueryOutcome(QueryOutcome outcome) {
  for (final message in outcome.messages) {
    switch (message) {
      case SdkSystemMessage(:final model, :final tools):
        print('  • system/init   model=$model, ${tools.length} tools');
      case SdkAssistantMessage(:final content):
        final text =
            content.whereType<TextBlock>().map((b) => b.text).join(' ').trim();
        print('  • assistant     ${oneLine(text)}');
      case SdkResultMessage(:final result, :final totalCostUsd):
        print('  • result        ${oneLine(result ?? '')} '
            '(cost \$${totalCostUsd ?? 0})');
      default:
        print('  • ${message.type}');
    }
  }
  if (outcome.error != null) {
    print('  Query reported an error: ${outcome.error}');
  } else if (outcome.timedOut) {
    print(
      '  No chunks arrived within the timeout (the window is busy or the query '
      'is stuck). Treated as a skip.',
    );
  } else if (outcome.completed) {
    print('  Query completed (${outcome.messages.length} messages).');
  }
}

/// Truncates [text] to a single short line for console output.
String oneLine(String text) {
  final collapsed = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (collapsed.length <= 80) return collapsed;
  return '${collapsed.substring(0, 77)}…';
}
