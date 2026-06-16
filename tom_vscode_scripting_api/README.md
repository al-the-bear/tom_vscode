# tom_vscode_scripting_api

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

Drive a **running VS Code window from Dart**. A typed, bridge-agnostic client for
the Tom AI VS Code extension: open files, run commands, query the language model,
stream an Anthropic Agent SDK session, and reach the extension's own features —
all over a local socket, from a plain Dart program or a `*.d4rt.dart` script.

---

## Overview

The Tom AI extension hosts a **CLI Integration Server**: a JSON-RPC server that
exposes the editor's capabilities to out-of-process clients.
`tom_vscode_scripting_api` is the Dart client for that server. Anything the
extension can do inside the editor host becomes a typed Dart call.

It exposes **three families of API** behind one connection:

1. **VS Code scripting** — the editor mirrored as Dart (`window`, `workspace`,
   `commands`, `extensions`, `lm`, `chat`) plus the batteries-included
   `VsCodeHelper`.
2. **Anthropic Agent SDK** — a 1:1 Dart mirror of the Agent SDK: streaming
   `query()`, in-process Dart tools, and a `canUseTool` permission callback.
3. **Extension features** — the Tom AI extension's own subsystems (todos, the
   prompt queue, timed requests, documents, workspace metadata, tools,
   send-to-chat) as static-method classes.

The package is **standalone** (zero runtime dependencies) and
**bridge-agnostic**: every API talks to an abstract `VSCodeAdapter`, so the same
surface is testable against fakes.

---

## Installation

```yaml
# pubspec.yaml
dependencies:
  tom_vscode_scripting_api: ^1.1.0
```

```bash
dart pub add tom_vscode_scripting_api
```

No native dependencies; pure Dart, SDK `^3.10.4`.

---

## Features

### VS Code scripting

| API | What it does |
| --- | --- |
| `VSCode` | Root singleton — version, env, clipboard, external URIs; owns the namespaces. |
| `window` (`VSCodeWindow`) | Messages, quick picks, input boxes, editors, output channels, status bar, terminals, file dialogs. |
| `workspace` (`VSCodeWorkspace`) | Folders, file finding, documents, host-side file system, configuration. |
| `commands` (`VSCodeCommands`) | Execute/register commands; `VSCodeCommonCommands` named constants. |
| `extensions` (`VSCodeExtensions`) | Query, activate, and read exports of installed extensions. |
| `lm` (`VSCodeLanguageModel`) | Select chat models (Copilot et al.), send requests, count tokens, register/invoke LM tools. |
| `chat` (`VSCodeChat`) | Register a chat participant whose handler runs in your Dart process. |
| `VsCodeHelper` | All-static convenience layer — Dart/Flutter tooling, Copilot prompts, editor edits, `VsProgress`, `FileBatch`. |

### Anthropic Agent SDK

| API | What it does |
| --- | --- |
| `AgentSdkClient` | `query()` → streaming `AgentQuery`; `collectQuery()` → `List<SdkMessage>`. |
| `Options` | Full Agent SDK option surface (model, tools, `maxTurns`, `permissionMode`, sessions, sub-agents, thinking…). |
| `SdkMessage` (sealed) | Raw-preserving typed message stream (`SdkAssistantMessage`, `SdkResultMessage`, …). |
| `SdkMcpTool` / `McpSdkServerConfig` | In-process Dart tools the agent can call. |
| `canUseTool` / `PermissionResult` | Per-call permission callback running in your process. |

### Extension features

| API | What it does |
| --- | --- |
| `AiPromptApi` | Run a prompt through the configured local LLM; manage profiles and models. |
| `AiConversationApi` | Drive the multi-turn bot-conversation engine. |
| `TomTodoApi` | CRUD over quest / workspace / session todos. |
| `TomQueueApi` | Full control of the multi-transport prompt queue. |
| `TomTimedApi` | Create and manage scheduled prompts; control the timer engine. |
| `TomDocumentApi` | Generic document store + typed Tom-folder accessors. |
| `TomWorkspaceApi` | Workspace info, projects, quests, the active quest, chat variables. |
| `TomToolsApi` | Invoke registered tools; fetch tools JSON for prompt injection. |
| `TomChatApi` | Send a prompt to the active chat target (Anthropic or Copilot). |

### Bridge transport

| Type | What it does |
| --- | --- |
| `VSCodeAdapter` | Abstract contract — `sendRequest(method, params)`. Everything routes through it. |
| `VSCodeBridgeClient` | Owns the socket; JSON-RPC 2.0, length-prefixed TCP, notifications + callbacks. |
| `VSCodeBridgeAdapter` | Wraps a connected client as a `VSCodeAdapter`. |
| `LazyVSCodeBridgeAdapter` | Same, but connects on first use — ideal for scripts. |
| `connectToWorkspace` / `findBridgePortForWorkspace` / `scanBridgePorts` | Discovery helpers — resolve the right window by the workspace it has open. |

