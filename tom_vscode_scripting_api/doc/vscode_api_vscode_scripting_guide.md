# VS Code Scripting Guide

This guide covers the part of `tom_vscode_scripting_api` that scripts **VS Code
itself** — the editor, its windows, the workspace and file system, command
execution, extensions, the language model, and chat participants. It also covers
`VsCodeHelper`, the batteries-included convenience layer.

If you have not connected yet, read
[vscode_api_intro.md](vscode_api_intro.md) first. In short:

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

final adapter = await connectToWorkspace('tom_agent_container');
VSCode.initialize(adapter);   // enables vscode / window / workspace / ...
```

Once `VSCode.initialize` has run, the top-level getters `vscode`, `window`,
`workspace`, `commands`, `extensions`, `lm`, and `chat` are live.

---

## The `VSCode` singleton

`VSCode` is the root namespace.

```dart
VSCode.initialize(adapter);          // set up once
VSCode.instance;                     // the singleton
VSCode.isInitialized;                // bool
VSCode.instance.adapter;             // the underlying VSCodeAdapter
```

Direct members:

| Member | Returns | Notes |
| ------ | ------- | ----- |
| `getVersion()` | `Future<String>` | VS Code version string. |
| `getEnv()` | `Future<Map>` | `appName`, `appRoot`, `language`, `machineId`, etc. |
| `openExternal(uri)` | `Future<bool>` | Open a URI in the OS default handler. |
| `copyToClipboard(text)` | `Future<void>` | Write the clipboard. |
| `readFromClipboard()` | `Future<String>` | Read the clipboard. |

Namespaces: `vscode.window`, `vscode.workspace`, `vscode.commands`,
`vscode.extensions`, `vscode.lm`, `vscode.chat`.

---

## `window` — `VSCodeWindow`

### Messages (non-blocking, return `null`)

```dart
await window.showInformationMessage('Build complete');
await window.showWarningMessage('Uncommitted changes');
await window.showErrorMessage('Analyzer found 3 errors');
```

These display a notification and return immediately; they do **not** block the
script waiting for the user to dismiss them.

### Interactive prompts (blocking, return the choice)

```dart
final choice = await window.showQuickPick(
  ['Debug', 'Release', 'Profile'],
  placeHolder: 'Pick a build mode',
  timeoutSeconds: 30,
  fallbackValueOnTimeout: 'Debug',
);

final name = await window.showInputBox(
  prompt: 'Feature branch name',
  placeHolder: 'feature/...',
);

final secret = await window.showInputBox(prompt: 'Token', password: true);
```

`showQuickPick` supports `canPickMany`, `timeoutSeconds`,
`fallbackValueOnTimeout`, and `failOnTimeout`. `showInputBox` accepts `prompt`,
`placeHolder`, `value`, `password`, and validation options.

### Editors

```dart
final editor = await window.getActiveTextEditor();   // TextEditor?
if (editor != null) {
  print(editor.document.uri);
}
await window.showTextDocument('lib/main.dart');
```

### Output channels, status bar, terminals, dialogs

```dart
await window.setStatusBarMessage('Indexing…', timeoutMs: 4000);

// Output channel
await window.appendToOutputChannel('Build', 'Compiling…');
await window.showOutputChannel('Build');

// Terminal
await window.createTerminal(name: 'tests');
await window.sendTextToTerminal('tests', 'dart test\n');

