/// Concept: inspect the prompt queue (read-only).
///
/// Run:  dart run bin/run_example.dart queue
///
/// `TomQueueApi` is full control of the multi-transport prompt queue — list,
/// mutate, reorder, manage follow-ups, and run/pause. This concept only
/// *reads*: it reports the item counts and whether the queue is paused, so it
/// never sends, removes, or reorders a real queued prompt. The mutating
/// operations (`add`, `remove`, `moveUp`, `sendNext`, `pause`, …) are the same
/// API surface, used the same way.
///
/// Expected output:
///   Queue: 4 items (2 pending, 2 sent). Paused: false.
///   Next pending: "Run the test suite and report failures…"
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, read the queue contents and pause state.
Future<bool> runQueueExample(VSCodeAdapter adapter) async {
  TomQueueApi.setAdapter(adapter);

  final queue = await TomQueueApi.list();
  final paused = await TomQueueApi.isPaused();
  print(
    'Queue: ${queue.totalCount} items (${queue.pendingCount} pending, '
    '${queue.sentCount} sent). Paused: $paused.',
  );

  QueuedPrompt? nextPending;
  for (final item in queue.items) {
    if (item.status == QueuedPromptStatus.pending) {
      nextPending = item;
      break;
    }
  }
  if (nextPending != null) {
    final preview = _preview(nextPending.expandedText);
    print('Next pending: "$preview"');
  } else {
    print('Next pending: <none>');
  }

  return true;
}

/// First line of [text], trimmed to ~48 chars with an ellipsis.
String _preview(String text) {
  final firstLine = text.split('\n').first.trim();
  return firstLine.length <= 48 ? firstLine : '${firstLine.substring(0, 48)}…';
}