---

## Quick start

First, in the target VS Code window, run **"DS: Start Tom CLI Integration
Server"** (Command Palette). Then, from Dart:

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  // Resolve the window by the workspace it has open, connect, and promote the
  // adapter to the VSCode singleton.
  await connectToWorkspace('tom_agent_container', initializeVSCode: true);

  final version = await VSCode.instance.getVersion();
  await VSCode.instance.window.showInformationMessage('Connected to VS Code $version');
  print('VS Code version: $version'); // e.g. VS Code version: 1.99.0
}
```

---

## Example projects

Runnable, self-contained samples live under [`example/`](example/), ordered as a
learning path — each introduces one new capability on top of the last. Each
sample is its own Dart subproject with a comprehensive README.

| Sample | Introduces |
| --- | --- |
| [`vscode_scripting_introduction_sample`](example/vscode_scripting_introduction_sample/) | Connecting to a live window — messages, commands, workspace folders, reading and opening files. **Start here.** |
| [`vscode_scripting_advanced_sample`](example/vscode_scripting_advanced_sample/) | Editor edits, file batches, progress and pickers, the language model, and `VsCodeHelper`. |
| [`vscode_agent_tools_sample`](example/vscode_agent_tools_sample/) | The extension's own feature APIs — todos, the prompt queue, timed requests, documents, workspace metadata, tools, send-to-chat. |
| [`vscode_agent_sdk_sample`](example/vscode_agent_sdk_sample/) | Streaming an Anthropic Agent SDK `query()` with `Options`, typed messages, in-process Dart `tool()`s, and `canUseTool`. |

---

## Usage

### Connect

There are two ways to connect; pick by how many windows you run.

**By port (single window):**

```dart
import 'package:tom_vscode_scripting_api/script_globals.dart';

final adapter = LazyVSCodeBridgeAdapter(host: '127.0.0.1', port: 19900);
VSCode.initialize(adapter);
```

**By workspace name (recommended for multi-window):** the discovery helper scans
the port range and matches the window by its open workspace.

```dart
final adapter = await connectToWorkspace('tom_agent_container', initializeVSCode: true);
```

### Two initialisation styles

Know which an API uses:

- **VS Code-namespace classes** (`VSCode`, `window`, `workspace`, `commands`,
  `extensions`, `lm`, `chat`) read the **`VSCode` singleton** — call
  `VSCode.initialize(adapter)` once.
- **Extension-feature classes** (`TomTodoApi`, `TomQueueApi`, `AiPromptApi`, …)
  are **static-method classes** — each needs `<Class>.setAdapter(adapter)`.

```dart
final adapter = await connectToWorkspace('tom_agent_container');
VSCode.initialize(adapter);        // enables vscode / window / workspace / ...
TomTodoApi.setAdapter(adapter);    // enables TomTodoApi.*
TomQueueApi.setAdapter(adapter);   // enables TomQueueApi.*
```

### Script the editor

```dart
await window.setStatusBarMessage('Running analyzer…');
await commands.executeCommand('workbench.action.files.saveAll');

final diagnostics = await VsCodeHelper.getDiagnostics('lib/main.dart');
if (diagnostics.isEmpty) {
  await window.showInformationMessage('No problems found');
} else {
  await window.showWarningMessage('${diagnostics.length} problems');
}
```

→ [VS Code scripting guide](doc/vscode_api_vscode_scripting_guide.md)

### Run an agent

```dart
final bridge = VSCodeBridgeClient(host: '127.0.0.1', port: 19900);
await bridge.connect();
final client = AgentSdkClient(VSCodeBridgeAgentSdkTransport(bridge));

final query = client.query(
  prompt: 'Read lib/parser.dart and suggest three improvements',
  options: Options(model: 'claude-sonnet-4', maxTurns: 10),
);

await for (final m in query) {
  if (m is SdkAssistantMessage) {
    for (final b in m.content) {
      if (b is TextBlock) stdout.write(b.text);
    }
  }
}
```

The Agent SDK transport needs the raw `VSCodeBridgeClient` (not just the
adapter) because it uses the bidirectional notification + callback channel.
→ [Agent SDK guide](doc/vscode_api_anthropic_agent_sdk_guide.md)

### Drive the extension's features

```dart
TomWorkspaceApi.setAdapter(adapter);
TomTodoApi.setAdapter(adapter);
TomChatApi.setAdapter(adapter);

