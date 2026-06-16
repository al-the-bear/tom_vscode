# @Tom VS Code Extension

> **Tom VS Code** — part of the Tom Framework by Peter Nicolai Alexis Kyaw.
> Licensed BSD-3-Clause. See [LICENSE](LICENSE).

The **`@Tom`** VS Code extension — an AI-assisted development cockpit. It adds
multi-model chat panels (Anthropic, Local LLM, Copilot), a multi-transport prompt
queue, timed requests, a shared tool registry, a standalone MCP server, the
status page, and the **CLI Integration Server** that lets out-of-process Dart
clients drive the live window. This is the product of the Tom VS Code repo.

---

## Overview

`@Tom` turns a normal VS Code window into a unified AI workspace:

- **Multi-model chat** — Anthropic (direct SDK + Agent SDK), the VS Code language
  model (Copilot), and a local LLM, in dedicated bottom-panel subpanels.
- **Prompt queue orchestration** — queue work across transports with follow-ups,
  reminders, repeat support, and automation toggles.
- **Timed requests** — interval / scheduled prompts that enqueue automatically.
- **Tool registry + MCP server** — the same MCP-style tools the panels use,
  published to external MCP clients over HTTP.
- **Scripting surface** — the CLI Integration Server exposes the extension to the
  [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) Dart client
  and the [`tom_vscode_bridge`](../tom_vscode_bridge/README.md) server.
- **Workspace tooling** — markdown/guideline browsing, quest navigation, a
  per-window status page, and D4rt/bridge/CLI runtime integration.

---

## Installation

### Prerequisites

| Software | Version | Notes |
| --- | --- | --- |
| Dart SDK | ≥ 3.10.4 (< 4.0) | Compiles the `tom_bs` bridge binary and runs the d4rt generator |
| Node.js | ≥ 20 (LTS) | Enforced by the installer; the extension targets Node v25 — install/switch with nvm |
| nvm | latest | Recommended — lets the installer install/switch to a supported Node automatically |
| VS Code | ≥ 1.96.0 | `engines.vscode` in `package.json` |
| `code` CLI | — | Must be on `PATH` for the installer to install the VSIX (VS Code → *Shell Command: Install 'code' command in PATH*) |
| `@vscode/vsce` | latest | Auto-run via `npx` if not installed globally |

