# VS Code Bridge User Guide

How to write the Dart scripts the VS Code bridge (`tom_bs`) runs, and how to run
them. The bridge runs a script in the D4rt interpreter, inside its own process;
the script drives VS Code through the scripting API of
`tom_vscode_scripting_api`, whose calls go to the extension as small
JavaScript snippets (`executeScriptVce`).

Every example on this page is a complete script and has been run through
`tom_bs` as written. The VS Code API itself — every namespace, method and type,
and the `VsCodeHelper` convenience layer — is documented with the scripting
API: [VS Code scripting guide](../../tom_vscode_scripting_api/doc/vscode_api_vscode_scripting_guide.md)
and [introduction](../../tom_vscode_scripting_api/doc/vscode_api_intro.md).

## Table of Contents

- [Running a script](#running-a-script)
- [What a script defines](#what-a-script-defines)
- [Imports](#imports)
- [Paths](#paths)
- [Examples](#examples)
  - [The smallest script](#the-smallest-script)
  - [Messages and input](#messages-and-input)
  - [Files in the workspace](#files-in-the-workspace)
  - [Commands and settings](#commands-and-settings)
  - [VsCodeHelper](#vscodehelper)
  - [Progress and batches of files](#progress-and-batches-of-files)
  - [Running a program](#running-a-program)
  - [Errors](#errors)
  - [A document as the result](#a-document-as-the-result)
  - [Copilot](#copilot)
- [See also](#see-also)

## Running a script

| From | How | Bridge request |
| --- | --- | --- |
| VS Code | `@T: Execute File` on a `.dart` file (Explorer or editor menu) | `executeFileVcb` |
| VS Code | `@T: Execute as Script`: the file, or the selection when called from the editor with one | `executeScriptVcb` |
| A Dart program | over the CLI integration server (`@T: Start Tom CLI Integration Server`), `executeFileVcb` / `executeScriptVcb` | — |

`@T: Execute File` waits as long as a bridge request may take
(`tomAi.bridge.requestTimeout`, 30 seconds by default). `@T: Execute as Script`
waits up to two hours, or the seconds a `// @timeout: <seconds>` line in the
script names.

## What a script defines

The bridge calls the script's top-level **`main()`**, with no arguments
(`main(List<String> args)` gets an empty list). A script without `main` fails
with *Undefined variable: main*. An `async` `main` is awaited.

- What `main` returns is the request's `result`; the extension shows success
  or the error. A map with `action: 'showDocument'`, `filename` and `content`
  is opened in a new editor ([example](#a-document-as-the-result)).
- `print` output goes to the bridge's log and comes back with the result as
  `logs`.
- An exception the script does not catch ends the run: the answer is
  `{success: false, error, stackTrace, logs}` and the extension shows the
  error.
- The request's `params` are not handed to the script. It asks VS Code for
  what it needs, e.g. `await workspace.getRootPath()`.

## Imports

Nothing is imported for a script. `import
'package:tom_vscode_scripting_api/script_globals.dart';` gives the VS Code
globals — `vscode`, `window`, `workspace`, `commands`, `extensions`, `lm`,
`chat` — and the rest of the scripting API: `VsCodeHelper`, `VsProgress`,
`FileBatch` and the types. `dart:io`, `dart:convert` and the other `dart:`
libraries are imported as usual. Other `package:` imports — including
`package:tom_vscode_bridge/...` — do not load in `tom_bs`.

## Paths

`workspace.readFile`, `writeFile` and `fileExists` hand the path to Node's `fs`
in the extension host: a relative path is relative to the extension host's
working directory, not the workspace. Build absolute paths from
`await workspace.getRootPath()`; `findFilePaths` / `VsCodeHelper.findFiles`
answer absolute paths.

## Examples

### The smallest script

```dart
main() {
  print('hello from the bridge');
  return {'success': true};
}
```

### Messages and input

The message methods answer the button the user clicked (`items`), or `null`;
`showInputBox` the text typed, `showQuickPick` the item picked.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  await window.showInformationMessage('Hello from Dart');
  final name = await window.showInputBox(prompt: 'Your name?');
  final size = await window.showQuickPick(['Small', 'Medium', 'Large'], placeHolder: 'Size');
  final go = await window.showWarningMessage('Continue?', items: ['Yes', 'No']);
  return {'name': name, 'size': size, 'continue': go};
}
```

### Files in the workspace

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final root = await workspace.getRootPath();
  if (root == null) {
    return {'success': false, 'error': 'no workspace folder open'};
  }
  final dartFiles = await workspace.findFilePaths(include: '**/*.dart', exclude: '**/build/**');
  var lines = 0;
  for (final path in dartFiles) {
    lines += (await workspace.readFile(path)).split('\n').length;
  }
  final report = '$root/dart_report.txt';
  await workspace.writeFile(report, '${dartFiles.length} Dart files, $lines lines\n');
  await window.showTextDocument(report);
  return {'files': dartFiles.length, 'lines': lines};
}
```

### Commands and settings

`VsCodeHelper.getConfig` takes the key by name (`key:`); without it, it answers
the whole section.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  await commands.executeCommand('workbench.action.files.saveAll');
  final tabSize = await VsCodeHelper.getConfig('editor', key: 'tabSize');
  await window.setStatusBarMessage('Saved all files (tab size $tabSize)');
  return {'tabSize': tabSize};
}
```

### VsCodeHelper

`VsCodeHelper` wraps common steps in one static call each — messages, files,
commands, configuration, the clipboard, Dart and Flutter tooling, Copilot.
Its full list is in the [scripting guide](../../tom_vscode_scripting_api/doc/vscode_api_vscode_scripting_guide.md#vscodehelper--the-convenience-layer).

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  await VsCodeHelper.setStatus('Looking for TODOs…');
  final files = await VsCodeHelper.findFiles(include: 'lib/**/*.dart');
  final withTodos = <String>[];
  for (final file in files) {
    final text = await VsCodeHelper.readFile(file);
    if (text.contains('TODO')) {
      withTodos.add(file);
    }
  }
  await VsCodeHelper.showInfo('${withTodos.length} of ${files.length} files have a TODO');
  return {'files': withTodos};
}
```

### Progress and batches of files

`VsProgress` writes to an output channel of its own name; `FileBatch` holds the
paths a pattern finds and reads each file for `process`.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final progress = await VsProgress.create('Indexing');
  final batch = await FileBatch.fromPattern(include: '**/*.dart');
  final sources = await batch.filter((path) => !path.endsWith('.g.dart'));
  await progress.report('${sources.count} Dart files to index');
  final sizes = await sources.process<int>((path, content) async => content.length);
  await progress.report('${sizes.fold<int>(0, (a, b) => a + b)} characters read');
  await progress.complete();
  return {'files': sources.count};
}
```

### Running a program

There is no shell helper in the scripting API; `dart:io` runs in the bridge
process, on the machine the bridge runs on.

```dart
import 'dart:io';
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final root = await workspace.getRootPath();
  // dart:io runs here, in the bridge process, on this machine.
  final result = await Process.run('ls', ['-1'], workingDirectory: root);
  final entries = (result.stdout as String).trim().split('\n');
  return {'exitCode': result.exitCode, 'entries': entries.length};
}
```

### Errors

A script that wants to end with its own message returns it; an uncaught
exception ends the run with an error answer.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final root = await workspace.getRootPath();
  final config = '$root/settings.yaml';
  if (!await workspace.fileExists(config)) {
    await window.showErrorMessage('No settings.yaml in the workspace');
    return {'success': false, 'error': 'settings.yaml missing'};
  }
  try {
    final text = await workspace.readFile(config);
    return {'success': true, 'lines': text.split('\n').length};
  } catch (e) {
    return {'success': false, 'error': e.toString()};
  }
}
```

### A document as the result

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final files = await workspace.findFilePaths(include: '**/*.dart');
  final report = StringBuffer('# Dart files\n\n');
  for (final f in files) {
    report.writeln('- `$f`');
  }
  // The extension opens `content` in a new editor, its language taken from `filename`.
  return {'action': 'showDocument', 'filename': 'dart_files.md', 'content': report.toString()};
}
```

### Copilot

`VsCodeHelper.askCopilot` sends the prompt (and `context`) to the first
language model VS Code offers and answers its text.

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<Map<String, dynamic>> main() async {
  final root = await workspace.getRootPath();
  final code = await workspace.readFile('$root/lib/util.dart');
  final answer = await VsCodeHelper.askCopilot('Explain this code in two sentences.', context: code);
  return {'answer': answer};
}
```

## See also

- [API reference](API_REFERENCE.md): the bridge's requests and the
  `VSCodeBridgeServer` API.
- [VS Code scripting guide](../../tom_vscode_scripting_api/doc/vscode_api_vscode_scripting_guide.md):
  the VS Code API and `VsCodeHelper` in full.
- [The package README](../README.md): the execution model, the bridge
  methods and building `tom_bs`.
