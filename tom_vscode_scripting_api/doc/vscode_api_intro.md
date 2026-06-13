# VS Code Scripting API — Introduction & Overview

`tom_vscode_scripting_api` is a Dart package that lets a Dart program (compiled,
or run as a d4rt/dcli script) drive a running VS Code window from the outside.
It speaks to the **Tom AI VS Code extension** over a local socket, so anything
the extension can do inside the editor host — run commands, open files, query
the language model, stream an Anthropic Agent SDK query, manage the Tom prompt
queue — becomes a typed Dart call.

This document is the map. It explains the architecture, the connection model,
the three families of API the package exposes, and how to get a script
connected. The detail lives in three companion guides:

| Guide | Covers |
| ----- | ------ |
| [vscode_api_vscode_scripting_guide.md](vscode_api_vscode_scripting_guide.md) | Scripting **VS Code itself** — commands, windows, workspace, files, editors, language model, chat participants, and the high-level `VsCodeHelper`. |
| [vscode_api_anthropic_agent_sdk_guide.md](vscode_api_anthropic_agent_sdk_guide.md) | Scripting the **Anthropic Agent SDK** — streaming `query()`, `Options`, messages, in-process MCP tools, and the `canUseTool` permission callback. |
| [vscode_api_extension_scripting_guide.md](vscode_api_extension_scripting_guide.md) | Scripting the **extension's own features** — local LLM prompts, bot conversations, todos, the prompt queue, timed requests, documents, workspace metadata, tools, and send-to-chat. |

---

## What this package is for

The Tom AI extension hosts a **CLI Integration Server**: a JSON-RPC server,
listening on a local TCP port, that exposes the extension's capabilities to
out-of-process clients. `tom_vscode_scripting_api` is the Dart client for that
server. Typical uses:

- **Automation scripts** — a `*.d4rt.dart` script that opens files, runs a
  build command, and reports diagnostics.
- **CLI tools** — the `tom_vscode_bridge` package builds on this to give Tom CLI
  tools access to the live editor.
- **Agentic workflows** — drive an Anthropic Agent SDK query, feeding it
  in-process Dart tools and approving its actions through a `canUseTool`
  callback, all from a Dart program.

The package is **bridge-agnostic**: every API talks to an abstract
`VSCodeAdapter`. The production adapter is socket-backed, but the seam means the
same API surface is testable against fakes.

---

## Architecture

Three layers, lowest to highest:

```
┌───────────────────────────────────────────────────────────────┐
│  3. High-level APIs                                            │
│     VSCode / window / workspace / commands / extensions / lm   │
│     / chat   ·   VsCodeHelper   ·   AgentSdkClient             │
│     Ai*/Tom* extension-feature APIs                            │
├───────────────────────────────────────────────────────────────┤
│  2. Transport                                                 │
│     VSCodeBridgeAdapter / LazyVSCodeBridgeAdapter             │
│     VSCodeBridgeClient  (JSON-RPC 2.0, length-prefixed TCP)   │
├───────────────────────────────────────────────────────────────┤
│  1. Adapter contract                                          │
│     abstract VSCodeAdapter.sendRequest(method, params)        │
└───────────────────────────────────────────────────────────────┘
                              │  TCP socket  (port 19900–19909)
                              ▼
┌───────────────────────────────────────────────────────────────┐
│  Tom AI VS Code extension  —  CLI Integration Server          │
│  executes JS in the extension host (context.vscode global),   │
│  routes <area>.<op>Vce methods to extension features          │
└───────────────────────────────────────────────────────────────┘
```

### Layer 1 — the adapter contract

```dart
abstract class VSCodeAdapter {
  Future<Map<String, dynamic>> sendRequest(
    String method,
    Map<String, dynamic> params, {
    String? scriptName,
    Duration timeout = const Duration(seconds: 60),
  });
}
```

Everything above this line ultimately calls `sendRequest`. Swap the adapter and
the entire API targets a different transport (or a test double).

### Layer 2 — the bridge transport

- **`VSCodeBridgeClient`** — owns the socket. JSON-RPC 2.0 framed with a 4-byte
  big-endian length prefix. Provides `connect()`, `disconnect()`,
  `sendRequest(method, params)`, a `notifications` broadcast stream (for
  server-pushed events like Agent SDK chunks), and request-handler registration
  for server→client calls.
- **`VSCodeBridgeAdapter`** — wraps a connected client as a `VSCodeAdapter`.
- **`LazyVSCodeBridgeAdapter`** — same, but connects on first use; ideal for
  scripts that don't want explicit lifecycle management.

Most VS Code-namespace calls are implemented by sending an `executeScriptVce`
request whose payload is JavaScript run in the extension host with a
`context.vscode` global; the extension-feature APIs instead call dedicated
`<area>.<op>Vce` methods (e.g. `queue.listVce`, `localLlm.processVce`).

### Layer 3 — the typed APIs

The three families described below.

---

## The three API families

### 1. VS Code scripting

The editor itself, mirrored as Dart. Entry point is the `VSCode` singleton and
its namespaces, plus convenience globals:

```dart
final version = await vscode.getVersion();
await window.showInformationMessage('VS Code $version');
final folders = await workspace.getWorkspaceFolders();
await commands.executeCommand('workbench.action.files.saveAll');
```