// File dialogs
final save = await window.showSaveDialog(/* ... */);
final open = await window.showOpenDialog(/* ... */);
```

---

## `workspace` — `VSCodeWorkspace`

### Folders & names

```dart
final folders = await workspace.getWorkspaceFolders();   // List<WorkspaceFolder>
final root    = await workspace.getRootPath();           // String?
final name    = await workspace.getWorkspaceName();       // String?
final folder  = await workspace.getWorkspaceFolder(uri);  // owning folder of a uri
```

### Finding files

```dart
final uris  = await workspace.findFiles('lib/**/*.dart', exclude: '**/*.g.dart');
final paths = await workspace.findFilePaths(include: 'test/**/*_test.dart');
```

### Documents

```dart
final doc = await workspace.openTextDocument('pubspec.yaml');
await workspace.saveTextDocument('pubspec.yaml');
```

### File system (via the extension host's Node `fs`)

```dart
if (await workspace.fileExists('build.log')) {
  final text = await workspace.readFile('build.log');
  await workspace.writeFile('build.copy.log', text);
  await workspace.deleteFile('build.log');
}
```

These run inside the extension host, so paths resolve relative to the workspace
and the operations honour the host's file access.

### Configuration

```dart
final tabSize = await workspace.getConfiguration('editor', scope: null);
await workspace.updateConfiguration('editor', 'tabSize', 2, global: false);
```

---

## `commands` — `VSCodeCommands`

```dart
await commands.executeCommand('workbench.action.files.saveAll');
final result = await commands.executeCommand(
  'vscode.executeDocumentSymbolProvider',
  args: [uri],
  timeoutSeconds: 20,
);
final ids = await commands.getCommands(filterInternal: true);
await commands.registerCommand('myscript.hello', handlerScript);
```

`VSCodeCommonCommands` provides named constants for frequent IDs
(`openFile`, `saveFile`, `formatDocument`, `reloadWindow`, …) so you avoid
magic strings:

```dart
await commands.executeCommand(VSCodeCommonCommands.formatDocument);
```

---

## `extensions` — `VSCodeExtensions`

```dart
final all = await extensions.getAll();                  // List<Extension>
final py  = await extensions.getExtension('ms-python.python');  // Extension?
final has = await extensions.isInstalled('redhat.vscode-yaml');  // bool

await extensions.activateExtension('ms-python.python');
final api = await extensions.getExtensionExports('ms-python.python');

final v   = await extensions.getExtensionVersion('ms-python.python');
final name = await extensions.getExtensionDisplayName('ms-python.python');
```

The `Extension` model carries `id`, `isActive`, version, display name, and
description.

---

## `lm` — `VSCodeLanguageModel`

Access the editor's language models (e.g. GitHub Copilot) and register/​invoke
language-model tools.

```dart
final models = await lm.selectChatModels(vendor: 'copilot');
final model  = models.first;

final response = await model.sendRequest(
  VSCode.instance.adapter,
  [
    LanguageModelChatMessage.user('Explain this stack trace'),
  ],
);
// response is a LanguageModelChatResponse