await TomWorkspaceApi.setActiveQuest('vscode_extension');
final todos = await TomTodoApi.listQuestTodos('vscode_extension');

final reply = await TomChatApi.sendToChat(
  'I have ${todos.length} open todos. Suggest which to tackle first.',
);
print(reply.text);
```

→ [Extension scripting guide](doc/vscode_api_extension_scripting_guide.md)

---

## Architecture

Three layers, lowest to highest. Everything above the adapter contract
ultimately calls `sendRequest`; swap the adapter and the whole surface targets a
different transport (or a test double).

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

VS Code-namespace calls are sent as an `executeScriptVce` request whose payload
is JavaScript run in the extension host with a `context.vscode` global; the
extension-feature APIs instead call dedicated `<area>.<op>Vce` methods (e.g.
`queue.listVce`, `localLlm.processVce`). Server→client callbacks (Agent SDK
chunks, `canUseTool`, chat handlers) are JSON-RPC requests pushed back over the
same socket and routed by `BridgeRequestDispatcher`.

### Key types

| Type | Role |
| --- | --- |
| `VSCodeAdapter` | Abstract request/response contract — the single seam every API depends on. |
| `VSCodeBridgeClient` | Socket owner: `connect`/`disconnect`, `sendRequest`, `notifications` stream, server→client handler registration. |
| `VSCodeBridgeAdapter` / `LazyVSCodeBridgeAdapter` | Adapt a client to `VSCodeAdapter`; the lazy variant connects on first use. |
| `VSCode` | Root singleton; gateway to the namespace classes after `initialize`. |
| `VsCodeHelper` | Static convenience layer over the namespaces. |
| `AgentSdkClient` / `AgentQuery` | Agent SDK entry; `AgentQuery extends StreamView<SdkMessage>` and adds `interrupt()`. |
| `AgentSdkTransport` / `VSCodeBridgeAgentSdkTransport` | Agent SDK seam and its socket-backed production implementation. |
| `Options` | Agent SDK configuration data class. |
| `SdkMessage` / `ContentBlock` | Sealed, raw-preserving message and content hierarchies. |
| `BridgeRequestDispatcher` | Routes server→client JSON-RPC requests to registered handlers. |
| `Tom*Api` / `Ai*Api` | Static-method extension-feature classes (each set up with `setAdapter`). |

---

## Ecosystem

`tom_vscode_scripting_api` is the Dart client half of the Tom VS Code repo. The
two halves meet only at the extension's JSON-RPC CLI Integration Server.

```
        ┌──────────────── inside the editor (TypeScript) ────────────────┐
        │  tom_vscode_extension  ◄── tom_vscode_shared / tom_vscode_workflow │
        │   · chat panels · prompt queue · tool registry · MCP server     │
        │   · CLI Integration Server  (JSON-RPC over TCP 19900–19909)     │
        └───────────────────────────────▲────────────────────────────────┘
                                         │  local socket
        ┌────────────────────── driving it (Dart) ───────────────────────┐
        │  tom_vscode_scripting_api  ──►  THIS PACKAGE (typed client)      │
        │  tom_vscode_bridge         ──►  Dart bridge server for CLI/d4rt  │
        └─────────────────────────────────────────────────────────────────┘
```

- [`tom_vscode_extension`](../tom_vscode_extension/README.md) — the extension
  that hosts the CLI Integration Server this client talks to.
- [`tom_vscode_bridge`](../tom_vscode_bridge/README.md) — the Dart bridge server
  that builds on this package to give Tom CLI tools and d4rt scripts editor
  access.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Further documentation

The full user guides live in [`doc/`](doc/):

| Guide | Covers |
| --- | --- |
| [vscode_api_intro.md](doc/vscode_api_intro.md) | Overview, architecture, connection model — **start here**. |
| [vscode_api_vscode_scripting_guide.md](doc/vscode_api_vscode_scripting_guide.md) | Scripting VS Code itself + `VsCodeHelper`. |
| [vscode_api_anthropic_agent_sdk_guide.md](doc/vscode_api_anthropic_agent_sdk_guide.md) | Scripting the Anthropic Agent SDK. |
| [vscode_api_extension_scripting_guide.md](doc/vscode_api_extension_scripting_guide.md) | Scripting the extension's own features. |

---

## Status

| | |
| --- | --- |
| Version | 1.1.0 |
| Dart SDK | `^3.10.4` |
| Runtime dependencies | none (standalone) |
| Tests | 85 passing across 8 suites (`dart test`) |
| License | BSD-3-Clause |

---

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
</content>
</invoke>
