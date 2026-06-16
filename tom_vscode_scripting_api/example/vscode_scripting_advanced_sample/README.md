# VS Code Scripting — Advanced Sample

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../../LICENSE).

> The second step on from the [introduction sample](../vscode_scripting_introduction_sample/).
> Where the introduction taught *how a Dart program finds and talks to a live
> VS Code window*, this project assumes that connection and goes wide: editing
> documents through the editor's own machinery, batched file I/O, progress
> reporting, asking the user with quick-pick and input flows, calling a language
> model (Copilot) in the window, and the `VsCodeHelper` static convenience
> layer. Six concepts, one per file, all over the same `tom_vscode_scripting_api`.

The introduction sample established the spine every scripting program shares: a
compiled Dart process connects over a localhost socket to a window that is
already open, and from then on `vscode.window.…`, `vscode.commands.…`,
`vscode.workspace.…` target that window. This sample reuses that spine verbatim
(the connection helper is copied into [`example/support.dart`](example/support.dart))
and spends its attention on the *next* layer of the API surface — the calls you
reach for once "hello, window" is behind you.

This article walks through **one** thing in depth — *how to edit a document
through the editor rather than by writing the file directly* — and then explains
each of the six concepts file by file. Along the way it surfaces two realities
of working against a live host that the introduction sample only hinted at:
operations that **block on the user**, and operations whose high-level wrapper
**isn't registered on every host build** (and the escape hatch that always
works).

---

## Table of contents

