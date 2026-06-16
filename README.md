# Tom VS Code — the AI-assisted editor extension and its scripting ecosystem

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE.md](LICENSE.md).

Tom VS Code turns a normal VS Code window into an **AI-assisted development
cockpit** and then makes that cockpit **scriptable from the outside**. Inside the
editor, the extension adds chat panels (Anthropic, Local LLM, Copilot), a
multi-transport prompt queue, a shared tool registry, and a standalone MCP
server. Outside the editor, a Dart scripting API drives that same running window
over a local socket — so a script, a CLI tool, or an autonomous agent can open
files, run commands, query the language model, and stream an Anthropic Agent SDK
session in the live editor.

This repository
([`al-the-bear/tom_vscode`](https://github.com/al-the-bear/tom_vscode)) holds the
whole ecosystem: the extension, the Dart bridge that exposes it to
out-of-process clients, the published scripting API, the shared TypeScript
libraries the extension is built from, and two decoupled YAML-graph packages.
This document is the **map**; each package has its own README and `doc/` folder
for the detail.

> **New here?** If you want to *use the editor*, build and install
> [`tom_vscode_extension`](tom_vscode_extension/README.md). If you want to
> *script the editor* from Dart, start with
> [`tom_vscode_scripting_api`](tom_vscode_scripting_api/README.md) and the
> [`vscode_scripting_introduction_sample`](tom_vscode_scripting_api/example/vscode_scripting_introduction_sample/)
> — the shortest path from "installed" to "driving a live window".

---

## What you can do with Tom VS Code

- **Chat with several models in one place** — Anthropic (direct SDK and Agent
  SDK), the VS Code language model (Copilot), and a local LLM, in dedicated
  bottom-panel subpanels.
- **Queue prompts across transports** — line up work and let it run, with timed
  templates, follow-ups, and per-quest trails.
- **Expose a tool registry** — the same MCP-style tools the in-editor panels use
  can be published to external MCP clients over HTTP.
- **Drive a running window from Dart** — open files, run commands, read/write
  the workspace, show pickers and progress, and call the language model from a
  plain Dart program or a `*.d4rt.dart` script.
- **Run an Anthropic Agent SDK query from Dart** — stream typed messages, feed
  the agent in-process Dart tools, and approve its actions through a
  `canUseTool` permission callback.
- **Reach the extension's own features programmatically** — todos, the prompt
  queue, timed requests, documents, workspace metadata, and send-to-chat.

---

## Two ways in

The packages split along one clean line: code that runs **inside** the editor
host, and code that drives the editor **from outside** over a socket. Reading
the component tables with this split in mind makes the dependency arrows obvious.

- **Inside the editor (TypeScript).** The
  [extension](tom_vscode_extension/README.md) is the product; the
  [shared](tom_vscode_shared/README.md) and
  [workflow](tom_vscode_workflow/README.md) libraries are the TypeScript building
  blocks it is assembled from.
- **Driving it from outside (Dart).** The
  [scripting API](tom_vscode_scripting_api/README.md) is the typed Dart client;
  the [bridge](tom_vscode_bridge/README.md) is the Dart server binary that the
  extension launches to give CLI tools and d4rt scripts access to the live
  editor.

The link between the two halves is a **JSON-RPC server inside the extension**
(the "CLI Integration Server") listening on a local TCP port (`19900`–`19909`).
The scripting API is the Dart client for that server.

```
        ┌──────────────────── inside the editor (TS) ────────────────────┐
        │  tom_vscode_extension  ◄── tom_vscode_shared / tom_vscode_workflow │
        │   · chat panels · prompt queue · tool registry · MCP server     │
        │   · CLI Integration Server  (JSON-RPC over TCP 19900–19909)     │
        └───────────────────────────────▲────────────────────────────────┘
                                         │  local socket
        ┌────────────────────── driving it (Dart) ───────────────────────┐
        │  tom_vscode_scripting_api  ──►  (typed client: vscode / window /  │
        │     workspace / lm / chat · Agent SDK · Tom* feature APIs)       │
        │  tom_vscode_bridge  ──►  Dart bridge server (tom_bs) for CLI/d4rt │
        └─────────────────────────────────────────────────────────────────┘
```

---

## The components

Every package below has a README (linked). Base path for all entries is this
repository root.

### Inside the editor (TypeScript)

| Package | What it is | Artifact |
| --- | --- | --- |
| [`tom_vscode_extension`](tom_vscode_extension/README.md) | The **`@Tom`** VS Code extension. AI chat panels (Anthropic / Local LLM / Copilot), the multi-transport prompt queue, the shared tool registry, the standalone MCP server, the status page, and the CLI Integration Server. This is the product. | VSIX (`@Tom`) |
| [`tom_vscode_shared`](tom_vscode_shared/README.md) | Shared TypeScript types and helpers consumed by the extension and workflow packages — todo scanning/management, Mermaid flowchart rendering, common types. | library |
| [`tom_vscode_workflow`](tom_vscode_workflow/README.md) | TODO-tracking and project-management panels for the Tom workspace, built on the shared library. | library |

### Driving it from Dart

| Package | What it is | Artifact |
| --- | --- | --- |
| [`tom_vscode_scripting_api`](tom_vscode_scripting_api/README.md) | The published Dart client. A bridge-agnostic, typed API surface mirroring VS Code (commands, window, workspace, files, language model, chat), the Anthropic Agent SDK (streaming `query()`, tools, permissions), and the extension's own features (todos, queue, timed requests, documents, tools). | pub.dev `^1.1.0` |
| [`tom_vscode_bridge`](tom_vscode_bridge/README.md) | The Dart **bridge server** the extension launches. Runs Dart (via the D4rt interpreter) with full VS Code API access and talks JSON-RPC over stdin/stdout — the local-process path for Tom CLI tools and d4rt scripts. | `tom_bs` |

### Decoupled / standalone (TypeScript)

| Package | What it is | Status |
| --- | --- | --- |
| [`yaml_graph_core`](yaml_graph_core/README.md) | YAML-graph → Mermaid conversion engine with configurable mappings. | decoupled — no longer consumed by the extension (removed in `3b0b63d`) |
| [`yaml_graph_vscode`](yaml_graph_vscode/README.md) | VS Code custom-editor integration for YAML-graph files. | decoupled — extension glue preserved under `_extension_backup/` |

---

## Getting started

### Use the editor

Build, package, and install the extension from
[`tom_vscode_extension`](tom_vscode_extension/README.md):

```bash
cd tom_vscode_extension
npm run compile          # tsc + copy config json to out/config/
./install_extension.sh   # build the VSIX and install it
# then in VS Code: Cmd+Shift+P → "Developer: Reload Window"
```

### Script the editor from Dart

Add the published client and drive a running window. First, in the target VS
Code window, run **"DS: Start Tom CLI Integration Server"** (Command Palette).
Then:

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  // Resolve the window by the workspace it has open, connect, and promote
  // the adapter to the VSCode singleton.
  await connectToWorkspace('tom_agent_container', initializeVSCode: true);

  final version = await VSCode.instance.getVersion();
  await VSCode.instance.window.showInformationMessage('Connected to VS Code $version');
  print('VS Code version: $version'); // e.g. 1.99.0
}
```

```yaml
# pubspec.yaml
dependencies:
  tom_vscode_scripting_api: ^1.1.0
```

From here, follow the [samples learning path](#samples) below.

---

## Samples

Runnable, self-contained samples live under
[`tom_vscode_scripting_api/example/`](tom_vscode_scripting_api/example/), ordered
as a learning path — each introduces one new capability on top of the last. Each
sample is its own Dart subproject with a comprehensive README (the basis for a
published article).

| Sample | Introduces |
| --- | --- |
| [`vscode_scripting_introduction_sample`](tom_vscode_scripting_api/example/vscode_scripting_introduction_sample/) | Connecting to a live window and making your first calls — messages, commands, workspace folders, reading and opening files. **Start here.** |
| [`vscode_scripting_advanced_sample`](tom_vscode_scripting_api/example/vscode_scripting_advanced_sample/) | Editor edits, file batches, progress and pickers, the language model (`lm.selectChatModels` → `sendRequest`), and the batteries-included `VsCodeHelper`. |
| [`vscode_agent_tools_sample`](tom_vscode_scripting_api/example/vscode_agent_tools_sample/) | The extension's own feature APIs — todos, the prompt queue, timed requests, documents, workspace metadata, the tool registry, and send-to-chat. |
| [`vscode_agent_sdk_sample`](tom_vscode_scripting_api/example/vscode_agent_sdk_sample/) | Streaming an Anthropic Agent SDK `query()` with `Options`, typed messages, in-process Dart `tool()`s, and the `canUseTool` permission callback. |

---

## Documentation index

Each package keeps its user documentation in its own `doc/` folder; the READMEs
above link the relevant files. The most common entry points:

| Topic | Document |
| --- | --- |
| Scripting API — overview & connection model | [`tom_vscode_scripting_api/doc/vscode_api_intro.md`](tom_vscode_scripting_api/doc/vscode_api_intro.md) |
| Scripting VS Code itself | [`vscode_api_vscode_scripting_guide.md`](tom_vscode_scripting_api/doc/vscode_api_vscode_scripting_guide.md) |
| Scripting the Anthropic Agent SDK | [`vscode_api_anthropic_agent_sdk_guide.md`](tom_vscode_scripting_api/doc/vscode_api_anthropic_agent_sdk_guide.md) |
| Scripting the extension's features | [`vscode_api_extension_scripting_guide.md`](tom_vscode_scripting_api/doc/vscode_api_extension_scripting_guide.md) |
| Extension architecture | [`tom_vscode_extension/doc/extension_analysis.md`](tom_vscode_extension/doc/extension_analysis.md) |
| Anthropic SDK integration | [`tom_vscode_extension/doc/anthropic_sdk_integration.md`](tom_vscode_extension/doc/anthropic_sdk_integration.md) |
| Standalone MCP server | [`tom_vscode_extension/doc/mcp_server.md`](tom_vscode_extension/doc/mcp_server.md) |
| Prompt queue model | [`tom_vscode_extension/doc/multi_transport_prompt_queue_revised.md`](tom_vscode_extension/doc/multi_transport_prompt_queue_revised.md) |

---

## Repository layout

```
tom_vscode_extension/      the @Tom VS Code extension (TypeScript)      (product)
tom_vscode_shared/         shared TS types/helpers used by the extension (library)
tom_vscode_workflow/       TODO/project-management panels (TypeScript)   (library)

tom_vscode_scripting_api/  published Dart client for the extension       (pub.dev)
  example/                 the four learning-path sample subprojects
  doc/                     scripting-API guides (intro + 3 families)
tom_vscode_bridge/         Dart bridge server (tom_bs) for CLI/d4rt       (binary)

yaml_graph_core/           YAML-graph → Mermaid engine                   (decoupled)
yaml_graph_vscode/         YAML-graph custom editor                      (decoupled)
```

Dependency direction, simplified: the TypeScript stack roots at
`tom_vscode_shared`, which `tom_vscode_extension` and `tom_vscode_workflow` build
on; the Dart stack roots at `tom_vscode_scripting_api`, which `tom_vscode_bridge`
and external CLI tools consume. The two stacks meet only at the extension's
JSON-RPC CLI Integration Server. The `yaml_graph_*` packages stand alone and are
no longer wired into the extension.

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[`LICENSE.md`](LICENSE.md) (each package also carries its own `LICENSE`).
