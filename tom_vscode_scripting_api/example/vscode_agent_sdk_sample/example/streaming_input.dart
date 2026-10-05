/// Concept (interactive): a conversation over streaming input — `streamQuery`.
///
/// Run:  dart run bin/run_example.dart streaming_input
///
/// [AgentSdkClient.query] takes one prompt string. [AgentSdkClient.streamQuery]
/// mirrors the SDK's streaming-input mode instead: you hand it a
/// `Stream<SdkUserInput>` and own that stream. Every [SdkUserInput] you add is
/// sent to the running query (`agentSdk.inputVce`), and closing the stream
/// ends the input (`agentSdk.endInputVce`), after which the query finishes and
/// the message stream completes.
///
/// So the question a streaming-input caller always has to answer is *when* to
/// send the next message, and when to close. Two signals answer it:
///
/// - `session_state_changed` with `state: 'idle'` (a [SdkSystemEvent]): the
///   Claude Code process has finished what it was doing and waits for input.
///   The extension asks for these events automatically for streaming queries.
/// - the `uuid` you stamp on a message comes back in the `user_message_uuids`
///   of the [SdkResultMessage] that answers it, so you can tell your answer
///   from other work (a background task's follow-up turn, for example).
///
/// This concept sends two questions, the second only once the process is idle
/// *and* the first has been answered, then closes the input.
///
/// Keep the input open as long as Dart tools or a `canUseTool` callback may
/// still be called: the process reaches both through that input, and closing
/// it early cuts them off.
///
/// It is flagged **interactive** because it drives real agent turns (model
/// budget), so the auto-run aggregator skips it. It is cheap: a small model,
/// no tools. A window whose extension predates streaming input (it answers
/// `Unknown method: agentSdk.inputVce`) and a timeout are reported as skips.
///
/// Expected output: the two questions, each followed by its result line with
/// its own uuid, an idle after each, and "input closed".
library;

import 'dart:async';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

/// The two questions, each with the uuid that marks its answer.
const _questions = [
  ('streaming-input-1', 'In one word: what colour is a clear daytime sky?'),
  ('streaming-input-2', 'In one word: what colour is fresh grass?'),
];

Future<bool> runStreamingInputExample(VSCodeBridgeClient client) async {
  final agent = agentSdkClientFor(client);
  final input = StreamController<SdkUserInput>();
  var sent = 0;
  final answered = <String>{};

  void sendNext() {
    final (uuid, text) = _questions[sent++];
    print('→ [$uuid] $text');
    input.add(SdkUserInput.text(text, uuid: uuid));
  }

  final query = agent.streamQuery(
    prompt: input.stream,
    options: Options(
      model: 'claude-haiku-4-5',
      tools: const ToolsList([]),
      maxTurns: 4,
    ),
  );

  // The first question can be added straight away: the stream buffers it
  // until the query has started and is listening.
  sendNext();

  try {
    await for (final message in query.timeout(const Duration(seconds: 60))) {
      switch (message) {
        case SdkResultMessage(:final result):
          final uuids =
              (message.raw['user_message_uuids'] as List?)?.cast<String>() ??
                  const <String>[];
          answered.addAll(uuids);
          print('  • result for $uuids: ${oneLine(result ?? '')}');
        case SdkSystemEvent(subtype: 'session_state_changed')
            when message.raw['state'] == 'idle':
          print('  • idle');
          final lastUuid = _questions[sent - 1].$1;
          if (!answered.contains(lastUuid)) {
            // Idle without our answer (e.g. after unrelated work): keep waiting.
            break;
          }
          if (sent < _questions.length) {
            sendNext();
          } else {
            print('→ input closed');
            await input.close();
          }
        default:
          break;
      }
    }
  } on TimeoutException {
    await query.interrupt();
    print('  No answer within 60 s; treated as a skip.');
    return true;
  } catch (e) {
    if ('$e'.contains('agentSdk.inputVce')) {
      print(
        '  This window\'s Tom extension predates streaming input '
        '(no agentSdk.inputVce). Reinstall it and reload; treated as a skip.',
      );
      return true;
    }
    print('  Query reported an error: $e');
    return false;
  } finally {
    if (!input.isClosed) await input.close();
  }

  final ok = _questions.every((q) => answered.contains(q.$1));
  print(
    ok
        ? '  Both questions answered, each result carrying its own uuid.'
        : '  Missing an answer: answered=$answered',
  );
  return ok;
}
