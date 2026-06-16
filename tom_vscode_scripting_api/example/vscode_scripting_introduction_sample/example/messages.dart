/// Concept: show notifications and a status-bar message.
///
/// Run:  dart run bin/run_example.dart messages
///
/// `window.show*Message` returns the label of the button the user clicked, or
/// `null` if the notification was dismissed. Passing no actions (as here) makes
/// them fire-and-forget toasts.
///
/// Expected output:
///   Information toast shown (clicked: <null or button label>)
///   Status bar updated.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: post the three notification severities and a status message.
Future<bool> runMessagesExample(VSCode vscode) async {
  final clicked = await vscode.window.showInformationMessage(
    'Hello from a Dart program driving VS Code.',
  );
  print('Information toast shown (clicked: $clicked)');

  await vscode.window.showWarningMessage('This is a warning notification.');
  await vscode.window.showErrorMessage('This is an error notification.');

  await vscode.window.setStatusBarMessage('tom_vscode_scripting_api connected');
  print('Status bar updated.');
  return true;
}
