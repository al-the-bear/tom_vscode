# Tom Agent Tools — Sample

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../../LICENSE).

> The third step in the scripting series, after the
> [introduction](../vscode_scripting_introduction_sample/) and
> [advanced](../vscode_scripting_advanced_sample/) samples. Those two scripted
> **VS Code itself** — windows, editors, files, the language model. This one
> scripts the **Tom AI extension's own features**: the workspace's project and
> quest tree, todos across scopes, the prompt queue, timed requests, the
> document store, the LLM tool registry, and send-to-chat. Seven concepts, one
> per file, all over the same `tom_vscode_scripting_api` — but reached through a
> different connection idiom you need to understand before the first call.

The earlier samples talked to VS Code through the `VSCode` singleton: connect
once, call `VSCode.initialize(adapter)`, then `vscode.window.…`,
`vscode.workspace.…`, `vscode.commands.…` all target the connected window. The
extension-feature APIs in *this* sample work differently. They are
**static-method classes** — `TomWorkspaceApi`, `TomTodoApi`, `TomQueueApi`,
`TomTimedApi`, `TomDocumentApi`, `TomToolsApi`, `TomChatApi` — and each one takes
its adapter directly via `<Class>.setAdapter(adapter)`. There is no singleton to
initialize; you hand each API the adapter it should use.

This article walks through **one** thing in depth — *that per-class `setAdapter`
connection idiom and why it differs from the singleton* — and then explains each
of the seven concepts file by file. It also covers two properties that shape how
this sample is written: every concept is deliberately **read-only**, and the
tool registry is **gated server-side by the active Anthropic profile**.

---

## Table of contents