`VsCodeHelper` sits on top with batteries-included helpers (Dart/Flutter
tooling, Copilot prompts, editor edits, progress, file batches).
→ [VS Code scripting guide](vscode_api_vscode_scripting_guide.md)

### 2. Anthropic Agent SDK

A 1:1 Dart mirror of the TypeScript Agent SDK, exposed through the bridge. Run a
streaming agent query, with optional in-process Dart tools and a permission
callback:

```dart
final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(bridgeClient));
final query = client.query(
  prompt: 'Refactor the parser and run the tests',
  options: Options(model: 'claude-sonnet-4', maxTurns: 20),
);
await for (final message in query) {
  // typed SdkMessage stream
}
```

→ [Agent SDK guide](vscode_api_anthropic_agent_sdk_guide.md)

### 3. Extension features

The Tom AI extension's own subsystems, as static-method Dart classes:

```dart
final todos = await TomTodoApi.listQuestTodos('vscode_extension');
final queue = await TomQueueApi.list();
final reply = await TomChatApi.sendToChat('Summarize the open file');
final result = await AiPromptApi.process(prompt: 'Explain this error');
```

→ [Extension scripting guide](vscode_api_extension_scripting_guide.md)

---

## Getting started

### 1. Start the server inside VS Code

In the target window, run the command **"DS: Start Tom CLI Integration Server"**
(Command Palette). It listens on the first free port in **19900–19909**. Each
open window gets its own port.

### 2. Connect from Dart

The simplest path uses the lazy adapter and the script globals:

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

Future<void> main() async {
  // Connect to the default port and promote to the VSCode singleton.
  final adapter = LazyVSCodeBridgeAdapter(host: '127.0.0.1', port: 19900);
  VSCode.initialize(adapter);

  final version = await vscode.getVersion();
  await window.showInformationMessage('Connected to VS Code $version');
}
```

### 3. Connect by workspace name (recommended for multi-window)

When several windows are open you rarely know which port is which. Resolve by
workspace name instead — `connectToWorkspace` scans the port range, matches the
window by its open workspace, connects, and (optionally) promotes the adapter to
the `VSCode` singleton:

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  final adapter = await connectToWorkspace(
    'tom_agent_container',
    initializeVSCode: true,
  );
  final root = await VSCode.instance.workspace.getRootPath();
  print('Workspace root: $root');
}
```

Discovery helpers (`bridge_discovery.dart`):

| Function | Purpose |
| -------- | ------- |
| `findBridgePortForWorkspace(name)` | Returns the port whose window has `name` open. Throws `BridgeWorkspaceNotFoundException` if none match. |
| `scanBridgePorts()` | Returns a `port → workspace` table for every responsive bridge. |
| `connectToWorkspace(name, {initializeVSCode})` | Resolves the port, connects, returns the adapter (optionally as the `VSCode` singleton). |
| `normalizeWorkspaceName(value)` | Canonicalises a name (drops `.code-workspace`, strips the `" (Workspace)"` suffix) for matching. |

### 4. Two initialisation styles

The package has two distinct setup mechanisms — know which an API uses:

- **VS Code-namespace classes** (`VSCode`, `window`, `workspace`, `commands`,
  `extensions`, `lm`, `chat`) are reached through the **`VSCode` singleton**.
  Call `VSCode.initialize(adapter)` once; then the top-level getters in
  `script_globals.dart` work.
- **Extension-feature classes** (`TomTodoApi`, `TomQueueApi`, `AiPromptApi`, …)
  are **static-method classes** that each need
  `<Class>.setAdapter(adapter)` before use (they do not read the `VSCode`
  singleton).

```dart
final adapter = await connectToWorkspace('tom_agent_container');
VSCode.initialize(adapter);          // enables vscode/window/workspace/...
TomTodoApi.setAdapter(adapter);      // enables TomTodoApi.*
TomQueueApi.setAdapter(adapter);     // enables TomQueueApi.*
```

---

## Connection model reference

| Property | Value |
| -------- | ----- |
| Protocol | JSON-RPC 2.0 |
| Framing | 4-byte big-endian length prefix per message |
| Transport | TCP, localhost |
| Default port | `19900` (`defaultVSCodeBridgePort`) |
| Port range | `19900`–`19909` (`maxVSCodeBridgePort`) |
| Connect timeout | 5 s (default) |
| Request timeout | 30 s client default; 60 s adapter default |
| Server start command | "DS: Start Tom CLI Integration Server" |
| VS Code-namespace dispatch | `executeScriptVce` (JS with `context.vscode`) |
| Feature dispatch | `<area>.<op>Vce` (e.g. `queue.listVce`) |
| Server→client (callbacks) | JSON-RPC requests pushed over the same socket, routed by `BridgeRequestDispatcher` |

---

## Conventions across all APIs

- **Async everywhere.** Every bridge call returns a `Future`; await it.
- **Non-blocking message dialogs.** `showInformationMessage` and friends return
  `null` and do not block the script (they are fire-and-display).
- **Null on absence.** Lookups (`getExtension`, `getActiveTextEditor`) return
  `null` when there is nothing to return rather than throwing.
- **Result envelopes.** The bridge wraps script results as `{success, result}`;
  the typed APIs unwrap that for you.
- **Initialise before use.** Calling an API before its adapter is set throws a
  `StateError` telling you which initialise call is missing.

Continue to whichever guide matches your task — the three links are at the top of
this document.
