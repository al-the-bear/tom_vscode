# VS Code Scripting — Introduction Sample

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../../LICENSE).

> The on-ramp to driving VS Code from Dart. This project is a **plain compiled
> Dart program** that connects to a **running VS Code window** over a local
> socket bridge and calls the editor's API — showing notifications, running
> commands, inspecting the workspace, and reading/opening files. It establishes
> the connection helper and run-script conventions reused by the other samples
> under [`tom_vscode_scripting_api/example/`](../README.md).

`tom_vscode_scripting_api` gives you a Dart-shaped view of the VS Code
extension API. You write ordinary async Dart — `vscode.window.showInformationMessage(...)`,
`vscode.commands.executeCommand(...)` — and each call is marshalled over a
JSON-RPC connection to a VS Code window that is **already open on your desktop**.
There is no extension to build, no webview, no `vsce package`: a window running
the Tom extension exposes a small server, your Dart program connects to it, and
from then on your program is "inside" that window.

This article walks through **one** thing in depth — *how a Dart program finds
and talks to a live editor* — and then explains each of the five example
concepts file by file. By the end you will understand the connection model,
the namespace API surface, and the run-script conventions every later sample
builds on.

---

## Table of contents

1. [What you'll build](#1-what-youll-build)
2. [Prerequisites](#2-prerequisites)
3. [Project layout](#3-project-layout)
4. [Running it](#4-running-it)
5. [The mental model: a program inside a live window](#5-the-mental-model-a-program-inside-a-live-window)
6. [The connection, line by line](#6-the-connection-line-by-line)
7. [The five concepts, file by file](#7-the-five-concepts-file-by-file)
8. [The aggregator and the dispatcher](#8-the-aggregator-and-the-dispatcher)
9. [Why the explicit exit codes](#9-why-the-explicit-exit-codes)
10. [Troubleshooting](#10-troubleshooting)
11. [The other samples](#11-the-other-samples)
12. [Where to go next](#12-where-to-go-next)

---

## 1. What you'll build

Five tiny, self-contained programs — one concept each — that together form a
complete first tour of the scripting API:

```text
connect  →  messages  →  commands  →  workspace_folders  →  read_open_file
(find a    (toasts &     (list &      (roots, name,         (find, read,
 window)    status bar)   execute)     folders)              open a file)
```

Each concept is a single public function with the uniform shape
`Future<bool> run<Name>Example(VSCode vscode)`, so a small **aggregator**
(`run_all_examples.dart`) can connect once and run them all, tallying
pass/fail. A **dispatcher** (`bin/run_example.dart`) runs any one of them by
name. The whole project depends on exactly one package —
`tom_vscode_scripting_api` — and talks to a window you already have open.

The point of choosing these five concepts is coverage without ceremony: they
touch the three core namespaces (`window`, `commands`, `workspace`) and the
top-level `VSCode` object, which is everything you need before reaching for the
editor-editing, language-model, agent-tool, and Agent-SDK surfaces shown in the
later samples.

---

## 2. Prerequisites

Unlike the d4rt samples (which run entirely in-process), **these examples need
a live VS Code window**. The socket calls have a hard runtime dependency:

1. **A VS Code window with the Tom extension active.** Any workspace will do —
   the examples are read-only-ish (they show notifications, save the active
   file, and open a markdown document; nothing destructive).
2. **The CLI Integration Server started in that window.** Open the command
   palette and run **`DS: Start Tom CLI Integration Server`**. The window now
   listens on a localhost port in the range **19900–19909** (the first free
   port; a second window takes the next one).

With no server running, the examples do **not** throw — `connectToFirstWindow`
prints a clear prerequisite message and the aggregator exits `0` (a documented
skip, not a failure). That makes the project safe to run in CI or on a headless
box: it simply reports "no window found" and stops.

---

## 3. Project layout

```text
vscode_scripting_introduction_sample/
├── pubspec.yaml                 # depends only on tom_vscode_scripting_api ^1.1.0
├── analysis_options.yaml        # package:lints/recommended.yaml
├── README.md                    # this article
├── run_example.sh               # POSIX runner (pub get on first run, forwards args)
├── run_example.ps1              # PowerShell runner
├── bin/
│   └── run_example.dart         # dispatcher: run one concept by name (or `all`)
└── example/
    ├── connect.dart             # the shared connection helper + the "connect" concept
    ├── messages.dart            # notifications + status bar
    ├── commands.dart            # list & execute commands
    ├── workspace_folders.dart   # workspace identity & root folders
    ├── read_open_file.dart      # find, read, and open a file
    └── run_all_examples.dart    # aggregator: connect once, run all, tally
```

Two roles of code live here, and keeping them straight is the whole idea:

- **`bin/run_example.dart` and `example/run_all_examples.dart` are entry
  points.** They own the connection: they call `connectToFirstWindow()`, run
  one or many concepts, then `disconnect()`.
- **The five `example/*.dart` concept files are pure functions of a connected
  window.** Each takes an already-connected `VSCode` and does one thing. They
  never connect on their own — that keeps each concept focused and lets the
  aggregator share a single connection across all of them.

---

## 4. Running it

From the package root, with a window + server ready:

```sh
# Run every concept (the aggregator):
./run_example.sh
# or:  dart run example/run_all_examples.dart

# Run a single concept by name:
./run_example.sh messages
# or:  dart run bin/run_example.dart messages

# Override the bridge host (default 127.0.0.1):
dart run bin/run_example.dart connect 127.0.0.1
```

The run scripts (`run_example.sh` / `run_example.ps1`) run `dart pub get` on the
first invocation, then forward all arguments to the dispatcher. Expected
aggregator output against a window named `tom_brain` on port 19900:

```text
Connected to "tom_brain.code-workspace" on 127.0.0.1:19900

=== connect ===
VS Code version: 1.124.0
  [PASS] connect

=== messages ===
Information toast shown (clicked: null)
Status bar updated.
  [PASS] messages

=== commands ===
Window exposes 5083 commands.
A few: noop, undo, default:undo, redo, default:redo
Executed workbench.action.files.save -> null
  [PASS] commands

=== workspace_folders ===
Workspace: tom_brain (Workspace) (root: /home/alexis/tac)
1 folder(s):
  - tac -> /home/alexis/tac
  [PASS] workspace_folders

=== read_open_file ===
Found markdown at: /home/alexis/tac/tom_brain/README.md
File is 12 characters; first line: # Tom Brain
Opened README.md (2 lines, language: markdown).
  [PASS] read_open_file

5/5 examples passed.
```

---

## 5. The mental model: a program inside a live window

An interpreter sample runs *your* code in *its* process. This sample is the
mirror image: it runs your code in your own process and reaches **out** to a
program (VS Code) that is already running.

```text
┌─────────────────────────┐         JSON-RPC 2.0          ┌──────────────────────────┐
│  your Dart program       │   over a length-prefixed      │  VS Code window          │
│  (this sample)           │   TCP socket on 127.0.0.1     │  + Tom extension         │
│                          │                                │                          │
│  vscode.window           │  ── request ──────────────▶   │  CLI Integration Server  │
│    .showInformation...() │                                │   (port 19900–19909)     │
│                          │  ◀───────────── response ──    │   → real vscode.window…  │
└─────────────────────────┘                                └──────────────────────────┘
```

Three facts follow from this picture:

- **Every call is async and remote.** `await vscode.getVersion()` is a network
  round-trip, not a local property read. Latency is small (localhost) but real.
- **State lives in the window, not your program.** "The active editor", "the
  workspace folders", "the command set" are all the window's state; you observe
  and mutate them through the API.
- **One window per port.** Several windows each run their own server on the next
  free port, so discovery means *scanning* the range and asking each responsive
  port who it is.

---

## 6. The connection, line by line

The one piece of infrastructure every concept shares lives in
[`example/connect.dart`](example/connect.dart). It is small enough to read in
full:

```dart
Future<LazyVSCodeBridgeAdapter?> connectToFirstWindow({
  String host = '127.0.0.1',
}) async {
  final windows = await scanBridgePorts(host: host);
  if (windows.isEmpty) {
    print(
      'No VS Code CLI Integration Server found on $host:'
      '$defaultVSCodeBridgePort–$maxVSCodeBridgePort.',
    );
    print(
      'Open a VS Code window with the Tom extension active and run '
      '"DS: Start Tom CLI Integration Server", then try again.',
    );
    return null;
  }

  final port = windows.keys.first;
  final identity = windows[port];
  final adapter = LazyVSCodeBridgeAdapter(host: host, port: port);
  if (!await adapter.connect()) {
    print('Found a window on $host:$port but could not connect to its bridge.');
    return null;
  }

  VSCode.initialize(adapter);
  print('Connected to "$identity" on $host:$port');
  return adapter;
}
```

What each step does:

- **`scanBridgePorts(host: host)`** probes every port from
  `defaultVSCodeBridgePort` (19900) to `maxVSCodeBridgePort` (19909). For each
  responsive port it performs a lightweight identity handshake and records the
  window's workspace name. It returns a `Map<int, String>` in ascending port
  order — empty if nothing is listening. This is the discovery primitive; the
  sibling helpers `findBridgePortForWorkspace(name)` and
  `connectToWorkspace(name)` build on it when you want a *specific* window
  rather than the first one.
- **The empty-map branch** is the documented prerequisite path: no server →
  print how to start one → return `null`. No exception, so callers can treat
  "no window" as a clean skip.
- **`LazyVSCodeBridgeAdapter(host:, port:)`** is the transport. "Lazy" because
  it defers the actual socket connect; `connect()` returns `false` (rather than
  throwing) when the port stops answering between scan and connect.
- **`VSCode.initialize(adapter)`** promotes this adapter to the global `VSCode`
  singleton, so `VSCode.instance` — and therefore `vscode.window`,
  `vscode.commands`, `vscode.workspace` — targets this window from now on.
- **The returned adapter** is the connection handle. The caller keeps it so it
  can `adapter.disconnect()` when finished.

The "connect" concept itself is then trivial — it just reads the connected
window's version, proving the round-trip works:

```dart
Future<bool> runConnectExample(VSCode vscode) async {
  final version = await vscode.getVersion();
  print('VS Code version: $version');
  return version.isNotEmpty;
}
```

---

## 7. The five concepts, file by file

### `connect.dart` — find a window, read its identity

Covered above: owns `connectToFirstWindow()` (shared infra) and
`runConnectExample()` (reads `getVersion()`). Start here; the rest assume a
connected `VSCode`.

### `messages.dart` — notifications and the status bar

The three notification severities all return the label of the button the user
clicked, or `null` when dismissed. With no action buttons they are
fire-and-forget toasts:

```dart
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
```

`setStatusBarMessage` writes to the left side of the status bar — a low-noise
way to surface progress from a long-running script.

### `commands.dart` — enumerate and execute commands

Every action in VS Code is a command with an id. `getCommands()` returns the
full set; `executeCommand(id, [args])` runs one and returns its result. Here we
run `workbench.action.files.save`, a safe no-op when nothing is dirty:

```dart
Future<bool> runCommandsExample(VSCode vscode) async {
  final commands = await vscode.commands.getCommands();
  print('Window exposes ${commands.length} commands.');
  final sample = commands.take(5).join(', ');
  print('A few: $sample');

  final result = await vscode.commands.executeCommand(
    'workbench.action.files.save',
  );
  print('Executed workbench.action.files.save -> $result');
  return commands.isNotEmpty;
}
```

A real window exposes several thousand commands — built-in editor commands plus
everything contributed by installed extensions. `executeCommand` is the escape
hatch for anything the typed namespaces don't wrap directly.

### `workspace_folders.dart` — inspect the workspace

A window can have zero, one, or several root folders (a multi-root workspace).
`getWorkspaceFolders()` lists them; `getWorkspaceName()` and `getRootPath()`
return the label and primary root:

```dart
Future<bool> runWorkspaceFoldersExample(VSCode vscode) async {
  final name = await vscode.workspace.getWorkspaceName();
  final root = await vscode.workspace.getRootPath();
  print('Workspace: $name (root: $root)');

  final folders = await vscode.workspace.getWorkspaceFolders();
  print('${folders.length} folder(s):');
  for (final folder in folders) {
    print('  - ${folder.name} -> ${folder.uri.fsPath}');
  }
  return true;
}
```

Each `WorkspaceFolder` carries a `name` and a `VSCodeUri` whose `fsPath` gives
you the absolute on-disk path — the bridge between editor concepts and ordinary
file I/O.

### `read_open_file.dart` — find, read, and open a file

Three workspace operations in sequence. `findFilePaths` runs a glob and returns
absolute paths; `readFile` returns a file's text without opening anything;
`openTextDocument` loads it into VS Code's document model:

```dart
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
```

> **Why `openTextDocument` and not `window.showTextDocument`?**
> `openTextDocument` loads the document into VS Code's model; `showTextDocument`
> additionally reveals it in a visible tab. This sample uses the former because
> it pins the published `tom_vscode_scripting_api ^1.1.0`, in which
> `TextEditor.fromJson` crashes on an empty `visibleRanges` array (the common
> case for a freshly revealed editor). That bug is already fixed in source;
> once `1.1.1` is published this example will switch to `showTextDocument` to
> demonstrate the reveal-in-tab path.

---

## 8. The aggregator and the dispatcher

The two entry points share the connection helper but differ in scope.

**`example/run_all_examples.dart`** declares the concepts in teaching order and
runs them all against one connection:

```dart
typedef Example = ({String name, Future<bool> Function(VSCode) run});

const List<Example> introductionExamples = [
  (name: 'connect', run: runConnectExample),
  (name: 'messages', run: runMessagesExample),
  (name: 'commands', run: runCommandsExample),
  (name: 'workspace_folders', run: runWorkspaceFoldersExample),
  (name: 'read_open_file', run: runReadOpenFileExample),
];
```

It connects once, iterates, catches any per-concept exception (so one failure
doesn't abort the rest), and prints a final `passed/total` tally. The
record-typed `Example` keeps the name and its function together in one list —
the single source of truth both entry points iterate.

**`bin/run_example.dart`** is the same idea narrowed to one concept by name,
with `all` delegating to the aggregator:

```dart
final Map<String, Future<bool> Function(VSCode)> _examples = {
  'connect': runConnectExample,
  'messages': runMessagesExample,
  'commands': runCommandsExample,
  'workspace_folders': runWorkspaceFoldersExample,
  'read_open_file': runReadOpenFileExample,
};
```

An unknown name exits `64` (`EX_USAGE`) with the list of valid names — the
standard "you held it wrong" exit code.

---

## 9. Why the explicit exit codes

Both entry points call `exit(...)` explicitly rather than letting `main` return.
There is a concrete reason: the bridge client keeps its socket open, which keeps
the Dart event loop alive, so a normally-returning `main` would leave the
process hanging after all work is done. The exit contract is:

| Code | Meaning |
| ---- | ------- |
| `0` | all examples passed, **or** no live bridge was found (documented skip) |
| `1` | at least one example failed against a live window |
| `64` | (dispatcher) unknown example name |

This makes the project CI-friendly: a headless run with no window exits `0`, a
real regression exits `1`.

---

## 10. Troubleshooting

| Symptom | Cause & fix |
| ------- | ----------- |
| `No VS Code CLI Integration Server found on 127.0.0.1:19900–19909` | No window has the server running. Run **`DS: Start Tom CLI Integration Server`** in the command palette. |
| Connects to the *wrong* window | `connectToFirstWindow` picks the lowest port. Use `connectToWorkspace('<name>')` / `findBridgePortForWorkspace('<name>')` to target a specific window by its workspace name. |
| `Found a window … but could not connect` | The port answered the scan but the socket connect failed (window closing, or the server stopped between scan and connect). Re-run. |
| `read_open_file` finds nothing | The active workspace has no markdown file matching `**/*.md`. Open a workspace that has one, or adjust the glob. |
| Process seems to hang | You're running a concept function directly without an entry point that calls `exit`. Use `bin/run_example.dart` or `run_all_examples.dart`. |

---

## 11. The other samples

This is the first of four samples under
[`tom_vscode_scripting_api/example/`](../README.md). Once the connection model
here is familiar, continue with:

| Sample | Adds |
| ------ | ---- |
| [`vscode_scripting_advanced_sample`](../vscode_scripting_advanced_sample/) | Editor edits, batched file operations, progress, quick-pick/input flows, the language-model API, and the `VsCodeHelper` convenience layer. |
| [`vscode_agent_tools_sample`](../vscode_agent_tools_sample/) | The extension's own feature APIs as in-process tools: todos, the prompt queue, timed requests, documents, workspace metadata, `TomToolsApi`, and send-to-chat. |
| [`vscode_agent_sdk_sample`](../vscode_agent_sdk_sample/) | Streaming `AgentSdkClient.query()`, typed message streams, in-process Dart `tool()`s, and the `canUseTool` permission callback. |

---

## 12. Where to go next

- [Scripting API module README](../../README.md) — the full API surface, install,
  and architecture.
- [Scripting API intro & architecture](../../doc/vscode_api_intro.md) — the
  connection model and initialization styles in depth.
- [`tom_vscode_bridge`](../../../tom_vscode_bridge/README.md) — the bridge that
  hosts the CLI Integration Server this sample connects to.
- [Repository map](../../../README.md) — the whole Tom VS Code ecosystem.

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](../../LICENSE).
