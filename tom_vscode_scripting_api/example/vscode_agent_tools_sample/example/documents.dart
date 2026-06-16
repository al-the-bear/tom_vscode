/// Concept: read workspace documents — guidelines and the prompt/answer trail.
///
/// Run:  dart run bin/run_example.dart documents
///
/// `TomDocumentApi` is the extension's typed view of the `_ai/` and
/// `_copilot_guidelines/` document tree: prompts, answers, notes, the trail,
/// the guidelines, and per-quest documents — each with list / read / write
/// operations. This concept stays read-only: it lists the guidelines (with
/// their categories), reads the first one to prove content round-trips, and
/// lists the most recent trail entries. It never writes a document.
///
/// Expected output:
///   42 guidelines across categories: root, dart, cloud, d4rt.
///   Read "coding_guidelines.md": 18234 chars.
///   Trail: 5 recent entries (latest quest: vscode_extension).
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, list guidelines, read one, list the trail.
Future<bool> runDocumentsExample(VSCodeAdapter adapter) async {
  TomDocumentApi.setAdapter(adapter);

  final guidelines = await TomDocumentApi.listGuidelines();
  final categories = guidelines.categories.isEmpty
      ? '<none>'
      : guidelines.categories.join(', ');
  print(
    '${guidelines.guidelines.length} guidelines across categories: $categories.',
  );

  if (guidelines.guidelines.isEmpty) {
    print('Read: <no guidelines to read>');
  } else {
    final first = guidelines.guidelines.first;
    final content = await TomDocumentApi.readGuideline(first.name);
    print('Read "${first.name}": ${content.content.length} chars.');
  }

  final trail = await TomDocumentApi.listTrail(limit: 5);
  final latestQuest = trail.entries.isEmpty
      ? '<none>'
      : (trail.entries.first.questId ?? '<unset>');
  print(
    'Trail: ${trail.entries.length} recent entries '
    '(latest quest: $latestQuest).',
  );

  // Listing succeeds even on a sparse workspace; returning without throwing is
  // the success condition.
  return true;
}
