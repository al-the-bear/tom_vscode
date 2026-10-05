/// Concept (interactive): a live streaming `query()` against the window.
///
/// Run:  dart run bin/run_example.dart streaming_query
///
/// This is the real thing: [AgentSdkClient.query] starts an agent run on the
/// extension via `agentSdk.queryVce` and returns an [AgentQuery] — a
/// `Stream<SdkMessage>` you `await for` over, plus [AgentQuery.interrupt] to
/// abort it. Each relayed `agentSdk.chunk` becomes a typed [SdkMessage].
///
/// It is flagged **interactive** because it drives a real agent turn, which
/// consumes model budget, so the auto-run aggregator skips it. [drainQuery]
/// still caps the wait with a timeout: if nothing arrives (a window whose
/// extension is busy or too old) it [AgentQuery.interrupt]s and reports a skip
/// rather than hanging.
///
/// To keep the run cheap and side-effect free it names a small model and
/// gives the agent no tools (`tools: ToolsList([])`), so it answers in its one
/// turn (`maxTurns: 1`). Without a model it would run on the window's own
/// default; with tools available it may spend its single turn on a tool call
/// and end on "Reached maximum number of turns".
///
/// Expected output: system/init, assistant text, and a result line.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

Future<bool> runStreamingQueryExample(VSCodeBridgeClient client) async {
  final agent = agentSdkClientFor(client);

  print('Starting query (claude-haiku-4-5, no tools, maxTurns: 1)…');
  final query = agent.query(
    prompt: 'In one sentence, what is the Tom Framework?',
    options: Options(
      model: 'claude-haiku-4-5',
      tools: const ToolsList([]),
      maxTurns: 1,
    ),
  );

  final outcome = await drainQuery(query);
  printQueryOutcome(outcome);

  // A timeout is a skip, not a failure; a completed run is a success; only an
  // error fails the concept.
  return outcome.error == null;
}
