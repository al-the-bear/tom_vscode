/// Concept: ask the user for input — quick pick and input box.
///
/// Run:  dart run bin/run_example.dart quick_pick_input
///
/// `window.showQuickPick(items)` and `window.showInputBox()` surface the native
/// VS Code pickers and return the user's choice (or `null` when dismissed).
/// They **block on the user** — which is why this concept is marked
/// *interactive* and is skipped by the auto-run aggregator. Both calls take a
/// `timeoutSeconds` plus a `fallbackValueOnTimeout`, so a headless run never
/// hangs: it waits a few seconds, then proceeds with the fallback.
///
/// Expected output (when run interactively, after you pick/type):
///   You picked: <choice>
///   You typed:  <text>
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: show a quick pick, then an input box, reporting both results.
///
/// A short timeout with a fallback keeps the concept safe to invoke without a
/// human present — it degrades to the fallback instead of blocking forever.
Future<bool> runQuickPickInputExample(VSCode vscode) async {
  final pick = await vscode.window.showQuickPick(
    ['Alpha', 'Beta', 'Gamma'],
    placeHolder: 'Pick one (auto-selects Alpha after 10s)',
    timeoutSeconds: 10,
    fallbackValueOnTimeout: 'Alpha (fallback)',
  );
  print('You picked: ${pick ?? '<dismissed>'}');

  final typed = await vscode.window.showInputBox(
    prompt: 'Type something (auto-fills after 10s)',
    placeHolder: 'free text',
    timeoutSeconds: 10,
    fallbackValueOnTimeout: 'fallback text',
  );
  print('You typed:  ${typed ?? '<dismissed>'}');

  // Both prompts resolved (to a value or fallback) without throwing.
  return true;
}