1. [What you'll build](#1-what-youll-build)
2. [Prerequisites](#2-prerequisites)
3. [Project layout](#3-project-layout)
4. [Running it](#4-running-it)
5. [Shared infrastructure: connection + scratch directories](#5-shared-infrastructure-connection--scratch-directories)
6. [Editing a document through the editor, in depth](#6-editing-a-document-through-the-editor-in-depth)
7. [The six concepts, file by file](#7-the-six-concepts-file-by-file)
8. [Interactive concepts and the aggregator's `interactive` flag](#8-interactive-concepts-and-the-aggregators-interactive-flag)
9. [The aggregator and the dispatcher](#9-the-aggregator-and-the-dispatcher)
10. [Two facts about a live host: blocking and unregistered commands](#10-two-facts-about-a-live-host-blocking-and-unregistered-commands)
11. [Exit codes](#11-exit-codes)
12. [Troubleshooting](#12-troubleshooting)
13. [The other samples](#13-the-other-samples)
14. [Where to go next](#14-where-to-go-next)

---

## 1. What you'll build

Six self-contained programs — one concept each — that tour the API surface a
real scripting task actually uses:

```
file_batch  →  editor_edits  →  progress  →  helper_layer  →  language_model  →  quick_pick_input
(bulk file     (ranged edit     (output     (the static      (Copilot via       (ask the user;
 read/write     via the          channel +   VsCodeHelper     selectChatModels   interactive,
 + verify)      editor)          status bar)  façade)          → sendRequest)     skipped in CI)
```

Each concept is a single public function with the uniform shape
`Future<bool> run<Name>Example(VSCode vscode)` — exactly the contract the
introduction sample established. A small **aggregator**
([`example/run_all_examples.dart`](example/run_all_examples.dart)) connects once
and runs them all; a **dispatcher** ([`bin/run_example.dart`](bin/run_example.dart))
runs any one by name. The project depends on exactly one package —
`tom_vscode_scripting_api` — and talks to a window you already have open.

The choice of these six is deliberate breadth: `file_batch` and `editor_edits`
cover the two ways to change content on disk (raw I/O vs. the editor's edit
machinery); `progress` covers feedback from a long job; `helper_layer` shows the
ergonomic static layer that fronts the singleton; `language_model` reaches the
Copilot surface; and `quick_pick_input` covers user prompts — including the
wrinkle that they *block on a human*, which is why one concept is flagged
interactive and skipped by the auto-run.

---

## 2. Prerequisites

Identical to the introduction sample — **these examples need a live VS Code
window**:

1. **A VS Code window with the Tom extension active.** Any workspace will do.
   The concepts are self-cleaning: every file they create lands under
   `<workspaceRoot>/ztmp/advanced_sample/<concept>/` and is deleted again before
   the concept returns.
2. **The CLI Integration Server started in that window.** Command palette →
   **`DS: Start Tom CLI Integration Server`**. The window then listens on a
   localhost port in **19900–19909** (first free port; a second window takes the
   next one).

With no server running, nothing throws: `connectToFirstWindow` prints the
prerequisite and the aggregator exits `0` (a documented skip). The project is
safe to run headless or in CI — it reports "no window found" and stops.

Two concepts have *soft* prerequisites that they degrade around rather than fail
on:

- **`language_model`** needs GitHub Copilot installed and signed in. With no
  model available it prints a skip line and returns success — "no model" is an
  environment fact, not a script bug.
- **`quick_pick_input`** needs a human to click/type. Run headless it falls
  back after a short timeout; in the aggregator it is skipped entirely.

---

## 3. Project layout

```
vscode_scripting_advanced_sample/
├── pubspec.yaml                 # depends only on tom_vscode_scripting_api ^1.1.0
├── analysis_options.yaml        # package:lints/recommended.yaml
├── README.md                    # this article
├── run_example.sh               # POSIX runner (pub get on first run, forwards args)
├── run_example.ps1              # PowerShell runner
├── bin/
│   └── run_example.dart         # dispatcher: run one concept by name (or `all`)
└── example/
    ├── support.dart             # shared connection helper + scratchDir()
    ├── file_batch.dart          # bulk file I/O: write 3, verify, delete
    ├── editor_edits.dart        # ranged edit through the editor machinery
    ├── progress.dart            # output channel + status-bar progress
    ├── helper_layer.dart        # the VsCodeHelper static façade
    ├── language_model.dart      # selectChatModels → sendRequest (Copilot)
    ├── quick_pick_input.dart    # showQuickPick / showInputBox (interactive)
    └── run_all_examples.dart    # aggregator: connect once, run all, tally
```

The same two-roles split as the introduction sample holds here:

- **`bin/run_example.dart` and `example/run_all_examples.dart` are entry
  points.** They own the connection — `connectToFirstWindow()`, run, then
  `disconnect()`.
- **The six `example/*.dart` concept files are pure functions of a connected
  window.** Each takes an already-connected `VSCode` and does one thing. They
  never connect on their own, so the aggregator can share one connection across
  all of them. `support.dart` is shared infra, not a concept.

---

## 4. Running it

From the package root, with a window + server ready:

```sh
# Run every (non-interactive) concept — the aggregator:
./run_example.sh
# or:  dart run example/run_all_examples.dart

# Run a single concept by name:
./run_example.sh editor_edits
# or:  dart run bin/run_example.dart editor_edits

# Run the interactive concept (needs a human):
./run_example.sh quick_pick_input

# Override the bridge host (default 127.0.0.1):
dart run bin/run_example.dart file_batch 127.0.0.1
```

The run scripts run `dart pub get` on first invocation, then forward all
arguments to the dispatcher. Expected aggregator output against a window named
`tom_brain` on port 19900:

```text
Connected to "tom_brain.code-workspace" on 127.0.0.1:19900

=== file_batch ===
Wrote 3 files under /home/alexis/tac/ztmp/advanced_sample/file_batch
Read back 3/3 files with matching content.
Cleaned up 3 files.
  [PASS] file_batch

=== editor_edits ===
Created scratch file with 3 lines.
Replaced line 2 via the editor.
Verified: line 2 is now "edited line".
  [PASS] editor_edits

=== progress ===
Working: step 1/5
Working: step 2/5
Working: step 3/5
Working: step 4/5
Working: step 5/5
Done — 5 steps in 1999 ms.
  [PASS] progress

=== helper_layer ===
Helper sees window "b21e0a2f-…" rooted at /home/alexis/tac.
Round-tripped a scratch file through the helper layer.
  [PASS] helper_layer

=== language_model ===
No chat models available on this window (Copilot signed out?). Skipping.
  [PASS] language_model

=== quick_pick_input (interactive — skipped) ===

5/5 examples passed (1 interactive skipped).
```

(The `language_model` line reads differently when Copilot *is* signed in — see
§7.)

---

## 5. Shared infrastructure: connection + scratch directories

Every concept needs two things: a connection, and (for the file-touching ones)
a private directory to work in. Both live in
[`example/support.dart`](example/support.dart).

`connectToFirstWindow()` is the same helper the introduction sample explains
line by line — scan the port range, connect to the first responsive window,
promote its adapter to the global `VSCode` singleton, return the adapter (or
`null` after printing the prerequisite). It is copied here rather than imported
so each sample stands alone; see the introduction sample's
[`connect.dart`](../vscode_scripting_introduction_sample/example/connect.dart)
for the walkthrough.

The new piece is `scratchDir`, which gives each file-touching concept a private,
predictable working directory under the connected window's workspace:

```dart
Future<String?> scratchDir(VSCode vscode, String sub) async {
  final root = await vscode.workspace.getRootPath();
  if (root == null) return null;
  return '$root/ztmp/advanced_sample/$sub';
}
```

Two design points:

- **It resolves the path against the *window's* root**, not the script's CWD.
  The directory must exist on the host the window runs on, which may not be the
  machine running the Dart program — so we ask the window for its root via
  `workspace.getRootPath()` and build the path from that.
- **It returns `null` when no folder is open.** Concepts treat that as a clean
  skip ("No workspace folder open; cannot demonstrate …") and return `false`
  without throwing, exactly as the introduction sample's read/open concept does.

Callers create files inside the returned directory and delete them again — the
sample never leaves litter behind.

---

## 6. Editing a document through the editor, in depth

The introduction sample read and opened files. The natural next question is *how
do I change one?* — and the answer has two layers worth understanding, because
the obvious one and the working one are not always the same on a given host.

There are two ways to change a file's content:

1. **Write the bytes** — `workspace.writeFile(path, text)` (see `file_batch`).
   Simple and reliable, but it bypasses the editor: open editors, undo history,
   and language features don't participate. Fine for generating files; wrong for
   *editing* a document the user has open.
2. **Edit through the editor** — a `WorkspaceEdit` applied via
   `workspace.applyEdit`. This is the editor's own edit machinery: open editors
   reflect the change, it joins the undo stack, and language features see it.
   This is what `editor_edits` demonstrates.

The library *offers* a high-level wrapper for the second path —
`VsCodeHelper.replaceText(uri, startLine, startChar, endLine, endChar, text)` —
which routes through an extension command (`vscode.executeDocumentEdit`). The
catch: **that command is not registered on every host build.** Probed against a
live window, both `VsCodeHelper.replaceText` and the lower-level
`VsCodeHelper.applyWorkspaceEdit` returned `false` because the commands they
call aren't present. So the sample uses the path that is **always** available:
the **adapter escape hatch**.

`vscode.adapter` exposes `sendRequest` — the very primitive the whole library is
built on. It lets you run genuine VS Code API as JavaScript inside the window's
host (`context.vscode.*`). That is exactly how `editor_edits` performs the edit:

```dart
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
```

Read the script body as ordinary VS Code extension code, because that is what it
is — it just runs in the window instead of in a `.ts` file:

- `context.vscode.Uri.file(params.path)` builds the document URI.
- `openTextDocument(uri)` loads it into the model and gives us `lineAt(line)` so
  we can size the replacement range to the **whole** line (`0 .. lineLen`).
- `new WorkspaceEdit()` + `edit.replace(uri, range, text)` describes the change.
- `workspace.applyEdit(edit)` applies it through the editor machinery and
  returns a boolean the Dart side forwards.

`params` is the bridge for values: anything you put in the `'params'` map is
available as `params.*` inside the script, so you never string-concatenate paths
or text into the script source (no escaping bugs, no injection). The `r'''…'''`
raw string keeps the JS `$`-free and literal.

This is the same primitive `language_model` uses (it reaches `vscode.adapter`
too). When you hit an operation the typed namespaces or `VsCodeHelper` don't
cover on your host, this escape hatch is the reliable fallback.

---

## 7. The six concepts, file by file

### `file_batch.dart` — bulk file I/O

The straight filesystem surface: `writeFile` / `readFile` / `fileExists` /
`deleteFile`, marshalled to the window's host. No editors are opened — this is
the bulk-I/O path for scripts that generate or rewrite many files. The concept
writes three files, reads them back to verify, then deletes them:

```dart
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
```

The concept passes when every file round-trips with matching content
(`matched == files.length`). Note each call is a separate round-trip to the
window; for very large batches you'd batch differently, but the API is the same.

### `editor_edits.dart` — edit through the editor

Covered in depth in §6. The public entry point creates a three-line scratch
file, opens it with the safe `openTextDocument` (see the box below), replaces
line index 1 through `_replaceLineViaEditor`, saves, and reads back to prove the
edit took:

```dart
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
```

> **Why `openTextDocument` and not `window.showTextDocument`?**
> Same reason as the introduction sample: this project pins the published
> `tom_vscode_scripting_api ^1.1.0`, whose `TextEditor.fromJson` crashes on an
> empty `visibleRanges` array (the common case for a freshly revealed editor).
> `openTextDocument` loads the document into the model without that code path.
> The bug is fixed in source; once `1.1.1` is published the reveal-in-tab path
> becomes available.

### `progress.dart` — report progress from a long job

There is no blocking `withProgress` modal in the scripting surface. A script
reports progress the way a CLI does: incremental lines to a named **output
channel** (the durable log) plus a one-line **status bar** summary (the
at-a-glance indicator):

```dart
Future<bool> runProgressExample(VSCode vscode) async {
  const channelName = 'Advanced Sample';
  const steps = 5;
  final started = DateTime.now();

  await vscode.window.createOutputChannel(channelName);
  await vscode.window.showOutputChannel(channelName);

  for (var step = 1; step <= steps; step++) {
    final line = 'Working: step $step/$steps';
    await vscode.window.appendToOutputChannel(channelName, line);
    await vscode.window.setStatusBarMessage('$line …');
    print(line);
    await Future<void>.delayed(const Duration(milliseconds: 150));
  }

  final elapsed = DateTime.now().difference(started).inMilliseconds;
  final summary = 'Done — $steps steps in $elapsed ms.';
  await vscode.window.appendToOutputChannel(channelName, summary);
  await vscode.window.setStatusBarMessage(summary);
  print(summary);

  return true;
}
```

`createOutputChannel` is idempotent by name (calling it again returns the same
channel), `showOutputChannel` reveals the panel, and `appendToOutputChannel`
adds a line. The `Future.delayed` stands in for real work between reports.

### `helper_layer.dart` — the `VsCodeHelper` static façade

Every other concept goes through the `VSCode` singleton
(`vscode.workspace.…`). `VsCodeHelper` is a thin static façade over that same
singleton: once `VSCode.initialize(adapter)` has run, you can call
`VsCodeHelper.writeFile(...)` without threading a `vscode` handle through every
function — the ergonomic layer for short scripts. This concept proves the two
layers share one connection by writing through the helper and reading through
the singleton:

```dart
Future<bool> runHelperLayerExample(VSCode vscode) async {
  final windowId = await VsCodeHelper.getWindowId();
  final root = await VsCodeHelper.getWorkspaceRoot();
  if (root == null) {
    print('No workspace folder open; cannot demonstrate the helper layer.');
    return false;
  }
  print('Helper sees window "$windowId" rooted at $root.');

  final dir = await scratchDir(vscode, 'helper_layer');
  if (dir == null) return false;
  final path = '$dir/helper_${VsCodeHelper.generateTimestampId()}.txt';
  const payload = 'written through VsCodeHelper';

  await VsCodeHelper.writeFile(path, payload);                 // helper-written …
  final exists = await vscode.workspace.fileExists(path);      // … singleton-read
  final readBack = exists ? await vscode.workspace.readFile(path) : '';
  await vscode.workspace.deleteFile(path);

  final ok = exists && readBack == payload;
  print(
    ok
        ? 'Round-tripped a scratch file through the helper layer.'
        : 'Helper round-trip did not verify.',
  );
  return ok;
}
```

`VsCodeHelper.generateTimestampId()` (format `YYYYMMDD_HHMMSS`) is one of the
small conveniences the façade adds on top of the raw API — handy for unique
scratch names.

### `language_model.dart` — call a language model (Copilot)

`lm.selectChatModels(...)` returns the chat models the *window's* VS Code can
see — typically GitHub Copilot when the user is signed in. The concept picks a
model, sends one message, and summarises the reply, degrading gracefully when no
model is present:

```dart
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
```

Two things to notice. First, `model.sendRequest` takes `vscode.adapter`
explicitly: a `LanguageModelChat` is a plain data holder (id, vendor, family,
maxInputTokens…); it borrows the window's transport to make the call, so you
hand it the adapter. Second, messages are built with factory constructors —
`LanguageModelChatMessage.user(content)` and `.assistant(content)` — and the
response exposes both the concatenated `text` and the streamed `streamParts`.

### `quick_pick_input.dart` — ask the user (interactive)

`window.showQuickPick(items)` and `window.showInputBox()` surface the native VS
Code pickers and return the user's choice (or `null` when dismissed). They
**block on the user**, which is why this concept is flagged interactive and
skipped by the auto-run. Both calls take a `timeoutSeconds` plus a
`fallbackValueOnTimeout`, so a headless run never hangs — it waits a few seconds
then proceeds with the fallback:

```dart
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

  return true;
}
```

The short timeout + fallback is the pattern that makes user-prompting safe to
ship in a script that might run unattended: it degrades to a default instead of
blocking forever. (`failOnTimeout: true` is the opposite choice — turn a timeout
into a thrown `TimeoutException` when a missing answer should be a hard error.)

---

## 8. Interactive concepts and the aggregator's `interactive` flag

The introduction sample's `Example` record was `(name, run)`. This sample adds
one field, because some concepts can't run unattended:

```dart
typedef Example = ({
  String name,
  Future<bool> Function(VSCode) run,
  bool interactive,
});

const List<Example> advancedExamples = [
  (name: 'file_batch', run: runFileBatchExample, interactive: false),
  (name: 'editor_edits', run: runEditorEditsExample, interactive: false),
  (name: 'progress', run: runProgressExample, interactive: false),
  (name: 'helper_layer', run: runHelperLayerExample, interactive: false),
  (name: 'language_model', run: runLanguageModelExample, interactive: false),
  (name: 'quick_pick_input', run: runQuickPickInputExample, interactive: true),
];
```

The auto-run **skips** any concept flagged `interactive` — a headless aggregator
must never block on a human — and reports the count so the skip is visible:

```text
=== quick_pick_input (interactive — skipped) ===

5/5 examples passed (1 interactive skipped).
```

The dispatcher imposes no such rule: `dart run bin/run_example.dart
quick_pick_input` runs it directly, which is how you exercise the interactive
concept when you *are* present. One list, two policies — the aggregator filters,
the dispatcher doesn't.

---

## 9. The aggregator and the dispatcher

Same two entry points as the introduction sample, with the `interactive` filter
added to the aggregator.

**`example/run_all_examples.dart`** connects once, iterates the concept list
(skipping interactive ones), catches per-concept exceptions so one failure
doesn't abort the rest, and prints a `passed/ran (n interactive skipped)` tally:

```dart
for (final example in advancedExamples) {
  if (example.interactive) {
    skipped++;
    stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
    continue;
  }
  stdout.writeln('\n=== ${example.name} ===');
  try {
    final ok = await example.run(vscode);
    if (!ok) failures.add(example.name);
    stdout.writeln(ok ? '  [PASS] ${example.name}' : '  [FAIL] ${example.name}');
  } catch (e, st) {
    failures.add(example.name);
    stdout.writeln('  [FAIL] ${example.name}: $e');
    stderr.writeln(st);
  }
}
```

**`bin/run_example.dart`** is the same idea narrowed to one concept by name,
with `all` delegating to the aggregator and an unknown name exiting `64`
(`EX_USAGE`) with the list of valid names:

```dart
final Map<String, Future<bool> Function(VSCode)> _examples = {
  'file_batch': runFileBatchExample,
  'editor_edits': runEditorEditsExample,
  'progress': runProgressExample,
  'helper_layer': runHelperLayerExample,
  'language_model': runLanguageModelExample,
  'quick_pick_input': runQuickPickInputExample,
};
```

Both entry points call `exit(...)` explicitly — the bridge client keeps its
socket open, which keeps the event loop alive, so a normally-returning `main`
would leave the process hanging after all work is done.

---

## 10. Two facts about a live host: blocking and unregistered commands

This sample exists partly to make two realities concrete, because they shape how
you write robust scripts:

**Some operations block on a human.** Quick-pick and input-box calls don't
return until the user acts (or a timeout fires). A script that calls them
unattended will hang unless you supply `timeoutSeconds` + `fallbackValueOnTimeout`
(degrade to a default) or `failOnTimeout: true` (turn the wait into an error).
The aggregator's `interactive` flag is the structural answer: keep blocking
concepts out of the automated path entirely.

**Some high-level wrappers aren't registered on every host build.** The typed
API and `VsCodeHelper` are conveniences over commands the extension contributes;
if a given build doesn't register the underlying command, the wrapper returns
`false` (it doesn't throw). `editor_edits` hit exactly this — `replaceText` /
`applyWorkspaceEdit` were unavailable — and the reliable answer was the **adapter
escape hatch** (`adapter.sendRequest('executeScriptVce', …)`), which runs genuine
`context.vscode.*` API in the window. When a typed call returns a surprising
`false`, reach for the escape hatch and run the real API directly.

Both facts share a theme from the introduction sample: you are talking to a
*live, external* program. Its state, its installed commands, and its human
operator are all outside your process — write scripts that account for that.

---

## 11. Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | all non-interactive examples passed, **or** no live bridge was found (documented skip) |
| `1` | at least one example failed against a live window |
| `64` | (dispatcher) unknown example name |

A headless run with no window exits `0`; a real regression exits `1`. The
interactive concept never affects the aggregator's exit code — it's skipped, not
run.

---

## 12. Troubleshooting

| Symptom | Cause & fix |
| ------- | ----------- |
| `No VS Code CLI Integration Server found on 127.0.0.1:19900–19909` | No window has the server running. Run **`DS: Start Tom CLI Integration Server`** in the command palette. |
| `editor_edits` prints `Editor edit did not apply on this window` | `applyEdit` returned `false` in the host. Confirm the scratch path is on the window's machine and the workspace has a folder open; the edit targets a freshly written file under `ztmp/advanced_sample/editor_edits/`. |
| `language_model` always skips | Copilot isn't installed or isn't signed in on that window. Sign in, or accept the skip — it's a soft prerequisite. |
| `quick_pick_input` never prompts | It's skipped by the aggregator. Run it through the dispatcher: `dart run bin/run_example.dart quick_pick_input`. |
| A concept hangs | You're running a concept function directly without an entry point that calls `exit`, or an interactive call has no timeout/fallback. Use `bin/run_example.dart`. |
| `No workspace folder open; cannot demonstrate …` | The connected window has no folder open. `scratchDir` needs a workspace root. Open a folder and re-run. |

---

## 13. The other samples

This is the second of four samples under
[`tom_vscode_scripting_api/example/`](../README.md):

| Sample | Adds |
| ------ | ---- |
| [`vscode_scripting_introduction_sample`](../vscode_scripting_introduction_sample/) | The connection model: discovering a window, the `VSCode` singleton, the three core namespaces, and the run-script conventions every later sample builds on. **Start here.** |
| [`vscode_agent_tools_sample`](../vscode_agent_tools_sample/) | The extension's own feature APIs as in-process tools: todos, the prompt queue, timed requests, documents, workspace metadata, `TomToolsApi`, and send-to-chat. |
| [`vscode_agent_sdk_sample`](../vscode_agent_sdk_sample/) | Streaming `AgentSdkClient.query()`, typed message streams, in-process Dart `tool()`s, and the `canUseTool` permission callback. |

---

## 14. Where to go next

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
