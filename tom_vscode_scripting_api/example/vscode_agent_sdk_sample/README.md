# Tom Agent SDK — Sample

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](../../LICENSE).

> The fourth and final step in the scripting series. The
> [introduction](../vscode_scripting_introduction_sample/) and
> [advanced](../vscode_scripting_advanced_sample/) samples scripted **VS Code
> itself**; the [agent-tools](../vscode_agent_tools_sample/) sample scripted the
> **Tom extension's own features**. This one drives the **Anthropic Agent SDK**:
> a streaming `query()` that runs a full agentic turn, the rich `Options` input
> surface, the typed `SdkMessage` output stream, in-process Dart `tool()`s the
> model can call back into, and a `canUseTool` permission callback. Five
> concepts, one per file, over a connection model neither of the earlier idioms
> uses — which is the first thing to understand.

The package ships a Dart **1:1 mirror** of the Anthropic Agent SDK. Where the
TypeScript SDK exposes `query({ prompt, options })`, this package exposes
`AgentSdkClient.query(prompt:, options:)`; where the SDK has `Options`,
`SDKMessage`, `tool()`, and `canUseTool`, this package has [`Options`], the
[`SdkMessage`] union, [`SdkMcpTool`], and the [`CanUseTool`] typedef — with the
same field names and the same shapes. The mirror runs in your Dart process and
relays each query to the **real** SDK hosted inside the VS Code extension, over
the bridge.

That relay is the reason this sample connects differently from the other three,
and the reason it is written to **degrade gracefully** rather than assume every
streamed chunk arrives. This article walks both of those in depth, then covers
each of the five concepts file by file.

---

## Table of contents

