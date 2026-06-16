/// Concept: talk to a language model (Copilot) through the connected window.
///
/// Run:  dart run bin/run_example.dart language_model
///
/// `lm.selectChatModels(...)` returns the chat models the *window's* VS Code
/// can see — typically GitHub Copilot, when the user is signed in. A script
/// picks a model, builds a message list, and calls `model.sendRequest(adapter,
/// messages)`. The adapter is passed explicitly because the model object is a
/// plain data holder; it borrows the window's transport to make the call.
///
/// This concept degrades gracefully: with no model available (Copilot not
/// installed / not signed in) it reports that and returns `true` — "no model"
/// is an environment fact, not a script failure.
///
/// Expected output (with Copilot available):
///   Found <n> chat model(s); using "<name>".
///   Model replied (<n> chars): <first line of reply>…
///
/// Expected output (without a model):
///   No chat models available on this window (Copilot signed out?). Skipping.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: select a model, send one prompt, summarise the reply.
Future<bool> runLanguageModelExample(VSCode vscode) async {
  final models = await vscode.lm.selectChatModels(vendor: 'copilot');
  if (models.isEmpty) {
    print(
      'No chat models available on this window (Copilot signed out?). '
      'Skipping.',
    );
    return true;
  }

  final model = models.first;
  print('Found ${models.length} chat model(s); using "${model.name}".');

  final response = await model.sendRequest(vscode.adapter, [
    LanguageModelChatMessage.user(
      'In one short sentence, what is the Dart programming language?',
    ),
  ]);

  final reply = response.text.trim();
  final firstLine = reply.split('\n').first;
  print('Model replied (${reply.length} chars): $firstLine…');

  return reply.isNotEmpty;
}