final tokens = await model.countTokens('some text');
```

Tools:

```dart
final tools  = await lm.getTools();                          // available LM tools
final result = await lm.invokeTool('myTool', toolOptions);   // LanguageModelToolResult
await lm.registerTool('myTool', tool);
```

Key types: `LanguageModelChat`, `LanguageModelChatMessage` (`.user` /
`.assistant` constructors), `LanguageModelChatResponse`,
`LanguageModelToolResult`, `LanguageModelToolInformation`.

> For the **Anthropic** Agent SDK (a different, richer agentic surface), see the
> [Agent SDK guide](vscode_api_anthropic_agent_sdk_guide.md). `lm` here is the
> VS Code language-model API (Copilot et al.), not the Agent SDK.

---

## `chat` — `VSCodeChat`

Register a chat participant whose handler runs in your Dart program (via the
server→client callback channel):

```dart
final participant = await chat.createChatParticipant(
  'myext.helper',
  description: 'My scripted assistant',
  fullName: 'Helper',
  handler: (request, context, stream) async {
    stream.markdown('You said: ${request.prompt}');
    stream.button(title: 'Run tests', command: 'myscript.runTests');
    return ChatResult();
  },
);
```

Handler-side types: `ChatRequest` (`prompt`, references), `ChatContext`,
`ChatResponseStream` (`markdown`, `anchor`, `button`, `filetree`, `progress`,
`reference`, `error`), `ChatResult`, `ChatErrorDetails`,
`ChatPromptReference`.

---

## Types — `vscode_types.dart`

Shared value types used across the namespaces:

| Type | Purpose |
| ---- | ------- |
| `VSCodeUri` | URI wrapper (scheme/path/fsPath). |
| `WorkspaceFolder` | Name + URI + index. |
| `TextDocument` | URI, languageId, line count, dirty/closed flags. |
| `Position`, `Range`, `Selection` | Editor coordinates. |
| `TextEditor` | Active document + selection. |
| `QuickPickItem` | label/description/detail for rich pick lists. |
| `InputBoxOptions`, `MessageOptions`, `TerminalOptions` | Option bags. |
| `DiagnosticSeverity` | enum (error/warning/info/hint). |
| `FileSystemWatcherOptions` | watcher configuration. |

---

## `VsCodeHelper` — the convenience layer

`VsCodeHelper` is an all-static helper that wraps common multi-step operations
into one call. It is the most ergonomic entry point for scripts.

```dart
await VsCodeHelper.init(adapter);   // or it uses the VSCode singleton
HelperLogging.debugLogging = true;  // verbose bridge logging
```

### UI convenience

```dart
await VsCodeHelper.showInfo('Done');
await VsCodeHelper.showWarning('Careful');
await VsCodeHelper.showError('Failed');
final pick = await VsCodeHelper.quickPick(['a', 'b']);
final text = await VsCodeHelper.inputBox(prompt: 'Name?');
```

### Files, commands, config, clipboard

```dart
await VsCodeHelper.openFile('lib/main.dart');
await VsCodeHelper.executeCommand('workbench.action.files.saveAll');
await VsCodeHelper.setStatus('Working…');
final cfg = await VsCodeHelper.getConfig('editor', 'tabSize');
await VsCodeHelper.setConfig('editor', 'tabSize', 2);
```

### Dart / Flutter tooling

```dart
await VsCodeHelper.runPubGet();
await VsCodeHelper.addDependency('http');
final diags = await VsCodeHelper.getDiagnostics('lib/main.dart');
await VsCodeHelper.formatDocument('lib/main.dart');
await VsCodeHelper.hotReload();
await VsCodeHelper.runFlutterApp();
```

### Copilot helpers

```dart
final answer = await VsCodeHelper.askCopilot('How do I parse YAML in Dart?');
final reply  = await VsCodeHelper.askCopilotChat('Refactor the selection');
final models = await VsCodeHelper.getCopilotModels();
await VsCodeHelper.selectCopilotModel('gpt-4o');

await VsCodeHelper.explainCode('lib/parser.dart');
await VsCodeHelper.reviewCode('lib/parser.dart');
await VsCodeHelper.generateTests('lib/parser.dart');
await VsCodeHelper.fixCode('lib/parser.dart');
```

> `askCopilotChat` works by dispatching to Copilot chat and polling
> `~/.tom/copilot-chat-answers/<windowId>_answer.json` for the reply.

### Editor edits

```dart
await VsCodeHelper.replaceText(/* range */, 'new text');
await VsCodeHelper.insertSnippet('TODO: $1');
final sel = await VsCodeHelper.getSelection();
final pos = await VsCodeHelper.getCursorPosition();
```

### Workspace / project / testing

```dart
final type = await VsCodeHelper.getProjectType();         // dart/flutter/...
final hits = await VsCodeHelper.searchInWorkspace('TODO');
await VsCodeHelper.runTests();
await VsCodeHelper.setBreakpoint('lib/main.dart', 42);
```

### Progress — `VsProgress`

```dart
final p = await VsProgress.create('Indexing');
await p.report(message: 'Scanning files', increment: 25);
await p.complete();
// or p.error('failed') on failure
```

### Batched file work — `FileBatch`

```dart
final batch = await FileBatch.fromPattern('lib/**/*.dart');
final count = await batch.count();
final dartFiles = batch.filter((path) => !path.endsWith('.g.dart'));
await batch.process((path) async {
  // do something per file
});
```

---

## Putting it together

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<void> main() async {
  final adapter = await connectToWorkspace('tom_agent_container');
  VSCode.initialize(adapter);

  await window.setStatusBarMessage('Running analyzer…');
  await commands.executeCommand('workbench.action.files.saveAll');

  final diagnostics = await VsCodeHelper.getDiagnostics('lib/main.dart');
  if (diagnostics.isEmpty) {
    await window.showInformationMessage('No problems found');
  } else {
    await window.showWarningMessage('${diagnostics.length} problems');
  }
}
```

Next: the [Agent SDK guide](vscode_api_anthropic_agent_sdk_guide.md) or the
[extension scripting guide](vscode_api_extension_scripting_guide.md).