1. [What you'll build](#1-what-youll-build)
2. [Prerequisites](#2-prerequisites)
3. [Project layout](#3-project-layout)
4. [Running it](#4-running-it)
5. [The connection model: the raw bridge client](#5-the-connection-model-the-raw-bridge-client)
6. [The transport stack, in depth](#6-the-transport-stack-in-depth)
7. [The chunk-relay gap and the degrade-gracefully design](#7-the-chunk-relay-gap-and-the-degrade-gracefully-design)
8. [The five concepts, file by file](#8-the-five-concepts-file-by-file)
9. [The raw-preserving message design](#9-the-raw-preserving-message-design)
10. [The aggregator and the dispatcher](#10-the-aggregator-and-the-dispatcher)
11. [Exit codes](#11-exit-codes)
12. [Troubleshooting](#12-troubleshooting)
13. [The other samples](#13-the-other-samples)
14. [Where to go next](#14-where-to-go-next)

---

## 1. What you'll build

Five self-contained programs — one concept each — that tour the Agent SDK mirror
as a script sees it:

```
message_types → options → in_process_tool → can_use_tool → streaming_query
(parse the      (the      (a Dart tool()    (the           (a real query()
 typed SDK      Options    the model can     canUseTool     against the
 message        input      call back into    permission     window; live,
 stream)        surface)   mid-query)        callback)      interactive)
└──────────────── deterministic, offline ────────────────┘  └─ interactive ─┘
```

Four of the five are **deterministic**: they build and parse the SDK type
surface in-process and assert exact results, so they teach the API without
depending on a live agent run. The fifth, `streaming_query`, fires a real
`AgentSdkClient.query()` against the window — it is flagged **interactive** (it
spends model budget) and is skipped by the headless auto-run.

Each concept is a single public function with the uniform shape
`Future<bool> run<Name>Example(VSCodeBridgeClient client)`. Note the parameter:
unlike the other samples, these take a **`VSCodeBridgeClient`** directly — not a
`VSCode` singleton and not a `VSCodeAdapter` (see §5). A small **aggregator**
([`example/run_all_examples.dart`](example/run_all_examples.dart)) connects once
and runs them all; a **dispatcher** ([`bin/run_example.dart`](bin/run_example.dart))
runs any one by name. The project depends on exactly one package —
`tom_vscode_scripting_api`.

---

## 2. Prerequisites

The four deterministic concepts exercise pure in-process logic, but the sample's
entry points still **connect to a live window** first (for a uniform shape with
the other samples, and because `streaming_query` genuinely needs it):

1. **A VS Code window with the Tom extension active.** Any Tom workspace will do.
2. **The CLI Integration Server started in that window.** Command palette →
   **`DS: Start Tom CLI Integration Server`**. The window then listens on a
   localhost port in **19900–19909** (first free port; a second window takes the
   next one).

With no server running, nothing throws: `connectToFirstWindow` prints the
prerequisite and the aggregator exits `0` (a documented skip). The project is
safe to run headless or in CI.

One concept is **interactive** and skipped by the auto-run:

- **`streaming_query`** fires a real `query()` — it runs an agentic turn that
  spends model budget, and it depends on the chunk relay covered in §7. Run it
  by name when you actually want to drive a live query.

---

## 3. Project layout

```
vscode_agent_sdk_sample/
├── pubspec.yaml                 # depends only on tom_vscode_scripting_api ^1.1.0
├── analysis_options.yaml        # package:lints/recommended.yaml
├── README.md                    # this article
├── run_example.sh               # POSIX runner (pub get on first run, forwards args)
├── run_example.ps1              # PowerShell runner
├── bin/
│   └── run_example.dart         # dispatcher: run one concept by name (or `all`)
└── example/
    ├── support.dart             # connection helper + drainQuery/printQueryOutcome
    ├── message_types.dart       # parse the typed SdkMessage / ContentBlock stream
    ├── options.dart             # the Options input surface → wire JSON
    ├── in_process_tool.dart     # an in-process Dart tool() the model can call
    ├── can_use_tool.dart        # the canUseTool permission callback
    ├── streaming_query.dart     # a live query() against the window (interactive)
    └── run_all_examples.dart    # aggregator: connect once, run all, tally
```

The same two-roles split as the other samples holds, with the connection type
swapped:

- **`bin/run_example.dart` and `example/run_all_examples.dart` are entry
  points.** They own the connection — `connectToFirstWindow()`, run, then
  `disconnect()`.
- **The five `example/*.dart` concept files are pure functions of a connected
  `VSCodeBridgeClient`.** `support.dart` is shared infra (the connection helper
  plus the `drainQuery`/`printQueryOutcome` utilities the live concept uses), not
  a concept.

---

## 4. Running it

From the package root, with a window + server ready:

```sh
# Run every (non-interactive) concept — the aggregator:
./run_example.sh
# or:  dart run example/run_all_examples.dart

# Run a single concept by name:
./run_example.sh options
# or:  dart run bin/run_example.dart options

# Run the interactive concept (drives a live agent query):
./run_example.sh streaming_query

# Override the bridge host (default 127.0.0.1):
dart run bin/run_example.dart message_types 127.0.0.1
```

The run scripts run `dart pub get` on first invocation, then forward all
arguments to the dispatcher. Expected aggregator output against a window named
`tom_brain` on port 19900 (abridged):

```text
Connected to "tom_brain.code-workspace" on 127.0.0.1:19900

=== message_types ===
  (bridge connected: true; this concept is offline-deterministic)
system/init:
  model           claude-sonnet-4-5
  tools           Read, Edit, Bash
assistant:
  text       "Let me read the changelog first."
  tool_use   Read({path: CHANGELOG.md})
result:
  isError    false
  numTurns   2
  costUsd    0.0123
unknown message preserved verbatim: true
  [PASS] message_types

=== options ===
  ...minimal / constrained / thinking option sets as wire JSON...
constrained options round-trip: true
  [PASS] options

=== in_process_tool ===
add(2, 3) -> {"content":[{"type":"text","text":"5"}]}
  [PASS] in_process_tool

=== can_use_tool ===
Bash rm -rf -> deny: {"behavior":"deny","message":"Refusing destructive command: rm -rf /","interrupt":true}
options.toJson() canUseTool flag present (not the function): true
  [PASS] can_use_tool

=== streaming_query (interactive — skipped) ===

4/4 examples passed (1 interactive skipped).
```

---

## 5. The connection model: the raw bridge client

Each sample in this series uses a different connection idiom, and they form a
ladder:

| Sample | Connection idiom | Concept parameter |
| ------ | ---------------- | ----------------- |
| introduction / advanced | the `VSCode` **singleton** — `VSCode.initialize(adapter)`, then `vscode.window`/`.workspace`/… | `VSCode` |
| agent-tools | per-class **`setAdapter`** — `TomTodoApi.setAdapter(adapter)`, … | `VSCodeAdapter` |
| **this sample** | the **raw `VSCodeBridgeClient`** | `VSCodeBridgeClient` |

The earlier idioms wrap the bridge behind an *adapter* — a request/response
façade that turns `await TomTodoApi.listAllTodos()` into a single round-trip.
That is all those APIs need. The Agent SDK needs more than request/response: a
streaming query receives a *series* of `agentSdk.chunk` **notifications** as the
turn unfolds, and an in-process tool or a `canUseTool` callback must answer
**server→client requests** mid-query (reverse RPC). Those two channels live on
the raw [`VSCodeBridgeClient`], not on the adapter façade — so this sample talks
to the client directly.

[`example/support.dart`](example/support.dart) returns the connected client
itself:

```dart
Future<VSCodeBridgeClient?> connectToFirstWindow({
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
  final client = VSCodeBridgeClient(host: host, port: port);
  if (!await client.connect()) {
    print('Found a window on $host:$port but could not connect to its bridge.');
    return null;
  }

  print('Connected to "$identity" on $host:$port');
  return client;
}
```

The discovery handshake is the same one the introduction sample explains line by
line in its [`connect.dart`](../vscode_scripting_introduction_sample/example/connect.dart):
`scanBridgePorts` probes the port range and returns responsive windows keyed by
port; we connect to the first and return it. The difference is the return value —
a `VSCodeBridgeClient` you wrap with the Agent SDK transport, not an adapter and
not a global singleton.

---

## 6. The transport stack, in depth

The Agent SDK mirror is built in three layers, and `support.dart` assembles them
in one helper:

```dart
AgentSdkClient agentSdkClientFor(VSCodeBridgeClient client) =>
    AgentSdkClient(VSCodeBridgeAgentSdkTransport(client));
```

Read it outside-in:

```
AgentSdkClient                       ← the API you call: query(), collectQuery()
  └── VSCodeBridgeAgentSdkTransport  ← the wire: queryVce/cancelVce + chunk stream
        └── VSCodeBridgeClient       ← the socket: requests, notifications, reverse RPC
```

- **[`AgentSdkClient`]** mirrors the SDK's `query()` free function. `query(prompt:,
  options:)` returns an [`AgentQuery`] — a `Stream<SdkMessage>` plus
  `interrupt()`. It is transport-agnostic: all the correlation logic (assign a
  `streamId`, subscribe to chunks before starting, register tool/permission
  handlers, clean up on completion or cancel) lives here and is unit-tested
  against a fake transport.
- **[`VSCodeBridgeAgentSdkTransport`]** is the production transport. `startQuery`
  sends `agentSdk.queryVce`; `cancelQuery` sends `agentSdk.cancelVce`; the
  `chunks` getter filters the client's notification stream for
  `method == 'agentSdk.chunk'`. It also installs the single method-keyed reverse-RPC
  handlers (`agentSdk.toolCall`, `agentSdk.canUseTool`) that route by `streamId`
  to the right query's tool registry or permission callback.
- **[`VSCodeBridgeClient`]** is the JSON-RPC-over-TCP socket: `sendRequest` for
  client→server calls, a `notifications` stream for server→client events, and
  `registerRequestHandler` for the reverse direction.

Why expose the seam? Because separating "what a query *means*" (correlate chunks
into a typed stream; dispatch tool calls) from "how the bytes move" (a TCP
socket to one VS Code window) keeps the meaning testable and lets the same
`AgentSdkClient` run over any transport. The production path is the only one this
sample uses, but the architecture is the reason `streaming_query` can be reasoned
about without a live socket.

---

## 7. The chunk-relay gap and the degrade-gracefully design

One honest caveat shapes how this sample is written. From the transport's own doc
comment:

> end-to-end delivery of `agentSdk.chunk` over the CLI socket **also requires the
> `tom_vscode_bridge` CLI server to relay extension notifications** to the
> connected client (today it only relays `log`). That relay is tracked as a
> completion step.

In other words: `AgentSdkClient.query()` will *start* a query (the
`agentSdk.queryVce` request returns), but whether the resulting `agentSdk.chunk`
notifications reach your Dart process over the CLI socket depends on a relay that
is a work-in-progress. A naïve `await for (final m in query) …` could therefore
**hang** waiting for chunks that never arrive.

Two design decisions follow from that, and they are the heart of this sample:

**1. The teaching value lives in the deterministic concepts.** `message_types`,
`options`, `in_process_tool`, and `can_use_tool` exercise the *type surface*
in-process — parsing messages, serializing options, invoking a tool handler,
running a permission policy — and assert exact results. They are correct and
instructive whether or not the relay is wired, which is why four of the five
concepts need no live stream.

**2. The live concept caps its wait and treats a timeout as a documented skip.**
`streaming_query` drains the query through `support.dart`'s `drainQuery`, which
collects whatever arrives within a timeout and then `interrupt()`s — so it
degrades gracefully instead of hanging:

```dart
Future<QueryOutcome> drainQuery(
  AgentQuery query, {
  Duration timeout = const Duration(seconds: 8),
}) async {
  final messages = <SdkMessage>[];
  Object? error;
  var completed = false;
  var timedOut = false;
  try {
    await for (final message in query.timeout(timeout)) {
      messages.add(message);
    }
    completed = true;
  } on TimeoutException {
    timedOut = true;
    await query.interrupt();
  } on AgentSdkQueryException catch (e) {
    error = e;
  } catch (e) {
    error = e;
  }
  return (
    messages: messages,
    completed: completed,
    timedOut: timedOut,
    error: error,
  );
}
```

`Stream.timeout` resets between events, so the timeout fires only when the stream
goes quiet — partial deliveries are collected, and a stall is bounded. A
`TimeoutException` is caught and reported as "the relay isn't wired yet," **not**
as a failure; only an unexpected `error` chunk fails the concept. This mirrors
how the advanced sample's `language_model` concept degrades when no model is
available: a documented, environmental absence is a skip, not a bug.

> In practice, running `streaming_query` by hand today already receives
> `system/init` (with the live model and tool list) and assistant turns before
> the trailing chunks stall — the relay is *partially* wired. The timeout path
> makes the concept robust either way.

---

## 8. The five concepts, file by file

### `message_types.dart` — the typed `SdkMessage` / `ContentBlock` stream

`query()` yields a stream of [`SdkMessage`]s. Each is parsed from the wire by
`SdkMessage.fromJson`, which dispatches on the SDK `type` discriminator into a
sealed subclass with typed accessors. This concept parses representative payloads
— exactly what the extension relays over `agentSdk.chunk` — and reads them back
through the typed API, so it teaches the output surface deterministically:

```dart
final assistant = SdkMessage.fromJson({
  'type': 'assistant',
  'session_id': 'demo-session',
  'message': {
    'role': 'assistant',
    'content': [
      {'type': 'text', 'text': 'Let me read the changelog first.'},
      {
        'type': 'tool_use',
        'id': 'toolu_01',
        'name': 'Read',
        'input': {'path': 'CHANGELOG.md'},
      },
    ],
  },
});
if (assistant is SdkAssistantMessage) {
  print('assistant:');
  for (final block in assistant.content) {
    switch (block) {
      case TextBlock(:final text):
        print('  text       "$text"');
      case ToolUseBlock(:final name, :final input):
        print('  tool_use   $name($input)');
      default:
        print('  ${block.type}');
    }
  }
}
```

The concept covers the three primary message types — [`SdkSystemMessage`]
(`subtype: init`, with `model`/`cwd`/`tools`/`permissionMode`/`slashCommands`),
[`SdkAssistantMessage`] (whose `content` is a list of typed [`ContentBlock`]s),
and [`SdkResultMessage`] (`isError`/`result`/`numTurns`/`durationMs`/
`totalCostUsd`/`usage`) — and finishes by proving the **raw-preserving** design
(§9): an unmodelled top-level `type` round-trips verbatim through
[`SdkUnknownMessage`]. Dart 3 sealed-class pattern matching makes the dispatch a
clean `switch` with no `is`-casts.

### `options.dart` — the `Options` input surface

[`Options`] is the Dart mirror of the SDK's `Options` argument to `query()`. It
travels Dart → extension → the real SDK as a faithful pass-through, so
`Options.toJson` uses the SDK's own camelCase wire field names. The concept builds
three representative sets and prints the exact JSON that crosses the bridge:

```dart
final constrained = Options(
  systemPrompt: const SystemPromptPreset(
    append: 'Prefer terse answers.',
  ),
  tools: const ToolsList(['Read', 'Grep']),
  allowedTools: const ['Read', 'Grep'],
  disallowedTools: const ['Bash'],
  maxBudgetUsd: 0.50,
  permissionMode: PermissionMode.acceptEdits,
);
_dump('constrained', constrained);
```

It then asserts the **data-field round-trip** that the type surface guarantees:

```dart
final roundTrips =
    jsonEncode(Options.fromJson(constrained.toJson()).toJson()) ==
        jsonEncode(constrained.toJson());
print('constrained options round-trip: $roundTrips');
```

The sealed sub-configs each serialize to their SDK wire shape: [`SystemPrompt`]
(`SystemPromptText` / `SystemPromptList` / `SystemPromptPreset`), [`ToolsConfig`]
(`ToolsList` / `ToolsClaudeCodePreset`), [`ThinkingConfig`] (`ThinkingEnabled` /
`ThinkingAdaptive` / `ThinkingDisabled`), and the [`PermissionMode`] /
[`EffortLevel`] enums. `Options` carries 50-plus fields; only data fields are
serialized — callback-bearing fields (`canUseTool`, `onStderr`) are handled
separately (§ on `can_use_tool`).

### `in_process_tool.dart` — a Dart tool the model can call

The SDK lets you define tools whose handler runs *in your process*. In Dart that
is an [`SdkMcpTool`] (name + description + JSON-Schema + a [`ToolHandler`])
grouped under an [`McpSdkServerConfig`] and passed through `Options.mcpServers`:

```dart
final addTool = SdkMcpTool(
  name: 'add',
  description: 'Adds two integers and returns the sum.',
  inputSchema: const {
    'type': 'object',
    'properties': {
      'a': {'type': 'integer'},
      'b': {'type': 'integer'},
    },
    'required': ['a', 'b'],
  },
  handler: (args) async {
    final a = (args['a'] as num).toInt();
    final b = (args['b'] as num).toInt();
    return CallToolResult.text('${a + b}');
  },
);
final server = McpSdkServerConfig(name: 'calculator', tools: [addTool]);
```

The live `McpServer` is not serializable, so over the bridge the server crosses
as a **descriptor** — server name/version plus each tool's name/description/schema
— and the extension rebuilds the real instance, routing each tool call back into
your Dart handler over the reverse RPC mid-query. The concept prints the
descriptor (`server.toJson()` — note the handler is absent), wires it into
`Options.mcpServers`, and invokes the handler directly to show the
[`CallToolResult`] shape the model would receive:

```dart
final result = await addTool.handler!({'a': 2, 'b': 3});
print('add(2, 3) -> ${jsonEncode(result.toJson())}');
// add(2, 3) -> {"content":[{"type":"text","text":"5"}]}
```

`CallToolResult.text(...)` is the convenience for a single text result; the full
form is a list of MCP content items with an optional `isError`.

### `can_use_tool.dart` — the permission callback

`Options.canUseTool` is a Dart callback the SDK consults *before* every tool
call. It receives the tool name, the proposed input, and a [`CanUseToolContext`],
and returns a [`PermissionResult`] — either a [`PermissionAllow`] (optionally
rewriting the input or persisting rules) or a [`PermissionDeny`] (with a reason,
optionally interrupting the run). The concept defines a small policy and runs it
against three scenarios:

```dart
Future<PermissionResult> policy(
  String toolName,
  Map<String, dynamic> input,
  CanUseToolContext context,
) async {
  if (toolName == 'Read' || toolName == 'Grep') {
    return PermissionAllow();
  }
  if (toolName == 'Bash') {
    final command = (input['command'] as String?) ?? '';
    if (command.contains('rm -rf')) {
      return PermissionDeny(
        message: 'Refusing destructive command: $command',
        interrupt: true,
      );
    }
    // Allow, but force a dry run by rewriting the input.
    return PermissionAllow(updatedInput: {...input, 'dryRun': true});
  }
  return PermissionDeny(message: 'Tool "$toolName" is not permitted.');
}
```

Allow-verbatim, allow-with-rewritten-input, and deny-with-interrupt each render
to their wire JSON. The callback is dispatched over the reverse RPC mid-query; on
the wire, `Options.toJson` sends only a **capability flag**, never the function —
the concept confirms it:

```dart
final options = Options(canUseTool: policy);
final wireHasFlag = options.toJson()['canUseTool'] == true;
// options.toJson() canUseTool flag present (not the function): true
```

The extension installs a real callback that sees the flag and calls back into
your Dart closure over the reverse RPC whenever the model requests a tool.

### `streaming_query.dart` — a live query (interactive)

This is the real thing: [`AgentSdkClient.query`] starts an agent run on the
extension and returns an [`AgentQuery`] you `await for` over, plus `interrupt()`.
To stay cheap and side-effect-free, the concept runs in plan mode with a single
turn, and drains the stream through `drainQuery` (§7):

```dart
Future<bool> runStreamingQueryExample(VSCodeBridgeClient client) async {
  final agent = agentSdkClientFor(client);

  print('Starting query (plan mode, maxTurns: 1)…');
  final query = agent.query(
    prompt: 'In one sentence, what is the Tom Framework?',
    options: Options(
      maxTurns: 1,
      permissionMode: PermissionMode.plan,
    ),
  );

  final outcome = await drainQuery(query);
  printQueryOutcome(outcome);

  // A timeout (relay not yet wired) is a documented skip, not a failure; a
  // completed run is a success; only an unexpected error fails the concept.
  return outcome.error == null;
}
```

It is flagged **interactive** for two reasons: it drives a real agent turn (model
budget), and it depends on the chunk relay (§7). The auto-run skips it; run it by
name to drive a live query.

---

## 9. The raw-preserving message design

The output surface is **raw-preserving**, and it is worth understanding because
it is what makes the mirror forward-compatible. Every [`SdkMessage`] and
[`ContentBlock`] keeps its full original wire JSON in a `raw` field, and `toJson()`
returns it verbatim:

```dart
sealed class SdkMessage {
  final Map<String, dynamic> raw;
  const SdkMessage(this.raw);
  String get type => raw['type'] as String? ?? '';
  Map<String, dynamic> toJson() => raw;        // verbatim, never lossy
  // …typed accessors read from raw…
}
```

The typed subclasses (`SdkAssistantMessage`, `SdkResultMessage`, …) are *views*
over `raw`: their getters read fields out of the original map but never replace
it. Two consequences:

- **Nothing is lost, even for fields this mirror does not type.** A new SDK field
  on an assistant message is still present in `raw` and survives a round-trip.
- **An unmodelled message or block type still parses.** A future top-level `type`
  lands in [`SdkUnknownMessage`]; a future content block lands in `UnknownBlock`.
  The `message_types` concept asserts exactly this:

```dart
final unknown = SdkMessage.fromJson({'type': 'future_kind', 'x': 1});
final preserved = unknown is SdkUnknownMessage && unknown.toJson()['x'] == 1;
print('unknown message preserved verbatim: $preserved');   // true
```

The same principle runs the other direction for *input* types ([`Options`] and
the permission/MCP values): they serialize the fields they model with the SDK's
own wire names, so what reaches the real SDK is exactly what the SDK expects.

---

## 10. The aggregator and the dispatcher

Same two entry points as the other samples, with the concept signature keyed on
`VSCodeBridgeClient` and the `interactive` filter applied to the aggregator.

**`example/run_all_examples.dart`** connects once, iterates the concept list
(skipping interactive ones), catches per-concept exceptions so one failure
doesn't abort the rest, and prints a `passed/ran (n interactive skipped)` tally:

```dart
typedef Example = ({
  String name,
  Future<bool> Function(VSCodeBridgeClient) run,
  bool interactive,
});

const List<Example> agentSdkExamples = [
  (name: 'message_types', run: runMessageTypesExample, interactive: false),
  (name: 'options', run: runOptionsExample, interactive: false),
  (name: 'in_process_tool', run: runInProcessToolExample, interactive: false),
  (name: 'can_use_tool', run: runCanUseToolExample, interactive: false),
  (name: 'streaming_query', run: runStreamingQueryExample, interactive: true),
];
```

The loop skips interactive concepts and passes the **client** to each `run`:

```dart
for (final example in agentSdkExamples) {
  if (example.interactive) {
    skipped++;
    stdout.writeln('\n=== ${example.name} (interactive — skipped) ===');
    continue;
  }
  stdout.writeln('\n=== ${example.name} ===');
  try {
    final ok = await example.run(client);
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
with the list of valid names. Both entry points call `exit(...)` explicitly — the
bridge client keeps its socket open, which keeps the event loop alive, so a
normally-returning `main` would leave the process hanging after all work is done.
The dispatcher imposes no `interactive` rule: it will run `streaming_query`
directly, which is how you exercise the live concept when you mean to.

---

## 11. Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | all non-interactive examples passed, **or** no live bridge was found (documented skip) |
| `1` | at least one example failed against a live window |
| `64` | (dispatcher) unknown example name |

A headless run with no window exits `0`; a real failure exits `1`. The
interactive concept never affects the aggregator's exit code — it's skipped, not
run. A `streaming_query` timeout (relay not yet wired) is a documented skip and
exits `0`.

---

## 12. Troubleshooting

| Symptom | Cause & fix |
| ------- | ----------- |
| `No VS Code CLI Integration Server found on 127.0.0.1:19900–19909` | No window has the server running. Run **`DS: Start Tom CLI Integration Server`** in the command palette. |
| `streaming_query` prints "No chunks arrived within the timeout" | The `agentSdk.chunk` relay over the CLI socket is a documented completion step (§7). This is a graceful skip, not a failure — the concept still exits `0`. |
| `streaming_query` reports a query error | The extension reported an `error` chunk (e.g. no API key configured for the active profile, or the query was rejected). Check the window's Anthropic profile configuration. |
| `options` / `message_types` etc. seem to ignore the window | They are deterministic and in-process by design (§7). They connect for a uniform shape but assert pure logic — that's expected. |
| A concept hangs | You're running a concept function directly without an entry point that calls `exit`, or draining a live query without a timeout. Use `bin/run_example.dart`; live queries go through `drainQuery`. |
| `dart analyze` complains about an unused `client` parameter | The deterministic concepts touch `client.isConnected` precisely so the parameter is used while staying offline; keep that line. |

---

## 13. The other samples

This is the fourth of four samples under
[`tom_vscode_scripting_api/example/`](../README.md):

| Sample | Adds |
| ------ | ---- |
| [`vscode_scripting_introduction_sample`](../vscode_scripting_introduction_sample/) | The connection model: discovering a window, the `VSCode` singleton, the three core namespaces, and the run-script conventions every later sample builds on. **Start here.** |
| [`vscode_scripting_advanced_sample`](../vscode_scripting_advanced_sample/) | The next layer of VS Code scripting: editor edits, batched file I/O, progress, quick-pick/input flows, the language model, and the `VsCodeHelper` façade. |
| [`vscode_agent_tools_sample`](../vscode_agent_tools_sample/) | The Tom extension's own feature APIs (workspace, todos, queue, timed requests, documents, the tool registry, send-to-chat) via the per-class `setAdapter` idiom. |

---

## 14. Where to go next

- [Agent SDK scripting guide](../../doc/vscode_api_anthropic_agent_sdk_guide.md) —
  the authoritative reference for `AgentSdkClient`, the full `Options` surface,
  the message hierarchy, in-process tools, and `canUseTool`.
- [Scripting API module README](../../README.md) — the full API surface, install,
  and architecture.
- [Scripting API intro & architecture](../../doc/vscode_api_intro.md) — the
  connection model and initialization styles in depth.
- [`tom_vscode_bridge`](../../../tom_vscode_bridge/README.md) — the bridge that
  hosts the CLI Integration Server this sample connects to, and where the
  `agentSdk.chunk` relay completion step lives.
- [Repository map](../../../README.md) — the whole Tom VS Code ecosystem.

[`Options`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkMessage`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkSystemMessage`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkAssistantMessage`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkResultMessage`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkUnknownMessage`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`ContentBlock`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SdkMcpTool`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`McpSdkServerConfig`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`ToolHandler`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`CallToolResult`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`CanUseTool`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`CanUseToolContext`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`PermissionResult`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`PermissionAllow`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`PermissionDeny`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`PermissionMode`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`EffortLevel`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`SystemPrompt`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`ToolsConfig`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`ThinkingConfig`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`AgentSdkClient`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`AgentSdkClient.query`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`AgentQuery`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md
[`VSCodeBridgeClient`]: ../../doc/vscode_api_intro.md
[`VSCodeBridgeAgentSdkTransport`]: ../../doc/vscode_api_anthropic_agent_sdk_guide.md

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](../../LICENSE).
