/// Concept (interactive): a live streaming `query()` against the window.
///
/// Run:  dart run bin/run_example.dart streaming_query
///
/// This is the real thing: [AgentSdkClient.query] starts an agent run on the
/// extension via `agentSdk.queryVce` and returns an [AgentQuery] — a
/// `Stream<SdkMessage>` you `await for` over, plus [AgentQuery.interrupt] to
/// abort it. Each relayed `agentSdk.chunk` becomes a typed [SdkMessage].
///
/// It is flagged **interactive** for two reasons: it drives a real agent turn
/// (which consumes model budget), and end-to-end chunk delivery over the CLI
/// socket is a documented completion step (the bridge relays only `log` today).
/// So the auto-run aggregator skips it, and [drainQuery] caps the wait with a
/// timeout: if no chunk arrives it [AgentQuery.interrupt]s and reports the
/// documented skip rather than hanging. To keep the run cheap and side-effect
/// free we use `permissionMode: plan` (no tool execution) and `maxTurns: 1`.
///
/// Expected output (when the relay is wired): system/init, assistant text, and
/// a result line. Otherwise: a clear "no chunks within timeout — documented
/// completion step" note, and a clean exit.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

Future<bool> runStreamingQueryExample(VSCodeBridgeClient client) async {
  final agent = agentSdkClientFor(client);

  print('Starting query (plan mode, maxTurns: 1)…');
  final query = agent.query(
    prompt: 'In one sentence, what is the Tom Framework?',
    options: Options(
      maxTurns: 1,
      permissionMode: PermissionMode.plan,
    ),
  );

  final outcome = await drainQuery(query);
  printQueryOutcome(outcome);

  // A timeout (relay not yet wired) is a documented skip, not a failure; a
  // completed run is a success; only an unexpected error fails the concept.
  return outcome.error == null;
}
