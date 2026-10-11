/// Concept: reveal a document in an editor tab and read the editor back.
///
/// Run:  dart run bin/run_example.dart reveal_editor
///
/// `workspace.openTextDocument(path)` loads a document without showing it.
/// `window.showTextDocument(path)` goes one step further: it **opens a tab** in
/// the connected window, focuses it, and returns the `TextEditor` — the
/// document plus the editor's own state (`selection`, `selections`,
/// `visibleRanges`). That tab is a visible change in the window you are
/// working in, which is why this concept is flagged *interactive* and skipped
/// by the auto-run aggregator: a headless run must not rearrange your editors.
///
/// Two details the concept shows:
///
/// - `showTextDocument` reports `visibleRanges` as `null`. VS Code has not laid
///   the new tab out when the call resolves, so the range would be empty;
///   `window.getActiveTextEditor()` asked a moment later returns the real one.
/// - The concept closes the tab it opened — and only that tab: it checks that
///   the active editor is still the scratch file before running
///   `workbench.action.closeActiveEditor`.
///
/// Expected output (line numbers depend on your editor's height):
///   Revealed scratch_<ms>.txt (plaintext, 200 lines) in a tab.
///   Cursor at line 1, column 1; 1 selection(s).
///   Visible lines: 1–35.
///   Closed the tab again.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

/// Concept body: scratch file → show in a tab → read the editor → close → clean up.
Future<bool> runRevealEditorExample(VSCode vscode) async {
  final dir = await scratchDir(vscode, 'reveal_editor');
  if (dir == null) {
    print('No workspace folder open; cannot demonstrate showTextDocument.');
    return false;
  }

  // A fresh name per run. VS Code keeps a document's model after its tab is
  // closed and its file deleted, so reusing one path would reveal the previous
  // run's text instead of what was just written.
  final path = '$dir/scratch_${DateTime.now().millisecondsSinceEpoch}.txt';
  // Enough lines that the visible range is smaller than the document.
  final text = List.generate(200, (i) => 'line ${i + 1}').join('\n');
  await vscode.workspace.writeFile(path, text);

  try {
    final editor = await vscode.window.showTextDocument(path);
    if (editor == null) {
      print('showTextDocument returned no editor on this window.');
      return false;
    }
    final doc = editor.document;
    print(
      'Revealed ${doc.fileName.split('/').last} '
      '(${doc.languageId}, ${doc.lineCount} lines) in a tab.',
    );
    final cursor = editor.selection.active;
    print(
      'Cursor at line ${cursor.line + 1}, column ${cursor.character + 1}; '
      '${editor.selections.length} selection(s).',
    );

    // The active editor, asked after the reveal, carries the laid-out range.
    final active = await vscode.window.getActiveTextEditor();
    final visible = active?.visibleRanges;
    print(
      visible == null
          ? 'Visible lines: not reported yet.'
          : 'Visible lines: ${visible.start.line + 1}–${visible.end.line + 1}.',
    );

    // Close only the tab this concept opened.
    if (active?.document.fileName == doc.fileName) {
      await vscode.commands
          .executeCommand(VSCodeCommonCommands.closeActiveEditor);
      print('Closed the tab again.');
    } else {
      print('The active editor changed; leaving it open.');
    }
    return doc.lineCount == 200;
  } finally {
    await vscode.workspace.deleteFile(path);
  }
}