1. [What you'll build](#1-what-youll-build)
2. [Prerequisites](#2-prerequisites)
3. [Project layout](#3-project-layout)
4. [Running it](#4-running-it)
5. [Shared infrastructure: the adapter, no singleton](#5-shared-infrastructure-the-adapter-no-singleton)
6. [The per-class `setAdapter` pattern, in depth](#6-the-per-class-setadapter-pattern-in-depth)
7. [The seven concepts, file by file](#7-the-seven-concepts-file-by-file)
8. [Read-only by design](#8-read-only-by-design)
9. [The profile gate and the interactive send-to-chat](#9-the-profile-gate-and-the-interactive-send-to-chat)
10. [The aggregator and the dispatcher](#10-the-aggregator-and-the-dispatcher)
11. [Exit codes](#11-exit-codes)
12. [Troubleshooting](#12-troubleshooting)
13. [The other samples](#13-the-other-samples)
14. [Where to go next](#14-where-to-go-next)

---

## 1. What you'll build

Seven self-contained programs — one concept each — that tour the extension's own
feature APIs as a script sees them:

```text
workspace_metadata → todos → queue → timed_requests → documents → tools → send_to_chat
(name, projects,     (CRUD   (multi-  (scheduled       (the _ai     (the LLM   (dispatch to
 quests, the          across  transport prompts +       document     tool        the live
 active quest)        scopes) prompt    the timer        store:       registry,   chat target;
                              queue)    engine)          guidelines, profile-     interactive,
                                                         trail)      gated)      skipped in CI)
```

Each concept is a single public function with the uniform shape
`Future<bool> run<Name>Example(VSCodeAdapter adapter)`. Note the parameter:
these concepts take a **`VSCodeAdapter`**, not a `VSCode` — because the APIs they
drive want the adapter directly (see §6). A small **aggregator**
([`example/run_all_examples.dart`](example/run_all_examples.dart)) connects once
and runs them all; a **dispatcher** ([`bin/run_example.dart`](bin/run_example.dart))
runs any one by name. The project depends on exactly one package —
`tom_vscode_scripting_api` — and talks to a window you already have open.

The choice of these seven is deliberate breadth across the extension surface:
`workspace_metadata` is the window's view of itself as a Tom project tree;
`todos`, `queue`, and `timed_requests` are the three work-management subsystems;
`documents` is the `_ai/` and `_copilot_guidelines/` document store; `tools` is
the LLM tool registry the chat transports use; and `send_to_chat` drives the
chat transport end to end — including the wrinkle that it *has a real
side-effect*, which is why one concept is flagged interactive and skipped by the
auto-run.

---

## 2. Prerequisites

Identical to the other samples — **these examples need a live VS Code window**:

1. **A VS Code window with the Tom extension active.** Any Tom workspace will do.
   Every concept here is **read-only**, so it is safe to run against a working
   window — it never creates, removes, or reorders a real todo, queued prompt,
   timed request, or document (see §8).
2. **The CLI Integration Server started in that window.** Command palette →
   **`DS: Start Tom CLI Integration Server`**. The window then listens on a
   localhost port in **19900–19909** (first free port; a second window takes the
   next one).

With no server running, nothing throws: `connectToFirstWindow` prints the
prerequisite and the aggregator exits `0` (a documented skip). The project is
safe to run headless or in CI — it reports "no window found" and stops.

One concept has a *soft* prerequisite it degrades around rather than fails on:

- **`tools`** lists the tools the active Anthropic profile permits. That list is
  *empty* when the Send-to-Chat target is Copilot, or when the profile enables
  no tools — a valid configuration, not a bug, so the concept reports the empty
  list and still passes.

And one concept is **interactive** and skipped by the auto-run:

- **`send_to_chat`** occupies the live chat transport, runs the full tool loop,
  and can take many seconds; a second concurrent Anthropic send is rejected
  mid-turn. Run it by name when you actually want to drive the chat (see §9).

---

## 3. Project layout

```text
vscode_agent_tools_sample/
├── pubspec.yaml                 # depends only on tom_vscode_scripting_api ^1.1.0
├── analysis_options.yaml        # package:lints/recommended.yaml
├── README.md                    # this article
├── run_example.sh               # POSIX runner (pub get on first run, forwards args)
├── run_example.ps1              # PowerShell runner
├── bin/
│   └── run_example.dart         # dispatcher: run one concept by name (or `all`)
└── example/
    ├── support.dart             # shared connection helper → returns the adapter
    ├── workspace_metadata.dart  # info / projects / quests / active quest
    ├── todos.dart               # combined todos across all scopes, tallied
    ├── queue.dart               # prompt-queue counts + next pending
    ├── timed_requests.dart      # scheduled prompts + timer-engine state
    ├── documents.dart           # guidelines + the prompt/answer trail
    ├── tools.dart               # the profile-gated LLM tool registry
    ├── send_to_chat.dart        # send a prompt to the chat target (interactive)
    └── run_all_examples.dart    # aggregator: connect once, run all, tally
```

The same two-roles split as the other samples holds here, but note the type:

- **`bin/run_example.dart` and `example/run_all_examples.dart` are entry
  points.** They own the connection — `connectToFirstWindow()`, run, then
  `disconnect()`.
- **The seven `example/*.dart` concept files are pure functions of a connected
  adapter.** Each takes an already-connected `VSCodeAdapter`, sets it on the API
  class(es) it uses, and does one thing. They never connect on their own, so the
  aggregator can share one connection across all of them. `support.dart` is
  shared infra, not a concept.

---

## 4. Running it

From the package root, with a window + server ready:

```sh
# Run every (non-interactive) concept — the aggregator:
./run_example.sh
# or:  dart run example/run_all_examples.dart

# Run a single concept by name:
./run_example.sh workspace_metadata
# or:  dart run bin/run_example.dart workspace_metadata

# Run the interactive concept (drives the live chat transport):
./run_example.sh send_to_chat

# Override the bridge host (default 127.0.0.1):
dart run bin/run_example.dart todos 127.0.0.1
```

The run scripts run `dart pub get` on first invocation, then forward all
arguments to the dispatcher. Expected aggregator output against a window named
`tom_brain` on port 19900 (counts vary with the window's actual state):

```text
Connected to "tom_brain.code-workspace" on 127.0.0.1:19900

=== workspace_metadata ===
Workspace "tom_brain (Workspace)" — 143 projects, 46 quests.
Active quest: tom_brain
First 3 projects: dart_overview, _scripts, deepwork_core
First 3 quests: al_the_bear, build_tom, c2dart
  [PASS] workspace_metadata

=== todos ===
8 todos across all scopes.
By status: completed=1, not-started=7
  [PASS] todos

=== queue ===
Queue: 55 items (5 pending, 50 sent). Paused: false.
Next pending: "The telegram access is having a session concept,…"
  [PASS] queue

=== timed_requests ===
Timed requests: 0 entries (0 active, 0 paused). Timer engine: on.
First entry: <none>
  [PASS] timed_requests

=== documents ===
62 guidelines across categories: cloud, d4rt, example, dart, pattern_prompts.
Read "cloud_deployment.md": 3362 chars.
Trail: 0 recent entries (latest quest: <none>).
  [PASS] documents

=== tools ===
129 tools available to the active profile.
First 5: tomAi_readFile, tomAi_listDirectory, tomAi_findFiles, tomAi_findTextInFiles, tomAi_createFile, …
  [PASS] tools

=== send_to_chat (interactive — skipped) ===

6/6 examples passed (1 interactive skipped).
```

---

## 5. Shared infrastructure: the adapter, no singleton

Every concept needs one thing: a connected adapter. That is all
[`example/support.dart`](example/support.dart) provides — and crucially, it does
**not** promote the connection to the `VSCode` singleton the way the other
samples' `support.dart` does, because these APIs don't read the singleton:

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

  print('Connected to "$identity" on $host:$port');
  return adapter;
}
```

The discovery handshake is the same one the introduction sample explains line by
line in its [`connect.dart`](../vscode_scripting_introduction_sample/example/connect.dart):
`scanBridgePorts` probes the port range and returns the responsive windows keyed
by port; we connect to the first one and return its adapter. The difference is
the return value — the **adapter itself**, not a side-effect on a global — and
the absence of any `VSCode.initialize(adapter)` call. The next section explains
why.

---

## 6. The per-class `setAdapter` pattern, in depth

The introduction and advanced samples share a connection model: one global
`VSCode` singleton. You call `VSCode.initialize(adapter)` once, and from then on
every namespace — `VSCode.instance.window`, `.workspace`, `.commands`, `.lm` —
routes through that single adapter. The concept functions take a `VSCode` and
never see the adapter directly.

The extension-feature APIs deliberately do **not** use that singleton. Each is a
static-method class that holds *its own* adapter, set explicitly:

```dart
TomWorkspaceApi.setAdapter(adapter);
final info = await TomWorkspaceApi.getInfo();
```

So every concept in this sample sets the adapter on the API class(es) it uses,
as its first line. `workspace_metadata` sets it on `TomWorkspaceApi`; `todos`
sets it on `TomTodoApi`; and so on. The contract is uniform across all nine
extension APIs (the seven this sample uses, plus `AiPromptApi` and
`AiConversationApi`): **call `<Class>.setAdapter(adapter)` before the first call,
or the next method throws a `StateError`.**

```dart
static VSCodeAdapter get _requireAdapter {
  if (_adapter == null) {
    throw StateError(
      'TomTimedApi: adapter not set. Call setAdapter() first.',
    );
  }
  return _adapter!;
}
```

Why the difference? The VS Code namespaces model *one window you are driving* —
a singleton fits, because there is conceptually one editor you are scripting. The
extension-feature APIs are a **set of independent service clients**: you might
talk to the queue on one window and the documents on another, or hold several
adapters at once. Threading the adapter per class keeps each API a plain,
testable client with no hidden global state, and lets a program point different
APIs at different windows if it wants to. The cost is one `setAdapter` line per
API — which is exactly what each concept demonstrates.

This is also why the concept signature is `Future<bool> run<Name>Example(
VSCodeAdapter adapter)` and not `…(VSCode vscode)`: there is no `VSCode` object
in play. The entry points pass the raw adapter straight through, and each concept
distributes it to the APIs it needs. If you mix these APIs with the VS Code
namespaces in one program, you would call **both** `VSCode.initialize(adapter)`
(for the namespaces) and `<Class>.setAdapter(adapter)` (for each extension API) —
they are independent connection registrations over the same underlying adapter.

---

## 7. The seven concepts, file by file

### `workspace_metadata.dart` — the window as a Tom project tree

`TomWorkspaceApi` is the extension's view of the workspace as a Tom project
tree: its name and root, the registered projects, the quests, and which quest is
active. It is the API the discovery helpers themselves use (`workspace.getInfoVce`)
to tell one window from another. The concept reads info, the active quest, and
the first few projects and quests:

```dart
Future<bool> runWorkspaceMetadataExample(VSCodeAdapter adapter) async {
  TomWorkspaceApi.setAdapter(adapter);

  final info = await TomWorkspaceApi.getInfo();
  print(
    'Workspace "${info.name}" — ${info.projectCount} projects, '
    '${info.questCount} quests.',
  );

  final active = await TomWorkspaceApi.getActiveQuest();
  print('Active quest: ${active?.id ?? '<none>'}');

  final projects = await TomWorkspaceApi.listProjects();
  final projectNames = projects.projects.take(3).map((p) => p.id).join(', ');
  print('First 3 projects: ${projectNames.isEmpty ? '<none>' : projectNames}');

  final quests = await TomWorkspaceApi.listQuests();
  final questIds = quests.quests.take(3).map((q) => q.id).join(', ');
  print('First 3 quests: ${questIds.isEmpty ? '<none>' : questIds}');

  // A populated workspace reports at least one project.
  return projects.projects.isNotEmpty;
}
```

`getActiveQuest()` returns a nullable `QuestInfo` — `null` when no quest is
active — so the concept guards with `active?.id ?? '<none>'`. This is the one
concept whose success is an actual assertion (`projects.isNotEmpty`): a populated
Tom workspace always reports at least one project.

### `todos.dart` — todos across quest / workspace / session

`TomTodoApi` is CRUD over the three todo scopes (quest, workspace, session) plus
a combined view. The concept lists the combined set and tallies it by status —
never touching a real todo:

```dart
Future<bool> runTodosExample(VSCodeAdapter adapter) async {
  TomTodoApi.setAdapter(adapter);

  final all = await TomTodoApi.listAllTodos();
  print('${all.todos.length} todos across all scopes.');

  final counts = <TodoStatus, int>{};
  for (final todo in all.todos) {
    counts.update(todo.status, (n) => n + 1, ifAbsent: () => 1);
  }
  final breakdown = counts.entries
      .map((e) => '${e.key.value}=${e.value}')
      .join(', ');
  print('By status: ${breakdown.isEmpty ? '<no todos>' : breakdown}');

  // Listing succeeds even when the workspace has zero todos; the call
  // returning without throwing is the success condition.
  return true;
}
```

`TodoStatus` is an enum with a `.value` string (`not-started`, `in-progress`,
`completed`), which is what the breakdown prints. The full API also offers
create / update / delete / move per scope — the same client, used the same way.

### `queue.dart` — the multi-transport prompt queue

`TomQueueApi` is full control of the prompt queue — list, mutate, reorder, manage
follow-ups, run/pause. This concept only reads: it reports the item counts and
the pause state, then finds the first pending prompt and previews it:

```dart
Future<bool> runQueueExample(VSCodeAdapter adapter) async {
  TomQueueApi.setAdapter(adapter);

  final queue = await TomQueueApi.list();
  final paused = await TomQueueApi.isPaused();
  print(
    'Queue: ${queue.totalCount} items (${queue.pendingCount} pending, '
    '${queue.sentCount} sent). Paused: $paused.',
  );

  QueuedPrompt? nextPending;
  for (final item in queue.items) {
    if (item.status == QueuedPromptStatus.pending) {
      nextPending = item;
      break;
    }
  }
  if (nextPending != null) {
    final preview = _preview(nextPending.expandedText);
    print('Next pending: "$preview"');
  } else {
    print('Next pending: <none>');
  }

  return true;
}
```

`QueuedPrompt.expandedText` is the prompt with its placeholders resolved — what
the transport would actually send. The mutating operations (`add`, `remove`,
`moveUp`, `sendNext`, `pause`, …) are the same surface; this concept just never
calls them.

### `timed_requests.dart` — scheduled prompts and the timer engine

`TomTimedApi` creates and manages scheduled prompts (interval or clock-scheduled)
and controls the timer engine. The concept reports the entry counts, whether the
engine is on, and a one-line summary of the first entry's schedule:

```dart
Future<bool> runTimedRequestsExample(VSCodeAdapter adapter) async {
  TomTimedApi.setAdapter(adapter);

  final result = await TomTimedApi.list();
  final activated = await TomTimedApi.isTimerActivated();
  print(
    'Timed requests: ${result.totalCount} entries '
    '(${result.activeCount} active, ${result.pausedCount} paused). '
    'Timer engine: ${activated ? 'on' : 'off'}.',
  );

  if (result.entries.isEmpty) {
    print('First entry: <none>');
  } else {
    final first = result.entries.first;
    print('First entry: ${_schedule(first)} — "${_preview(first.originalText)}"');
  }

  return true;
}
```

A `TimedRequest` has a `scheduleMode` (`interval` or `scheduled`); the concept's
`_schedule` helper renders the interval minutes or the scheduled `HH:MM` times
accordingly. `isTimerActivated()` reports the engine's master switch — entries
only fire when it is on.

### `documents.dart` — guidelines and the prompt/answer trail

`TomDocumentApi` is the extension's typed view of the `_ai/` and
`_copilot_guidelines/` document tree. The concept lists the guidelines with their
categories, reads the first one to prove content round-trips, and lists the most
recent trail entries:

```dart
Future<bool> runDocumentsExample(VSCodeAdapter adapter) async {
  TomDocumentApi.setAdapter(adapter);

  final guidelines = await TomDocumentApi.listGuidelines();
  final categories = guidelines.categories.isEmpty
      ? '<none>'
      : guidelines.categories.join(', ');
  print(
    '${guidelines.guidelines.length} guidelines across categories: $categories.',
  );

  if (guidelines.guidelines.isEmpty) {
    print('Read: <no guidelines to read>');
  } else {
    final first = guidelines.guidelines.first;
    final content = await TomDocumentApi.readGuideline(first.name);
    print('Read "${first.name}": ${content.content.length} chars.');
  }

  final trail = await TomDocumentApi.listTrail(limit: 5);
  final latestQuest = trail.entries.isEmpty
      ? '<none>'
      : (trail.entries.first.questId ?? '<unset>');
  print(
    'Trail: ${trail.entries.length} recent entries '
    '(latest quest: $latestQuest).',
  );

  return true;
}
```

`listGuidelines()` returns both the documents and the set of categories
(`dart`, `cloud`, `d4rt`, the root level, …); `readGuideline(name)` returns a
`DocumentContent` whose `.content` is the file body. `listTrail(limit:)` reads
the recent prompt/answer pairs — the same trail the live-trail and history files
are built from. The API also has typed accessors for prompts, answers, notes, and
quest documents, plus generic `read`/`write`/`delete` — the concept stays on the
read side.

### `tools.dart` — the profile-gated LLM tool registry

`TomToolsApi` exposes the same LLM tools the extension offers its chat transports.
The concept lists the allowed tool names and prints the first few. It does
**not** invoke a tool — invocation has effects that depend on the tool, and the
point here is to show the gated registry:

```dart
Future<bool> runToolsExample(VSCodeAdapter adapter) async {
  TomToolsApi.setAdapter(adapter);

  final names = await TomToolsApi.listAllowedToolNames();
  print('${names.length} tools available to the active profile.');

  if (names.isEmpty) {
    // Empty is a valid state: the Send-to-Chat target is Copilot, or the
    // active profile enables no tools. The gate lives in the extension.
    print('First 5: <none — Copilot target or no tools enabled>');
  } else {
    final first = names.take(5).join(', ');
    print('First 5: $first${names.length > 5 ? ', …' : ''}');
  }

  return true;
}
```

The list is **gated server-side by the active Anthropic profile** — see §9. An
empty list is a legitimate configuration (the Copilot target, or a profile with
no tools), so the concept treats it as a pass, not a failure.

### `send_to_chat.dart` — drive the chat transport (interactive)

`TomChatApi.sendToChat` dispatches a prompt to whichever transport the extension
is configured to use (`anthropic` or `copilot`) and returns the answer. This is
the one concept with a real side-effect, so it is flagged interactive and skipped
by the auto-run (see §9). Run by name, it sends one prompt and reports the
outcome:

```dart
Future<bool> runSendToChatExample(VSCodeAdapter adapter) async {
  TomChatApi.setAdapter(adapter);

  final result = await TomChatApi.sendToChat(
    'Reply with only the number: what is 2 + 2?',
  );

  if (result.rejected) {
    // A turn was already running — the prompt queue owns queuing, not this API.
    print('Rejected: an Anthropic turn was already in flight.');
    // Rejection is the documented contention outcome, not a transport failure.
    return true;
  }
  if (!result.success) {
    print('Send to "${result.target}" failed: ${result.error}');
    return false;
  }

  final firstLine = result.answer.split('\n').first.trim();
  print('Sent to "${result.target}". Answer (first line): "$firstLine"');
  return true;
}
```

The `SendToChatResult` distinguishes three outcomes: `rejected` (a turn was
already in flight — contention, not failure), `!success` (the transport reported
an error), and success (an `answer` came back). The concept treats `rejected` as
a pass because it is the documented contention behaviour, and only fails on a
real transport error.

---

## 8. Read-only by design

Every non-interactive concept in this sample is deliberately **read-only**. That
is a design choice, not a limitation of the APIs: `TomTodoApi`, `TomQueueApi`,
`TomTimedApi`, and `TomDocumentApi` all offer full create / update / delete /
move / reorder operations. The sample exercises only the *list* and *read*
operations because:

- **It runs against your real working window.** A sample that added a todo,
  enqueued a prompt, or scheduled a timed request would litter the very workspace
  you are developing in. Reads observe; they don't disturb.
- **It is safe to run repeatedly and headless.** The aggregator can run in CI or
  on a loop without accumulating side-effects — the only concept with effects is
  the interactive one, which the auto-run skips.

The mutating operations are the same API surface, reached the same way (set the
adapter, call the method). Each concept's header comment names the mutating
operations it deliberately avoids, so the read-only versions double as a map of
the full API. The one concept that *does* have an effect — `send_to_chat` — is
quarantined behind the `interactive` flag, which §9 covers.

---

## 9. The profile gate and the interactive send-to-chat

Two of these APIs have behaviour worth understanding before you rely on them.

**The tool registry is gated server-side by the active Anthropic profile.** Both
the listing (`getToolsJson` / `listAllowedToolNames`) and the invocation
(`invokeTool`) are scoped to the currently active profile's tool set
(`toolsEnabled` / `enabledTools`), and when the Send-to-Chat target is Copilot
the list is *empty* and every invoke is refused. The gate lives **inside the VS
Code extension**, not in this Dart API — the package is a thin pass-through that
adds no checks of its own and does no client-side filtering. A tool the active
profile hides cannot be invoked by passing its name to `invokeTool`: the
extension refuses it before the executor runs and returns an error string. That
is why the `tools` concept treats an empty list as a valid state — what you see
reflects the window's current profile configuration, and the extension is the
single authority.

**`send_to_chat` has a real side-effect and is therefore interactive.** It is
flagged `interactive: true` and skipped by the headless auto-run for two reasons:

1. It occupies the live chat transport — for the anthropic target it runs the
   active profile's full tool loop, which can take many seconds.
2. A second concurrent Anthropic send is *rejected* while a turn is in flight
   (`SendToChatResult.rejected`). Firing it from an unattended batch would
   collide with whatever the window is doing.

The queuing of prompts is owned by the prompt **queue** (`TomQueueApi`), not by
this API — `sendToChat` is a single immediate dispatch, and contention surfaces
as `rejected` rather than being silently queued. Run it deliberately, when you
mean to drive the chat:

```sh
dart run bin/run_example.dart send_to_chat
```

---

## 10. The aggregator and the dispatcher

Same two entry points as the other samples, with the concept signature keyed on
`VSCodeAdapter` (not `VSCode`) and the `interactive` filter applied to the
aggregator.

**`example/run_all_examples.dart`** connects once, iterates the concept list
(skipping interactive ones), catches per-concept exceptions so one failure
doesn't abort the rest, and prints a `passed/ran (n interactive skipped)` tally:

```dart
typedef Example = ({
  String name,
  Future<bool> Function(VSCodeAdapter) run,
  bool interactive,
});

const List<Example> agentToolsExamples = [
  (
    name: 'workspace_metadata',
    run: runWorkspaceMetadataExample,
    interactive: false,
  ),
  (name: 'todos', run: runTodosExample, interactive: false),
  (name: 'queue', run: runQueueExample, interactive: false),
  (name: 'timed_requests', run: runTimedRequestsExample, interactive: false),
  (name: 'documents', run: runDocumentsExample, interactive: false),
  (name: 'tools', run: runToolsExample, interactive: false),
  (name: 'send_to_chat', run: runSendToChatExample, interactive: true),
];
```

The loop skips interactive concepts and passes the **adapter** to each `run`:

```dart
for (final example in agentToolsExamples) {
  if (example.interactive) {
    skipped++;
    stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
    continue;
  }
  stdout.writeln('\n=== ${example.name} ===');
  try {
    final ok = await example.run(adapter);
    if (!ok) failures.add(example.name);
    stdout.writeln(ok ? '  [PASS] ${example.name}' : '  [FAIL] ${example.name}');
  } catch (e, st) {
    failures.add(example.name);
    stdout.writeln('  [FAIL] ${example.name}: $e');
    stderr.writeln(st);
  }
}
```

**`bin/run_example.dart`** is the same idea narrowed to one concept by name, with
`all` delegating to the aggregator and an unknown name exiting `64` (`EX_USAGE`)
with the list of valid names:

```dart
final Map<String, Future<bool> Function(VSCodeAdapter)> _examples = {
  'workspace_metadata': runWorkspaceMetadataExample,
  'todos': runTodosExample,
  'queue': runQueueExample,
  'timed_requests': runTimedRequestsExample,
  'documents': runDocumentsExample,
  'tools': runToolsExample,
  'send_to_chat': runSendToChatExample,
};
```

Both entry points call `exit(...)` explicitly — the bridge client keeps its
socket open, which keeps the event loop alive, so a normally-returning `main`
would leave the process hanging after all work is done. The dispatcher imposes no
`interactive` rule: it will run `send_to_chat` directly, which is how you
exercise the interactive concept when you mean to.

---

## 11. Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | all non-interactive examples passed, **or** no live bridge was found (documented skip) |
| `1` | at least one example failed against a live window |
| `64` | (dispatcher) unknown example name |

A headless run with no window exits `0`; a real failure exits `1`. The
interactive concept never affects the aggregator's exit code — it's skipped, not
run.

---

## 12. Troubleshooting

| Symptom | Cause & fix |
| ------- | ----------- |
| `No VS Code CLI Integration Server found on 127.0.0.1:19900–19909` | No window has the server running. Run **`DS: Start Tom CLI Integration Server`** in the command palette. |
| `StateError: <Class>: adapter not set. Call setAdapter() first.` | A concept used an extension API before `setAdapter`. Each concept must call `<Class>.setAdapter(adapter)` first — see §6. |
| `tools` reports `0 tools available` | The active Send-to-Chat target is Copilot, or the active Anthropic profile enables no tools. That's the server-side gate (§9), not an error — switch the target/profile to see tools. |
| `send_to_chat` prints `Rejected: an Anthropic turn was already in flight` | An Anthropic turn was already running on that window. Wait for it to finish, or use the prompt **queue** (`TomQueueApi`) to enqueue instead of sending directly. |
| `send_to_chat` never runs from the aggregator | It's skipped by the auto-run. Run it through the dispatcher: `dart run bin/run_example.dart send_to_chat`. |
| `workspace_metadata` returns `false` | The connected window reports zero projects — it isn't a populated Tom workspace. Connect to a Tom workspace window. |
| A concept hangs | You're running a concept function directly without an entry point that calls `exit`. Use `bin/run_example.dart`. |

---

## 13. The other samples

This is the third of four samples under
[`tom_vscode_scripting_api/example/`](../README.md):

| Sample | Adds |
| ------ | ---- |
| [`vscode_scripting_introduction_sample`](../vscode_scripting_introduction_sample/) | The connection model: discovering a window, the `VSCode` singleton, the three core namespaces, and the run-script conventions every later sample builds on. **Start here.** |
| [`vscode_scripting_advanced_sample`](../vscode_scripting_advanced_sample/) | The next layer of VS Code scripting: editor edits, batched file I/O, progress, quick-pick/input flows, the language model, and the `VsCodeHelper` façade. |
| [`vscode_agent_sdk_sample`](../vscode_agent_sdk_sample/) | Streaming `AgentSdkClient.query()`, typed message streams, in-process Dart `tool()`s, and the `canUseTool` permission callback. |

---

## 14. Where to go next

- [Extension scripting guide](../../doc/vscode_api_extension_scripting_guide.md) —
  the authoritative reference for all nine extension-feature APIs and the
  "choosing the right API" table.
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
