/// Concept: edit a document through the editor, then verify on disk.
///
/// Run:  dart run bin/run_example.dart editor_edits
///
/// A ranged edit goes through VS Code's edit machinery (`WorkspaceEdit` +
/// `workspace.applyEdit`), not a raw file write — so open editors, undo
/// history, and language features all see the change. The high-level
/// `VsCodeHelper.replaceText(...)` wraps this, but it routes through an
/// extension command that not every host build registers. The reliable,
/// always-available path is the **adapter escape hatch**: `vscode.adapter`
/// exposes `sendRequest`, the same primitive the library itself is built on,
/// letting a script run genuine VS Code API in the window's JS host.
///
/// This concept creates a scratch file, opens it, replaces a line through
/// `applyEdit`, saves, and reads the result back to prove the edit took.
///
/// Expected output:
///   Created scratch file with 3 lines.
///   Replaced line 2 via the editor.
///   Verified: line 2 is now "edited line".
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

/// Concept body: scratch file → editor edit → save → verify → clean up.
Future<bool> runEditorEditsExample(VSCode vscode) async {
  final dir = await scratchDir(vscode, 'editor_edits');
  if (dir == null) {
    print('No workspace folder open; cannot demonstrate editor edits.');
    return false;
  }

  final path = '$dir/scratch.txt';
  const original = 'line one\nline two\nline three';
  await vscode.workspace.writeFile(path, original);
  await vscode.workspace.openTextDocument(path);
  print('Created scratch file with 3 lines.');

  // Replace the whole of line index 1 ("line two") with new text, through the
  // editor's WorkspaceEdit machinery. We run the genuine VS Code API in the
  // window's JS host via the adapter escape hatch (`context.vscode.*`).
  final edited = await _replaceLineViaEditor(
    vscode.adapter,
    path: path,
    line: 1,
    text: 'edited line',
  );
  if (!edited) {
    print('Editor edit did not apply on this window.');
    return false;
  }
  print('Replaced line 2 via the editor.');

  await vscode.workspace.saveTextDocument(path);
  final contents = await vscode.workspace.readFile(path);
  final lines = contents.split('\n');
  final ok = lines.length >= 2 && lines[1].trim() == 'edited line';
  print(
    ok
        ? 'Verified: line 2 is now "${lines[1].trim()}".'
        : 'Edit did not verify; line 2 is "${lines.length >= 2 ? lines[1] : ''}".',
  );

  await vscode.workspace.deleteFile(path);
  return ok;
}

/// Replaces the whole of [line] in the document at [path] with [text] using a
/// `WorkspaceEdit`. Returns the boolean `applyEdit` reports.
///
/// This is the escape hatch for operations the high-level wrappers don't cover
/// on a given host: `adapter.sendRequest('executeScriptVce', …)` runs the
/// script's `context.vscode.*` body inside the connected window.
Future<bool> _replaceLineViaEditor(
  VSCodeAdapter adapter, {
  required String path,
  required int line,
  required String text,
}) async {
  final result = await adapter.sendRequest(
    'executeScriptVce',
    {
      'script': r'''
        const uri = context.vscode.Uri.file(params.path);
        const doc = await context.vscode.workspace.openTextDocument(uri);
        const lineLen = doc.lineAt(params.line).text.length;
        const range = new context.vscode.Range(params.line, 0, params.line, lineLen);
        const edit = new context.vscode.WorkspaceEdit();
        edit.replace(uri, range, params.text);
        return await context.vscode.workspace.applyEdit(edit);
      ''',
      'params': {'path': path, 'line': line, 'text': text},
    },
    scriptName: 'replaceLineViaEditor',
    timeout: const Duration(seconds: 30),
  );
  return result['success'] == true && result['result'] == true;
}
