/// Concept: send a prompt to the configured chat transport and read the answer.
///
/// Run:  dart run bin/run_example.dart send_to_chat
///
/// `TomChatApi.sendToChat` dispatches a prompt to whichever transport the
/// extension is configured to use (`sendToChatTarget`: `anthropic` or
/// `copilot`) and returns the answer. To the script the two targets look the
/// same — an answer comes back either way.
///
/// This concept is flagged **interactive** in the aggregator and is therefore
/// **skipped by the headless auto-run**, for two reasons:
///   1. It has a real side-effect — it occupies the live chat transport, runs
///      the full tool loop (for anthropic), and can take many seconds.
///   2. A second concurrent Anthropic send is *rejected* while a turn is in
///      flight (see [SendToChatResult.rejected]); firing it from an unattended
///      batch would collide with whatever the window is doing.
/// Run it by name when you actually want to drive the chat:
///   dart run bin/run_example.dart send_to_chat
///
/// Expected output (anthropic target, idle window):
///   Sent to "anthropic". Answer (first line): "4"
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, send one prompt, report the outcome.
Future<bool> runSendToChatExample(VSCodeAdapter adapter) async {
  TomChatApi.setAdapter(adapter);

  final result = await TomChatApi.sendToChat(
    'Reply with only the number: what is 2 + 2?',
  );

  if (result.rejected) {
    // A turn was already running — the prompt queue owns queuing, not this API.
    print('Rejected: an Anthropic turn was already in flight.');
    // Rejection is the documented contention outcome, not a transport failure.
    return true;
  }
  if (!result.success) {
    print('Send to "${result.target}" failed: ${result.error}');
    return false;
  }

  final firstLine = result.answer.split('\n').first.trim();
  print('Sent to "${result.target}". Answer (first line): "$firstLine"');
  return true;
}