The from-source build also needs two sibling Tom projects present on disk (see
[Directory Layout](#directory-layout)):

- **`tom_vscode_bridge`** — the bridge whose `tom_bs` binary is compiled (ships
  in the same repo as this extension).
- **`tom_d4rt_generator`** — the d4rt bridge generator, part of the **d4rt
  repo**, which must be cloned as a sibling under `tom_ai/d4rt/`.

All other Dart dependencies (`tom_d4rt`, `tom_vscode_scripting_api`,
`tom_build_base`, `analyzer`, …) are resolved from pub.dev by `dart pub get`.

### Preferred: build from source for the current platform

`compile_and_install.sh` / `.ps1` is the recommended installer. It performs a
fully local build for the host platform only:

```bash
bash compile_and_install.sh      # macOS / Linux
pwsh compile_and_install.ps1     # Windows
```

It runs end to end:

1. Checks Node (switches via nvm if below 20), installs npm deps, compiles the TypeScript.
2. `dart pub get` for the generator and the bridge.
3. Regenerates the d4rt bridges for `tom_vscode_bridge`.
4. `dart compile exe bin/tom_bs.dart` straight into the extension's local
   `bin/<platform>/` — it never writes to `tom_binaries`, relies on
   `$TOM_BINARY_PATH`, or needs any tool on `PATH`.
5. Ensures the host's Claude Agent SDK native CLI binary is present.
6. Packages the VSIX (bundling only the host `tom_bs`) and installs it via the `code` CLI.

After install, reload VS Code: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

### Alternative: bundle prebuilt binaries for all platforms

`install_extension.sh` / `.ps1` builds the same VSIX but bundles prebuilt
`tom_bs` binaries for all five platforms copied from
`tom_binaries/tom/<platform>/` (it does **not** compile from source). Use this
only when the prebuilt binaries layer is present:

```bash
bash install_extension.sh        # macOS / Linux
pwsh install_extension.ps1       # Windows
```

### Alternative: install a prebuilt VSIX

```bash
code --install-extension tom-ai-extension-0.1.0.vsix
```

### Directory Layout

Both installer scripts resolve the workspace root as **three levels above** the
extension folder (`tom_vscode_extension/../../..`) and expect the layout below.
The `tom_vscode_*` projects live in the **tom_vscode** repo (mounted at
`tom_ai/vscode/`); the `tom_d4rt*` projects live in the separate **d4rt** repo
(cloned at `tom_ai/d4rt/`):

```
<workspace-root>/                      # parent of tom_ai (e.g. tom_agent_container)
├── tom_ai/
│   ├── vscode/                        # tom_vscode repo
│   │   ├── tom_vscode_extension/      # ← this extension (scripts live here)
│   │   │   ├── compile_and_install.sh / .ps1
│   │   │   ├── install_extension.sh / .ps1
│   │   │   └── bin/<platform>/tom_bs  # build output (gitignored)
│   │   ├── tom_vscode_bridge/         # bridge source → compiled to tom_bs
│   │   └── tom_vscode_scripting_api/  # bridged scripting API
│   └── d4rt/                          # d4rt repo (separate clone, sibling of vscode/)
│       ├── tom_d4rt_generator/        # d4rtgen — regenerates the d4rt bridges
│       └── tom_d4rt/                  # d4rt interpreter runtime
└── tom_binaries/                      # prebuilt binaries layer (install_extension only)
    └── tom/<platform>/tom_bs
```

`<platform>` is VS Code's platform-vs id: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, or `win32-x64`.

---

## Features

### Chat panels

The bottom **@CHAT** panel (`tomAi.chatPanel`) hosts five subpanels:

| Subpanel | Transport |
| --- | --- |
| Anthropic | Direct Anthropic SDK + Agent SDK (`anthropic-handler`, `agent-sdk-transport`). |
| Tom AI Chat | The extension's own chat surface. |
| AI Conversation | Multi-turn bot-conversation loop (not queue-compatible). |
| Copilot | VS Code language model (`vscodeLm`). |
| Local LLM | Locally hosted models (`localLlm-handler`). |

Alongside it: **@WS** (`tomAi.wsPanel`, workspace) in the bottom panel, and the
**@TOM** sidebar with tree views for notes, todos, the todo log, and window
status.

### Highlights

| Area | Capabilities |
| --- | --- |
| Prompt Queue | One-file-per-entry YAML storage; auto-send / auto-start / auto-pause / auto-continue / restart; repeat with prefix/suffix placeholders; answer-wait timeout; watchdog health checks. |
| Timed Requests | Interval and scheduled firing; `sentCount`-based `sendMaximum` auto-pause; reminder + repeat config; global schedule-slot filtering; all fires enqueue through the Prompt Queue (single dispatch path). |
| Answer detection | RequestId-based detection with a file watcher plus a polling fallback. |
| Browsing | Markdown Browser with a grouped document picker, quest filters, line anchors, and auto-reload. |
| Status | Window Status panel showing per-window subsystem state from window-state files. |
| MCP server | Standalone MCP server publishing the tool registry over HTTP — see [doc/mcp_server.md](doc/mcp_server.md). |

### Output channels

`Tom Prompt Queue` · `Tom Timed Requests` · `Tom Debug` · `Tom Tests` ·
`Tom Dartbridge Log` · `Tom Conversation Log` · `Tom AI Chat Log` ·
`Tom Tool Log` · `Tom AI Chat Responses` · `Tom AI Local LLM` ·
`Tom AI Local Log`.

---

## Commands

Open the command palette and type `@T:` to discover commands.

| Group | Commands |
| --- | --- |
| Core AI | Send to Copilot · Send to Copilot (Default Template) · Send to Copilot (Pick Template) · Send to Local LLM · Change Local LLM Model… · Start AI Conversation · Start Tom AI Chat |
| Queue & timer | Open Prompt Queue · Open Timed Requests · Open Prompt Templates · Open Reusable Prompts |
| Workspace & runtime | Open in Markdown Browser · Extension Status Page · Restart Bridge · Start / Stop Tom CLI Integration Server · Start Process Monitor |

### Keybindings

High-use shortcuts (full list in [doc/quick_reference.md](doc/quick_reference.md)):

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+0` | Focus @CHAT |
| `Ctrl+Shift+9` | Focus @WS |
| `Ctrl+Shift+6` | Open Prompt Queue |
| `Ctrl+Shift+7` | Open Timed Requests |
| `Ctrl+Shift+5` | Open Raw Trail Viewer |
| `Ctrl+Shift+\` | Maximize toggle |

---

## Architecture

The extension activates `onStartupFinished` (`src/extension.ts`) and is layered:
handlers own webview wiring, services own side-effects, utils are pure.

| Folder | Role |
| --- | --- |
| `config/` | Configuration schemas + defaults (`sendToChatConfig.ts`, `tom_vscode_extension.schema.json`). |
| `extension.ts` | Activation entry point. |
| `handlers/` | Per-subsystem handlers — chatPanel, anthropic, agent-sdk-transport, localLlm, tomAiChat, queueEditor, statusPage, mcpServer, … |
| `managers/` | Long-lived state managers (e.g. `promptQueueManager`, `reminderSystem`). |
| `services/` | Pure side-effect services — trail, tool-result store, history compaction, memory, drafts, answer files. |
| `storage/` | Disk-backed stores (`panelYamlStore`, notepad stores). |
| `tools/` | MCP-style tool surface — shared tool registry, tool executors, chat-enhancement / issue / test tools. |
| `types/` | Shared type declarations. |
| `utils/` | Pure helpers — `variableResolver`, `tomAiConfiguration`, `fsUtils`, `workspacePaths`, `retryWithBudget`. |
| `vscode-bridge.ts` | External bridge surface consumed by `tom_vscode_bridge`. |

### Key components

| Component | Role |
| --- | --- |
| `promptQueueManager` (managers) | The single dispatch path; owns queue state, automation, and watchdog recovery. |
| `anthropic-handler` / `agent-sdk-transport` (handlers) | Anthropic direct-SDK and Agent-SDK transports. |
| `shared-tool-registry` (tools) | The MCP-style tool surface shared by panels and the MCP server. |
| `mcpServer-handler` (handlers) | Standalone MCP server lifecycle and HTTP surface. |
| CLI Integration Server | TCP server (`19900`–`19909`) the scripting API connects to (hosted via the bridge). |
| `extensionConfigStore` (managers) | Section-scoped reads/writes of the per-quest config files. |

> **Configuration invariant.** Any change to the configuration shape must update
> **both** `src/config/sendToChatConfig.ts` (the TypeScript shape) and
> `src/config/tom_vscode_extension.schema.json` (the JSON Schema) in lockstep.

---

## Queue and timed-request behavior

- **Prompt Queue** — one-file-per-entry YAML storage; automation toggles for flow
  behavior; repetition with prefix/suffix placeholders; answer-wait timeout for
  time-based auto-advance; watchdog health checks to recover watcher issues.
- **Timed Requests** — interval and scheduled firing modes; `sendMaximum` with
  `sentCount`-based auto-pause; reminder and repeat configuration; global
  schedule-slot filtering; every fire enqueues through the Prompt Queue.

Full model: [doc/multi_transport_prompt_queue_revised.md](doc/multi_transport_prompt_queue_revised.md).

---

## Development

```bash
npm run compile      # tsc -p ./ + copy config json to out/config/
npm run watch        # incremental rebuild
npm test             # lint media + tools/services/utils test suites + tool-coverage audit
```

Run the extension host for manual testing: open this project in VS Code, press
`F5`, and test commands in the Extension Development Host.

> Reloading the window alone does **not** pick up source changes — it reloads the
> *installed* VSIX. Repackage + reinstall first (`compile_and_install.sh`), then
> reload.

---

## Ecosystem

- [`tom_vscode_scripting_api`](../tom_vscode_scripting_api/README.md) — the typed
  Dart client that drives this extension over the CLI Integration Server.
- [`tom_vscode_bridge`](../tom_vscode_bridge/README.md) — the Dart bridge server
  this extension launches (`tom_bs`).
- [`tom_vscode_shared`](../tom_vscode_shared/README.md) /
  [`tom_vscode_workflow`](../tom_vscode_workflow/README.md) — the shared
  TypeScript libraries the extension is built from.
- [Repository map](../README.md) — the whole Tom VS Code ecosystem at a glance.

---

## Further documentation

User-facing guides live in [`doc/`](doc/); development docs in
[`_copilot_guidelines/`](_copilot_guidelines/).

| Document | Covers |
| --- | --- |
| [doc/user_guide.md](doc/user_guide.md) | Complete feature guide. |
| [doc/quick_reference.md](doc/quick_reference.md) | Shortcuts, panels, command map. |
| [doc/extension_analysis.md](doc/extension_analysis.md) | Cross-component architecture analysis. |
| [doc/anthropic_sdk_integration.md](doc/anthropic_sdk_integration.md) | Anthropic direct + Agent SDK integration. |
| [doc/mcp_server.md](doc/mcp_server.md) | Standalone MCP server — config, auth, lifecycle, security. |
| [doc/multi_transport_prompt_queue_revised.md](doc/multi_transport_prompt_queue_revised.md) | The current prompt-queue model. |
| [doc/llm_configuration.md](doc/llm_configuration.md) | Local LLM + Anthropic + history-compaction settings. |
| [doc/placeholder_engine.md](doc/placeholder_engine.md) | Placeholder engine reference. |
| [doc/copilot_chat_tools.md](doc/copilot_chat_tools.md) | Copilot / Tom AI Chat tooling. |
| [_copilot_guidelines/architecture.md](_copilot_guidelines/architecture.md) | Architecture and state model (dev). |
| [_copilot_guidelines/keybindings_and_commands.md](_copilot_guidelines/keybindings_and_commands.md) | Command and keybinding details (dev). |

---

## Status

| | |
| --- | --- |
| Name / publisher | `tom-ai-extension` (`@Tom`) · `peter-nicolai-alexis-kyaw` |
| Version | 0.1.0 |
| VS Code engine | `^1.96.0` |
| Node.js | ≥ 20 (targets v25) |
| Tests | 88 test files (`npm test` runs the tools/services/utils suites + tool-coverage audit) |
| License | BSD-3-Clause |

---

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Chat API](https://code.visualstudio.com/api/extension-guides/chat)

## License

Part of the Tom Framework by Peter Nicolai Alexis Kyaw, BSD-3-Clause. See
[LICENSE](LICENSE).
</content>
