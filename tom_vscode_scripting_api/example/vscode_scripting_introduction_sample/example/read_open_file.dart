/// Concept: find a file, read its contents, and open it in the editor.
///
/// Run:  dart run bin/run_example.dart read_open_file
///
/// `workspace.findFilePaths` runs a glob against the workspace and returns
/// absolute paths; `workspace.readFile` returns a file's text without opening
/// it; `workspace.openTextDocument` loads it into VS Code's document model.
/// (`window.showTextDocument` additionally reveals it in a visible tab.)
///
/// Expected output:
///   Found markdown at: /abs/path/README.md
///   File is <N> characters; first line: # ...
///   Opened README.md (<lineCount> lines, language: markdown).
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: locate a markdown file, read it, then open it.
Future<bool> runReadOpenFileExample(VSCode vscode) async {
  final matches = await vscode.workspace.findFilePaths(
    include: '**/*.md',
    exclude: '**/node_modules/**',
    maxResults: 1,
  );
  if (matches.isEmpty) {
    print('No markdown file found in the workspace to demonstrate read/open.');
    return false;
  }

  final path = matches.first;
  print('Found markdown at: $path');

  final contents = await vscode.workspace.readFile(path);
  final firstLine = contents.split('\n').first;
  print('File is ${contents.length} characters; first line: $firstLine');

  final doc = await vscode.workspace.openTextDocument(path);
  if (doc == null) {
    print('Read the file but could not open it as a document.');
    return false;
  }
  final fileName = path.split(RegExp(r'[\\/]')).last;
  print(
    'Opened $fileName (${doc.lineCount} lines, language: ${doc.languageId}).',
  );
  return true;
}
