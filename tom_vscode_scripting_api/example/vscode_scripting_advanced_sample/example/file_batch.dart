/// Concept: batched file operations — create, read, verify, delete.
///
/// Run:  dart run bin/run_example.dart file_batch
///
/// `workspace.writeFile` / `readFile` / `fileExists` / `deleteFile` are
/// straight filesystem operations marshalled to the window's host. They don't
/// open editors — they're the bulk-IO surface for scripts that generate or
/// rewrite many files. This concept writes a small batch, reads it back to
/// verify, then cleans up after itself.
///
/// Expected output:
///   Wrote 3 files under <root>/ztmp/advanced_sample/file_batch
///   Read back 3/3 files with matching content.
///   Cleaned up 3 files.
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

import 'support.dart';

/// Concept body: write a batch of files, verify, and delete them.
Future<bool> runFileBatchExample(VSCode vscode) async {
  final dir = await scratchDir(vscode, 'file_batch');
  if (dir == null) {
    print('No workspace folder open; cannot demonstrate file operations.');
    return false;
  }

  final files = <String, String>{
    '$dir/alpha.txt': 'alpha contents',
    '$dir/beta.txt': 'beta contents',
    '$dir/gamma.txt': 'gamma contents',
  };

  for (final entry in files.entries) {
    await vscode.workspace.writeFile(entry.key, entry.value);
  }
  print('Wrote ${files.length} files under $dir');

  var matched = 0;
  for (final entry in files.entries) {
    if (!await vscode.workspace.fileExists(entry.key)) continue;
    final actual = await vscode.workspace.readFile(entry.key);
    if (actual == entry.value) matched++;
  }
  print('Read back $matched/${files.length} files with matching content.');

  var deleted = 0;
  for (final path in files.keys) {
    if (await vscode.workspace.deleteFile(path)) deleted++;
  }
  print('Cleaned up $deleted files.');

  return matched == files.length;
}
